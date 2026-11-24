import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

// One warehouse named "constructor" and five teams whose names are special to JavaScript objects (or to the Statements picker):
// __proto__ 1.0, constructor, toString, all and hasOwnProperty 0.5 credits each, with idle, a pure-idle tail and cloud services.
const METERING = `START_TIME,END_TIME,WAREHOUSE_ID,WAREHOUSE_NAME,CREDITS_USED,CREDITS_USED_COMPUTE,CREDITS_USED_CLOUD_SERVICES,CREDITS_ATTRIBUTED_COMPUTE_QUERIES
2026-10-01 10:00:00.000 +0000,2026-10-01 11:00:00.000 +0000,1,constructor,5,4,1,3
2026-10-01 11:00:00.000 +0000,2026-10-01 12:00:00.000 +0000,1,constructor,1,1,0,0
`
const ATTRIBUTION = `QUERY_ID,PARENT_QUERY_ID,ROOT_QUERY_ID,WAREHOUSE_ID,WAREHOUSE_NAME,QUERY_HASH,QUERY_PARAMETERIZED_HASH,QUERY_TAG,USER_NAME,START_TIME,END_TIME,CREDITS_ATTRIBUTED_COMPUTE,CREDITS_USED_QUERY_ACCELERATION
q0,,,1,constructor,h0,p0,"{""team"":""__proto__""}",USER_0,2026-10-01 10:10:00.000 +0000,2026-10-01 10:12:00.000 +0000,1,
q1,,,1,constructor,h1,p1,"{""team"":""constructor""}",USER_1,2026-10-01 10:15:00.000 +0000,2026-10-01 10:17:00.000 +0000,0.5,
q2,,,1,constructor,h2,p2,"{""team"":""toString""}",USER_2,2026-10-01 10:20:00.000 +0000,2026-10-01 10:22:00.000 +0000,0.5,
q3,,,1,constructor,h3,p3,"{""team"":""all""}",USER_3,2026-10-01 10:25:00.000 +0000,2026-10-01 10:27:00.000 +0000,0.5,
q4,,,1,constructor,h4,p4,"{""team"":""hasOwnProperty""}",USER_4,2026-10-01 10:30:00.000 +0000,2026-10-01 10:32:00.000 +0000,0.5,
`
const NAMES = ['__proto__', 'constructor', 'toString', 'all', 'hasOwnProperty']

const num = (s: string) => Number(s.replace(/[,$\s]/g, ''))

async function openProject(page: Page) {
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).click()
  await page.locator('input[type=file]').setInputFiles([
    { name: 'metering.csv', mimeType: 'text/csv', buffer: Buffer.from(METERING) },
    { name: 'attribution.csv', mimeType: 'text/csv', buffer: Buffer.from(ATTRIBUTION) },
  ])
  await page.getByRole('button', { name: 'Import all 2 files' }).click()
  await expect(page.getByText(/Imported [\d,]+ rows from 2 files/)).toBeVisible()
  await page.getByRole('link', { name: /^Rules/ }).click()
  await page.getByRole('button', { name: /Use the tag.s .team. key as the team/ }).click()
  await page.getByRole('link', { name: 'Overview' }).click()
  await expect(page.getByRole('heading', { name: /Bill by team/ })).toBeVisible()
}

async function teamCredits(page: Page) {
  // A Map: a plain object would itself mishandle the name "__proto__".
  const out = new Map<string, number>()
  for (const tr of await page.locator('table.data').first().locator('tbody tr').all()) {
    out.set((await tr.locator('th').innerText()).trim(), num((await tr.locator('td.num.strong').first().innerText())))
  }
  return out
}

test('teams and warehouses named like JavaScript object members get the right credits and the bill ties out', async ({ page }) => {
  await openProject(page)
  const credits = await teamCredits(page)
  expect([...credits.keys()].sort()).toEqual([...NAMES].sort())
  // 5.0 metered compute + 0.5 billed cloud services = 5.5, split 1.8 / 0.9 / 0.9 / 0.9 / 0.9 by query credits.
  expect([...credits]).toEqual([['__proto__', 1.8], ['constructor', 0.9], ['toString', 0.9], ['all', 0.9], ['hasOwnProperty', 0.9]])
  await expect(page.locator('table.data').first().locator('tfoot td.num.strong').first()).toHaveText('5.5')
  await expect(page.locator('table.recon tr.sum', { hasText: 'Billable credits' }).locator('td')).toHaveText('5.50')
  await expect(page.locator('table.recon tr.sum', { hasText: 'Residual' }).locator('td')).toHaveText('0.000')
  await expect(page.getByText('Ties out to WAREHOUSE_METERING_HISTORY')).toBeVisible()
  await expect(page.locator('table.data').first().locator('.chip')).toHaveCount(0)

  // The same under every idle split, with the warehouse "constructor" owned by a team.
  await page.getByRole('link', { name: /^Rules/ }).click()
  await page.getByLabel('constructor', { exact: true }).fill('Platform')
  await page.getByRole('link', { name: 'Overview' }).click()
  for (const method of ['credits', 'exec', 'even', 'owner']) {
    await page.getByLabel('Idle split').selectOption(method)
    await expect(page.getByLabel('Idle split')).toHaveValue(method)
    await expect(page.locator('table.data').first().locator('tfoot td.num.strong').first()).toHaveText('5.5')
    await expect(page.locator('table.recon tr.sum', { hasText: 'Residual' }).locator('td')).toHaveText('0.000')
    await expect(page.getByText('Ties out to WAREHOUSE_METERING_HISTORY')).toBeVisible()
  }
  expect((await teamCredits(page)).get('Platform')).toBeCloseTo(2.1, 1)

  // Reload: the owner, which is stored under the key "constructor", is still there.
  await page.reload()
  await expect(page.getByLabel('Idle split')).toHaveValue('owner')
  expect((await teamCredits(page)).get('Platform')).toBeCloseTo(2.1, 1)
})

test('budgets, statements and the finance CSV work for these names', async ({ page }) => {
  await openProject(page)

  // A budget on "__proto__" is kept (and survives a reload); the other names have none.
  await page.getByRole('link', { name: 'Budgets' }).click()
  await page.getByLabel('__proto__ monthly budget in dollars').fill('100')
  await expect(page.locator('.budget-card', { hasText: '__proto__' }).locator('.chip')).not.toHaveText('No budget')
  for (const name of NAMES.filter(n => n !== '__proto__')) {
    await expect(page.locator('.budget-card', { has: page.getByRole('heading', { name, exact: true }) }).locator('.chip')).toHaveText('No budget')
  }
  await page.reload()
  await expect(page.getByLabel('__proto__ monthly budget in dollars')).toHaveValue('100')
  await expect(page.getByLabel('constructor monthly budget in dollars')).toHaveValue('')

  // Statements: a team called "all" has its own page, and "All teams" still means every team.
  await page.getByRole('link', { name: 'Overview' }).click()
  await page.getByRole('link', { name: 'Statements' }).click()
  const picker = page.locator('.statement-toolbar label', { hasText: 'Team' }).locator('select')
  await expect(page.locator('article.statement')).toHaveCount(5)
  await picker.selectOption('all')
  await expect(page.locator('article.statement')).toHaveCount(1)
  await expect(page.locator('article.statement h1')).toHaveText('all')
  await picker.selectOption('__proto__')
  await expect(page.locator('article.statement h1')).toHaveText('__proto__')
  await expect(page.locator('article.statement tr.total')).toContainText('1.83')
  await picker.selectOption({ label: 'All teams (5 pages)' })
  await expect(page.locator('article.statement')).toHaveCount(5)

  // The finance CSV has every name and adds up to the bill.
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Finance CSV' }).click()
  const rows = (await readFile((await (await download).path())!, 'utf8')).trim().split('\n').slice(1).map(l => l.split(','))
  expect([...new Set(rows.map(r => r[1]))].sort()).toEqual([...NAMES].sort())
  expect(rows.reduce((a, r) => a + Number(r[7]), 0)).toBeCloseTo(5.5, 3)
  expect(rows.every(r => r[2] === 'constructor')).toBe(true)
})
