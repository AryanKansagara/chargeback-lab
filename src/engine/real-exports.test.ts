import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { autoMap, detectKind, mergeRows, parseCsv, parseNum, parseTime, validate, type Kind } from './csv.ts'
import { allocate } from './allocate.ts'
import { creditsPerHour, recommend } from './insights.ts'
import type { Config, Dataset, WarehouseInfo } from './types.ts'

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const fixture = (name: string) => parseCsv(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const load = (name: string, want: Kind) => {
  const csv = fixture(name)
  const kind = detectKind(csv.rows[0])
  assert.equal(kind, want, name)
  const v = validate(want, csv, autoMap(want, csv.rows[0]))
  assert.deepEqual(v.issues, [], name)
  return v.rows
}
const cfg: Config = { rules: [{ id: 't', field: 'tag_key', key: 'team', op: 'any', value: '', team: '', useValue: true }], idleMethod: 'credits', pricePerCredit: 3, owners: {}, budgets: {}, carryHours: 2 }

function fullAccount(): Dataset {
  let ds: Dataset = { meter: [], usage: [], daily: [], warehouses: [] }
  ds = mergeRows(ds, 'meter', load('warehouse_metering_snowsight.csv', 'meter'))
  ds = mergeRows(ds, 'usage', load('query_attribution_history.csv', 'usage'))
  ds = mergeRows(ds, 'daily', load('metering_daily_history.csv', 'daily'))
  ds = mergeRows(ds, 'warehouses', load('show_warehouses_result_scan.csv', 'warehouses'))
  return ds
}

test('Snowsight WAREHOUSE_METERING_HISTORY download: all columns, -0700 offsets, NULL attribution', () => {
  const rows = load('warehouse_metering_snowsight.csv', 'meter') as Dataset['meter']
  assert.equal(rows.length, 6)
  assert.equal(rows[0].hour, Date.UTC(2026, 9, 1, 7))
  assert.equal(rows[0].compute, 8)
  close(rows[0].cloud, 0.153611111)
  assert.equal(rows.find(r => r.warehouse === 'CLOUD_SERVICES_ONLY')!.compute, 0)
})

test('raw QUERY_ATTRIBUTION_HISTORY: per-query rows, JSON tags with doubled quotes, scientific notation, child queries', () => {
  const rows = load('query_attribution_history.csv', 'usage') as Dataset['usage']
  assert.equal(rows.length, 5)
  assert.equal(JSON.parse(rows[0].tag).model, 'fct_orders')
  assert.equal(rows[0].hour, Date.UTC(2026, 9, 1, 7))
  close(rows[4].credits, 0.011714)
  assert.equal(rows[2].qas, 0.25)
  assert.ok(rows.every(r => r.queries === 1))
})

test('SHOW WAREHOUSES via RESULT_SCAN: quoted lowercase headers, null auto-suspend, warehouse type', () => {
  const rows = load('show_warehouses_result_scan.csv', 'warehouses') as WarehouseInfo[]
  assert.deepEqual(rows.map(r => [r.name, r.type, r.size, r.autoSuspend, r.maxClusters]), [
    ['TRANSFORM_WH', 'STANDARD', 'Large', 60, 1], ['BI_WH', 'STANDARD', 'Small', 600, 3], ['ML_WH', 'SNOWPARK-OPTIMIZED', 'Medium', null, 1],
  ])
})

test('a full real-layout account reconciles to the billed total, with every service type carried', () => {
  const a = allocate(fullAccount(), cfg)
  const r = a.recon
  // 12.8 compute + 0 billed cloud (adjustment cancels it) + 1.327683 serverless incl. query acceleration
  close(r.billable, 12.8 + 1.327683)
  close(r.residual, 0)
  close(r.cloudAdjustment, -0.511111111)
  assert.deepEqual(r.attributedCheck && [+r.attributedCheck.metering.toFixed(6), +r.attributedCheck.queries.toFixed(6)], [9.188162, 9.188162])
  const de = a.teams.find(t => t.team === 'data-eng')!
  close(de.qas, 0.25)
})

test('CLOUD_SERVICES_ONLY cloud credits with no owner land on the fix list, and go to the owner once set', () => {
  const ds = fullAccount()
  // Turn the adjustment off so the cloud services are actually billed.
  ds.daily = ds.daily.map(d => d.service === 'WAREHOUSE_METERING' ? { ...d, adjustment: 0, billed: d.compute + d.cloud } : d)
  const a = allocate(ds, cfg)
  const fix = a.fixes.find(f => f.kind === 'idle' && f.subject.warehouse === 'CLOUD_SERVICES_ONLY')
  assert.ok(fix)
  close(fix!.credits, 0.241944444)
  const b = allocate(ds, { ...cfg, owners: { CLOUD_SERVICES_ONLY: 'Platform' } })
  close(b.teams.find(t => t.team === 'Platform')!.cloud, 0.241944444)
  assert.ok(!b.fixes.some(f => f.subject.warehouse === 'CLOUD_SERVICES_ONLY'))
})

test('semicolon CSV from a European spreadsheet reads decimal commas and dot thousands', () => {
  const rows = load('warehouse_metering_excel_eu.csv', 'meter') as Dataset['meter']
  assert.equal(rows[0].compute, 8)
  close(rows[0].cloud, 0.153611111)
  assert.equal(rows[1].compute, 1024.5)
  assert.equal(rows[1].attributed, 1000.25)
  // Comma files keep treating the comma as a thousands separator.
  assert.equal(parseNum('1,024.5'), 1024.5)
  assert.equal(parseNum('8.5', true), 8.5)
})

test('parseTime reads the older Snowflake DY, DD MON YYYY output format', () => {
  assert.equal(parseTime('Thu, 01 Oct 2026 00:00:00 -0700'), Date.UTC(2026, 9, 1, 7))
  assert.equal(parseTime('Thu, 01 Oct 2026 00:00:00.000 Z'), Date.UTC(2026, 9, 1, 0))
  assert.ok(Number.isNaN(parseTime('Thu, 01 Foo 2026 00:00:00')))
})

test('Snowpark-optimized warehouses bill 1.5x and are never sized below Medium', () => {
  assert.equal(creditsPerHour('Medium'), 4)
  assert.equal(creditsPerHour('Medium', 'SNOWPARK-OPTIMIZED'), 6)
  assert.equal(creditsPerHour('2X-Large', 'STANDARD'), 32)
  const wh = { name: 'ML_WH', metered: 100, attributed: 10, idle: 90, over: 0, unmetered: 0, idlePct: 0.9, cloud: 0, idleByTeam: {}, activeHours: 20, idleOnlyHours: 0, meteredHours: 25, queries: 100, execMs: 100_000, byDay: {} }
  const alloc = { warehouses: [wh], days: ['2026-10-01'], price: 3 } as unknown as Parameters<typeof recommend>[0]
  const std = recommend(alloc, [{ name: 'ML_WH', size: 'Medium', autoSuspend: 60, type: 'STANDARD' }])
  assert.ok(std.some(r => r.kind === 'size'))
  const sp = recommend(alloc, [{ name: 'ML_WH', size: 'Medium', autoSuspend: 60, type: 'SNOWPARK-OPTIMIZED' }])
  assert.ok(!sp.some(r => r.kind === 'size'))
  // Never-suspending: the 60-second tail kept per active hour uses the 1.5x rate (20 h x 1/60 h x 6 cr).
  const never = recommend(alloc, [{ name: 'ML_WH', size: 'Medium', autoSuspend: null, type: 'SNOWPARK-OPTIMIZED' }])
  close(never.find(r => r.kind === 'auto_suspend')!.savingsCredits, 90 - 20 * (60 / 3600) * 6)
})

test('adaptive warehouses get no ALTER WAREHOUSE recommendations', () => {
  const wh = { name: 'AD_WH', metered: 100, attributed: 0, idle: 90, over: 0, unmetered: 0, idlePct: 0.9, cloud: 0, idleByTeam: {}, activeHours: 20, idleOnlyHours: 5, meteredHours: 25, queries: 100, execMs: 100_000, byDay: {} }
  const alloc = { warehouses: [wh], days: ['2026-10-01'], price: 3 } as unknown as Parameters<typeof recommend>[0]
  assert.equal(recommend(alloc, [{ name: 'AD_WH', size: 'Large', autoSuspend: 600, type: 'ADAPTIVE' }]).length, 0)
  assert.ok(recommend(alloc, [{ name: 'AD_WH', size: 'Large', autoSuspend: 600 }]).length > 0)
})
