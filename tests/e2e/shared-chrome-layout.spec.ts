import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, test, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
let vite: ViteDevServer
let url: string
const evidence = '.superpowers/sdd/2026-09-07-ui-optimization-round2'
test.beforeAll(async () => {
  const productionHtml = await readFile('src/renderer/index.html', 'utf8')
  const entry = path.resolve('tests/e2e/fixtures/shared-chrome-layout-fixture.tsx').replaceAll('\\', '/')
  vite = await createServer({ configFile: path.resolve('vite.renderer.config.ts'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'shared-chrome-fixture', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/') { next(); return }
        const html = await server.transformIndexHtml('/', productionHtml.replace('/main.tsx', `/@fs/${entry}`))
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html)
      })
    } }],
  })
  await vite.listen()
  url = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`
})
test.afterAll(async () => { await vite?.close() })
async function geometry(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect()
      return { left: r.left, top: r.top, bottom: r.bottom, width: r.width, height: r.height }
    }
    return { sidebar: rect('.sidebar'),
      content: rect('.sidebar > section:not([hidden])') }
  })
}

test('keeps production tooltips dismissed through pointer and keyboard interaction', async ({ page }) => {
  await page.goto(url)
  const bold = page.getByRole('button', { name: '加粗', exact: true })
  const italic = page.getByRole('button', { name: '斜体', exact: true })
  const tip = page.getByRole('tooltip')
  const expectDismissed = async () => {
    await expect(tip).toHaveCount(0)
    // Wait past the production hover delay to catch a newly scheduled tooltip.
    await page.waitForTimeout(450)
    await expect(tip).toHaveCount(0)
  }
  await bold.hover()
  await expect(tip).toHaveText('加粗')
  const bounds = (await bold.boundingBox())!
  await page.mouse.down()
  await expect(bold).toBeFocused()
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
  await expectDismissed()
  await page.mouse.up()
  await bold.locator('img').hover()
  await expectDismissed()

  await page.getByLabel('Document content').hover()
  await bold.hover()
  await expect(tip).toHaveText('加粗')
  await page.keyboard.press('Tab')
  await expect(italic).toBeFocused()
  await expect(tip).toHaveText('斜体')
  const keyboardTip = (await tip.boundingBox())!
  const trigger = (await italic.boundingBox())!
  expect(keyboardTip.x >= trigger.x + trigger.width
    || keyboardTip.x + keyboardTip.width <= trigger.x
    || keyboardTip.y >= trigger.y + trigger.height
    || keyboardTip.y + keyboardTip.height <= trigger.y).toBe(true)

  // Focus remains on Italic while the real pointer crosses Bold's image/button boundary.
  await page.getByLabel('Document content').hover()
  await bold.locator('img').hover()
  await expect(tip).toHaveText('加粗')
  await expect(italic).toBeFocused()
  await page.keyboard.press('Escape')
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
  await bold.locator('img').hover()
  await expectDismissed()
  await page.getByLabel('Document content').hover()
  await bold.hover()
  await expect(tip).toHaveText('加粗')
})
test('fills the sidebar with files and preserves its search surface without tabs', async ({ page }) => {
  await page.goto(url)
  await expect(page.getByRole('button', { name: 'note-0.md', exact: true })).toBeVisible()
  await expect(page.locator('.sidebar-tabs')).toHaveCount(0)
  const r = await geometry(page)
  expect(Math.abs(r.content.bottom - r.sidebar.bottom)).toBeLessThanOrEqual(1)
  await page.getByRole('button', { name: '搜索工作区', exact: true }).click()
  const search = await geometry(page)
  expect(search.content.bottom).toBeLessThanOrEqual(search.sidebar.bottom)
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeVisible()
})

test('opens files with arrow keys, keeps theme selection without an outline, and scrolls the target into view', async ({ page }) => {
  await page.goto(url)
  // This standalone shell fixture does not mount App's theme preference hook.
  await page.evaluate(() => document.documentElement.style.setProperty('--theme-color-rgb', '198 40 40'))
  await page.getByRole('button', { name: 'note-0.md', exact: true }).click()
  await page.keyboard.press('ArrowDown')
  const second = page.getByRole('button', { name: 'note-1.md', exact: true })
  await expect(second).toBeFocused()
  await expect(second).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'note-1.md', exact: true })).toBeVisible()
  await expect(second).toHaveCSS('outline-style', 'none')
  await expect(second).toHaveCSS('background-color', 'rgba(198, 40, 40, 0.05)')
  for (let index = 1; index < 40; index++) await page.keyboard.press('ArrowDown')
  const target = page.getByRole('button', { name: 'note-40.md', exact: true })
  await expect(target).toBeFocused()
  await expect(target).toBeInViewport()
  const tree = page.locator('.workspace-tree-context')
  expect(await tree.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  await page.keyboard.press('ArrowUp')
  await expect(page.getByRole('heading', { name: 'note-39.md', exact: true })).toBeVisible()
  await page.getByLabel('Document content').click()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('heading', { name: 'note-39.md', exact: true })).toBeVisible()
})
test('offsets the toggle SVG by two CSS pixels and preserves view and document across keyboard collapse', async ({ page }) => {
  await page.goto(url)
  const toggle = page.getByRole('button', { name: '隐藏侧边栏' })
  await expect(toggle).toBeVisible()
  await expect(page.locator('.app-menu-button').first()).toHaveCSS('font-size', '13px')
  const toggleIcon = await toggle.locator('svg').boundingBox()
  const rootIcon = await page.getByRole('button', { name: 'note-0.md', exact: true }).locator('.file-type-icon').boundingBox()
  expect(Math.abs(toggleIcon!.x - rootIcon!.x + 1)).toBeLessThanOrEqual(1)
  expect(toggleIcon!.width).toBe(18)
  const hit = (await toggle.boundingBox())!
  expect(hit.width).toBeGreaterThanOrEqual(26); expect(hit.height).toBeGreaterThanOrEqual(26)
  expect(await toggle.evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('no-drag')
  const menu = (await page.locator('.app-menu-bar').boundingBox())!
  expect(menu.x - hit.x - hit.width).toBe(8)
  const initial = await geometry(page)
  await writeFile(`${evidence}/task-1-geometry.json`, JSON.stringify({ toggleIcon, rootIcon, hit, menu, ...initial }, null, 2))
  await page.screenshot({ path: `${evidence}/task-1-chrome.png` })
  await page.getByRole('button', { name: 'note-2.md', exact: true }).click()
  await page.getByLabel('Document content').fill('Changed draft remains')
  const files = page.locator('.workspace-tree-context')
  await files.evaluate(el => { el.scrollTop = 200 })
  await expect.poll(() => files.evaluate(el => el.scrollTop)).toBe(200)
  await toggle.click()
  await expect(page.locator('.sidebar')).not.toBeVisible()
  await page.getByRole('button', { name: '显示侧边栏' }).press('Enter')
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect.poll(() => files.evaluate(el => el.scrollTop)).toBe(200)
  await expect(page.getByRole('heading', { name: 'note-2.md' })).toBeVisible()
  await expect(page.getByLabel('Document content')).toHaveValue('Changed draft remains')
  await expect(page.locator('.sidebar-tabs')).toHaveCount(0)
  await expect(page.getByLabel('Document content')).toHaveValue('Changed draft remains')
})
