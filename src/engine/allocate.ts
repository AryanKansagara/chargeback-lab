import { dayOf, HOUR } from './csv.ts'
import { resolve, type Subject } from './rules.ts'
import { UNASSIGNED, UNMAPPED, type Config, type Dataset, type IdleMethod, type UsageRow } from './types.ts'

export interface TeamTotal {
  team: string
  query: number
  qas: number
  idle: number
  cloud: number
  serverless: number
  total: number
  usd: number
  byWarehouse: Record<string, { query: number; idle: number; cloud: number }>
  byDay: Record<string, number>
  byUser: Record<string, number>
  byService: Record<string, number>
}

export interface WarehouseTotal {
  name: string
  metered: number
  attributed: number
  idle: number
  over: number
  unmetered: number
  idlePct: number
  cloud: number
  idleByTeam: Record<string, number>
  activeHours: number
  idleOnlyHours: number
  meteredHours: number
  queries: number
  execMs: number
  byDay: Record<string, number>
}

export interface Cell {
  warehouse: string
  hour: number
  metered: number
  query: Record<string, number>
  idle: Record<string, number>
  /** How the idle in this cell was placed. */
  how: 'split' | 'carried' | 'owner' | 'unassigned' | 'none'
}

export interface FixItem {
  kind: 'query' | 'serverless' | 'idle'
  subject: Subject
  credits: number
  queries: number
}

export interface Reconciliation {
  meteredCompute: number
  meteredCloud: number
  cloudAdjustment: number
  cloudEstimated: boolean
  serverless: number
  billable: number
  allocated: number
  residual: number
  /** Query credits in hours with no metering row (usually view latency). */
  unmetered: number
  /** Query credits above what the warehouse metered for that hour. */
  over: number
  /** CREDITS_ATTRIBUTED_COMPUTE_QUERIES from metering vs the uploaded query rows. */
  attributedCheck: { metering: number; queries: number } | null
}

export interface Allocation {
  teams: TeamTotal[]
  warehouses: WarehouseTotal[]
  cells: Cell[]
  fixes: FixItem[]
  recon: Reconciliation
  days: string[]
  price: number
  method: IdleMethod
}

const WAREHOUSE_SERVICES = new Set(['WAREHOUSE_METERING', 'WAREHOUSE_METERING_READER'])
const add = (o: Record<string, number>, k: string, v: number) => { if (v) o[k] = (o[k] ?? 0) + v }
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)

interface Agg { credits: number; qas: number; exec: number; cloud: number; queries: number }

/** Spreads amount across keys by weight. Weights must have a positive sum. */
export function split(amount: number, weights: Record<string, number>): Record<string, number> {
  const total = sum(weights)
  const out: Record<string, number> = {}
  for (const [k, w] of Object.entries(weights)) if (w > 0) out[k] = (amount * w) / total
  return out
}

/** The weights each idle-split method uses for one warehouse-hour. Empty means nobody to charge. */
export function idleWeights(method: IdleMethod, teams: Map<string, Agg>, owner: string | undefined): Record<string, number> {
  const w: Record<string, number> = {}
  if (method === 'owner') { if (owner) w[owner] = 1; return w }
  for (const [team, a] of teams) {
    if (method === 'credits') w[team] = a.credits
    else if (method === 'exec') w[team] = a.exec
    else if (a.credits > 0 || a.queries > 0) w[team] = 1
  }
  // Execution time can be missing from an export; fall back to credits rather than dropping the hour.
  if (method === 'exec' && sum(w) <= 0) for (const [team, a] of teams) w[team] = a.credits
  for (const k of Object.keys(w)) if (!(w[k] > 0)) delete w[k]
  return w
}

export function months(ds: Dataset): string[] {
  const set = new Set<string>()
  for (const m of ds.meter) set.add(new Date(m.hour).toISOString().slice(0, 7))
  for (const u of ds.usage) set.add(new Date(u.hour).toISOString().slice(0, 7))
  for (const d of ds.daily) set.add(d.day.slice(0, 7))
  return [...set].sort()
}

export function filterMonth(ds: Dataset, month: string | null): Dataset {
  if (!month) return ds
  const inMonth = (t: number) => new Date(t).toISOString().startsWith(month)
  return {
    meter: ds.meter.filter(m => inMonth(m.hour)),
    usage: ds.usage.filter(u => inMonth(u.hour)),
    daily: ds.daily.filter(d => d.day.startsWith(month)),
    warehouses: ds.warehouses,
  }
}

export function allocate(ds: Dataset, cfg: Config): Allocation {
  const teamMap = new Map<string, TeamTotal>()
  const team = (name: string): TeamTotal => {
    let t = teamMap.get(name)
    if (!t) teamMap.set(name, t = { team: name, query: 0, qas: 0, idle: 0, cloud: 0, serverless: 0, total: 0, usd: 0, byWarehouse: {}, byDay: {}, byUser: {}, byService: {} })
    return t
  }
  const whMap = new Map<string, WarehouseTotal>()
  const wh = (name: string): WarehouseTotal => {
    let w = whMap.get(name)
    if (!w) whMap.set(name, w = { name, metered: 0, attributed: 0, idle: 0, over: 0, unmetered: 0, idlePct: 0, cloud: 0, idleByTeam: {}, activeHours: 0, idleOnlyHours: 0, meteredHours: 0, queries: 0, execMs: 0, byDay: {} })
    return w
  }
  const byWh = (t: TeamTotal, w: string) => (t.byWarehouse[w] ??= { query: 0, idle: 0, cloud: 0 })

  // 1. Resolve each usage row to a team once per distinct subject.
  const memo = new Map<string, string>()
  const teamOf = (u: UsageRow) => {
    const k = `${u.warehouse}\u0001${u.user}\u0001${u.role}\u0001${u.tag}\u0001${u.database}`
    let t = memo.get(k)
    if (t === undefined) memo.set(k, t = resolve(cfg.rules, u).team)
    return t
  }

  // 2. Group query usage and metering by warehouse-hour.
  const usageCells = new Map<string, Map<string, Agg>>()
  const fixMap = new Map<string, FixItem>()
  const qasByDayTeam = new Map<string, Record<string, number>>()
  for (const u of ds.usage) {
    const t = teamOf(u)
    const key = `${u.warehouse}\u0001${u.hour}`
    let cell = usageCells.get(key)
    if (!cell) usageCells.set(key, cell = new Map())
    let a = cell.get(t)
    if (!a) cell.set(t, a = { credits: 0, qas: 0, exec: 0, cloud: 0, queries: 0 })
    a.credits += u.credits; a.qas += u.qas; a.exec += u.execMs; a.cloud += u.cloud; a.queries += u.queries
    if (u.qas) { const d = dayOf(u.hour); const rec = qasByDayTeam.get(d) ?? {}; add(rec, t, u.qas); qasByDayTeam.set(d, rec) }
    const tt = team(t)
    add(tt.byUser, u.user || '(no user)', u.credits + u.qas)
    const w = wh(u.warehouse)
    w.queries += u.queries; w.execMs += u.execMs
    if (t === UNMAPPED) {
      const fk = `q\u0001${u.warehouse}\u0001${u.user}\u0001${u.role}\u0001${u.tag}\u0001${u.database}`
      const f = fixMap.get(fk) ?? { kind: 'query', subject: { warehouse: u.warehouse, user: u.user, role: u.role, tag: u.tag, database: u.database }, credits: 0, queries: 0 }
      f.credits += u.credits + u.qas; f.queries += u.queries
      fixMap.set(fk, f)
    }
  }
  const meterCells = new Map<string, { compute: number; cloud: number; attributed?: number }>()
  let attrMetering = 0
  let attrSeen = false
  for (const m of ds.meter) {
    const key = `${m.warehouse}\u0001${m.hour}`
    const c = meterCells.get(key) ?? { compute: 0, cloud: 0 }
    c.compute += m.compute; c.cloud += m.cloud
    if (m.attributed !== undefined) { attrMetering += m.attributed; attrSeen = true }
    meterCells.set(key, c)
  }

  // 3. Walk every warehouse-hour in time order so pure-idle hours can inherit the last active split.
  const keys = new Set([...usageCells.keys(), ...meterCells.keys()])
  const perWh = new Map<string, number[]>()
  for (const k of keys) {
    const [w, h] = k.split('\u0001')
    const list = perWh.get(w) ?? []
    list.push(Number(h))
    perWh.set(w, list)
  }

  const cells: Cell[] = []
  const rawCloudByDay = new Map<string, Record<string, number>>()
  const computeByDay = new Map<string, number>()
  const idleFix = new Map<string, number>()
  let meteredCompute = 0, meteredCloud = 0, unmeteredTotal = 0, overTotal = 0, queriesTotal = 0

  for (const [w, hours] of [...perWh].sort((a, b) => a[0].localeCompare(b[0]))) {
    hours.sort((a, b) => a - b)
    const W = wh(w)
    const owner = cfg.owners[w]?.trim() || undefined
    let lastActive: { hour: number; weights: Record<string, number> } | null = null
    for (const hour of hours) {
      const key = `${w}\u0001${hour}`
      const usage = usageCells.get(key) ?? new Map<string, Agg>()
      const meter = meterCells.get(key)
      const M = meter?.compute ?? 0
      const day = dayOf(hour)
      let A = 0
      for (const a of usage.values()) A += a.credits
      queriesTotal += A
      const cell: Cell = { warehouse: w, hour, metered: M, query: {}, idle: {}, how: 'none' }

      for (const [t, a] of usage) {
        if (a.credits <= 0 && a.qas <= 0) continue
        const T = team(t)
        T.query += a.credits
        byWh(T, w).query += a.credits
        add(T.byDay, day, a.credits)
        add(cell.query, t, a.credits)
      }
      if (meter) {
        meteredCompute += M
        W.metered += M
        W.meteredHours++
        add(W.byDay, day, M)
        computeByDay.set(day, (computeByDay.get(day) ?? 0) + M)
        if (A > M) { W.over += A - M; overTotal += A - M }
      } else if (A > 0) {
        W.unmetered += A
        unmeteredTotal += A
      }
      if (meter) W.attributed += Math.min(A, M)
      if (A > 0) W.activeHours++
      else if (M > 0) W.idleOnlyHours++

      // Idle: metered compute that no query was charged for.
      const I = meter ? Math.max(0, M - A) : 0
      let weights = idleWeights(cfg.idleMethod, usage, owner)
      if (A > 0 && cfg.idleMethod !== 'owner') lastActive = { hour, weights }
      if (I > 0) {
        if (Object.keys(weights).length) cell.how = cfg.idleMethod === 'owner' ? 'owner' : 'split'
        else if (cfg.idleMethod !== 'owner' && lastActive && cfg.carryHours > 0 && hour - lastActive.hour <= cfg.carryHours * HOUR) { weights = lastActive.weights; cell.how = 'carried' }
        else if (owner) { weights = { [owner]: 1 }; cell.how = 'owner' }
        else { weights = { [UNASSIGNED]: 1 }; cell.how = 'unassigned' }
        for (const [t, v] of Object.entries(split(I, weights))) {
          const T = team(t)
          T.idle += v
          byWh(T, w).idle += v
          add(T.byDay, day, v)
          add(W.idleByTeam, t, v)
          add(cell.idle, t, v)
        }
        W.idle += I
        if (cell.how === 'unassigned') idleFix.set(w, (idleFix.get(w) ?? 0) + I)
      }

      // Cloud services: split by each team's own cloud services if exported, otherwise by its share of the hour.
      const C = meter?.cloud ?? 0
      if (C > 0) {
        meteredCloud += C
        W.cloud += C
        const cw: Record<string, number> = {}
        for (const [t, a] of usage) if (a.cloud > 0) cw[t] = a.cloud
        if (!Object.keys(cw).length) {
          for (const [t, v] of Object.entries(cell.query)) add(cw, t, v)
          for (const [t, v] of Object.entries(cell.idle)) add(cw, t, v)
        }
        if (!Object.keys(cw).length) cw[owner ?? UNASSIGNED] = 1
        const rec = rawCloudByDay.get(day) ?? {}
        for (const [t, v] of Object.entries(split(C, cw))) { add(rec, `${t}\u0001${w}`, v) }
        rawCloudByDay.set(day, rec)
      }
      cells.push(cell)
    }
  }

  // 4. The daily cloud services adjustment: only cloud services above 10% of daily warehouse compute is billed.
  const dailyByDay = new Map<string, typeof ds.daily>()
  for (const d of ds.daily) { const l = dailyByDay.get(d.day) ?? []; l.push(d); dailyByDay.set(d.day, l) }
  let cloudAdjustment = 0
  let cloudEstimated = false
  for (const [day, rec] of rawCloudByDay) {
    const used = sum(rec)
    const wmRows = (dailyByDay.get(day) ?? []).filter(d => WAREHOUSE_SERVICES.has(d.service.toUpperCase()))
    let billed: number
    if (wmRows.length) {
      const cs = wmRows.reduce((a, d) => a + d.cloud, 0)
      const adj = wmRows.reduce((a, d) => a + d.adjustment, 0)
      billed = cs > 0 ? used * Math.max(0, (cs + adj) / cs) : used
    } else {
      cloudEstimated = true
      billed = Math.max(0, used - 0.1 * (computeByDay.get(day) ?? 0))
    }
    const f = used > 0 ? billed / used : 0
    cloudAdjustment += billed - used
    for (const [k, v] of Object.entries(rec)) {
      const [t, w] = k.split('\u0001')
      const T = team(t)
      T.cloud += v * f
      byWh(T, w).cloud += v * f
      add(T.byDay, day, v * f)
    }
  }

  // 5. Serverless and query acceleration from METERING_DAILY_HISTORY.
  let serverless = 0
  const qaDays = new Set<string>()
  for (const d of ds.daily) {
    const svc = d.service.toUpperCase()
    if (WAREHOUSE_SERVICES.has(svc)) continue
    const credits = d.billed
    if (!credits) continue
    serverless += credits
    const teamQas = svc === 'QUERY_ACCELERATION' ? qasByDayTeam.get(d.day) : undefined
    if (teamQas && sum(teamQas) > 0) {
      qaDays.add(d.day)
      for (const [t, v] of Object.entries(split(credits, teamQas))) {
        const T = team(t)
        T.qas += v
        add(T.byDay, d.day, v)
        add(T.byService, svc, v)
      }
      continue
    }
    const t = resolve(cfg.rules, { service: svc }).team
    const T = team(t)
    T.serverless += credits
    add(T.byDay, d.day, credits)
    add(T.byService, svc, credits)
    if (t === UNMAPPED) {
      const fk = `s\u0001${svc}`
      const f = fixMap.get(fk) ?? { kind: 'serverless', subject: { service: svc }, credits: 0, queries: 0 }
      f.credits += credits
      fixMap.set(fk, f)
    }
  }
  // Query acceleration seen per query but not in the daily export: charge it as-is.
  for (const [day, rec] of qasByDayTeam) {
    if (qaDays.has(day)) continue
    for (const [t, v] of Object.entries(rec)) { const T = team(t); T.qas += v; add(T.byDay, day, v) }
    serverless += sum(rec)
  }

  for (const [w, credits] of idleFix) fixMap.set(`i\u0001${w}`, { kind: 'idle', subject: { warehouse: w }, credits, queries: 0 })

  // 6. Totals and reconciliation.
  const price = cfg.pricePerCredit
  let allocated = 0
  for (const t of teamMap.values()) {
    t.total = t.query + t.qas + t.idle + t.cloud + t.serverless
    t.usd = t.total * price
    allocated += t.total
  }
  for (const w of whMap.values()) w.idlePct = w.metered > 0 ? w.idle / w.metered : 0
  const meteredCloudBilled = meteredCloud + cloudAdjustment
  const billable = meteredCompute + meteredCloudBilled + serverless
  const days = [...new Set(cells.map(c => dayOf(c.hour)).concat(ds.daily.map(d => d.day)))].sort()
  const teams = [...teamMap.values()].filter(t => Math.abs(t.total) >= 0.05).sort((a, b) => b.total - a.total)

  return {
    teams,
    warehouses: [...whMap.values()].sort((a, b) => b.metered - a.metered),
    cells,
    fixes: [...fixMap.values()].filter(f => f.credits >= 0.05).sort((a, b) => b.credits - a.credits),
    recon: {
      meteredCompute, meteredCloud, cloudAdjustment, cloudEstimated, serverless, billable, allocated,
      residual: billable - allocated,
      unmetered: unmeteredTotal, over: overTotal,
      attributedCheck: attrSeen ? { metering: attrMetering, queries: queriesTotal } : null,
    },
    days,
    price,
    method: cfg.idleMethod,
  }
}

export const isPseudo = (team: string) => team === UNMAPPED || team === UNASSIGNED
