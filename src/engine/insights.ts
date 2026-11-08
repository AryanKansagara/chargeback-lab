import { allocate, filterMonth, isPseudo, type Allocation } from './allocate.ts'
import { dayOf } from './csv.ts'
import { resolve } from './rules.ts'
import type { Config, Dataset, IdleMethod, WarehouseInfo } from './types.ts'

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ---------- Warehouse sizes ----------

export const SIZES = ['XSMALL', 'SMALL', 'MEDIUM', 'LARGE', 'XLARGE', 'XXLARGE', 'XXXLARGE', 'X4LARGE', 'X5LARGE', 'X6LARGE'] as const
export const SIZE_LABEL = ['X-Small', 'Small', 'Medium', 'Large', 'X-Large', '2X-Large', '3X-Large', '4X-Large', '5X-Large', '6X-Large']

/** Index into SIZES for whatever spelling SHOW WAREHOUSES or a person used. -1 if unknown. */
export function sizeIndex(raw: string): number {
  const s = raw.toUpperCase().replace(/[\s_-]/g, '')
  const alias: Record<string, string> = { XS: 'XSMALL', S: 'SMALL', M: 'MEDIUM', L: 'LARGE', XL: 'XLARGE', '2XLARGE': 'XXLARGE', '3XLARGE': 'XXXLARGE', '4XLARGE': 'X4LARGE', '5XLARGE': 'X5LARGE', '6XLARGE': 'X6LARGE', XXL: 'XXLARGE' }
  return SIZES.indexOf((alias[s] ?? s) as (typeof SIZES)[number])
}

/** Credits per hour for a standard warehouse of this size (X-Small = 1, doubling each step). */
export const creditsPerHour = (size: string) => { const i = sizeIndex(size); return i < 0 ? NaN : 2 ** i }

// ---------- Recommendations ----------

export interface Recommendation {
  warehouse: string
  kind: 'auto_suspend' | 'size'
  sql: string
  savingsCredits: number
  savingsUsd: number
  /** Savings scaled to a 30-day month at this period's pattern. */
  monthlyUsd: number
  title: string
  why: string
  assumptions: string[]
}

export const TARGET_SUSPEND = 60

export function recommend(alloc: Allocation, infos: WarehouseInfo[]): Recommendation[] {
  const out: Recommendation[] = []
  const days = Math.max(1, alloc.days.length)
  const scale = 30 / days
  const price = alloc.price
  for (const w of alloc.warehouses) {
    const info = infos.find(i => i.name.toUpperCase() === w.name.toUpperCase())
    if (!info || w.metered <= 0) continue
    const rate = creditsPerHour(info.size)
    const S = info.autoSuspend ?? 0
    let idleAfter = w.idle
    if (w.idle > 0 && (S === 0 || S > TARGET_SUSPEND * 1.5) && w.idlePct > 0.12) {
      let saved: number
      const assumptions = [
        'Workload stays the same: same queries at the same times.',
        `After a burst of queries the warehouse now stays up the full ${S === 0 ? 'hour, every hour' : `${S} seconds`} before suspending; at ${TARGET_SUSPEND} seconds each idle tail is cut to ${TARGET_SUSPEND} seconds.`,
        'Each resume is billed for at least 60 seconds, so tails shorter than that save nothing.',
        'The local disk cache is dropped on suspend, so the first query after a resume can run slower.',
      ]
      if (S === 0) {
        // Never suspends: keep one 60-second tail per active hour, the rest of the idle goes away.
        const keep = Number.isFinite(rate) ? w.activeHours * (TARGET_SUSPEND / 3600) * rate : 0
        saved = Math.max(0, w.idle - keep)
      } else {
        saved = w.idle * (1 - TARGET_SUSPEND / S)
      }
      if (saved > 0.5) {
        idleAfter = w.idle - saved
        out.push({
          warehouse: w.name, kind: 'auto_suspend',
          sql: `ALTER WAREHOUSE ${w.name} SET AUTO_SUSPEND = ${TARGET_SUSPEND};`,
          savingsCredits: saved, savingsUsd: saved * price, monthlyUsd: saved * price * scale,
          title: `${w.name}: auto-suspend ${S === 0 ? 'is off' : `${S}s`} → ${TARGET_SUSPEND}s`,
          why: `${Math.round(w.idlePct * 100)}% of its metered credits were idle${w.idleOnlyHours ? `, including ${w.idleOnlyHours} hours with no queries at all` : ''}.`,
          assumptions,
        })
      }
    }
    const si = sizeIndex(info.size)
    const avgExec = w.queries ? w.execMs / w.queries : Infinity
    const util = w.metered ? w.attributed / w.metered : 1
    if (si >= 2 && avgExec < 2000 && util < 0.45 && (info.maxClusters ?? 1) <= 1 && idleAfter > 0.5) {
      const saved = idleAfter / 2
      out.push({
        warehouse: w.name, kind: 'size',
        sql: `ALTER WAREHOUSE ${w.name} SET WAREHOUSE_SIZE = '${SIZES[si - 1]}';`,
        savingsCredits: saved, savingsUsd: saved * price, monthlyUsd: saved * price * scale,
        title: `${w.name}: ${SIZE_LABEL[si]} → ${SIZE_LABEL[si - 1]}`,
        why: `Queries average ${(avgExec / 1000).toFixed(1)}s and only ${Math.round(util * 100)}% of the warehouse's credits do query work.`,
        assumptions: [
          'Short queries take up to twice as long on half the compute, so query credits stay about the same. The saving comes from idle time, which burns at half the rate.',
          'Idle left after any auto-suspend change above is what gets halved.',
          'Check p95 latency for dashboards before and after; resize back if it hurts.',
        ],
      })
    }
  }
  return out.sort((a, b) => b.savingsCredits - a.savingsCredits)
}

// ---------- Query tag adoption ----------

export interface TagAdoption {
  score: number
  taggedCredits: number
  totalCredits: number
  users: { user: string; untagged: number; share: number; team: string; sql: string }[]
}

export function tagAdoption(ds: Dataset, cfg: Config): TagAdoption {
  let tagged = 0, total = 0
  const users = new Map<string, { untagged: number; total: number; teams: Map<string, number> }>()
  for (const u of ds.usage) {
    const c = u.credits + u.qas
    total += c
    const rec = users.get(u.user) ?? { untagged: 0, total: 0, teams: new Map() }
    rec.total += c
    if (u.tag.trim()) tagged += c
    else {
      rec.untagged += c
      const t = resolve(cfg.rules, u).team
      rec.teams.set(t, (rec.teams.get(t) ?? 0) + c)
    }
    users.set(u.user, rec)
  }
  const list = [...users].filter(([, r]) => r.untagged > 0).map(([user, r]) => {
    const best = [...r.teams].filter(([t]) => !isPseudo(t)).sort((a, b) => b[1] - a[1])[0]
    const team = best?.[0] ?? '<team>'
    // Reuse the tag value an existing rule already maps to this team, so the new tag is picked up immediately.
    const existing = cfg.rules.find(r => !r.disabled && r.field === 'tag_key' && r.key === 'team' && r.op === 'equals' && r.team === team)
    const tag = JSON.stringify({ team: existing?.value || team.toLowerCase().replace(/\s+/g, '-'), source: user.toLowerCase() })
    return { user, untagged: r.untagged, share: r.untagged / (r.total || 1), team, sql: `ALTER USER ${quoteIdent(user)} SET QUERY_TAG = '${tag.replace(/'/g, "''")}';` }
  }).sort((a, b) => b.untagged - a.untagged)
  return { score: total ? tagged / total : 0, taggedCredits: tagged, totalCredits: total, users: list }
}

const quoteIdent = (s: string) => /^[A-Za-z_][A-Za-z0-9_$]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`

// ---------- Budgets ----------

export interface BudgetStatus {
  team: string
  budget: number
  spent: number
  forecast: number
  daysInMonth: number
  daysElapsed: number
  /** Cumulative spend in dollars per day of month (index 0 = day 1); null after the last data day. */
  burn: (number | null)[]
  status: 'over' | 'at-risk' | 'on-track' | 'no-budget'
}

export function budgets(alloc: Allocation, cfg: Config, month: string): BudgetStatus[] {
  const [y, m] = month.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const monthDays = alloc.days.filter(d => d.startsWith(month))
  const last = monthDays.length ? Number(monthDays[monthDays.length - 1].slice(8)) : 0
  return alloc.teams.filter(t => !isPseudo(t.team) || cfg.budgets[t.team]).map(t => {
    const daily = Array.from({ length: daysInMonth }, (_, i) => (t.byDay[`${month}-${String(i + 1).padStart(2, '0')}`] ?? 0) * alloc.price)
    const burn: (number | null)[] = []
    let acc = 0
    for (let i = 0; i < daysInMonth; i++) { acc += daily[i]; burn.push(i < last ? acc : null) }
    const spent = sum(daily.slice(0, last))
    const recent = daily.slice(Math.max(0, last - 7), last)
    const pace = recent.length ? sum(recent) / recent.length : 0
    const forecast = spent + pace * (daysInMonth - last)
    const budget = cfg.budgets[t.team] ?? 0
    const status: BudgetStatus['status'] = !budget ? 'no-budget' : spent > budget ? 'over' : forecast > budget ? 'at-risk' : 'on-track'
    return { team: t.team, budget, spent, forecast, daysInMonth, daysElapsed: last, burn, status }
  })
}

// ---------- Anomalies ----------

export interface Anomaly {
  scope: 'team' | 'warehouse'
  name: string
  day: string
  value: number
  baseline: number
  ratio: number
  /** What moved most that day versus the baseline days. */
  drivers: { label: string; delta: number }[]
}

export const ANOMALY_RATIO = 2
export const ANOMALY_FLOOR = 5

const isWeekend = (day: string) => { const d = new Date(day + 'T00:00:00Z').getUTCDay(); return d === 0 || d === 6 }

/**
 * Flags days at least 2x the median of comparable days in the week before (weekdays against weekdays,
 * weekends against weekends) and at least 5 credits above it. Needs 3 comparable days of history.
 */
export function detectSpikes(series: Record<string, number>, days: string[], ratio = ANOMALY_RATIO, floor = ANOMALY_FLOOR) {
  const out: { day: string; value: number; baseline: number; ratio: number }[] = []
  for (let i = 1; i < days.length; i++) {
    const kind = isWeekend(days[i])
    const prev = days.slice(Math.max(0, i - 7), i).filter(d => isWeekend(d) === kind).map(d => series[d] ?? 0)
    if (prev.length < (kind ? 2 : 3)) continue
    const base = median(prev)
    const v = series[days[i]] ?? 0
    if (v - base >= floor && v >= ratio * Math.max(base, 0.01)) out.push({ day: days[i], value: v, baseline: base, ratio: base > 0 ? v / base : Infinity })
  }
  return out
}

export function anomalies(ds: Dataset, cfg: Config, alloc: Allocation): Anomaly[] {
  const days = alloc.days
  const out: Anomaly[] = []
  const memo = new Map<string, string>()
  const teamOf = (u: Dataset['usage'][number]) => {
    const k = `${u.warehouse}|${u.user}|${u.role}|${u.tag}|${u.database}`
    if (!memo.has(k)) memo.set(k, resolve(cfg.rules, u).team)
    return memo.get(k)!
  }
  const drivers = (keep: (u: Dataset['usage'][number]) => boolean, label: (u: Dataset['usage'][number]) => string, day: string, idleOf: (c: Allocation['cells'][number]) => number) => {
    const i = days.indexOf(day)
    const baseDays = new Set(days.slice(Math.max(0, i - 7), i).filter(d => isWeekend(d) === isWeekend(day)))
    const now = new Map<string, number>(), before = new Map<string, number>()
    for (const u of ds.usage) {
      if (!keep(u)) continue
      const d = dayOf(u.hour)
      if (d === day) now.set(label(u), (now.get(label(u)) ?? 0) + u.credits)
      else if (baseDays.has(d)) before.set(label(u), (before.get(label(u)) ?? 0) + u.credits / Math.max(1, baseDays.size))
    }
    // Idle moves bills too: count it per warehouse from the allocated cells.
    for (const c of alloc.cells) {
      const d = dayOf(c.hour)
      if (d !== day && !baseDays.has(d)) continue
      const v = idleOf(c)
      if (!v) continue
      const l = `idle on ${c.warehouse}`
      if (d === day) now.set(l, (now.get(l) ?? 0) + v)
      else before.set(l, (before.get(l) ?? 0) + v / Math.max(1, baseDays.size))
    }
    return [...new Set([...now.keys(), ...before.keys()])]
      .map(l => ({ label: l, delta: (now.get(l) ?? 0) - (before.get(l) ?? 0) }))
      .filter(d => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3)
  }
  for (const t of alloc.teams) {
    for (const s of detectSpikes(t.byDay, days)) out.push({
      scope: 'team', name: t.team, ...s,
      drivers: drivers(u => teamOf(u) === t.team, u => `${u.user || '(no user)'} on ${u.warehouse}${u.tag ? ` · ${shortTag(u.tag)}` : ''}`, s.day, c => c.idle[t.team] ?? 0),
    })
  }
  for (const w of alloc.warehouses) {
    for (const s of detectSpikes(w.byDay, days)) out.push({
      scope: 'warehouse', name: w.name, ...s,
      drivers: drivers(u => u.warehouse === w.name, u => `${teamOf(u)} · ${u.user || '(no user)'}`, s.day, c => c.warehouse === w.name ? Object.values(c.idle).reduce((a, b) => a + b, 0) : 0),
    })
  }
  return out.sort((a, b) => (b.value - b.baseline) - (a.value - a.baseline))
}

export const shortTag = (tag: string) => tag.length > 48 ? tag.slice(0, 46) + '…' : tag

// ---------- Snapshots and month-over-month ----------

export interface SnapshotTeam {
  team: string
  query: number
  qas: number
  idle: number
  cloud: number
  serverless: number
  total: number
  usd: number
  byWarehouse: Record<string, number>
  byUser: Record<string, number>
}

export interface Snapshot {
  id: string
  label: string
  month: string
  createdAt: number
  method: IdleMethod
  price: number
  billable: number
  residual: number
  teams: SnapshotTeam[]
}

export function snapshotOf(alloc: Allocation, month: string, id: string, label = month): Snapshot {
  return {
    id, label, month, createdAt: Date.now(), method: alloc.method, price: alloc.price,
    billable: alloc.recon.billable, residual: alloc.recon.residual,
    teams: alloc.teams.map(t => ({
      team: t.team, query: t.query, qas: t.qas, idle: t.idle, cloud: t.cloud, serverless: t.serverless, total: t.total, usd: t.usd,
      byWarehouse: Object.fromEntries(Object.entries(t.byWarehouse).map(([w, v]) => [w, v.query + v.idle + v.cloud])),
      byUser: Object.fromEntries(Object.entries(t.byUser).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    })),
  }
}

export interface TeamChange {
  team: string
  before: number
  after: number
  delta: number
  pct: number | null
  usdDelta: number
  parts: { part: 'query' | 'idle' | 'cloud' | 'serverless'; delta: number }[]
  topWarehouse: { name: string; delta: number } | null
  topUser: { name: string; delta: number } | null
  why: string
}

const biggest = (a: Record<string, number>, b: Record<string, number>) => {
  let best: { name: string; delta: number } | null = null
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[k] ?? 0) - (a[k] ?? 0)
    if (!best || Math.abs(d) > Math.abs(best.delta)) best = { name: k, delta: d }
  }
  return best && Math.abs(best.delta) > 1e-9 ? best : null
}

const PART_WORDS = { query: 'query credits', idle: 'idle time', cloud: 'cloud services', serverless: 'serverless' }

export function compare(a: Snapshot, b: Snapshot): TeamChange[] {
  const names = new Set([...a.teams.map(t => t.team), ...b.teams.map(t => t.team)])
  const zero: SnapshotTeam = { team: '', query: 0, qas: 0, idle: 0, cloud: 0, serverless: 0, total: 0, usd: 0, byWarehouse: {}, byUser: {} }
  const out: TeamChange[] = []
  for (const name of names) {
    if (Math.max(a.teams.find(t => t.team === name)?.total ?? 0, b.teams.find(t => t.team === name)?.total ?? 0) < 0.05) continue
    const x = a.teams.find(t => t.team === name) ?? zero
    const y = b.teams.find(t => t.team === name) ?? zero
    const parts = ([
      ['query', y.query + y.qas - x.query - x.qas],
      ['idle', y.idle - x.idle],
      ['cloud', y.cloud - x.cloud],
      ['serverless', y.serverless - x.serverless],
    ] as const).map(([part, delta]) => ({ part, delta })).sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta))
    const delta = y.total - x.total
    const topWarehouse = biggest(x.byWarehouse, y.byWarehouse)
    const topUser = biggest(x.byUser, y.byUser)
    const lead = parts[0]
    const dir = (n: number) => n >= 0 ? 'up' : 'down'
    let why = x.total === 0 ? 'New this month.' : y.total === 0 ? 'No spend this month.' : `Mostly ${PART_WORDS[lead.part]} (${dir(lead.delta)} ${Math.abs(lead.delta).toFixed(1)} cr)`
    if (x.total && y.total && topWarehouse) why += `, led by ${topWarehouse.name} (${topWarehouse.delta >= 0 ? '+' : ''}${topWarehouse.delta.toFixed(1)} cr)`
    if (x.total && y.total && topUser && Math.abs(topUser.delta) > Math.abs(delta) * 0.25) why += `; biggest user change ${topUser.name} (${topUser.delta >= 0 ? '+' : ''}${topUser.delta.toFixed(1)} cr)`
    if (x.total && y.total) why += '.'
    out.push({ team: name, before: x.total, after: y.total, delta, pct: x.total ? delta / x.total : null, usdDelta: y.usd - x.usd, parts, topWarehouse, topUser, why })
  }
  return out.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta))
}

/** Allocate a month and snapshot it in one go. */
export function snapshotMonth(ds: Dataset, cfg: Config, month: string, id: string, label = month): Snapshot {
  return snapshotOf(allocate(filterMonth(ds, month), cfg), month, id, label)
}
