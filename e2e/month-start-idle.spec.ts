import { expect, test } from './fixtures.ts'

// Alpha and beta run queries in the last hour of October (alpha 1.0, beta 0.5); the next two hours are pure idle tail
// (1.2 and 0.6 credits). Beta also runs 2.0 credits on 1 November.
const METERING = `START_TIME,END_TIME,WAREHOUSE_ID,WAREHOUSE_NAME,CREDITS_USED,CREDITS_USED_COMPUTE,CREDITS_USED_CLOUD_SERVICES,CREDITS_ATTRIBUTED_COMPUTE_QUERIES
2026-10-31 23:00:00.000 +0000,2026-11-01 00:00:00.000 +0000,1,SHARED_WH,2.5,2.5,0,1.5
2026-11-01 00:00:00.000 +0000,2026-11-01 01:00:00.000 +0000,1,SHARED_WH,1.2,1.2,0,0
2026-11-01 01:00:00.000 +0000,2026-11-01 02:00:00.000 +0000,1,SHARED_WH,0.6,0.6,0,0
2026-11-01 09:00:00.000 +0000,2026-11-01 10:00:00.000 +0000,1,SHARED_WH,2,2,0,2
`
const ATTRIBUTION = `QUERY_ID,PARENT_QUERY_ID,ROOT_QUERY_ID,WAREHOUSE_ID,WAREHOUSE_NAME,QUERY_HASH,QUERY_PARAMETERIZED_HASH,QUERY_TAG,USER_NAME,START_TIME,END_TIME,CREDITS_ATTRIBUTED_COMPUTE,CREDITS_USED_QUERY_ACCELERATION
q1,,,1,SHARED_WH,h1,p1,"{""team"":""alpha""}",ALPHA_USER,2026-10-31 23:05:00.000 +0000,2026-10-31 23:20:00.000 +0000,1.0,
q2,,,1,SHARED_WH,h2,p2,"{""team"":""beta""}",BETA_USER,2026-10-31 23:25:00.000 +0000,2026-10-31 23:40:00.000 +0000,0.5,
q3,,,1,SHARED_WH,h3,p3,"{""team"":""beta""}",BETA_USER,2026-11-01 09:05:00.000 +0000,2026-11-01 09:50:00.000 +0000,2.0,
`

test('idle at the start of a month stays with the team that was active at the end of the last one', async ({ page }) => {
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

  const row = (team: string) => page.locator('table.data').first().locator('tbody tr', { has: page.getByRole('rowheader', { name: team, exact: true }) })
  const credits = (team: string) => row(team).locator('td.num.strong').first()

  await page.getByLabel('Month').selectOption('2026-10')
  await expect(credits('alpha')).toHaveText('1.7')
  await expect(credits('beta')).toHaveText('0.8')

  // November: the 1.8 credits of tail go to alpha and beta (2:1), not to "Unassigned idle".
  await page.getByLabel('Month').selectOption('2026-11')
  await expect(credits('beta')).toHaveText('2.6')
  await expect(credits('alpha')).toHaveText('1.2')
  await expect(page.getByRole('rowheader', { name: 'Unassigned idle' })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  // Only November's own credits are counted: 3.8 metered in November, none of the 2.5 from 31 October.
  await expect(page.locator('table.recon tr.sum', { hasText: 'Billable credits' }).locator('td')).toHaveText('3.80')
  await expect(page.getByText('Ties out to WAREHOUSE_METERING_HISTORY')).toBeVisible()

  // Statements for November have the same two teams and no unassigned page.
  await page.getByRole('link', { name: 'Statements' }).click()
  await expect(page.locator('article.statement')).toHaveCount(2)
  await expect(page.locator('article.statement', { hasText: 'Unassigned' })).toHaveCount(0)
})
