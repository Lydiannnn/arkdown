import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const pages = [
  'index.html', 'workspace.html', 'writing.html', 'saving.html', 'media.html',
  'notes.html', 'translation.html', 'ai.html', 'settings.html', 'shortcuts.html',
]
let vite: ViteDevServer
let url: string

test.beforeAll(async () => {
  vite = await createServer({
    appType: 'mpa',
    configFile: false,
    logLevel: 'error',
    root: path.resolve('user-guide/dist/使用说明书'),
    server: { host: '127.0.0.1', port: 0 },
  })
  await vite.listen()
  url = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`
})

test.afterAll(async () => { await vite?.close() })

test('loads every built page and local image, then exercises search and theme', async ({ page }) => {
  const pageErrors: string[] = []
  const externalRequests: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => {
    const target = new URL(request.url())
    if (target.origin !== new URL(url).origin) externalRequests.push(request.url())
  })

  for (const name of pages) {
    const response = await page.goto(`${url}/${name}`)
    expect(response?.ok(), name).toBe(true)
    await expect(page.locator('h1')).toHaveCount(1)
    const smallText = await page.locator('body *').evaluateAll(nodes => nodes.filter(node =>
      node.textContent?.trim() && node.getClientRects().length && parseFloat(getComputedStyle(node).fontSize) < 12
    ).map(node => node.tagName + ':' + getComputedStyle(node).fontSize))
    expect(smallText, name).toEqual([])
    await expect(page.locator('.nav-link').first()).toHaveCSS('font-size', '14px')
    for (const image of await page.locator('img[src]').all()) {
      await image.scrollIntoViewIfNeeded()
      await expect.poll(() => image.evaluate((element) => (
        (element as HTMLImageElement).naturalWidth
      )), `${name}: ${await image.getAttribute('src')}`).toBeGreaterThan(0)
    }
  }

  await page.goto(`${url}/index.html`)
  const originalTheme = await page.locator('html').getAttribute('data-theme')
  await page.getByRole('button', { name: /切换到.+色模式/ }).click()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', originalTheme ?? '')
  await page.getByRole('button', { name: '搜索使用说明' }).click()
  const search = page.getByRole('searchbox', { name: '搜索功能、操作或问题' })
  await search.fill('保存')
  await expect(page.getByRole('status').filter({ hasText: /找到 \d+ 个相关小节/ })).toBeVisible()
  await expect(page.locator('.search-result').first()).toBeVisible()

  expect(pageErrors).toEqual([])
  expect(externalRequests).toEqual([])
})
