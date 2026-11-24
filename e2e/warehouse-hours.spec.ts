import { expect, test } from './fixtures.ts'

// One warehouse-hour (6.5 credits metered) shared by N teams that together ran 5.8 credits of queries.
const METERING = 'START_TIME,END_TIME,WAREHOUSE_ID,WAREHOUSE_NAME,CREDITS_USED,CREDITS_USED_COMPUTE,CREDITS_USED_CLOUD_SERVICES,CREDITS_ATTRIBUTED_COMPUTE_QUERIES\n2026-10-01 00:00:00.000 +0000,2026-10-01 01:00:00.000 +0000,1,SHARED_WH,6.5,6.5,0,5.8\n'
const ATTRIBUTION_HEADER = 'QUERY_ID,PARENT_QUERY_ID,ROOT_QUERY_ID,WAREHOUSE_ID,WAREHOUSE_NAME,QUERY_HASH,QUERY_PARAMETERIZED_HASH,QUERY_TAG,USER_NAME,START_TIME,END_TIME,CREDITS_ATTRIBUTED_COMPUTE,CREDITS_USED_QUERY_ACCELERATION\n'
const attribution = (teams: number) => ATTRIBUTION_HEADER + Array.from({ length: teams }, (_, i) => {
  const mm = String(i % 60).padStart(2, '0')
  return `q${i},,,1,SHARED_WH,h${i},p${i},"{""team"":""team-${String(i).padStart(3, '0')}""}",USER_${i},2026-10-01 00:${mm}:00.000 +0000,2026-10-01 00:${mm}:30.000 +0000,${5.8 / teams},\n`
}).join('')

for (const teams of [1, 10, 102, 500]) {
  test(`the Warehouse hours bar stays inside its row with ${teams} team${teams === 1 ? '' : 's'}`, async ({ page }) => {
    await page.goto('/app')
    await page.getByRole('button', { name: 'Import your data' }).click()
    await page.locator('input[type=file]').setInputFiles([
      { name: 'metering.csv', mimeType: 'text/csv', buffer: Buffer.from(METERING) },
      { name: 'attribution.csv', mimeType: 'text/csv', buffer: Buffer.from(attribution(teams)) },
    ])
    await page.getByRole('button', { name: 'Import all 2 files' }).click()
    await expect(page.getByText(/Imported [\d,]+ rows from 2 files/)).toBeVisible()
    await page.getByRole('link', { name: /^Rules/ }).click()
    await page.getByRole('button', { name: /Use the tag.s .team. key as the team/ }).click()
    await page.getByRole('link', { name: 'Overview' }).click()
    await expect(page.locator('table.data').first().locator('tbody tr')).toHaveCount(teams)
    await page.getByRole('radio', { name: '1 day' }).click()

    const panel = page.locator('.panel', { has: page.getByRole('heading', { name: 'Warehouse hours' }) })
    const billPanel = page.locator('.panel', { has: page.locator('table.data') }).first()
    const track = panel.locator('.tl-track')
    const stack = panel.locator('.tl-col').first().locator('.tl-stack')
    await stack.scrollIntoViewIfNeeded()

    for (const idle of ['Idle claimed', 'Idle unassigned']) {
      await panel.getByRole('radio', { name: idle }).click()
      // Heights animate for 0.7s; wait for them to settle before measuring.
      await expect.poll(async () => {
        const box = (await stack.boundingBox())!
        const heights = await stack.locator('span').evaluateAll(els => els.map(e => e.getBoundingClientRect().height))
        const drawn = heights.reduce((a, b) => a + b, 0)
        const shares = await stack.locator('span').evaluateAll(els => els.map(e => parseFloat((e as HTMLElement).style.height)))
        const [t, p, bill] = [(await track.boundingBox())!, (await panel.boundingBox())!, (await billPanel.boundingBox())!]
        return {
          insideTrack: box.y >= t.y - 0.5 && box.y + box.height <= t.y + t.height + 0.5,
          insidePanel: t.y >= p.y && t.y + t.height <= p.y + p.height,
          belowBill: p.y >= bill.y + bill.height,
          // The metered hour is the lane's maximum, so its segments fill the whole bar and no more
          // (the browser lays heights out in 1/64 px steps, so the pixels can fall a hair short with many segments).
          sumsToBar: Math.abs(shares.reduce((a, b) => a + b, 0) - 100) < 0.01 && drawn <= box.height + 0.5 && drawn > box.height - 1 - teams / 64,
        }
      }, { message: `${idle}, ${teams} teams` }).toEqual({ insideTrack: true, insidePanel: true, belowBill: true, sumsToBar: true })
    }

    // The hour still has a tooltip that fits on screen and adds up to the metered credits.
    await panel.getByRole('radio', { name: 'Idle claimed' }).click()
    await track.evaluate(e => e.scrollIntoView({ block: 'center' })) // the tooltip opens above the hour
    await panel.locator('.tl-col').first().hover()
    const tip = page.getByRole('tooltip')
    await expect(tip).toContainText('SHARED_WH')
    await expect(tip.locator('.tip-row').first()).toContainText('Metered')
    const tipBox = (await tip.boundingBox())!
    expect(tipBox.y).toBeGreaterThanOrEqual(0)
    expect(tipBox.height).toBeLessThan(400)
    const rows = await tip.locator('.tip-row b').allInnerTexts()
    expect(rows.slice(1).reduce((a, s) => a + Number(s), 0)).toBeCloseTo(6.5, 0)
    if (teams > 7) await expect(tip).toContainText(`${teams - 4} other teams (query)`)
    else await expect(tip).not.toContainText('other teams')
  })
}

test('hours above the warehouse size stay inside the row and comparable with each other', async ({ page }) => {
  const hour = (h: number, credits: number) => `2026-10-01 0${h}:00:00.000 +0000,2026-10-01 0${h + 1}:00:00.000 +0000,1,SHARED_WH,${credits},${credits},0,${credits}\n`
  const query = (h: number, credits: number) => `q${h},,,1,SHARED_WH,h,p,"{""team"":""alpha""}",U,2026-10-01 0${h}:01:00.000 +0000,2026-10-01 0${h}:30:00.000 +0000,${credits},\n`
  await page.goto('/app')
  await page.getByRole('button', { name: 'Import your data' }).click()
  await page.locator('input[type=file]').setInputFiles([
    { name: 'metering.csv', mimeType: 'text/csv', buffer: Buffer.from(METERING.split('\n')[0] + '\n' + hour(0, 2) + hour(1, 4)) },
    { name: 'attribution.csv', mimeType: 'text/csv', buffer: Buffer.from(ATTRIBUTION_HEADER + query(0, 2) + query(1, 4)) },
    { name: 'warehouses.csv', mimeType: 'text/csv', buffer: Buffer.from('name,state,type,size,auto_suspend,auto_resume\nSHARED_WH,STARTED,STANDARD,X-Small,60,true\n') }, // X-Small is 1 credit an hour
  ])
  await page.getByRole('button', { name: 'Import all 3 files' }).click()
  await page.getByRole('link', { name: 'Overview' }).click()
  const track = page.locator('.tl-track').first()
  await expect(page.locator('.tl-meta')).toContainText('X-Small')
  await expect.poll(async () => {
    const height = async (i: number) => (await track.locator('.tl-col').nth(i).locator('.seg').evaluateAll(els => els.reduce((a, e) => a + e.getBoundingClientRect().height, 0)))
    const [two, four, lane] = [await height(0), await height(1), (await track.locator('.tl-stack').first().boundingBox())!.height]
    return { ratio: Math.round(four / two * 10) / 10, fits: four <= lane + 0.5 }
  }).toEqual({ ratio: 2, fits: true })
})
