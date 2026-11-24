import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

const fixture = (name: string) => fileURLToPath(new URL(`../src/engine/fixtures/${name}`, import.meta.url))
const ENGINE_FIXTURES = ['warehouse_metering_snowsight.csv', 'query_attribution_history.csv', 'metering_daily_history.csv', 'show_warehouses_result_scan.csv'].map(fixture)

const num = (s: string) => Number(s.replace(/[,$\s]/g, ''))

interface TeamRow { query: number; idle: number; cloud: number; serverless: number; credits: number }

/** The "Bill by team" table on the Overview tab: one row per team, plus the footer total. */
async function billByTeam(page: Page) {
  const table = page.locator('table.data').first()
  await expect(table).toBeVisible()
  const read = (cells: string[]): TeamRow => ({ query: num(cells[0]), idle: num(cells[1]), cloud: num(cells[2]), serverless: num(cells[3]), credits: num(cells[4]) })
  const teams: Record<string, TeamRow> = {}
  for (const tr of await table.locator('tbody tr').all()) {
    teams[(await tr.locator('th').innerText()).trim()] = read(await tr.locator('td.num').allInnerTexts())
  }
  const total = read(await table.locator('tfoot td.num').allInnerTexts())
  return { teams, total }
}

/** "Billable credits" from the Reconciliation panel: what Snowflake metered, which the teams must add up to. */
async function billable(page: Page) {
  return num(await page.locator('table.recon tr.sum', { hasText: 'Billable credits' }).locator('td').innerText())
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

async function openSample(page: Page, id: 'acme' | 'consolidated') {
  await page.goto(`/app?sample=${id}`)
  await expect(page.getByRole('heading', { name: /Bill by team/ })).toBeVisible()
  await expect(page).toHaveURL(/\/app\/p\/[\w-]+$/)
}

async function importFiles(page: Page, files: Parameters<ReturnType<Page['locator']>['setInputFiles']>[0]) {
  await page.locator('input[type=file]').setInputFiles(files)
}

test.describe('sample account', () => {
  test('landing page opens the sample and shows credits per team, idle included', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Every Snowflake credit')
    await page.getByRole('link', { name: 'Try the sample' }).first().click()
    await expect(page.getByRole('heading', { name: /Bill by team/ })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Acme Retail')

    const { teams, total } = await billByTeam(page)
    expect(Object.keys(teams)).toEqual(expect.arrayContaining(['Data Science', 'Data Engineering', 'Analytics', 'Finance', 'Growth', 'Unmapped']))
    expect(teams['Data Science']).toMatchObject({ query: 851.0, idle: 652.4, credits: 1503.5 })
    expect(teams['Data Engineering']).toMatchObject({ credits: 1207.9 })
    // Every team carries idle credits, and the table ties out to the metered bill.
    for (const t of Object.values(teams)) expect(t.idle).toBeGreaterThan(0)
    expect(total.credits).toBe(3751.2)
    expect(await billable(page)).toBeCloseTo(3751.23, 2)
    expect(sum(Object.values(teams).map(t => t.credits))).toBeCloseTo(total.credits, 0)
    await expect(page.getByText('Ties out to WAREHOUSE_METERING_HISTORY')).toBeVisible()
  })

  test('idle credits with no team are listed as their own row', async ({ page }) => {
    await openSample(page, 'consolidated')
    const { teams, total } = await billByTeam(page)
    expect(teams['Unassigned idle']).toMatchObject({ query: 0, idle: 763.0, credits: 763.0 })
    expect(teams['Unmapped'].credits).toBe(1659.8)
    expect(total.credits).toBe(3743.2)
    expect(await billable(page)).toBeCloseTo(3743.2, 1)
  })

  test('changing the idle split moves team totals but not the overall total', async ({ page }) => {
    await openSample(page, 'acme')
    const before = await billByTeam(page)
    const billBefore = await billable(page)

    await page.getByLabel('Idle split').selectOption('even')
    await expect.poll(async () => (await billByTeam(page)).teams['Finance'].idle).not.toBe(before.teams['Finance'].idle)
    const after = await billByTeam(page)

    for (const team of ['Finance', 'Analytics', 'Growth']) expect(after.teams[team].credits).not.toBe(before.teams[team].credits)
    // Query, cloud and serverless credits do not depend on the idle rule; only idle moves between teams.
    for (const [team, row] of Object.entries(before.teams)) expect(after.teams[team].query).toBe(row.query)
    expect(after.total.idle).toBe(before.total.idle)
    expect(after.total.credits).toBe(before.total.credits)
    expect(await billable(page)).toBe(billBefore)
    expect(sum(Object.values(after.teams).map(t => t.credits))).toBeCloseTo(after.total.credits, 0)
  })

  test('adding a team mapping rule moves unmapped spend to a team and keeps the total', async ({ page }) => {
    await openSample(page, 'consolidated')
    const before = await billByTeam(page)

    await page.getByRole('link', { name: /^Rules/ }).click()
    const fix = page.locator('li.fix', { hasText: 'Serverless PIPE' })
    await expect(fix).toBeVisible()
    await fix.getByLabel('Team').fill('Data Engineering')
    await fix.getByRole('button', { name: 'Add rule' }).click()
    await expect(page.getByText('Rule added')).toBeVisible()
    await expect(page.locator('li.fix', { hasText: 'Serverless PIPE' })).toHaveCount(0)

    await page.getByRole('link', { name: 'Overview' }).click()
    const after = await billByTeam(page)
    expect(after.teams['Data Engineering'].serverless).toBeGreaterThan(before.teams['Data Engineering'].serverless)
    expect(after.teams['Unmapped'].serverless).toBeLessThan(before.teams['Unmapped'].serverless)
    expect(after.teams['Unmapped'].credits).toBeLessThan(before.teams['Unmapped'].credits)
    expect(after.total.credits).toBe(before.total.credits)
    expect(after.total.serverless).toBe(before.total.serverless)
  })

  test('settings survive a reload: idle method and added rule', async ({ page }) => {
    await openSample(page, 'consolidated')
    await page.getByLabel('Idle split').selectOption('even')
    await page.getByRole('link', { name: /^Rules/ }).click()
    const fix = page.locator('li.fix', { hasText: 'Serverless PIPE' })
    await fix.getByLabel('Team').fill('Data Engineering')
    await fix.getByRole('button', { name: 'Add rule' }).click()
    await page.getByRole('link', { name: 'Overview' }).click()
    const before = await billByTeam(page)
    const url = page.url()

    await page.reload()
    await expect(page).toHaveURL(url)
    await expect(page.getByRole('heading', { name: /Bill by team/ })).toBeVisible()
    await expect(page.getByLabel('Idle split')).toHaveValue('even')
    expect(await billByTeam(page)).toEqual(before)

    await page.getByRole('link', { name: /^Rules/ }).click()
    await expect(page.locator('li.fix', { hasText: 'Serverless PIPE' })).toHaveCount(0)
    await expect(page.locator('ol.rules > li')).toHaveCount(4)

    // The project list also remembers it.
    await page.goto('/app')
    await expect(page.getByRole('link', { name: 'Just consolidated (synthetic)' })).toBeVisible()
  })
})

test.describe('importing exports', () => {
  test('engine fixtures import through to a printable statement and survive a reload', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Import your data' }).click()
    await expect(page).toHaveURL(/\/app\/p\/[\w-]+\/data$/)
    await expect(page.getByText('No data yet')).toBeVisible()

    await importFiles(page, ENGINE_FIXTURES)
    await expect(page.locator('.pending')).toHaveCount(4)
    for (const [file, type] of [
      ['warehouse_metering_snowsight.csv', 'Warehouse metering'],
      ['query_attribution_history.csv', 'Query attribution'],
      ['metering_daily_history.csv', 'Daily metering'],
      ['show_warehouses_result_scan.csv', 'Warehouse settings'],
    ] as const) {
      const card = page.locator('.pending', { hasText: file })
      await expect(card.getByLabel('Detected as')).toHaveValue(/.+/)
      await expect(card.locator('select').first().locator('option:checked')).toContainText(type)
    }
    await page.getByRole('button', { name: 'Import all 4 files' }).click()
    await expect(page.getByText(/Imported [\d,]+ rows from 4 files/)).toBeVisible()
    await expect(page.locator('.pending')).toHaveCount(0)
    await expect(page.locator('table.data th[scope=row]', { hasText: 'query_attribution_history.csv' })).toBeVisible()

    // Map teams from the JSON query tag, then read the bill.
    await page.getByRole('link', { name: /^Rules/ }).click()
    await page.getByRole('button', { name: /Use the tag.s .team. key as the team/ }).click()
    await page.getByRole('link', { name: 'Overview' }).click()
    const { teams, total } = await billByTeam(page)
    expect(teams['data-eng'].query).toBeGreaterThan(0)
    expect(total.credits).toBeCloseTo(await billable(page), 0)
    expect(sum(Object.values(teams).map(t => t.credits))).toBeCloseTo(total.credits, 0)

    // Statements: one page per team that ties out to the same total.
    await page.getByRole('link', { name: 'Statements' }).click()
    await expect(page).toHaveURL(/\/statements\?m=2026-10$/)
    const statements = page.locator('article.statement')
    await expect(statements).toHaveCount(Object.keys(teams).length)
    const dataEng = statements.filter({ hasText: 'CB-202610-DATAEN' })
    await expect(dataEng).toHaveCount(1)
    await expect(dataEng).toContainText(/October/)
    await expect(statements.first().locator('.st-foot')).toContainText(/Account total for the period: [\d,.]+ billable credits/)

    // The imported project, its rows and its rule are still there after a reload.
    await page.reload()
    await expect(page.locator('article.statement')).toHaveCount(Object.keys(teams).length)
    await page.getByRole('link', { name: /←/ }).click()
    expect((await billByTeam(page)).teams['data-eng']).toEqual(teams['data-eng'])
  })

  test('files in the wrong format are explained and the app stays usable', async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Import your data' }).click()
    await expect(page.getByText('No data yet')).toBeVisible()

    // Not a CSV at all: JSON, a header with no rows, and an empty file.
    await importFiles(page, [
      { name: 'export.json', mimeType: 'application/json', buffer: Buffer.from('{"warehouse":"BI_WH","credits":1.5}') },
      { name: 'header-only.csv', mimeType: 'text/csv', buffer: Buffer.from('START_TIME,WAREHOUSE_NAME,CREDITS_USED_COMPUTE\n') },
      { name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) },
    ])
    await expect(page.getByText('export.json has no data rows.')).toBeVisible()
    await expect(page.getByText('header-only.csv has no data rows.')).toBeVisible()
    await expect(page.getByText('empty.csv has no data rows.')).toBeVisible()

    // A CSV from somewhere else: columns we do not know.
    await importFiles(page, [{ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from('name,age\nAda,36\nGrace,45\n') }])
    const unknown = page.locator('.pending', { hasText: 'people.csv' })
    await expect(unknown).toContainText('do not match any export we know')
    await expect(unknown.getByRole('button', { name: /^Import/ })).toHaveCount(0)

    // Unreadable bytes with a .csv name must not import as anything.
    const junk = Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 73 + 41) % 256))
    await importFiles(page, [{ name: 'broken.csv', mimeType: 'text/csv', buffer: junk }])
    await expect(page.getByText('broken.csv').first()).toBeVisible()
    const broken = page.locator('.pending', { hasText: 'broken.csv' })
    await expect(broken).toContainText('do not match any export we know')
    await expect(broken.getByRole('button', { name: /^Import/ })).toHaveCount(0)

    // Right columns, bad values: good rows import, bad ones are reported by line and skipped.
    await importFiles(page, [{
      name: 'metering-truncated.csv', mimeType: 'text/csv',
      buffer: Buffer.from('START_TIME,WAREHOUSE_NAME,CREDITS_USED_COMPUTE\n2026-10-01 00:00:00.000 -0700,BI_WH,1.5\n2026-10-01 01:00:00.000 -0700,BI_WH,abc\nnot a time,BI_WH,2\n'),
    }])
    const partial = page.locator('.pending', { hasText: 'metering-truncated.csv' })
    await expect(partial.locator('.report')).toContainText('1 row ready, 2 skipped, 2 issues')
    await expect(partial.locator('.issues')).toContainText('line 3')
    await expect(partial.locator('.issues')).toContainText('"abc" is not a number')
    await expect(partial.locator('.issues')).toContainText('line 4')
    await expect(partial.locator('.issues')).toContainText('"not a time" is not a date/time')
    // Nothing has been imported by any of this.
    await expect(page.getByText('No data yet')).toBeVisible()
    await expect(page.locator('table.data')).toHaveCount(0)

    // The app is still usable: navigate, then import a real export.
    await page.getByRole('link', { name: 'Docs' }).first().click()
    await expect(page).toHaveURL(/\/docs$/)
    await page.goBack()
    await expect(page).toHaveURL(/\/data$/)
    await importFiles(page, [ENGINE_FIXTURES[0]])
    await page.locator('.pending', { hasText: 'warehouse_metering_snowsight.csv' }).getByRole('button', { name: /^Import 6 rows$/ }).click()
    await expect(page.getByText(/Imported 6 warehouse metering rows/)).toBeVisible()
    await expect(page.getByText('No data yet')).toHaveCount(0)
  })
})

test('every page loads without page errors or external requests', async ({ page }) => {
  for (const [path, heading] of [['/', 'Every Snowflake credit'], ['/docs', 'Getting the data out of Snowflake'], ['/settings', 'Settings'], ['/app', 'Projects'], ['/no/such/page', 'No warehouse at this address']] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(heading)
  }
})
