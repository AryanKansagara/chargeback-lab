import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allocate, filterMonth } from './allocate.ts'
import { budgets, compare, snapshotMonth, snapshotOf } from './insights.ts'
import { matchRule, resolve } from './rules.ts'
import { dict, own, put } from './dict.ts'
import { financeCsv } from '../projectData.ts'
import { UNMAPPED, type Config, type Dataset, type IdleMethod, type UsageRow } from './types.ts'

const H = 3600e3
const T = Date.UTC(2026, 9, 1, 10)
const METHODS: IdleMethod[] = ['credits', 'exec', 'even', 'owner']
// Names that exist on Object.prototype, plus ones that are special to objects, arrays and JSON.
const NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '__defineGetter__', 'prototype', 'length', 'then', 'toJSON']
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const u = (p: Partial<UsageRow>): UsageRow => ({ hour: T, warehouse: 'WH', user: 'U', role: 'R', tag: '', database: 'D', credits: 0, qas: 0, execMs: 1000, queries: 1, cloud: 0, ...p })
const byUserName: Config['rules'] = [{ id: '1', field: 'user', op: 'any', value: '', team: '', useValue: true }]
const cfg = (p: Partial<Config> = {}): Config => ({ rules: byUserName, idleMethod: 'credits', pricePerCredit: 3, owners: {}, budgets: {}, carryHours: 6, ...p })

/** Two hours on one warehouse: both teams query and idle is split, cloud services are metered, the second hour is pure idle tail,
 *  and there is query acceleration and serverless spend, so every code path that keys by name is exercised. */
function data(team: string, wh = 'WH'): Dataset {
  return {
    meter: [{ hour: T, warehouse: wh, compute: 2, cloud: 0.5 }, { hour: T + H, warehouse: wh, compute: 1, cloud: 0 }, { hour: T + 5 * H, warehouse: 'OTHER', compute: 1, cloud: 0.2 }],
    usage: [u({ user: team, warehouse: wh, credits: 1, execMs: 3000, qas: 0.1 }), u({ user: 'beta', warehouse: wh, credits: 0.5, execMs: 1000 })],
    daily: [{ day: '2026-10-01', service: 'QUERY_ACCELERATION', compute: 0, cloud: 0, adjustment: 0, billed: 0.3 }, { day: '2026-10-01', service: 'PIPE', compute: 0, cloud: 0, adjustment: 0, billed: 0.4 }],
    warehouses: [],
  }
}

/** Serialise an allocation with one name swapped for an ordinary one; equal output means the name changed nothing but itself. */
const canon = (v: unknown, name: string, plain: string) => norm(JSON.parse(JSON.stringify(v).split(JSON.stringify(name)).join(JSON.stringify(plain))))
/** Warehouses and cells are listed in name order, which a different name changes; compare them in a fixed order. */
function norm(a: { warehouses?: { name: string }[]; cells?: { hour: number; warehouse: string }[] }) {
  a.warehouses?.sort((x, y) => x.name.localeCompare(y.name))
  a.cells?.sort((x, y) => x.hour - y.hour || x.warehouse.localeCompare(y.warehouse))
  // Summing in a different order moves the last bits of a float; round them away.
  return JSON.stringify(a, (_, v) => typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v)
}

function assertAdds(a: ReturnType<typeof allocate>, label: string) {
  close(sum(a.teams.map(t => t.total)), a.recon.allocated, 1e-9)
  close(a.recon.allocated + a.recon.residual, a.recon.billable, 1e-9)
  assert.ok(Math.abs(a.recon.residual) < 1e-9, `${label}: residual ${a.recon.residual}`)
}

test('a team named like an Object.prototype member allocates exactly like an ordinary name, for every idle method', () => {
  for (const name of NAMES) for (const idleMethod of METHODS) {
    const c = cfg({ idleMethod, owners: { WH: 'Platform' } })
    const got = allocate(data(name), c), want = allocate(data('gamma'), c)
    assertAdds(got, `${name}/${idleMethod}`)
    assert.equal(canon(got, name, 'gamma'), norm(JSON.parse(JSON.stringify(want))), `${name}/${idleMethod}`)
    assert.ok(got.teams.some(t => t.team === name), `${name} has a row`)
  }
})

test('the exact cases from the issue: constructor and toString keep their cloud credits, __proto__ keeps its own idle and cloud share', () => {
  const ds = { meter: [{ hour: T, warehouse: 'WH', compute: 2, cloud: 0.5 }], usage: [u({ user: 'X', credits: 1 }), u({ user: 'beta', credits: 0.5 })], daily: [], warehouses: [] }
  for (const name of ['__proto__', 'constructor', 'toString']) {
    const a = allocate({ ...ds, usage: [u({ user: name, credits: 1 }), u({ user: 'beta', credits: 0.5 })] }, cfg())
    assertAdds(a, name)
    const x = a.teams.find(t => t.team === name)!, beta = a.teams.find(t => t.team === 'beta')!
    close(x.total, 1.5333333333333332, 1e-9)
    close(beta.total, 0.7666666666666667, 1e-9)
    close(a.recon.billable, 2.3, 1e-9)
  }
})

test('warehouses named like Object.prototype members: owners, idle, cloud and the per-team maps', () => {
  for (const wh of NAMES) for (const idleMethod of METHODS) {
    const c = cfg({ idleMethod, owners: { [wh]: 'Platform' } })
    const got = allocate(data('alpha', wh), c), want = allocate(data('alpha', 'WH2'), { ...c, owners: { WH2: 'Platform' } })
    assertAdds(got, `${wh}/${idleMethod}`)
    assert.equal(canon(got, wh, 'WH2'), norm(JSON.parse(JSON.stringify(want))), `${wh}/${idleMethod}`)
  }
})

test('a warehouse with no owner is not given an inherited one', () => {
  for (const wh of NAMES) {
    const a = allocate(data('alpha', wh), cfg({ idleMethod: 'owner', owners: {} }))
    assertAdds(a, wh)
    assert.ok(a.teams.some(t => t.team === 'Unassigned idle'), wh)
  }
})

test('user names like constructor and __proto__ keep their own credits in the per-user breakdown', () => {
  for (const user of NAMES) {
    const ds = data('alpha')
    ds.usage = [u({ user, credits: 1 }), u({ user: 'beta', credits: 0.5 })]
    const rules: Config['rules'] = [{ id: '1', field: 'user', op: 'any', value: '', team: 'Everyone' }]
    const a = allocate(ds, cfg({ rules }))
    const t = a.teams.find(x => x.team === 'Everyone')!
    close(own(t.byUser, user) ?? NaN, 1)
    close(own(t.byUser, 'beta') ?? NaN, 0.5)
    assertAdds(a, user)
  }
})

test('the empty string is not a team', () => {
  const ds = data('alpha')
  ds.usage = [u({ user: '', credits: 1 }), u({ user: 'beta', credits: 0.5 })]
  const a = allocate(ds, cfg())
  assertAdds(a, 'empty user')
  assert.ok(a.teams.some(t => t.team === UNMAPPED))
  assert.ok(!a.teams.some(t => t.team === ''))
  assert.ok(a.fixes.some(f => f.kind === 'query'))
  const empty: Config['rules'] = [{ id: '1', field: 'user', op: 'any', value: '', team: '' }, ...byUserName]
  assert.equal(resolve(empty, { user: 'beta' }).team, 'beta')
  assert.equal(allocate(data('alpha'), cfg({ owners: { WH: '  ' }, idleMethod: 'owner' })).teams.some(t => t.team === ''), false)
})

test('tag-key rules read only the tag\'s own keys', () => {
  const rule = (key: string): Config['rules'][number] => ({ id: 'k', field: 'tag_key', key, op: 'any', value: '', team: '', useValue: true })
  for (const key of NAMES) {
    // The tag has no such key: no match, never a function or object turned into a team name.
    assert.equal(matchRule(rule(key), { tag: '{"team":"growth"}' }), null, key)
  }
  // A real key with a special name does match, including "__proto__", which JSON.parse keeps as an ordinary key.
  assert.equal(matchRule(rule('__proto__'), { tag: '{"__proto__":"growth"}' }), 'growth')
  assert.equal(matchRule(rule('constructor'), { tag: '{"constructor":"ops"}' }), 'ops')
  assert.equal(matchRule(rule('a.constructor'), { tag: '{"a":{"constructor":"deep"}}' }), 'deep')
  assert.equal(matchRule(rule('a.toString'), { tag: '{"a":{}}' }), null)
})

test('budgets: only a budget that was set counts, and a team named constructor can have one', () => {
  for (const name of NAMES) {
    const a = allocate(data(name), cfg())
    const month = '2026-10'
    const none = budgets(a, cfg({ budgets: {} }), month)
    assert.ok(none.every(b => b.budget === 0 && b.status === 'no-budget'), name)
    const budgetsWithOne = dict<number>(); put(budgetsWithOne, name, 100)
    const withOne = budgets(a, cfg({ budgets: { ...budgetsWithOne } }), month)
    assert.equal(withOne.find(b => b.team === name)!.budget, 100, name)
    assert.equal(withOne.find(b => b.team === 'beta')!.budget, 0, name)
    // Budgets that came back from JSON keep the key, too.
    const parsed = JSON.parse(JSON.stringify({ ...budgetsWithOne })) as Record<string, number>
    assert.equal(budgets(a, cfg({ budgets: parsed }), month).find(b => b.team === name)!.budget, 100, name)
  }
})

test('snapshots, JSON round trips, structured clones, compare and the finance CSV keep special names', () => {
  for (const name of NAMES) {
    const c = cfg()
    const snap = (d: Dataset, id: string) => snapshotMonth(d, c, '2026-10', id)
    const a = snap(data(name), 'a'), b = snap({ ...data(name), usage: data(name).usage.map(r => r.user === name ? { ...r, credits: 2 } : r) }, 'b')
    for (const copy of [JSON.parse(JSON.stringify(a)), structuredClone(a)]) {
      assert.equal(copy.teams.find((t: { team: string }) => t.team === name).total, a.teams.find(t => t.team === name)!.total)
      assert.equal(own(copy.teams.find((t: { team: string }) => t.team === name).byUser, name), own(a.teams.find(t => t.team === name)!.byUser, name))
      assert.equal(own(copy.teams.find((t: { team: string }) => t.team === name).byWarehouse, 'WH'), own(a.teams.find(t => t.team === name)!.byWarehouse, 'WH'))
    }
    const via = compare(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
    const direct = compare(a, b)
    assert.equal(JSON.stringify(via), JSON.stringify(direct), name)
    const ch = direct.find(x => x.team === name)!
    assert.equal(ch.topUser?.name, name)
    close(ch.topUser!.delta, 1)
    assert.ok(ch.delta > 0 && Number.isFinite(ch.pct ?? 0), name)
    assert.ok(direct.every(x => Number.isFinite(x.delta) && x.parts.every(p => Number.isFinite(p.delta))), name)
    const al = allocate(filterMonth(data(name), '2026-10'), c)
    const csv = financeCsv(al, '2026-10').split('\n').slice(1).filter(Boolean).map(l => l.split(','))
    assert.ok(csv.some(r => r[1] === name), name)
    close(sum(csv.map(r => Number(r[7]))), al.recon.allocated, 0.01)
    assert.ok(snapshotOf(al, '2026-10', 'x').teams.some(t => t.team === name))
  }
})

test('an old snapshot saved before this fix (plain objects, own __proto__ key) still compares correctly', () => {
  const old = JSON.parse('{"id":"o","label":"Old","month":"2026-09","createdAt":0,"method":"credits","price":3,"billable":10,"residual":0,"teams":[{"team":"X","query":5,"qas":0,"idle":1,"cloud":0,"serverless":0,"total":6,"usd":18,"byWarehouse":{"__proto__":6},"byUser":{"__proto__":6,"constructor":0}}]}')
  const now = snapshotMonth(data('X'), cfg(), '2026-10', 'n')
  const changes = compare(old, now)
  assert.ok(changes.every(c => Number.isFinite(c.delta)))
  assert.deepEqual(changes.find(c => c.team === 'X')!.topWarehouse?.name, '__proto__')
})
