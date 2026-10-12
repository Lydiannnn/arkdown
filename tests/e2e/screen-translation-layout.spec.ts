import { mkdir, readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

let vite: ViteDevServer | undefined
let fixtureUrl = ''
const evidence = path.resolve('.superpowers/sdd/2026-09-13-cli-floating-translation-feedback/task2-layout')

test.beforeAll(async () => {
  const productionHtml = await readFile(path.resolve('src/renderer/index.html'), 'utf8')
  const fixture = path.resolve('tests/e2e/fixtures/screen-translation-layout-fixture.tsx').replaceAll('\\', '/')
  vite = await createServer({
    configFile: path.resolve('vite.renderer.config.ts'), logLevel: 'error',
    cacheDir: path.resolve('.native-cache/vite-screen-layout', String(process.pid)),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{ name: 'screen-translation-layout-fixture', configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/') return next()
        const html = productionHtml.replace('<script type="module" src="/main.tsx"></script>', `<script type="module" src="/@fs/${fixture}"></script>`)
        response.statusCode = 200
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end(await server.transformIndexHtml(request.url ?? '/', html))
      })
    } }],
  })
  await vite.listen()
  const address = vite.httpServer?.address() as AddressInfo
  fixtureUrl = `http://127.0.0.1:${address.port}`
  await mkdir(evidence, { recursive: true })
})
test.afterAll(async () => { await vite?.close() })

async function open(page: Page, theme: 'light' | 'dark') {
  await page.goto(`${fixtureUrl}/?surface=screen-translation&theme=${theme}`)
  await expect(page.getByRole('heading', { name: '悬浮翻译窗' })).toBeVisible()
  await page.evaluate(async () => { await document.fonts.ready })
  await expect(page.getByRole('button', { name: '等待快捷键' })).toBeVisible()
}

async function assertNoHorizontalOverflow(page: Page) {
  const geometry = await page.locator('.screen-translation-body').evaluate(body => ({
    bodyWidth: body.clientWidth, contentWidth: body.scrollWidth,
    documentWidth: document.documentElement.clientWidth, documentContentWidth: document.documentElement.scrollWidth,
    controls: [...body.querySelectorAll('button, input, summary')].filter(element => element.getClientRects().length > 0)
      .map(element => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right } }),
  }))
  expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.bodyWidth)
  expect(geometry.documentContentWidth).toBeLessThanOrEqual(geometry.documentWidth)
  for (const control of geometry.controls) {
    expect(control.left).toBeGreaterThanOrEqual(0)
    expect(control.right).toBeLessThanOrEqual(geometry.documentWidth)
  }
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), animations: 'disabled' })
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: default panel preserves hotkey order, red prompts, compact text and accessible actions`, async ({ page }) => {
    await open(page, theme)
    const panel = page.getByRole('main', { name: '悬浮翻译窗' })
    await expect(page.getByRole('combobox', { name: '翻译方式' })).toHaveText('大模型')
    await expect(page.getByRole('combobox', { name: '目标语言' })).toHaveText('自动')
    await expect(panel).toHaveCSS('background-color', theme === 'dark' ? 'rgb(24, 24, 24)' : 'rgb(255, 255, 255)')
    await expect(panel).toHaveCSS('font-size', '11px')
    await expect(page.getByRole('heading')).toHaveCSS('font-size', '13px')
    await expect(page.getByRole('heading').locator('svg')).toHaveCount(0)
    const guide = page.locator('.screen-translation-guide')
    await expect(guide.locator('svg')).toHaveCSS('color', 'rgb(198, 40, 40)')
    const alignment = await guide.evaluate(element => {
      const icon = element.querySelector('svg')!.getBoundingClientRect()
      const text = element.querySelector('span')!.getBoundingClientRect()
      return Math.abs(icon.y + icon.height / 2 - text.y - text.height / 2)
    })
    expect(alignment).toBeLessThanOrEqual(0.5)
    const once = page.getByText('Ctrl+Shift+A', { exact: true })
    const clear = page.getByText('Ctrl+Shift+D', { exact: true })
    await expect(once).toHaveCSS('color', 'rgb(198, 40, 40)')
    await expect(clear).toHaveCSS('color', 'rgb(198, 40, 40)')
    expect((await once.boundingBox())!.y).toBeLessThan((await clear.boundingBox())!.y)
    await page.getByRole('combobox', { name: '触发方式' }).click()
    await expect(page.getByRole('option')).toHaveText(['快捷键', '自动'])
    await expect(page.getByRole('option', { name: '快捷键' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('option').first()).toHaveCSS('font-size', '11px')
    await page.keyboard.press('Escape')
    await assertNoHorizontalOverflow(page)
    await capture(page, `${theme}-default-360x450`)
    const copy = page.getByRole('button', { name: '复制译文', exact: true })
    await copy.scrollIntoViewIfNeeded(); await expect(copy).toBeInViewport(); await copy.click()
    const erase = page.getByRole('button', { name: '清除译文', exact: true })
    await erase.scrollIntoViewIfNeeded(); await expect(erase).toBeInViewport(); await erase.click()
    expect(await page.evaluate(() => window.screenLayoutFixture.commands())).toEqual(['copy', 'clear'])
  })

  test(`${theme}: expanded Baidu credentials remain within width and scroll to all actions`, async ({ page }) => {
    await open(page, theme)
    await page.getByRole('combobox', { name: '翻译方式' }).click()
    await page.getByRole('option', { name: '百度快译', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '目标语言' })).toHaveText('自动')
    await page.getByText('百度智能云密钥', { exact: true }).click()
    const form = page.locator('.screen-translation-credentials form')
    await expect(form).toBeVisible()
    await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password')
    await assertNoHorizontalOverflow(page)
    await page.getByLabel('Secret Key', { exact: true }).scrollIntoViewIfNeeded()
    await capture(page, `${theme}-baidu-expanded-360x450`)
    for (const name of ['保存密钥', '复制译文', '清除译文']) {
      const button = page.getByRole('button', { name, exact: true })
      await button.scrollIntoViewIfNeeded(); await expect(button).toBeInViewport()
    }
    const scroll = await page.locator('.screen-translation-body').evaluate(body => ({ height: body.clientHeight, scroll: body.scrollHeight, top: body.scrollTop }))
    expect(scroll.scroll).toBeGreaterThan(scroll.height)
    expect(scroll.top).toBeGreaterThan(0)
    await expect(page.getByRole('heading')).toBeInViewport()
    await capture(page, `${theme}-baidu-bottom-360x450`)
  })

  test(`${theme}: model thinking portals fit the viewport at default and enlarged sizes`, async ({ page }) => {
    await open(page, theme)
    await page.getByRole('combobox', { name: '翻译方式' }).click()
    await page.getByRole('option', { name: '大模型', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '模型连接' })).toContainText('合成模型')
    await assertNoHorizontalOverflow(page)
    for (const size of [{ width: 360, height: 450 }, { width: 540, height: 680 }]) {
      await page.setViewportSize(size)
      const thinking = page.getByRole('combobox', { name: '悬浮翻译窗思考', exact: true })
      await thinking.click()
      await expect(page.getByRole('option', { name: '开', exact: true })).toBeInViewport()
      await expect(page.getByRole('combobox', { name: '悬浮翻译窗推理强度', exact: true })).toHaveCount(0)
      const menu = page.getByRole('listbox')
      const bounds = (await menu.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height)
      await expect(menu.getByRole('option').first()).toHaveCSS('font-size', '11px')
      await capture(page, `${theme}-thinking-${size.width}x${size.height}`)
      await page.getByRole('option', { name: '开', exact: true }).click()
      await assertNoHorizontalOverflow(page)
      const erase = page.getByRole('button', { name: '清除译文', exact: true })
      await erase.scrollIntoViewIfNeeded(); await expect(erase).toBeInViewport()
    }
  })
}
