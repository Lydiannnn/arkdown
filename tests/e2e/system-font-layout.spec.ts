import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
let vite: ViteDevServer
let url: string
test.beforeAll(async () => {
  const html = await readFile('src/renderer/index.html', 'utf8')
  const entry = path.resolve('tests/e2e/fixtures/system-font-fixture.tsx').replaceAll('\\', '/')
  vite = await createServer({ configFile: path.resolve('vite.renderer.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'font-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/') { next(); return }
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(await server.transformIndexHtml('/', html.replace('/main.tsx', `/@fs/${entry}`)))
      })
    } }],
  })
  await vite.listen()
  url = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`
})
test.afterAll(async () => { await vite?.close() })

test('renders installed Chinese and variable Latin fonts, keeps code separate and settings readable', async ({ page }, info) => {
  const errors: string[] = []
  const fontRequests: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/\.(?:ttf|woff2?|otf)(?:\?|$)/u.test(request.url())) fontRequests.push(request.url()) })
  await page.goto(url)
  await page.getByRole('button', { name: '选择工作区', exact: true }).click()
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click()
  await page.getByRole('button', { name: '字体测试.md', exact: true }).click()
  const prose = page.locator('.ProseMirror').first()
  await expect(prose.getByRole('heading', { name: 'Arkdown 字体测试' })).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await expect(prose).toHaveCSS('font-weight', '430')
  await expect(prose).toHaveCSS('font-size', '16px')
  await expect(prose).toHaveCSS('line-height', '25.6px')
  await expect(page.locator('.app-menu-button').first()).toHaveCSS('font-weight', '430')
  await expect(page.getByRole('button', { name: '字体测试.md', exact: true })).toHaveCSS('font-weight', '430')
  await expect(prose.getByRole('heading', { level: 1 })).toHaveCSS('font-weight', '650')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.ProseMirror p' })
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
  expect(fonts.some(font => font.postScriptName === 'Segoe-UI-Variable-Text')).toBe(true)
  expect(fonts.some(font => font.familyName === 'Microsoft YaHei UI')).toBe(true)
  expect(fonts.every(font => !font.isCustomFont)).toBe(true)
  await writeFile(info.outputPath('actual-fonts.json'), JSON.stringify(fonts, null, 2), 'utf8')
  const code = prose.locator('p code').first()
  await expect(code).toHaveCSS('font-weight', '400')
  expect(await code.evaluate(el => getComputedStyle(el).fontFamily)).toContain('monospace')
  await expect(prose.locator('.cm-scroller').first()).toHaveCSS('font-weight', '400')
  expect(await prose.locator('.cm-scroller').first().evaluate(el => getComputedStyle(el).fontFamily)).toContain('monospace')
  await page.screenshot({ path: info.outputPath('system-font-document.png'), animations: 'disabled' })
  await page.getByRole('button', { name: '源码模式/渲染模式' }).click()
  expect(await page.locator('.source-editor .cm-scroller').evaluate(el => getComputedStyle(el).fontFamily)).toContain('monospace')
  await expect(page.locator('.source-editor .cm-scroller')).toHaveCSS('font-weight', '400')
  await page.getByRole('button', { name: '源码模式/渲染模式' }).click()
  await page.evaluate(() => window.arkdown.executeApplicationMenuItem!('file.preferences'))
  await expect(page.getByRole('heading', { name: '偏好设置', exact: true })).toBeVisible()
  await expect(page.locator('.preferences-page--arkdown')).toHaveCSS('font-weight', '430')
  await expect(page.locator('.preferences-page--arkdown small').first()).toHaveCSS('font-weight', '430')
  await page.screenshot({ path: info.outputPath('system-font-preferences.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 760, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: info.outputPath('system-font-preferences-narrow.png'), animations: 'disabled' })
  expect(fontRequests).toEqual([])
  expect(errors).toEqual([])
})
