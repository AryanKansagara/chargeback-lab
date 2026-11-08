import { useEffect, useMemo, useState } from 'react'
import { allocate, filterMonth, months as monthsOf, type Allocation } from './engine/allocate.ts'
import { snapshotMonth } from './engine/insights.ts'
import { toCsv } from './engine/csv.ts'
import { SAMPLES, generate, sampleConfig } from './engine/sample.ts'
import { staticTeams } from './engine/rules.ts'
import { UNASSIGNED, UNMAPPED, type Config, type Dataset } from './engine/types.ts'
import { blankConfig, getData, getProjects, saveProject, useProjects, uuid, type Project } from './store.ts'

const sampleCache = new Map<string, Dataset>()
export function sampleDataset(id: string): Dataset | null {
  const def = SAMPLES.find(s => s.id === id)
  if (!def) return null
  if (!sampleCache.has(id)) sampleCache.set(id, generate(def))
  return sampleCache.get(id)!
}

export const EMPTY: Dataset = { meter: [], usage: [], daily: [], warehouses: [] }

export async function createSampleProject(sampleId: string): Promise<Project> {
  const existing = getProjects().find(p => p.sampleId === sampleId)
  if (existing) return existing
  const def = SAMPLES.find(s => s.id === sampleId)!
  const ds = sampleDataset(sampleId)!
  const config = sampleConfig(def)
  // Two closed months already snapshotted so the compare view has something to show.
  const snapshots = ['2026-09', '2026-10'].map(m => snapshotMonth(ds, config, m, uuid(), new Date(m + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })))
  const now = Date.now()
  return saveProject({
    id: uuid(), name: def.name, createdAt: now, updatedAt: now, config, snapshots, sampleId,
    imports: [
      { id: uuid(), kind: 'meter', fileName: 'synthetic warehouse_metering_history', rows: ds.meter.length, skipped: 0, at: now },
      { id: uuid(), kind: 'usage', fileName: 'synthetic query_attribution_history', rows: ds.usage.length, skipped: 0, at: now },
      { id: uuid(), kind: 'daily', fileName: 'synthetic metering_daily_history', rows: ds.daily.length, skipped: 0, at: now },
      { id: uuid(), kind: 'warehouses', fileName: 'synthetic show warehouses', rows: ds.warehouses.length, skipped: 0, at: now },
    ],
  })
}

export async function createBlankProject(name: string): Promise<Project> {
  const now = Date.now()
  return saveProject({ id: uuid(), name, createdAt: now, updatedAt: now, config: blankConfig(), snapshots: [], imports: [] })
}

/** Teams in a stable order for colours: rule order, then owners, then anything else alphabetically. */
export function teamOrder(cfg: Config, alloc: Allocation | null): string[] {
  const out = staticTeams(cfg.rules)
  for (const t of Object.values(cfg.owners)) if (t && !out.includes(t)) out.push(t)
  const rest = (alloc?.teams.map(t => t.team) ?? []).filter(t => !out.includes(t) && t !== UNMAPPED && t !== UNASSIGNED).sort()
  return [...out, ...rest]
}

/** Latest month whose data runs to the last day, else the latest month. Bills are for closed months. */
export function defaultMonth(ds: Dataset, ms: string[]): string | null {
  if (!ms.length) return null
  const last = ms[ms.length - 1]
  let maxHour = 0
  for (const m of ds.meter) if (m.hour > maxHour) maxHour = m.hour
  const [y, mo] = last.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  const complete = new Date(maxHour).toISOString().slice(0, 10) === `${last}-${String(lastDay).padStart(2, '0')}`
  return complete || ms.length === 1 ? last : ms[ms.length - 2]
}

export function useProject(id: string) {
  const list = useProjects()
  const project = list?.find(p => p.id === id) ?? null
  const [ds, setDs] = useState<Dataset | null>(null)
  const [version, setVersion] = useState(0)
  const importsKey = project ? project.imports.map(i => i.id).join(',') : ''
  useEffect(() => {
    if (!project) return
    let live = true
    if (project.sampleId) { setDs(sampleDataset(project.sampleId) ?? EMPTY); return }
    void getData(project.id).then(d => { if (live) setDs(d ?? EMPTY) })
    return () => { live = false }
    // Reload when imports change or the caller bumps the version.
  }, [project?.id, project?.sampleId, importsKey, version])
  const update = (patch: Partial<Project>) => project && saveProject({ ...project, ...patch })
  const setConfig = (patch: Partial<Config>) => project && saveProject({ ...project, config: { ...project.config, ...patch } })
  return { loading: list === null || (project !== null && ds === null), project, ds, update, setConfig, reload: () => setVersion(v => v + 1) }
}

export function useAllocation(ds: Dataset | null, cfg: Config | undefined, month: string | null) {
  const sliced = useMemo(() => ds && month ? filterMonth(ds, month) : null, [ds, month])
  const alloc = useMemo(() => sliced && cfg ? allocate(sliced, cfg) : null, [sliced, cfg])
  return { sliced, alloc }
}

export const monthsIn = (ds: Dataset | null) => ds ? monthsOf(ds) : []

export const METHODS: Record<Config['idleMethod'], { label: string; body: string }> = {
  credits: { label: 'Proportional to query credits', body: 'Each warehouse-hour’s idle credits are split among the teams that ran queries in that hour, in proportion to their attributed query credits. The default, and what Snowflake’s own cost-attribution example does.' },
  exec: { label: 'Proportional to execution time', body: 'Split by each team’s total query execution time in that hour. Favors heavy, short queries; charges long, light queries that kept the warehouse awake. Falls back to credits if execution time is missing.' },
  even: { label: 'Even split among active teams', body: 'Every team that ran at least one query in the hour pays an equal share of that hour’s idle, regardless of size. Simple to explain; a small team on a big warehouse pays a lot.' },
  owner: { label: 'Charge the warehouse owner', body: 'All idle on a warehouse goes to its owning team (set on the Rules tab). The owner controls size and auto-suspend, so the owner pays for the idle those settings cause.' },
}

const r4 = (n: number) => Math.round(n * 10000) / 10000

/** One row per team per warehouse, plus serverless rows, for finance. */
export function financeCsv(alloc: Allocation, month: string): string {
  const rows: (string | number)[][] = [['month', 'team', 'source', 'query_credits', 'idle_credits', 'cloud_services_credits', 'serverless_credits', 'total_credits', 'price_per_credit', 'amount_usd', 'idle_method']]
  for (const t of alloc.teams) {
    for (const [w, v] of Object.entries(t.byWarehouse).sort()) {
      const total = v.query + v.idle + v.cloud
      if (total <= 0) continue
      rows.push([month, t.team, w, r4(v.query), r4(v.idle), r4(v.cloud), 0, r4(total), alloc.price, Math.round(total * alloc.price * 100) / 100, alloc.method])
    }
    const services = Object.entries(t.byService)
    for (const [svc, v] of services) rows.push([month, t.team, svc, 0, 0, 0, r4(v), r4(v), alloc.price, Math.round(v * alloc.price * 100) / 100, alloc.method])
    const unservice = t.serverless + t.qas - services.reduce((a, [, v]) => a + v, 0)
    if (unservice > 1e-6) rows.push([month, t.team, 'QUERY_ACCELERATION', 0, 0, 0, r4(unservice), r4(unservice), alloc.price, Math.round(unservice * alloc.price * 100) / 100, alloc.method])
  }
  return toCsv(rows)
}
