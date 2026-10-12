import type { AddressInfo } from 'node:net'
import { expect, test, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_PATH = '/__translation-sidebar-fixture'
const VIRTUAL_FIXTURE_ID = 'virtual:translation-sidebar-fixture'
const RESOLVED_FIXTURE_ID = `\0${VIRTUAL_FIXTURE_ID}`

const fixtureModule = String.raw`
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TranslationSidebar } from '/src/renderer/editor/TranslationSidebar.tsx'
import { EditorRightSidebar } from '/src/renderer/editor/EditorRightSidebar.tsx'
import '/src/renderer/app/styles.css'
import '/src/renderer/editor/selection-translation.css'

const h = React.createElement
const record = {
  id: 'record-1',
  requestId: 'request-1',
  documentKey: 'note.md',
  workspaceAbsolutePath: null,
  documentRelativePath: null,
  documentAbsolutePath: null,
  documentRevision: null,
  mode: 'visual',
  source: { markdown: 'source', plainText: 'source' },
  translatedMarkdown: Array.from({ length: 48 }, (_, index) => 'History line ' + (index + 1)).join('\n\n'),
  modelId: 'chat-model',
  targetLanguage: 'zh-CN',
  terminal: 'completed',
  createdAt: 1,
  anchor: {
    mode: 'visual',
    from: 1,
    to: 7,
    blockStart: 0,
    fingerprint: { before: '', selected: 'source', after: '' },
    status: 'valid',
  },
}
const longOutput = Array.from({ length: 80 }, (_, index) => (
  index === 40
    ? 'unbroken-' + 'x'.repeat(512)
    : 'Translation result line ' + (index + 1)
)).join('\n\n')

function Fixture() {
  const [view, setView] = useState({ kind: 'live' })
  const [status, setStatus] = useState('streaming')
  const [stopCount, setStopCount] = useState(0)
  useEffect(() => {
    const root = document.querySelector('#fixture-root')
    root.dataset.view = view.kind
    root.dataset.status = status
    root.dataset.stopCount = String(stopCount)
    window.translationSidebarFixture = { setStatus }
  }, [view, status, stopCount])
  return h(EditorRightSidebar, {
    activeTab: 'translation',
    containerWidth: window.innerWidth,
    initialWidth: window.innerWidth,
    onActiveTabChange() {},
  }, h(TranslationSidebar, {
    state: {
      requestId: 'request-live',
      status,
      output: status === 'ready' ? '' : longOutput,
      errorCode: null,
      error: null,
    },
    mode: 'visual',
    selectionTop: 0,
    surfaceTop: 0,
    alignmentHeight: window.innerHeight,
    resultHeight: 2000,
    onTranslate() {},
    onStop() { setStopCount((count) => count + 1) },
    onCopy() {},
    onClose() {},
    view,
    historyRecords: [record],
    historyRecordId: record.id,
    onOpenHistory(recordId) { setView({ kind: 'history', recordId }) },
    onReturnToLive() { setView({ kind: 'live' }) },
    onSelectHistory() {},
  }))
}

const root = createRoot(document.querySelector('#fixture-root'))
window.mountTranslationSidebarFixture = () => root.render(h(Fixture))
`

let vite: ViteDevServer
let fixtureUrl: string

test.beforeAll(async () => {
  vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'translation-sidebar-playwright-fixture',
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
              <main id="fixture-root" style="--theme-color-rgb:37 99 235;height:100vh;width:100vw"></main>
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

async function mountFixture(page: Page) {
  await page.goto(fixtureUrl)
  await page.evaluate(() => {
    (window as typeof window & { mountTranslationSidebarFixture(): void })
      .mountTranslationSidebarFixture()
  })
  await expect(page.getByRole('complementary', { name: '右侧栏' })).toBeVisible()
}

test('real live Sidebar keeps long output above its fixed footer at 480px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 })
  await mountFixture(page)
  const scroll = page.locator('.translation-sidebar-live-scroll')
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight })

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const value = document.querySelector(selector)!.getBoundingClientRect()
      return { top: value.top, right: value.right, bottom: value.bottom, left: value.left }
    }
    const sidebar = document.querySelector<HTMLElement>('.editor-right-sidebar')!
    const liveScroll = document.querySelector<HTMLElement>('.translation-sidebar-live-scroll')!
    return {
      sidebar: rect('.editor-right-sidebar'),
      scroll: rect('.translation-sidebar-live-scroll'),
      footer: rect('.translation-sidebar-footer'),
      lastLine: rect('.translation-output p:last-child'),
      viewport: { right: innerWidth, bottom: innerHeight },
      sidebarHorizontalOverflow: sidebar.scrollWidth > sidebar.clientWidth,
      scrollHorizontalOverflow: liveScroll.scrollWidth > liveScroll.clientWidth,
    }
  })

  expect(Math.abs(geometry.sidebar.right - geometry.viewport.right)).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry.sidebar.bottom - geometry.viewport.bottom)).toBeLessThanOrEqual(1)
  expect(geometry.footer.top).toBeGreaterThanOrEqual(geometry.scroll.bottom - 1)
  expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.sidebar.bottom + 1)
  expect(geometry.lastLine.top).toBeGreaterThanOrEqual(geometry.scroll.top - 1)
  expect(geometry.lastLine.bottom).toBeLessThanOrEqual(geometry.scroll.bottom + 1)
  expect(geometry.sidebarHorizontalOverflow).toBe(false)
  expect(geometry.scrollHorizontalOverflow).toBe(false)
  await expect(page.getByRole('button', { name: '查看翻译记录' })).toBeVisible()
  await page.getByRole('button', { name: '停止翻译' }).click()
  await expect(page.locator('#fixture-root')).toHaveAttribute('data-stop-count', '1')
})

test('real short Sidebar preserves live scroll through history and keeps every footer action reachable', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 320 })
  await mountFixture(page)
  const liveScroll = page.locator('.translation-sidebar-live-scroll')
  await liveScroll.evaluate((element) => {
    element.scrollTop = 141
    element.setAttribute('data-live-node', 'retained')
  })

  await page.getByRole('button', { name: '查看翻译记录' }).click()
  await expect(page.locator('#fixture-root')).toHaveAttribute('data-view', 'history')
  await expect(page.locator('.translation-history-view')).toBeVisible()
  await expect(page.locator('.translation-history-view h2')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查看翻译记录' })).toBeHidden()
  await expect(page.getByRole('button', { name: '返回当前翻译' })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止翻译' })).toBeVisible()

  const historyGeometry = await page.evaluate(() => {
    const history = document.querySelector('.translation-sidebar-history-scroll')!.getBoundingClientRect()
    const footerElement = document.querySelector('.translation-sidebar-footer')!
    const footer = footerElement.getBoundingClientRect()
    const left = document.querySelector('.translation-sidebar-footer-left')!.getBoundingClientRect()
    const right = document.querySelector('.translation-sidebar-footer-right')!.getBoundingClientRect()
    const resultStyle = getComputedStyle(document.querySelector('.translation-history-view')!)
    return {
      historyBottom: history.bottom,
      footerTop: footer.top,
      footerBottom: footer.bottom,
      viewportBottom: innerHeight,
      leftAligned: Math.abs(left.left - footer.left - Number.parseFloat(getComputedStyle(footerElement).paddingLeft)),
      groupsOrdered: left.right <= right.left,
      historyBorderStyle: resultStyle.borderStyle,
      historyBorderWidth: resultStyle.borderWidth,
      historyRadius: resultStyle.borderRadius,
      historyShadow: resultStyle.boxShadow,
    }
  })
  expect(historyGeometry.footerTop).toBeGreaterThanOrEqual(historyGeometry.historyBottom - 1)
  expect(historyGeometry.footerBottom).toBeLessThanOrEqual(historyGeometry.viewportBottom + 1)
  expect(historyGeometry.leftAligned).toBeLessThanOrEqual(1)
  expect(historyGeometry.groupsOrdered).toBe(true)
  expect(historyGeometry.historyBorderStyle).toBe('none')
  expect(historyGeometry.historyBorderWidth).toBe('0px')
  expect(historyGeometry.historyRadius).toBe('0px')
  expect(historyGeometry.historyShadow).toBe('none')

  await page.getByRole('button', { name: '返回当前翻译' }).click()
  await expect(page.locator('#fixture-root')).toHaveAttribute('data-view', 'live')
  await expect(page.locator('.translation-sidebar-live-scroll[data-live-node="retained"]')).toBeVisible()
  expect(await liveScroll.evaluate((element) => element.scrollTop)).toBe(141)
  await page.getByRole('button', { name: '停止翻译' }).click()
  await expect(page.locator('#fixture-root')).toHaveAttribute('data-stop-count', '1')
})

test('ready Sidebar keeps the flat translation action above the ten-percent floor', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 480 })
  await mountFixture(page)
  await page.evaluate(() => {
    (window as typeof window & { translationSidebarFixture: { setStatus(value: string): void } })
      .translationSidebarFixture.setStatus('ready')
  })
  await expect(page.locator('#fixture-root')).toHaveAttribute('data-status', 'ready')
  const action = page.getByRole('button', { name: '翻译选中的文本' })
  await expect(action).toBeVisible()
  const geometry = await page.evaluate(() => {
    const scroll = document.querySelector('.translation-sidebar-live-scroll')!.getBoundingClientRect()
    const result = document.querySelector('.translation-sidebar-result')!.getBoundingClientRect()
    const button = document.querySelector('.translation-sidebar-ready-action')!
    const style = getComputedStyle(button)
    return {
      borderColor: style.borderColor,
      buttonTop: button.getBoundingClientRect().top,
      color: style.color,
      resultTop: result.top,
      scrollTop: scroll.top,
      viewportHeight: window.innerHeight,
      shadow: getComputedStyle(document.querySelector('.translation-sidebar-result')!).boxShadow,
    }
  })
  expect(Math.abs(
    geometry.buttonTop - geometry.scrollTop - geometry.viewportHeight * 0.1,
  )).toBeLessThanOrEqual(1)
  expect(geometry.borderColor).toBe('rgba(37, 99, 235, 0.6)')
  expect(geometry.color).toBe('rgba(37, 99, 235, 0.6)')
  expect(geometry.shadow).toBe('none')

  await action.hover()
  const hover = await action.evaluate((node) => {
    const style = getComputedStyle(node)
    return { background: style.backgroundColor, shadow: style.boxShadow }
  })
  expect(hover.background).toBe('rgba(37, 99, 235, 0.05)')
  expect(hover.shadow).not.toBe('none')

  await page.mouse.down()
  const active = await action.evaluate((node) => getComputedStyle(node).backgroundColor)
  await page.mouse.up()
  expect(active).toBe('rgba(37, 99, 235, 0.1)')
})
