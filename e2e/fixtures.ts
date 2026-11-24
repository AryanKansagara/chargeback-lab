import { expect, test as base } from '@playwright/test'

// Google Fonts is the only external resource the app asks for. It is stubbed with an empty stylesheet;
// every other request that leaves the preview server (Supabase included) is aborted and fails the test.
const STUBBED_HOSTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//

export const test = base.extend<{ guard: void }>({
  guard: [async ({ context, page, baseURL }, use) => {
    const origin = new URL(baseURL!).origin
    const external: string[] = []
    const pageErrors: string[] = []
    page.on('pageerror', e => pageErrors.push(e.message))
    await context.route(url => url.origin !== origin, route => {
      const url = route.request().url()
      if (STUBBED_HOSTS.test(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
      external.push(url)
      return route.abort()
    })
    await use()
    expect(external, 'requests to hosts other than the preview server').toEqual([])
    expect(pageErrors, 'uncaught page errors').toEqual([])
  }, { auto: true }],
})

export { expect }
