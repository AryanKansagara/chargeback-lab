import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allocate, filterMonth, months } from './allocate.ts'
import { SAMPLES, generate, sampleConfig } from './sample.ts'
import { UNASSIGNED, type Config, type Dataset, type IdleMethod, type UsageRow } from './types.ts'

const H = 3600e3
const METHODS: IdleMethod[] = ['credits', 'exec', 'even', 'owner']
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const u = (hour: number, user: string, credits: number, p: Partial<UsageRow> = {}): UsageRow => ({ hour, warehouse: 'WH', user, role: 'R', tag: '', database: 'D', credits, qas: 0, execMs: 100, queries: 1, cloud: 0, ...p })
const m = (hour: number, compute: number, warehouse = 'WH', cloud = 0) => ({ hour, warehouse, compute, cloud })
const cfg = (p: Partial<Config> = {}): Config => ({ rules: [{ id: '1', field: 'user', op: 'any', value: '', team: '', useValue: true }], idleMethod: 'credits', pricePerCredit: 3, owners: {}, budgets: {}, carryHours: 6, ...p })
const ds = (p: Partial<Dataset>): Dataset => ({ meter: [], usage: [], daily: [], warehouses: [], ...p })
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const totals = (a: ReturnType<typeof allocate>) => Object.fromEntries(a.teams.map(t => [t.team, t.total]))

/** Allocate each month on its own: the per-team totals must add up to the all-months allocation. */
function assertMonthsAddUp(data: Dataset, c: Config, label: string) {
  const all = allocate(data, c)
  const perMonth = months(data).map(mo => allocate(filterMonth(data, mo), c))
  const summed: Record<string, number> = {}
  for (const a of perMonth) for (const t of a.teams) summed[t.team] = (summed[t.team] ?? 0) + t.total
  const want = totals(all)
  for (const team of new Set([...Object.keys(summed), ...Object.keys(want)])) close(summed[team] ?? 0, want[team] ?? 0, 1e-6)
  close(sum(perMonth.map(a => a.recon.billable)), all.recon.billable)
  // Each month on its own still adds up, and the context rows are never counted in it.
  for (const a of perMonth) { close(sum(a.teams.map(t => t.total)), a.recon.allocated); close(a.recon.allocated + a.recon.residual, a.recon.billable) }
  void label
}

// Alpha's last query is 31 Oct 23:00 UTC; 1 Nov 00:00 and 01:00 are idle tail.
const t0 = Date.UTC(2026, 9, 31, 22)
const boundary = () => ds({
  meter: [m(t0 + H, 2), m(t0 + 2 * H, 1), m(t0 + 3 * H, 0.5)],
  usage: [u(t0 + H, 'alpha', 1)],
})

test('an idle tail at the start of a month goes to the team that was active at the end of the last one', () => {
  const data = boundary()
  assert.deepEqual(totals(allocate(data, cfg())), { alpha: 3.5 })
  const nov = allocate(filterMonth(data, '2026-11'), cfg())
  assert.deepEqual(totals(nov), { alpha: 1.5 })
  close(nov.recon.billable, 1.5)
  assert.deepEqual(nov.fixes, [])
  assert.ok(!nov.teams.some(t => t.team === UNASSIGNED))
  const oct = allocate(filterMonth(data, '2026-10'), cfg())
  assert.deepEqual(totals(oct), { alpha: 2 })
})

test('the previous hours are context only: their credits are not counted in the month', () => {
  const nov = allocate(filterMonth(boundary(), '2026-11'), cfg())
  close(nov.recon.meteredCompute, 1.5)
  close(nov.teams[0].query, 0)
  close(nov.teams[0].idle, 1.5)
  assert.equal(nov.warehouses[0].queries, 0)
  assert.equal(nov.warehouses[0].activeHours, 0)
  assert.equal(allocate(filterMonth(boundary(), '2026-11'), cfg()).cells.some(c => c.hour < Date.UTC(2026, 10, 1)), false)
})

test('the carry window still applies across the boundary', () => {
  const data = boundary()
  // 2 hours: 00:00 and 01:00 are inside it (1h and 2h after the last active hour), 02:00 is not.
  const wide = ds({ ...data, meter: [...data.meter, m(t0 + 4 * H, 0.25)] })
  const nov = allocate(filterMonth(wide, '2026-11'), cfg({ carryHours: 2 }))
  assert.deepEqual(totals(nov), { alpha: 1.5, [UNASSIGNED]: 0.25 })
  assert.deepEqual(totals(allocate(filterMonth(data, '2026-11'), cfg({ carryHours: 1 }))), { alpha: 1, [UNASSIGNED]: 0.5 })
})

test('carryHours 0 does not carry across the boundary, matching all months', () => {
  const data = boundary()
  const c = cfg({ carryHours: 0 })
  assert.deepEqual(totals(allocate(data, c)), { alpha: 2, [UNASSIGNED]: 1.5 })
  assert.deepEqual(totals(allocate(filterMonth(data, '2026-11'), c)), { [UNASSIGNED]: 1.5 })
  assertMonthsAddUp(data, c, 'carry 0')
})

test('a month with no earlier data behaves exactly as before', () => {
  const data = ds({ meter: [m(Date.UTC(2026, 10, 1, 0), 1)], usage: [] })
  assert.deepEqual(totals(allocate(filterMonth(data, '2026-11'), cfg())), { [UNASSIGNED]: 1 })
  const first = ds({ meter: [m(Date.UTC(2026, 10, 1, 1), 1)], usage: [u(Date.UTC(2026, 10, 1, 0), 'alpha', 1)] })
  assertMonthsAddUp(first, cfg(), 'first month')
})

test('year boundary: December to January', () => {
  const dec = Date.UTC(2026, 11, 31, 23)
  const data = ds({ meter: [m(dec, 2), m(dec + H, 1)], usage: [u(dec, 'alpha', 1), u(dec, 'beta', 1)] })
  for (const idleMethod of METHODS) assertMonthsAddUp(data, cfg({ idleMethod, owners: { WH: 'beta' } }), idleMethod)
  const jan = allocate(filterMonth(data, '2027-01'), cfg())
  assert.deepEqual(totals(jan), { alpha: 0.5, beta: 0.5 })
})

test('a tail after a month with no queries on that warehouse in its last hours falls back as before', () => {
  // The last active hour is more than carryHours before the month starts: nothing to carry.
  const data = ds({ meter: [m(t0 - 20 * H, 1), m(t0 + 2 * H, 1)], usage: [u(t0 - 20 * H, 'alpha', 1)] })
  assert.deepEqual(totals(allocate(filterMonth(data, '2026-11'), cfg())), { [UNASSIGNED]: 1 })
  assert.deepEqual(totals(allocate(data, cfg())), { alpha: 1, [UNASSIGNED]: 1 })
})

test('several warehouses keep their own last active team', () => {
  const data = ds({
    meter: [m(t0 + H, 2, 'A'), m(t0 + H, 2, 'B'), m(t0 + 2 * H, 1, 'A'), m(t0 + 2 * H, 1, 'B'), m(t0 + 2 * H, 1, 'C')],
    usage: [u(t0 + H, 'alpha', 1, { warehouse: 'A' }), u(t0 + H, 'beta', 1, { warehouse: 'B' })],
  })
  const nov = allocate(filterMonth(data, '2026-11'), cfg())
  assert.deepEqual(totals(nov), { alpha: 1, beta: 1, [UNASSIGNED]: 1 })
  assert.deepEqual(nov.fixes.map(f => f.subject.warehouse), ['C'])
  for (const idleMethod of METHODS) assertMonthsAddUp(data, cfg({ idleMethod }), idleMethod)
})

test('every idle method: months add up to all months for one warehouse with several teams', () => {
  const rows = [u(t0 + H, 'alpha', 1, { execMs: 3000 }), u(t0 + H, 'beta', 0.5, { execMs: 1500 }), u(t0 - 5 * H, 'gamma', 2)]
  const data = ds({ meter: [m(t0 - 5 * H, 3), m(t0 + H, 3), m(t0 + 2 * H, 1.2, 'WH', 0.1), m(t0 + 3 * H, 0.8), m(t0 + 40 * H, 1)], usage: rows })
  for (const idleMethod of METHODS) for (const carryHours of [0, 1, 2, 6, 48]) {
    assertMonthsAddUp(data, cfg({ idleMethod, carryHours, owners: { WH: 'gamma' } }), `${idleMethod}/${carryHours}`)
  }
})

test('sample accounts: per-team totals of the months add up to all months, for every idle method', () => {
  for (const def of SAMPLES) {
    const data = generate(def)
    for (const idleMethod of METHODS) for (const carryHours of [0, 2, 12]) {
      assertMonthsAddUp(data, { ...sampleConfig(def), idleMethod, carryHours }, `${def.id}/${idleMethod}/${carryHours}`)
    }
  }
})

test('a month slice with no earlier data carries no context', () => {
  const data = generate(SAMPLES[0])
  const first = months(data)[0]
  assert.equal(filterMonth(data, first).before, undefined)
  assert.ok(filterMonth(data, months(data)[1]).before)
})
