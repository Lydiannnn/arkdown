import type { AddressInfo } from 'node:net'
import { expect, test, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_PATH = '/__sidebar-transition-fixture'
const VIRTUAL_FIXTURE_ID = 'virtual:sidebar-transition-fixture'
const RESOLVED_FIXTURE_ID = `\0${VIRTUAL_FIXTURE_ID}`

const fixtureModule = String.raw`
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorRightSidebar } from '/src/renderer/editor/EditorRightSidebar.tsx'
import '/src/renderer/app/styles.css'

const h = React.createElement

function Fixture() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    window.sidebarTransitionFixture = { setOpen }
  }, [])
  return h('main', { className: 'editor-pane', style: { height: '420px', width: '900px' } },
    h('div', {
      className: 'editor-surface',
      contentEditable: true,
      'data-testid': 'surface',
      suppressContentEditableWarning: true,
    }, Array.from({ length: 100 }, (_, index) => 'editor line ' + index).join('\n')),
    h(EditorRightSidebar, {
      activeTab: 'translation',
      containerWidth: 900,
      onActiveTabChange() {},
      open,
    }, h('div', { style: { width: '100%', height: '100%', background: '#eef2ff' } },
      h('button', { type: 'button' }, 'sidebar action'),
    )),
  )
}

createRoot(document.querySelector('#fixture-root')).render(h(Fixture))
`

let vite: ViteDevServer
let fixtureUrl: string

test.beforeAll(async () => {
  vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'sidebar-transition-playwright-fixture',
      resolveId(id) {
        return id === VIRTUAL_FIXTURE_ID ? RESOLVED_FIXTURE_ID : undefined
      },
      load(id) {
        return id === RESOLVED_FIXTURE_ID ? fixtureModule : undefined
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== FIXTURE_PATH) {
            next()
            return
          }
          const html = await server.transformIndexHtml(FIXTURE_PATH, `<!doctype html>
            <html><head><meta charset="UTF-8"></head>
            <body style="margin:0;overflow:hidden">
              <div id="fixture-root"></div>
              <script type="module">import '${VIRTUAL_FIXTURE_ID}'</script>
            </body></html>`)
          response.statusCode = 200
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(html)
        })
      },
    }],
  })
  await vite.listen()
  const address = vite.httpServer!.address() as AddressInfo
  fixtureUrl = `http://127.0.0.1:${address.port}${FIXTURE_PATH}`
})

test.afterAll(async () => {
  await vite.close()
})

async function setSidebarOpen(page: Page, open: boolean) {
  await page.evaluate((nextOpen) => {
    (window as typeof window & {
      sidebarTransitionFixture: { setOpen(open: boolean): void }
    }).sidebarTransitionFixture.setOpen(nextOpen)
  }, open)
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const value = document.querySelector(selector)!.getBoundingClientRect()
      return { left: value.left, right: value.right, width: value.width }
    }
    return {
      phase: document.querySelector('.editor-right-sidebar-motion-track')
        ?.getAttribute('data-phase'),
      pane: rect('.editor-pane'),
      surface: rect('.editor-surface'),
      track: rect('.editor-right-sidebar-motion-track'),
      sidebar: rect('.editor-right-sidebar'),
    }
  })
}

async function splitterHitAtTrackOffset(page: Page, offset: number) {
  return page.evaluate((trackOffset) => {
    const track = document.querySelector<HTMLElement>('.editor-right-sidebar-motion-track')
    const splitter = document.querySelector<HTMLElement>('.editor-right-sidebar-splitter')
    if (!track || !splitter) return null
    const trackRect = track.getBoundingClientRect()
    const splitterRect = splitter.getBoundingClientRect()
    const hit = document.elementFromPoint(
      trackRect.left + trackOffset,
      splitterRect.top + splitterRect.height / 2,
    )
    return {
      hitSplitter: hit === splitter || Boolean(hit?.closest('.editor-right-sidebar-splitter')),
      splitterLeft: splitterRect.left,
      splitterWidth: splitterRect.width,
      trackLeft: trackRect.left,
    }
  }, offset)
}

test('right sidebar reflows the editor continuously without compressing or covering its content', async ({ page }, testInfo) => {
  await page.goto(fixtureUrl)
  expect(await page.evaluate(() => devicePixelRatio)).toBe(testInfo.project.metadata.requestedDpr)
  await expect(page.getByTestId('surface')).toBeVisible()
  await expect(page.locator('.editor-right-sidebar-motion-track')).toHaveCount(0)

  await setSidebarOpen(page, true)
  await expect(page.locator('.editor-right-sidebar-motion-track')).toHaveAttribute('data-phase', 'entering')
  const closed = await geometry(page)
  expect(closed.track.width).toBe(0)
  expect(Math.abs(closed.sidebar.width - 320)).toBeLessThanOrEqual(0.01)
  expect(Math.abs(closed.surface.right - closed.pane.right)).toBeLessThanOrEqual(1)

  await page.waitForTimeout(80)
  const mid = await geometry(page)
  expect(mid.track.width).toBeGreaterThan(0)
  expect(mid.track.width).toBeLessThan(320)
  expect(Math.abs(mid.sidebar.width - 320)).toBeLessThanOrEqual(0.01)
  expect(Math.abs(mid.surface.right - mid.track.left)).toBeLessThanOrEqual(1)
  expect(Math.abs(mid.track.right - mid.pane.right)).toBeLessThanOrEqual(1)

  await expect(page.locator('.editor-right-sidebar-motion-track')).toHaveAttribute('data-phase', 'open')
  const opened = await geometry(page)
  expect(Math.abs(opened.track.width - 320)).toBeLessThanOrEqual(1)
  expect(Math.abs(opened.sidebar.width - 320)).toBeLessThanOrEqual(0.01)
  expect(Math.abs(opened.surface.right - opened.track.left)).toBeLessThanOrEqual(1)

  await setSidebarOpen(page, false)
  await expect(page.locator('.editor-right-sidebar-motion-track')).toHaveAttribute('data-phase', 'closing')
  await expect(page.locator('.editor-right-sidebar-motion-track')).toHaveCSS('pointer-events', 'none')
  await page.waitForTimeout(80)
  const closing = await geometry(page)
  expect(closing.track.width).toBeGreaterThan(0)
  expect(closing.track.width).toBeLessThan(320)
  expect(Math.abs(closing.sidebar.width - 320)).toBeLessThanOrEqual(0.01)
  expect(Math.abs(closing.surface.right - closing.track.left)).toBeLessThanOrEqual(1)
  await expect(page.locator('.editor-right-sidebar-motion-track')).toHaveCount(0)

})

test('keeps the full seven CSS-pixel splitter hit target outside the clip only while open', async ({ page }) => {
  await page.goto(fixtureUrl)
  await expect(page.getByTestId('surface')).toBeVisible()

  await setSidebarOpen(page, true)
  await expect(page.locator('.editor-right-sidebar-motion-track')).toHaveAttribute('data-phase', 'opening')
  expect((await splitterHitAtTrackOffset(page, -2.5))?.hitSplitter).toBe(false)

  const track = page.locator('.editor-right-sidebar-motion-track')
  const splitter = page.getByRole('separator', { name: '调整右侧栏宽度' })
  await expect(track).toHaveAttribute('data-phase', 'open')
  const hitSamples = await Promise.all(
    [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5, 3.5]
      .map((offset) => splitterHitAtTrackOffset(page, offset)),
  )
  expect(hitSamples.every((sample) => sample?.hitSplitter)).toBe(true)
  expect(Math.abs((hitSamples[0]?.splitterWidth ?? 0) - 7)).toBeLessThanOrEqual(0.01)
  expect(Math.abs(
    (hitSamples[0]?.splitterLeft ?? 0) - (hitSamples[0]?.trackLeft ?? 0) + 3,
  )).toBeLessThanOrEqual(0.01)

  const openGeometry = await geometry(page)
  const splitterBounds = await splitter.boundingBox()
  expect(splitterBounds).not.toBeNull()
  await page.mouse.move(openGeometry.track.left - 2.5, splitterBounds!.y + splitterBounds!.height / 2)
  await page.mouse.down()
  await page.mouse.move(openGeometry.track.left - 22.5, splitterBounds!.y + splitterBounds!.height / 2)
  await page.mouse.up()
  await expect(splitter).toHaveAttribute('aria-valuenow', '340')

  await setSidebarOpen(page, false)
  await expect(track).toHaveAttribute('data-phase', 'closing')
  expect((await splitterHitAtTrackOffset(page, -2.5))?.hitSplitter).toBe(false)
  await expect(track).toHaveCount(0)
  await expect(splitter).toHaveCount(0)
})

test('tabs from the editor to the splitter before sidebar controls and dynamic content', async ({ page }) => {
  await page.goto(fixtureUrl)
  const surface = page.getByTestId('surface')
  await expect(surface).toBeVisible()
  await setSidebarOpen(page, true)

  const splitter = page.getByRole('separator', { name: '调整右侧栏宽度' })
  await expect(page.locator('.editor-right-sidebar-motion-track')).toHaveAttribute('data-phase', 'open')
  await surface.focus()
  await page.keyboard.press('Tab')
  await expect(splitter).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tab', { name: '翻译' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'sidebar action' })).toBeFocused()
})
