import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoMap, detectKind, mergeRows, parseCsv, parseTime, toCsv, validate, type Kind } from './csv.ts'
import { matchRule, resolve } from './rules.ts'
import { allocate, filterMonth, idleWeights, months, split } from './allocate.ts'
import { anomalies, budgets, compare, creditsPerHour, detectSpikes, recommend, sizeIndex, snapshotMonth, tagAdoption } from './insights.ts'
import { SAMPLES, generate, sampleConfig, toSnowflakeCsvs } from './sample.ts'
import { financeCsv } from '../projectData.ts'
import { UNASSIGNED, UNMAPPED, type Config, type Dataset, type Rule, type UsageRow } from './types.ts'

const H = Date.UTC(2026, 9, 1, 10)
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const u = (p: Partial<UsageRow>): UsageRow => ({ hour: H, warehouse: 'WH', user: 'U', role: 'R', tag: '', database: 'DB', credits: 0, qas: 0, execMs: 0, queries: 1, cloud: 0, ...p })
const cfg = (p: Partial<Config> = {}): Config => ({ rules: [], idleMethod: 'credits', pricePerCredit: 3, owners: {}, budgets: {}, carryHours: 2, ...p })
const ds = (p: Partial<Dataset>): Dataset => ({ meter: [], usage: [], daily: [], warehouses: [], ...p })
const byUser: Rule[] = [
  { id: 'a', field: 'user', op: 'equals', value: 'ALICE', team: 'Growth' },
  { id: 'b', field: 'user', op: 'equals', value: 'BOB', team: 'Finance' },
]
const team = (a: ReturnType<typeof allocate>, name: string) => a.teams.find(t => t.team === name)

// ---------- CSV ----------

test('parseCsv handles quotes, escaped quotes, embedded newlines and CRLF, with record line numbers', () => {
  const { rows, lines } = parseCsv('A,B\r\n"x, y","say ""hi"""\r\n"multi\nline",2\r\n3,4')
  assert.deepEqual(rows, [['A', 'B'], ['x, y', 'say "hi"'], ['multi\nline', '2'], ['3', '4']])
  assert.deepEqual(lines, [1, 2, 3, 5])
})

test('parseCsv sniffs tab and semicolon delimiters', () => {
  assert.deepEqual(parseCsv('a\tb\n1\t2').rows[1], ['1', '2'])
  assert.deepEqual(parseCsv('a;b\n1;2').rows[1], ['1', '2'])
})

test('parseTime reads Snowsight timestamps with offsets, ISO, and plain dates as UTC', () => {
  assert.equal(parseTime('2026-10-01 07:00:00.000 -0700'), Date.UTC(2026, 9, 1, 14))
  assert.equal(parseTime('2026-10-01T07:00:00Z'), Date.UTC(2026, 9, 1, 7))
  assert.equal(parseTime('2026-10-01 07:30:00 +05:30'), Date.UTC(2026, 9, 1, 2))
  assert.equal(parseTime('2026-10-01'), Date.UTC(2026, 9, 1))
  assert.equal(parseTime('10/1/2026 7:00 PM'), Date.UTC(2026, 9, 1, 19))
  assert.ok(Number.isNaN(parseTime('yesterday')))
})

test('detectKind tells the four exports apart by their columns', () => {
  assert.equal(detectKind(['START_TIME', 'END_TIME', 'WAREHOUSE_ID', 'WAREHOUSE_NAME', 'CREDITS_USED', 'CREDITS_USED_COMPUTE', 'CREDITS_USED_CLOUD_SERVICES', 'CREDITS_ATTRIBUTED_COMPUTE_QUERIES']), 'meter')
  assert.equal(detectKind(['HOUR', 'WAREHOUSE_NAME', 'USER_NAME', 'ROLE_NAME', 'QUERY_TAG', 'CREDITS_ATTRIBUTED_COMPUTE']), 'usage')
  assert.equal(detectKind(['QUERY_ID', 'WAREHOUSE_NAME', 'QUERY_TAG', 'USER_NAME', 'START_TIME', 'END_TIME', 'CREDITS_ATTRIBUTED_COMPUTE', 'CREDITS_USED_QUERY_ACCELERATION']), 'usage')
  assert.equal(detectKind(['SERVICE_TYPE', 'USAGE_DATE', 'CREDITS_USED_COMPUTE', 'CREDITS_USED_CLOUD_SERVICES', 'CREDITS_USED', 'CREDITS_ADJUSTMENT_CLOUD_SERVICES', 'CREDITS_BILLED']), 'daily')
  assert.equal(detectKind(['name', 'state', 'type', 'size', 'auto_suspend', 'owner']), 'warehouses')
  assert.equal(detectKind(['foo', 'bar']), null)
})

test('validate reports bad rows with their line numbers and keeps the good ones', () => {
  const csv = parseCsv('START_TIME,WAREHOUSE_NAME,CREDITS_USED_COMPUTE\n2026-10-01 00:00:00,WH,1.5\nnot a time,WH,1\n2026-10-01 01:00:00,,2\n2026-10-01 02:00:00,WH,abc\n2026-10-01 03:00:00,WH,"1,234.5"')
  const v = validate('meter', csv, autoMap('meter', csv.rows[0]))
  assert.equal(v.rows.length, 2)
  assert.equal(v.skipped, 3)
  assert.deepEqual(v.issues.map(i => i.line), [3, 4, 5])
  assert.equal((v.rows[1] as { compute: number }).compute, 1234.5)
})

test('validate floors timestamps to the hour and defaults a per-query export to one query per row', () => {
  const csv = parseCsv('START_TIME,WAREHOUSE_NAME,CREDITS_ATTRIBUTED_COMPUTE,QUERY_TAG\n2026-10-01 10:41:13.120 +0000,WH,0.25,etl')
  const [row] = validate('usage', csv, autoMap('usage', csv.rows[0])).rows as UsageRow[]
  assert.equal(row.hour, H)
  assert.equal(row.queries, 1)
  assert.equal(row.tag, 'etl')
})

test('a missing required column is a single clear issue', () => {
  const csv = parseCsv('WAREHOUSE_NAME,CREDITS_USED_COMPUTE\nWH,1')
  const v = validate('meter', csv, autoMap('meter', csv.rows[0]))
  assert.equal(v.rows.length, 0)
  assert.match(v.issues[0].message, /Hour start/)
})

test('toCsv quotes fields that need it', () => {
  assert.equal(toCsv([['a', 'b,c'], ['say "x"', 1.5], ['n', 1 / 3]]), 'a,"b,c"\n"say ""x""",1.5\nn,0.333333\n')
})

// ---------- Rules ----------

test('rules match JSON query tag keys, including nested keys, and can use the value as the team', () => {
  const tag = '{"team":"growth","meta":{"cost_center":"CC-42"}}'
  assert.equal(matchRule({ id: '1', field: 'tag_key', key: 'team', op: 'equals', value: 'GROWTH', team: 'Growth' }, { tag }), 'Growth')
  assert.equal(matchRule({ id: '2', field: 'tag_key', key: 'meta.cost_center', op: 'any', value: '', team: '', useValue: true }, { tag }), 'CC-42')
  assert.equal(matchRule({ id: '3', field: 'tag_key', key: 'team', op: 'equals', value: 'growth', team: 'G' }, { tag: 'team=growth' }), null)
})

test('rules support contains, starts with and regex on any field; disabled rules never match', () => {
  assert.equal(matchRule({ id: '1', field: 'query_tag', op: 'contains', value: 'dbt', team: 'DE' }, { tag: 'app=DBT;model=x' }), 'DE')
  assert.equal(matchRule({ id: '2', field: 'role', op: 'starts', value: 'fin', team: 'Finance' }, { role: 'FINANCE_ANALYST' }), 'Finance')
  assert.equal(matchRule({ id: '3', field: 'user', op: 'regex', value: '^svc_(looker|tableau)$', team: 'BI' }, { user: 'SVC_TABLEAU' }), 'BI')
  assert.equal(matchRule({ id: '4', field: 'user', op: 'regex', value: '([', team: 'BI' }, { user: 'x' }), null)
  assert.equal(matchRule({ id: '5', field: 'warehouse', op: 'equals', value: 'WH', team: 'X', disabled: true }, { warehouse: 'WH' }), null)
})

test('the first matching rule wins and nothing matching means Unmapped', () => {
  const rules: Rule[] = [
    { id: '1', field: 'tag_key', key: 'team', op: 'any', value: '', team: '', useValue: true },
    { id: '2', field: 'warehouse', op: 'equals', value: 'BI_WH', team: 'Analytics' },
  ]
  assert.equal(resolve(rules, { tag: '{"team":"finance"}', warehouse: 'BI_WH' }).team, 'finance')
  assert.equal(resolve(rules, { tag: '', warehouse: 'BI_WH' }).team, 'Analytics')
  assert.equal(resolve(rules, { warehouse: 'OTHER' }).team, UNMAPPED)
})

// ---------- Allocation ----------

const twoTeams = ds({
  meter: [{ hour: H, warehouse: 'WH', compute: 10, cloud: 0 }],
  usage: [u({ user: 'ALICE', credits: 3, execMs: 1000 }), u({ user: 'BOB', credits: 1, execMs: 3000 })],
})

test('idle = metered minus attributed, split proportional to query credits', () => {
  const a = allocate(twoTeams, cfg({ rules: byUser }))
  close(team(a, 'Growth')!.idle, 4.5)
  close(team(a, 'Finance')!.idle, 1.5)
  close(a.warehouses[0].idle, 6)
  close(a.warehouses[0].idlePct, 0.6)
})

test('idle split proportional to execution time', () => {
  const a = allocate(twoTeams, cfg({ rules: byUser, idleMethod: 'exec' }))
  close(team(a, 'Growth')!.idle, 1.5)
  close(team(a, 'Finance')!.idle, 4.5)
})

test('idle split evenly among teams active that hour', () => {
  const a = allocate(twoTeams, cfg({ rules: byUser, idleMethod: 'even' }))
  close(team(a, 'Growth')!.idle, 3)
  close(team(a, 'Finance')!.idle, 3)
})

test('idle charged to the warehouse owner, or Unassigned idle when there is no owner', () => {
  const a = allocate(twoTeams, cfg({ rules: byUser, idleMethod: 'owner', owners: { WH: 'Platform' } }))
  close(team(a, 'Platform')!.idle, 6)
  close(team(a, 'Growth')!.total, 3)
  const b = allocate(twoTeams, cfg({ rules: byUser, idleMethod: 'owner' }))
  close(team(b, UNASSIGNED)!.idle, 6)
  assert.equal(b.fixes[0].kind, 'idle')
})

test('execution-time split falls back to credits when an export has no execution time', () => {
  const w = idleWeights('exec', new Map([['A', { credits: 2, qas: 0, exec: 0, cloud: 0, queries: 1 }], ['B', { credits: 6, qas: 0, exec: 0, cloud: 0, queries: 1 }]]), undefined)
  assert.deepEqual(w, { A: 2, B: 6 })
  assert.deepEqual(split(10, w), { A: 2.5, B: 7.5 })
})

test('a pure-idle hour inherits the split of the last active hour within the carry window', () => {
  const d = ds({
    meter: [{ hour: H, warehouse: 'WH', compute: 4, cloud: 0 }, { hour: H + 3600_000, warehouse: 'WH', compute: 2, cloud: 0 }, { hour: H + 5 * 3600_000, warehouse: 'WH', compute: 1, cloud: 0 }],
    usage: [u({ user: 'ALICE', credits: 1 }), u({ user: 'BOB', credits: 3 })],
  })
  const a = allocate(d, cfg({ rules: byUser, owners: { WH: 'Platform' } }))
  close(team(a, 'Growth')!.idle, 0.5)
  close(team(a, 'Finance')!.idle, 1.5)
  // Five hours later is past the 2-hour window, so the owner takes it.
  close(team(a, 'Platform')!.idle, 1)
  assert.deepEqual(a.cells.map(c => c.how), ['none', 'carried', 'owner'])
})

test('unmapped queries are their own bucket and appear in the fix list, biggest first', () => {
  const d = ds({ meter: [{ hour: H, warehouse: 'WH', compute: 5, cloud: 0 }], usage: [u({ user: 'ALICE', credits: 1 }), u({ user: 'MALLORY', credits: 2 }), u({ user: 'EVE', credits: 1 })] })
  const a = allocate(d, cfg({ rules: byUser }))
  close(team(a, UNMAPPED)!.query, 3)
  assert.deepEqual(a.fixes.map(f => f.subject.user), ['MALLORY', 'EVE'])
})

test('reconciliation: every metered credit is allocated when the data lines up', () => {
  const a = allocate(twoTeams, cfg({ rules: byUser }))
  close(a.recon.billable, 10)
  close(a.recon.allocated, 10)
  close(a.recon.residual, 0)
})

test('reconciliation surfaces query credits with no metering row and credits above the meter', () => {
  const d = ds({
    meter: [{ hour: H, warehouse: 'WH', compute: 1, cloud: 0 }],
    usage: [u({ user: 'ALICE', credits: 1.5 }), u({ user: 'ALICE', credits: 2, hour: H + 3600_000 })],
  })
  const a = allocate(d, cfg({ rules: byUser }))
  close(a.recon.over, 0.5)
  close(a.recon.unmetered, 2)
  close(a.recon.residual, -2.5)
})

test('cloud services: the daily adjustment from METERING_DAILY_HISTORY is applied pro rata', () => {
  const d = ds({
    meter: [{ hour: H, warehouse: 'WH', compute: 10, cloud: 2 }],
    usage: [u({ user: 'ALICE', credits: 5, cloud: 1.5 }), u({ user: 'BOB', credits: 5, cloud: 0.5 })],
    daily: [{ day: '2026-10-01', service: 'WAREHOUSE_METERING', compute: 10, cloud: 2, adjustment: -1, billed: 11 }],
  })
  const a = allocate(d, cfg({ rules: byUser }))
  close(team(a, 'Growth')!.cloud, 0.75)
  close(team(a, 'Finance')!.cloud, 0.25)
  close(a.recon.billable, 11)
  close(a.recon.residual, 0)
  assert.equal(a.recon.cloudEstimated, false)
})

test('cloud services: without the daily view, only the part above 10% of compute is billed (estimated)', () => {
  const d = ds({ meter: [{ hour: H, warehouse: 'WH', compute: 10, cloud: 1.5 }], usage: [u({ user: 'ALICE', credits: 10 })] })
  const a = allocate(d, cfg({ rules: byUser }))
  close(team(a, 'Growth')!.cloud, 0.5)
  assert.equal(a.recon.cloudEstimated, true)
})

test('serverless services map through rules; query acceleration follows each team’s QAS usage', () => {
  const d = ds({
    meter: [{ hour: H, warehouse: 'WH', compute: 2, cloud: 0 }],
    usage: [u({ user: 'ALICE', credits: 1, qas: 0.3 }), u({ user: 'BOB', credits: 1, qas: 0.1 })],
    daily: [
      { day: '2026-10-01', service: 'PIPE', compute: 4, cloud: 0, adjustment: 0, billed: 4 },
      { day: '2026-10-01', service: 'AUTO_CLUSTERING', compute: 1, cloud: 0, adjustment: 0, billed: 1 },
      { day: '2026-10-01', service: 'QUERY_ACCELERATION', compute: 0.8, cloud: 0, adjustment: 0, billed: 0.8 },
    ],
  })
  const rules = [...byUser, { id: 's', field: 'service_type', op: 'equals', value: 'PIPE', team: 'Data Eng' } as Rule]
  const a = allocate(d, cfg({ rules }))
  close(team(a, 'Data Eng')!.serverless, 4)
  close(team(a, 'Growth')!.qas, 0.6)
  close(team(a, 'Finance')!.qas, 0.2)
  assert.equal(a.fixes.find(f => f.kind === 'serverless')?.subject.service, 'AUTO_CLUSTERING')
  close(a.recon.residual, 0)
})

test('dollars follow the editable price per credit', () => {
  const a = allocate(twoTeams, cfg({ rules: byUser, pricePerCredit: 2.5 }))
  close(team(a, 'Growth')!.usd, 7.5 * 2.5)
})

test('months and filterMonth slice a multi-month dataset', () => {
  const d = ds({ meter: [{ hour: H, warehouse: 'WH', compute: 1, cloud: 0 }, { hour: Date.UTC(2026, 10, 2), warehouse: 'WH', compute: 1, cloud: 0 }] })
  assert.deepEqual(months(d), ['2026-10', '2026-11'])
  assert.equal(filterMonth(d, '2026-11').meter.length, 1)
})

// ---------- Insights ----------

test('warehouse sizes map to credits per hour across spellings', () => {
  assert.equal(creditsPerHour('X-Small'), 1)
  assert.equal(creditsPerHour('MEDIUM'), 4)
  assert.equal(creditsPerHour('2X-Large'), 32)
  assert.equal(sizeIndex('banana'), -1)
})

test('auto-suspend recommendation: savings scale with the shortened idle tail', () => {
  const d = ds({
    meter: [{ hour: H, warehouse: 'WH', compute: 4, cloud: 0 }],
    usage: [u({ user: 'ALICE', credits: 1, execMs: 60_000, queries: 10 })],
    warehouses: [{ name: 'WH', size: 'Medium', autoSuspend: 600 }],
  })
  const a = allocate(d, cfg({ rules: byUser }))
  const [rec] = recommend(a, d.warehouses).filter(r => r.kind === 'auto_suspend')
  close(rec.savingsCredits, 3 * (1 - 60 / 600))
  assert.equal(rec.sql, 'ALTER WAREHOUSE WH SET AUTO_SUSPEND = 60;')
  assert.ok(rec.assumptions.length >= 3)
})

test('downsizing is only suggested for short queries on an underused warehouse, at half the remaining idle', () => {
  const d = ds({
    meter: [{ hour: H, warehouse: 'WH', compute: 4, cloud: 0 }],
    usage: [u({ user: 'ALICE', credits: 1, execMs: 10_000, queries: 10 })],
    warehouses: [{ name: 'WH', size: 'Medium', autoSuspend: 60 }],
  })
  const recs = recommend(allocate(d, cfg({ rules: byUser })), d.warehouses)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].sql, "ALTER WAREHOUSE WH SET WAREHOUSE_SIZE = 'SMALL';")
  close(recs[0].savingsCredits, 1.5)
  const slow = ds({ ...d, usage: [u({ user: 'ALICE', credits: 1, execMs: 100_000, queries: 10 })] })
  assert.equal(recommend(allocate(slow, cfg({ rules: byUser })), d.warehouses).length, 0)
})

test('query-tag adoption scores tagged credits and writes ALTER USER with escaped JSON', () => {
  const d = ds({ usage: [u({ user: 'ALICE', credits: 3, tag: '{"team":"growth"}' }), u({ user: "O'BRIEN.X", credits: 1 })] })
  const t = tagAdoption(d, cfg({ rules: [{ id: 'x', field: 'database', op: 'equals', value: 'DB', team: 'Data Eng' }] }))
  close(t.score, 0.75)
  assert.equal(t.users.length, 1)
  assert.equal(t.users[0].sql, `ALTER USER "O'BRIEN.X" SET QUERY_TAG = '{"team":"data-eng","source":"o''brien.x"}';`)
})

test('spike detection compares each day to the median of the seven before it', () => {
  const days = Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
  const series = Object.fromEntries(days.map((d, i) => [d, i === 8 ? 40 : 10]))
  const s = detectSpikes(series, days)
  assert.deepEqual(s.map(x => x.day), ['2026-10-09'])
  assert.equal(s[0].baseline, 10)
  // Below the absolute floor: 3 vs 1 is 3x but only 2 credits.
  assert.equal(detectSpikes({ ...series, '2026-10-09': 3, '2026-10-01': 1 }, days.map(d => d)).length, 0)
})

test('budgets: month-end forecast = spend to date + 7-day pace for the remaining days', () => {
  const meter = Array.from({ length: 10 }, (_, i) => ({ hour: Date.UTC(2026, 10, i + 1, 12), warehouse: 'WH', compute: 10, cloud: 0 }))
  const usage = meter.map(m => u({ hour: m.hour, user: 'ALICE', credits: 10 }))
  const c = cfg({ rules: byUser, budgets: { Growth: 800 }, pricePerCredit: 1 })
  const [b] = budgets(allocate(ds({ meter, usage }), c), c, '2026-11')
  assert.equal(b.daysElapsed, 10)
  close(b.spent, 100)
  close(b.forecast, 300)
  assert.equal(b.status, 'on-track')
  assert.equal(b.burn[9], 100)
  assert.equal(b.burn[10], null)
  const [tight] = budgets(allocate(ds({ meter, usage }), { ...c, budgets: { Growth: 250 } }), { ...c, budgets: { Growth: 250 } }, '2026-11')
  assert.equal(tight.status, 'at-risk')
})

// ---------- The synthetic account end to end ----------

const def = SAMPLES[0]
const sample = generate(def)
const sCfg = sampleConfig(def)

test('the synthetic account reconciles to the metered total with no residual', () => {
  for (const m of months(sample)) {
    const a = allocate(filterMonth(sample, m), sCfg)
    assert.ok(Math.abs(a.recon.residual) < 1e-3, `${m} residual ${a.recon.residual}`)
    assert.equal(a.warehouses.length, 6)
  }
})

test('every idle method allocates the same total, only the split changes', () => {
  const oct = filterMonth(sample, '2026-10')
  const totals = (['credits', 'exec', 'even', 'owner'] as const).map(m => allocate(oct, { ...sCfg, idleMethod: m }).recon.allocated)
  for (const t of totals) close(t, totals[0], 1e-6)
})

test('the synthetic account flags the runaway dbt refresh and the one-hour auto-suspend', () => {
  const oct = filterMonth(sample, '2026-10')
  const a = allocate(oct, sCfg)
  const top = anomalies(oct, sCfg, a)[0]
  assert.equal(top.day, '2026-10-14')
  assert.match(top.drivers[0].label, /SVC_DBT/)
  const recs = recommend(a, sample.warehouses)
  assert.ok(recs.some(r => r.warehouse === 'ADHOC_WH' && r.kind === 'auto_suspend'))
})

test('month-over-month compare explains which team grew and why', () => {
  const sep = snapshotMonth(sample, sCfg, '2026-09', 'a')
  const oct = snapshotMonth(sample, sCfg, '2026-10', 'b')
  const [first] = compare(sep, oct)
  assert.equal(first.team, 'Data Science')
  assert.ok(first.delta > 0)
  assert.equal(first.topWarehouse?.name, 'DS_WH')
  assert.match(first.why, /DS_WH/)
})

test('round trip: the docs-shaped CSV exports import back to the same bill', () => {
  const oct = filterMonth(sample, '2026-10')
  const files = toSnowflakeCsvs(oct)
  let back: Dataset = { meter: [], usage: [], daily: [], warehouses: [] }
  for (const text of Object.values(files)) {
    const csv = parseCsv(text)
    const kind = detectKind(csv.rows[0]) as Kind
    const v = validate(kind, csv, autoMap(kind, csv.rows[0]))
    assert.equal(v.issues.length, 0)
    back = mergeRows(back, kind, v.rows)
  }
  const a = allocate(oct, sCfg), b = allocate(back, sCfg)
  for (const t of a.teams) close(b.teams.find(x => x.team === t.team)!.total, t.total, 1e-3)
  close(b.recon.residual, 0, 1e-3)
})

test('re-importing a month replaces that month and keeps the others', () => {
  const base = ds({ meter: [{ hour: Date.UTC(2026, 8, 1), warehouse: 'A', compute: 1, cloud: 0 }, { hour: H, warehouse: 'A', compute: 1, cloud: 0 }] })
  const next = mergeRows(base, 'meter', [{ hour: H + 3600_000, warehouse: 'A', compute: 5, cloud: 0 }])
  assert.equal(next.meter.length, 2)
  assert.deepEqual(next.meter.map(m => m.compute), [1, 5])
  const wh = mergeRows(ds({ warehouses: [{ name: 'A', size: 'Small', autoSuspend: 600 }] }), 'warehouses', [{ name: 'a', size: 'Medium', autoSuspend: 60 }])
  assert.equal(wh.warehouses.length, 1)
  assert.equal(wh.warehouses[0].size, 'Medium')
})

test('the finance CSV adds up to the allocated total', () => {
  const oct = filterMonth(sample, '2026-10')
  const a = allocate(oct, sCfg)
  const rows = parseCsv(financeCsv(a, '2026-10')).rows
  const i = rows[0].indexOf('total_credits')
  const total = rows.slice(1).reduce((s, r) => s + Number(r[i]), 0)
  close(total, a.recon.allocated, 0.05)
})
