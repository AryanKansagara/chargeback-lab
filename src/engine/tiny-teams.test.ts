import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allocate, filterMonth, months } from './allocate.ts'
import { compare, snapshotMonth } from './insights.ts'
import { SAMPLES, generate, sampleConfig } from './sample.ts'
import { UNMAPPED, type Config, type Dataset, type IdleMethod, type UsageRow } from './types.ts'

const H = Date.UTC(2026, 9, 1, 10)
const METHODS: IdleMethod[] = ['credits', 'exec', 'even', 'owner']
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const u = (p: Partial<UsageRow>): UsageRow => ({ hour: H, warehouse: 'WH', user: 'U', role: 'R', tag: '', database: 'DB', credits: 0, qas: 0, execMs: 100, queries: 1, cloud: 0, ...p })
const cfg = (p: Partial<Config> = {}): Config => ({ rules: [{ id: '1', field: 'user', op: 'any', value: '', team: '', useValue: true }], idleMethod: 'credits', pricePerCredit: 3, owners: {}, budgets: {}, carryHours: 2, ...p })
const ds = (p: Partial<Dataset>): Dataset => ({ meter: [], usage: [], daily: [], warehouses: [], ...p })
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** The invariants every allocation must keep, for any idle method: what is shown is what was allocated, and it ties to the bill. */
function assertAdds(a: ReturnType<typeof allocate>, label: string) {
  close(sum(a.teams.map(t => t.total)), a.recon.allocated, 1e-6)
  close(a.recon.allocated + a.recon.residual, a.recon.billable, 1e-6)
  assert.ok(Math.abs(sum(a.teams.map(t => t.usd)) - a.recon.allocated * a.price) < 1e-6, `${label}: usd`)
}

const hundredTiny = (credits = 0.04) => ds({
  meter: [{ hour: H, warehouse: 'WH', compute: 100 * credits, cloud: 0 }],
  usage: Array.from({ length: 100 }, (_, i) => u({ user: `team${i}`, credits })),
})

test('100 teams at 0.04 credits each are all kept, and the rows add up to the bill', () => {
  for (const idleMethod of METHODS) {
    const a = allocate(hundredTiny(), cfg({ idleMethod, owners: { WH: 'team0' } }))
    assert.equal(a.teams.length, 100, idleMethod)
    close(a.recon.allocated, 4, 1e-9)
    close(a.recon.residual, 0, 1e-9)
    assertAdds(a, idleMethod)
  }
})

test('teams are kept with idle and cloud credits that put them under or over the old 0.05 cut-off', () => {
  // 0.04 query credits plus a share of idle takes a team from below to above 0.05, and a 0.01 team stays below it.
  const data = ds({
    meter: [{ hour: H, warehouse: 'WH', compute: 1.2, cloud: 0.1 }],
    usage: [u({ user: 'big', credits: 1 }), u({ user: 'small', credits: 0.04 }), u({ user: 'tiny', credits: 0.01 })],
  })
  for (const idleMethod of METHODS) {
    const a = allocate(data, cfg({ idleMethod, owners: { WH: 'big' } }))
    assert.deepEqual(new Set(a.teams.map(t => t.team)), new Set(['big', 'small', 'tiny']), idleMethod)
    assertAdds(a, idleMethod)
  }
})

test('teams still come out largest first, and a team with no credits at all is still left out', () => {
  const data = ds({
    meter: [{ hour: H, warehouse: 'WH', compute: 1, cloud: 0 }],
    usage: [u({ user: 'a', credits: 0.001 }), u({ user: 'b', credits: 0.5 }), u({ user: 'zero', credits: 0, queries: 3 }), u({ user: 'c', credits: 0.049 })],
  })
  const a = allocate(data, cfg())
  assert.deepEqual(a.teams.map(t => t.team), ['b', 'c', 'a'])
  assertAdds(a, 'order')
})

test('unmapped spend under 0.05 credits is still listed under "Fix these first"', () => {
  const data = ds({
    meter: [{ hour: H, warehouse: 'WH', compute: 0.04, cloud: 0 }],
    usage: [u({ user: 'nobody', credits: 0.04 })],
  })
  const a = allocate(data, cfg({ rules: [{ id: '1', field: 'user', op: 'equals', value: 'SOMEONE_ELSE', team: 'X' }] }))
  assert.deepEqual(a.teams.map(t => [t.team, t.total]), [[UNMAPPED, 0.04]])
  assert.equal(a.fixes.length, 1)
  assert.equal(a.fixes[0].kind, 'query')
  close(a.fixes[0].credits, 0.04)
  assertAdds(a, 'fixes')
})

test('unassigned idle under 0.05 credits is listed under "Fix these first"', () => {
  const a = allocate(ds({ meter: [{ hour: H, warehouse: 'WH', compute: 0.03, cloud: 0 }] }), cfg())
  assert.deepEqual(a.teams.map(t => t.team), ['Unassigned idle'])
  assert.deepEqual(a.fixes.map(f => [f.kind, f.subject.warehouse]), [['idle', 'WH']])
})

test('serverless spend under 0.05 credits is kept on its team and unmapped serverless is listed', () => {
  const data = ds({ daily: [{ day: '2026-10-01', service: 'PIPE', compute: 0, cloud: 0, adjustment: 0, billed: 0.03 }] })
  const a = allocate(data, cfg({ rules: [] }))
  assert.deepEqual(a.teams.map(t => [t.team, t.total]), [[UNMAPPED, 0.03]])
  assert.deepEqual(a.fixes.map(f => f.kind), ['serverless'])
  assertAdds(a, 'serverless')
})

test('the compare view keeps teams that are small in both months', () => {
  const snap = (m: string, credits: number) => snapshotMonth(ds({
    meter: [{ hour: Date.parse(`${m}-01T10:00:00Z`), warehouse: 'WH', compute: credits, cloud: 0 }],
    usage: [u({ hour: Date.parse(`${m}-01T10:00:00Z`), user: 'tiny', credits })],
  }), cfg(), m, m)
  const changes = compare(snap('2026-09', 0.02), snap('2026-10', 0.04))
  assert.equal(changes.length, 1)
  assert.equal(changes[0].team, 'tiny')
  close(changes[0].delta, 0.02)
})

test('sample accounts: every idle method and month adds up, and no team is hidden', () => {
  for (const def of SAMPLES) {
    const data = generate(def)
    for (const idleMethod of METHODS) for (const m of [null, ...months(data)]) {
      const a = allocate(filterMonth(data, m), { ...sampleConfig(def), idleMethod })
      assertAdds(a, `${def.id}/${idleMethod}/${m}`)
      assert.ok(a.teams.every(t => Math.abs(t.total) > 1e-9))
    }
  }
})
