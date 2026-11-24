import { readFile } from 'node:fs/promises'
import { expect, test } from './fixtures.ts'

const num = (s: string) => Number(s.replace(/[,$\s]/g, ''))

// One warehouse-hour, two ordinary teams and 100 teams of 0.04 credits each (about 0.045 with their share of idle).
const METERING = 'START_TIME,END_TIME,WAREHOUSE_ID,WAREHOUSE_NAME,CREDITS_USED,CREDITS_USED_COMPUTE,CREDITS_USED_CLOUD_SERVICES,CREDITS_ATTRIBUTED_COMPUTE_QUERIES\n2026-10-01 00:00:00.000 +0000,2026-10-01 01:00:00.000 +0000,1,SHARED_WH,6.5,6.5,0,5.8\n'
const query = (i: number, team: string, user: string, credits: number) =>
  `q${i},,,1,SHARED_WH,h${i},p${i},"{""team"":""${team}""}",${user},2026-10-01 00:${String(i % 60).padStart(2, '0')}:00.000 +0000,2026-10-01 00:${String(i % 60).padStart(2, '0')}:30.000 +0000,${credits},\n`
const ATTRIBUTION = 'QUERY_ID,PARENT_QUERY_ID,ROOT_QUERY_ID,WAREHOUSE_ID,WAREHOUSE_NAME,QUERY_HASH,QUERY_PARAMETERIZED_HASH,QUERY_TAG,USER_NAME,START_TIME,END_TIME,CREDITS_ATTRIBUTED_COMPUTE,CREDITS_USED_QUERY_ACCELERATION\n'
  + query(0, 'data-eng', 'SVC_DBT', 1.2) + query(1, 'finance', 'FIN_ANALYST', 0.6)
  + Array.from({ length: 100 }, (_, i) => query(i + 2, `team-${String(i).padStart(3, '0')}`, `USER_${i}`, 0.04)).join('')

test('teams under 0.05 credits stay in the bill, the statements and the finance CSV', async ({ page }) => {
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

  // Every team has a row, and the rows add up to the total and to the bill.
  const table = page.locator('table.data').first()
  await expect(table.locator('tbody tr')).toHaveCount(102)
  const credits = (await table.locator('tbody tr td.num.strong').allInnerTexts()).filter((_, i) => i % 2 === 0).map(num)
  expect(credits).toHaveLength(102)
  expect(credits.reduce((a, b) => a + b, 0)).toBeCloseTo(6.5, 1)
  await expect(table.locator('tbody tr', { hasText: 'team-007' }).locator('td.num.strong').first()).toHaveText('0.045')
  await expect(table.locator('tfoot td.num.strong').first()).toHaveText('6.5')
  await expect(page.locator('table.recon tr.sum', { hasText: 'Billable credits' }).locator('td')).toHaveText('6.50')
  await expect(page.getByText('Ties out to WAREHOUSE_METERING_HISTORY')).toBeVisible()

  // One statement per team, and a small team can open its own.
  await page.getByRole('link', { name: 'Statements' }).click()
  await expect(page.locator('article.statement')).toHaveCount(102)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Finance CSV' }).click()
  const csv = (await readFile((await (await download).path())!, 'utf8')).trim().split('\n').slice(1).map(l => l.split(','))
  expect(csv.filter(r => r[1].startsWith('team-'))).toHaveLength(100)
  expect(csv.reduce((a, r) => a + Number(r[7]), 0)).toBeCloseTo(6.5, 1) // each row is rounded to 4 decimals

  await page.locator('.statement-toolbar label', { hasText: 'Team' }).locator('select').selectOption('team-007')
  const own = page.locator('article.statement')
  await expect(own).toHaveCount(1)
  await expect(own).toContainText('team-007')
  await expect(own.locator('tr.total')).toContainText('0.04')
})
