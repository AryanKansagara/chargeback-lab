// Synthetic Snowflake accounts. Everything here is generated; none of it is real customer data.
import { dayOf, HOUR } from './csv.ts'
import type { Config, Dataset, DailyRow, MeterRow, Rule, UsageRow, WarehouseInfo } from './types.ts'
import { creditsPerHour } from './insights.ts'
import { toCsv } from './csv.ts'

export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Shape = 'nightly' | 'hourly' | 'business' | 'bursty' | 'steady' | 'adhoc'
interface Workload {
  user: string
  role: string
  db: string
  tags?: string[]
  shape: Shape
  /** Queries in a busy hour. */
  qph: number
  /** Average execution seconds per query. */
  exec: number
  /** Cloud services credits per query. */
  cs?: number
  /** Month-over-month growth multiplier applied in the second month. */
  growth?: number
  /** Extra multiplier on a single day (YYYY-MM-DD). */
  spike?: [string, number]
}
interface WhSpec { name: string; size: string; autoSuspend: number; ownerRole: string; work: Workload[] }

const weekday = (t: number) => { const d = new Date(t).getUTCDay(); return d > 0 && d < 6 }

function intensity(shape: Shape, t: number, r: () => number): number {
  const h = new Date(t).getUTCHours()
  const wd = weekday(t)
  switch (shape) {
    case 'nightly': return h >= 2 && h < 6 ? 1 : 0
    case 'hourly': return 0.35 + 0.1 * r()
    case 'steady': return r() < 0.85 ? 0.6 + 0.3 * r() : 0
    case 'business': return wd && h >= 13 && h < 23 ? 0.6 + 0.4 * r() : wd && (h === 12 || h === 23) ? 0.2 : r() < 0.04 ? 0.15 : 0
    case 'bursty': return wd && h >= 15 && h < 23 && r() < 0.7 ? 0.75 + 0.5 * r() : 0
    case 'adhoc': return wd && h >= 14 && h < 22 && r() < 0.3 ? 0.4 + 0.6 * r() : 0
  }
}

const dbt = (models: string[]) => models.map(m => JSON.stringify({ team: 'data-eng', app: 'dbt', model: m }))

const TAGGED: WhSpec[] = [
  { name: 'TRANSFORM_WH', size: 'Large', autoSuspend: 60, ownerRole: 'TRANSFORMER', work: [
    { user: 'SVC_DBT', role: 'TRANSFORMER', db: 'ANALYTICS', tags: dbt(['fct_orders', 'dim_customers', 'fct_sessions']), shape: 'nightly', qph: 140, exec: 22, cs: 0.0006, spike: ['2026-10-14', 3.2] },
    { user: 'SVC_DBT', role: 'TRANSFORMER', db: 'ANALYTICS', tags: dbt(['incremental_events']), shape: 'hourly', qph: 18, exec: 9, cs: 0.0004 },
  ] },
  { name: 'LOAD_WH', size: 'X-Small', autoSuspend: 60, ownerRole: 'LOADER', work: [
    { user: 'SVC_FIVETRAN', role: 'LOADER', db: 'RAW', shape: 'steady', qph: 90, exec: 8, cs: 0.006 },
  ] },
  { name: 'BI_WH', size: 'Medium', autoSuspend: 600, ownerRole: 'BI_READER', work: [
    { user: 'SVC_LOOKER', role: 'BI_READER', db: 'ANALYTICS', tags: [JSON.stringify({ team: 'analytics', app: 'looker' })], shape: 'business', qph: 420, exec: 3.5, cs: 0.0011 },
    { user: 'SVC_TABLEAU', role: 'BI_READER', db: 'FINANCE', shape: 'business', qph: 160, exec: 4.5, cs: 0.0016, growth: 1.15 },
  ] },
  { name: 'ANALYTICS_WH', size: 'Small', autoSuspend: 300, ownerRole: 'SYSADMIN', work: [
    { user: 'MAYA_PATEL', role: 'GROWTH_ANALYST', db: 'ANALYTICS', tags: [JSON.stringify({ team: 'growth' })], shape: 'business', qph: 30, exec: 6, growth: 1.35 },
    { user: 'LEO_NGUYEN', role: 'GROWTH_ANALYST', db: 'ANALYTICS', shape: 'adhoc', qph: 40, exec: 8, growth: 1.5 },
    { user: 'PRIYA_SHAH', role: 'FINANCE_ANALYST', db: 'FINANCE', tags: [JSON.stringify({ team: 'finance', report: 'close' })], shape: 'business', qph: 22, exec: 5 },
    { user: 'JORDAN_LEE', role: 'SYSADMIN', db: 'SANDBOX', shape: 'adhoc', qph: 25, exec: 12 },
  ] },
  { name: 'DS_WH', size: 'X-Large', autoSuspend: 300, ownerRole: 'DATA_SCIENTIST', work: [
    { user: 'ANA_GARCIA', role: 'DATA_SCIENTIST', db: 'ML', tags: [JSON.stringify({ team: 'data-science', notebook: 'churn_model' })], shape: 'bursty', qph: 16, exec: 70, growth: 1.4 },
    { user: 'SAM_OKAFOR', role: 'DATA_SCIENTIST', db: 'ML', tags: [JSON.stringify({ team: 'data-science', notebook: 'ltv_forecast' })], shape: 'bursty', qph: 10, exec: 55 },
  ] },
  { name: 'ADHOC_WH', size: 'Medium', autoSuspend: 3600, ownerRole: 'SYSADMIN', work: [
    { user: 'LEO_NGUYEN', role: 'GROWTH_ANALYST', db: 'ANALYTICS', shape: 'adhoc', qph: 12, exec: 10 },
    { user: 'PRIYA_SHAH', role: 'FINANCE_ANALYST', db: 'FINANCE', shape: 'adhoc', qph: 10, exec: 9 },
    { user: 'NEW_HIRE_TEMP', role: 'PUBLIC', db: 'SANDBOX', shape: 'adhoc', qph: 14, exec: 15 },
  ] },
]

const CONSOLIDATED: WhSpec[] = [
  { name: 'ETL_WH', size: 'Large', autoSuspend: 120, ownerRole: 'TRANSFORMER', work: [
    { user: 'SVC_DBT', role: 'TRANSFORMER', db: 'ANALYTICS', shape: 'nightly', qph: 160, exec: 20, cs: 0.0006 },
    { user: 'SVC_FIVETRAN', role: 'LOADER', db: 'RAW', shape: 'steady', qph: 50, exec: 6 },
    { user: 'SVC_AIRFLOW', role: 'SYSADMIN', db: 'RAW', shape: 'hourly', qph: 20, exec: 10 },
  ] },
  { name: 'BI_WH', size: 'Medium', autoSuspend: 900, ownerRole: 'BI_READER', work: [
    { user: 'SVC_LOOKER', role: 'BI_READER', db: 'ANALYTICS', shape: 'business', qph: 300, exec: 1.2, cs: 0.0012 },
    { user: 'SVC_TABLEAU', role: 'BI_READER', db: 'FINANCE', shape: 'business', qph: 140, exec: 2, cs: 0.0015 },
  ] },
  { name: 'SHARED_WH', size: 'Large', autoSuspend: 600, ownerRole: 'SYSADMIN', work: [
    { user: 'MAYA_PATEL', role: 'ANALYST', db: 'ANALYTICS', shape: 'business', qph: 30, exec: 6 },
    { user: 'PRIYA_SHAH', role: 'ANALYST', db: 'FINANCE', shape: 'business', qph: 25, exec: 5 },
    { user: 'ANA_GARCIA', role: 'ANALYST', db: 'ML', shape: 'bursty', qph: 12, exec: 40 },
  ] },
  { name: 'DEV_WH', size: 'Small', autoSuspend: 0, ownerRole: 'SYSADMIN', work: [
    { user: 'JORDAN_LEE', role: 'SYSADMIN', db: 'SANDBOX', shape: 'adhoc', qph: 20, exec: 8 },
  ] },
]

const rule = (id: string, field: Rule['field'], op: Rule['op'], value: string, team: string, extra: Partial<Rule> = {}): Rule => ({ id, field, op, value, team, ...extra })

export const TAGGED_RULES: Rule[] = [
  rule('r1', 'tag_key', 'equals', 'data-eng', 'Data Engineering', { key: 'team' }),
  rule('r2', 'tag_key', 'equals', 'analytics', 'Analytics', { key: 'team' }),
  rule('r3', 'tag_key', 'equals', 'growth', 'Growth', { key: 'team' }),
  rule('r4', 'tag_key', 'equals', 'finance', 'Finance', { key: 'team' }),
  rule('r5', 'tag_key', 'equals', 'data-science', 'Data Science', { key: 'team' }),
  rule('r6', 'user', 'equals', 'SVC_FIVETRAN', 'Data Engineering'),
  rule('r7', 'user', 'equals', 'SVC_TABLEAU', 'Finance'),
  rule('r8', 'role', 'equals', 'GROWTH_ANALYST', 'Growth'),
  rule('r9', 'role', 'equals', 'FINANCE_ANALYST', 'Finance'),
  rule('r10', 'service_type', 'equals', 'PIPE', 'Data Engineering'),
  rule('r11', 'service_type', 'equals', 'SERVERLESS_TASK', 'Data Engineering'),
]

export const CONSOLIDATED_RULES: Rule[] = [
  rule('c1', 'user', 'equals', 'SVC_DBT', 'Data Engineering'),
  rule('c2', 'user', 'equals', 'SVC_LOOKER', 'Analytics'),
  rule('c3', 'database', 'equals', 'FINANCE', 'Finance'),
]

export interface SampleDef { id: string; name: string; blurb: string; specs: WhSpec[]; rules: Rule[]; owners: Record<string, string>; budgets: Record<string, number>; seed: number }

export const SAMPLES: SampleDef[] = [
  {
    id: 'acme', name: 'Acme Retail (synthetic)', seed: 7,
    blurb: '6 warehouses, 5 teams, dbt + Fivetran ETL, Looker and Tableau service users, one warehouse two teams share, and ADHOC_WH left at a one-hour auto-suspend.',
    specs: TAGGED, rules: TAGGED_RULES,
    owners: { TRANSFORM_WH: 'Data Engineering', LOAD_WH: 'Data Engineering', BI_WH: 'Analytics', DS_WH: 'Data Science' },
    budgets: { 'Data Engineering': 3600, Analytics: 1200, Growth: 700, Finance: 1100, 'Data Science': 4000 },
  },
  {
    id: 'consolidated', name: 'Just consolidated (synthetic)', seed: 11,
    blurb: '14 warehouses squeezed into 4, almost no query tags, a dev warehouse that never suspends. Most spend starts out unmapped.',
    specs: CONSOLIDATED, rules: CONSOLIDATED_RULES,
    owners: { ETL_WH: 'Data Engineering' },
    budgets: {},
  },
]

/** Generates hourly data from the first of `from` up to (not including) the `to` date. */
export function generate(def: SampleDef, from = '2026-09', to = '2026-11-07'): Dataset {
  const r = rng(def.seed)
  const meter: MeterRow[] = []
  const usage: UsageRow[] = []
  const warehouses: WarehouseInfo[] = def.specs.map(s => ({ name: s.name, size: s.size, autoSuspend: s.autoSuspend, owner: s.ownerRole, maxClusters: 1 }))
  const start = Date.UTC(+from.slice(0, 4), +from.slice(5) - 1, 1)
  const end = Date.parse(to + 'T00:00:00Z')
  for (const spec of def.specs) {
    const rate = creditsPerHour(spec.size)
    let spill = 0
    for (let t = start; t < end; t += HOUR) {
      const second = new Date(t).toISOString().slice(0, 7) !== from
      const day = dayOf(t)
      let busy = 0
      let bursts = 0
      const rows: UsageRow[] = []
      for (const w of spec.work) {
        let k = intensity(w.shape, t, r)
        // A runaway full refresh: the job keeps going all day.
        if (w.spike && w.spike[0] === day) k = (k || 0.9) * w.spike[1]
        if (!k) continue
        if (second && w.growth) k *= w.growth
        const n = Math.max(1, Math.round(w.qph * k * (0.8 + 0.4 * r())))
        const tags = w.tags ?? ['']
        bursts += Math.max(1, Math.round(k * 2.2))
        for (let i = 0; i < tags.length; i++) {
          const q = Math.max(1, Math.round(n / tags.length))
          const exec = q * w.exec * (0.7 + 0.6 * r()) * 1000
          // Concurrency packs short queries together; long ones mostly serialize.
          const sec = exec / 1000 / (w.exec < 5 ? 2 : 1.4)
          busy += sec
          rows.push({ hour: t, warehouse: spec.name, user: w.user, role: w.role, tag: tags[i], database: w.db, credits: 0, qas: 0, execMs: Math.round(exec), queries: q, cloud: q * (w.cs ?? 0.0005) * (0.8 + 0.4 * r()) })
        }
      }
      busy = Math.min(busy, 3600)
      // Idle model: gaps between bursts idle up to the auto-suspend window, and the last burst's tail spills over.
      const tail = spec.autoSuspend === 0 ? Infinity : spec.autoSuspend
      let on: number
      if (rows.length) {
        const lastTail = Math.min(tail, 3600 * (0.04 + 0.12 * r()))
        on = Math.min(3600, busy + (bursts - 1) * Math.min(tail, 200) + lastTail)
        spill = Math.max(0, tail - lastTail)
      } else {
        on = Math.min(3600, spill)
        spill = Math.max(0, spill - 3600)
        if (spill === Infinity && r() < 0.04) spill = 0
      }
      if (on <= 0) continue
      const attributed = (rate * busy) / 3600
      const totalExec = rows.reduce((a, b) => a + b.execMs, 0) || 1
      for (const row of rows) row.credits = round6((attributed * row.execMs) / totalExec)
      const cloud = rows.reduce((a, b) => a + b.cloud, 0)
      meter.push({ hour: t, warehouse: spec.name, compute: round6((rate * on) / 3600), cloud: round6(cloud), attributed: round6(attributed) })
      for (const row of rows) { row.cloud = round6(row.cloud); usage.push(row) }
    }
  }
  const daily: DailyRow[] = []
  const byDay = new Map<string, { compute: number; cloud: number }>()
  for (const m of meter) {
    const d = byDay.get(dayOf(m.hour)) ?? { compute: 0, cloud: 0 }
    d.compute += m.compute; d.cloud += m.cloud
    byDay.set(dayOf(m.hour), d)
  }
  for (const [day, d] of [...byDay].sort()) {
    const adj = -Math.min(d.cloud, 0.1 * d.compute)
    daily.push({ day, service: 'WAREHOUSE_METERING', compute: round6(d.compute), cloud: round6(d.cloud), adjustment: round6(adj), billed: round6(d.compute + d.cloud + adj) })
    const pipe = 1.6 + r() * 0.8
    daily.push({ day, service: 'PIPE', compute: round6(pipe), cloud: 0, adjustment: 0, billed: round6(pipe) })
    const ac = 1.1 + r() * 0.6
    daily.push({ day, service: 'AUTO_CLUSTERING', compute: round6(ac), cloud: 0, adjustment: 0, billed: round6(ac) })
    const task = 0.5 + r() * 0.4
    daily.push({ day, service: 'SERVERLESS_TASK', compute: round6(task), cloud: 0, adjustment: 0, billed: round6(task) })
  }
  return { meter, usage, daily, warehouses }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

export function sampleConfig(def: SampleDef): Config {
  return { rules: def.rules.map(r => ({ ...r })), idleMethod: 'credits', pricePerCredit: 3, owners: { ...def.owners }, budgets: { ...def.budgets }, carryHours: 2 }
}

const ts = (t: number) => new Date(t).toISOString().replace('T', ' ').replace('Z', ' +0000')

/** The dataset as the four CSVs the docs' SQL produces, with Snowflake's column names. */
export function toSnowflakeCsvs(ds: Dataset): Record<'metering' | 'attribution' | 'daily' | 'warehouses', string> {
  return {
    metering: toCsv([['START_TIME', 'WAREHOUSE_NAME', 'CREDITS_USED_COMPUTE', 'CREDITS_USED_CLOUD_SERVICES', 'CREDITS_ATTRIBUTED_COMPUTE_QUERIES'],
      ...ds.meter.map(m => [ts(m.hour), m.warehouse, m.compute, m.cloud, m.attributed ?? ''])]),
    attribution: toCsv([['HOUR', 'WAREHOUSE_NAME', 'USER_NAME', 'ROLE_NAME', 'QUERY_TAG', 'DATABASE_NAME', 'QUERIES', 'EXECUTION_MS', 'CREDITS_ATTRIBUTED_COMPUTE', 'CREDITS_USED_QUERY_ACCELERATION', 'CREDITS_USED_CLOUD_SERVICES'],
      ...ds.usage.map(u => [ts(u.hour), u.warehouse, u.user, u.role, u.tag, u.database, u.queries, u.execMs, u.credits, u.qas, u.cloud])]),
    daily: toCsv([['USAGE_DATE', 'SERVICE_TYPE', 'CREDITS_USED_COMPUTE', 'CREDITS_USED_CLOUD_SERVICES', 'CREDITS_ADJUSTMENT_CLOUD_SERVICES', 'CREDITS_BILLED'],
      ...ds.daily.map(d => [d.day, d.service, d.compute, d.cloud, d.adjustment, d.billed])]),
    warehouses: toCsv([['name', 'size', 'auto_suspend', 'owner', 'max_cluster_count'],
      ...ds.warehouses.map(w => [w.name, w.size, w.autoSuspend ?? '', w.owner ?? '', w.maxClusters ?? 1])]),
  }
}
