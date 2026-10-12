import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_PATH = '/__translation-history-rail-layout-fixture'
const VIRTUAL_FIXTURE_ID = 'virtual:translation-history-rail-layout-fixture'
const RESOLVED_FIXTURE_ID = `\0${VIRTUAL_FIXTURE_ID}`

const fixtureModule = String.raw`
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextMenuProvider } from '/src/renderer/context-menu/ContextMenuProvider.tsx'
import { EditorPane } from '/src/renderer/editor/EditorPane.tsx'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '/src/shared/large-model-settings.ts'
import { modelObservation } from '/tests/helpers/model-observation.ts'
import '/src/renderer/app/styles.css'

const h = React.createElement
const markdown = 'before selected after'
const common = {
  documentKey: 'fixture.md',
  workspaceAbsolutePath: null,
  documentRelativePath: null,
  documentAbsolutePath: null,
  documentRevision: null,
  modelId: 'fixture-model',
  targetLanguage: 'zh-CN',
  terminal: 'completed',
}
const visualAnchor = {
  mode: 'visual', from: 8, to: 16, blockStart: 0,
  fingerprint: { before: 'before ', selected: 'selected', after: ' after' },
  status: 'valid',
}
const sourceAnchor = {
  mode: 'source', from: 7, to: 15, lineStart: 0,
  fingerprint: { before: 'before ', selected: 'selected', after: ' after' },
  status: 'valid',
}
const allRecords = [
  { ...common, id: 'visual-one', requestId: 'request-visual-one', mode: 'visual', source: { markdown: 'selected', plainText: 'selected' }, translatedMarkdown: 'visual translation one', createdAt: 1, anchor: visualAnchor },
  { ...common, id: 'visual-two', requestId: 'request-visual-two', mode: 'visual', source: { markdown: 'selected', plainText: 'selected' }, translatedMarkdown: 'visual translation two', createdAt: 2, anchor: visualAnchor },
  { ...common, id: 'source-one', requestId: 'request-source-one', mode: 'source', source: { markdown: 'selected', plainText: 'selected' }, translatedMarkdown: 'source translation', createdAt: 3, anchor: sourceAnchor },
  { ...common, id: 'source-two', requestId: 'request-source-two', mode: 'source', source: { markdown: 'selected', plainText: 'selected' }, translatedMarkdown: 'source translation two', createdAt: 4, anchor: sourceAnchor },
  { ...common, id: 'source-invalid', requestId: 'request-source-invalid', mode: 'source', source: { markdown: 'selected', plainText: 'selected' }, translatedMarkdown: 'invalid translation', createdAt: 5, anchor: { ...sourceAnchor, status: 'location-changed' } },
]

const modelSettings = {
  ...DEFAULT_LARGE_MODEL_SETTINGS,
  connections: [{
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Fixture',
    provider: 'other',
    accessType: 'standard-api',
    protocol: 'openai',
    baseUrl: 'https://example.invalid',
    modelId: 'fixture-model',
    apiKeyHint: 'test',
    status: 'connected',
    lastTestedAt: null,
    capabilityOverride: null,
  }],
  selectionTranslation: {
    ...DEFAULT_LARGE_MODEL_SETTINGS.selectionTranslation,
    connectionId: '00000000-0000-4000-8000-000000000001',
    targetLanguage: 'zh-CN',
    privacyNoticeAccepted: true,
  },
  screenshotTranslation: {
    ...DEFAULT_LARGE_MODEL_SETTINGS.screenshotTranslation,
    connectionId: '00000000-0000-4000-8000-000000000001',
    targetLanguage: 'zh-CN',
  },
}
window.arkdown = {
  cancelTranslation: async () => ({ ok: true, value: null }),
  getLargeModelSettings: async () => ({ ok: true, value: modelSettings }),
  getModelSettingsSnapshot: async () => ({ ok: true, value: modelObservation(modelSettings) }),
  onTranslationEvent: () => () => {},
  startTranslation: async () => ({
    ok: true,
    value: {
      requestId: 'fixture-live-request',
      modelId: 'fixture-model',
      targetLanguage: 'zh-CN',
    },
  }),
}

function Fixture() {
  const editorRef = useRef(null)
  const [zoom, setZoom] = useState(100)
  const [records, setRecords] = useState(allRecords)
  const [selectedId, setSelectedId] = useState(null)
  const [rightSidebarState, setRightSidebarState] = useState({ open: false, activeTab: 'translation' })
  const history = useMemo(() => ({
    selectedRecordId: selectedId,
    finalize() { return null },
    selectById(id) {
      const found = records.find((record) => record.id === id) ?? null
      if (found) setSelectedId(id)
      return found
    },
    updateAnchor() {},
  }), [records, selectedId])
  useEffect(() => {
    window.translationRailFixture = {
      setZoom,
      setRecordsVisible(value) { setRecords(value ? allRecords : []) },
      closeSidebar() { setRightSidebarState((current) => ({ ...current, open: false })) },
      toggleMode() { window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'toggle-source-mode' })) },
    }
  }, [])
  return h(ContextMenuProvider, null,
    h('div', { className: 'fixture-shell' },
      h(EditorPane, {
        ref: editorRef,
        documentKey: 'fixture.md',
        markdown,
        onChange() {},
        onOpenLargeModelSettings() {},
        onOpenRightSidebar(activeTab) { setRightSidebarState({ open: true, activeTab }) },
        onCloseRightSidebar() { setRightSidebarState((current) => ({ ...current, open: false })) },
        onNavigateTranslationHistoryRecord(recordId, alignment) {
          editorRef.current?.revealTranslationHistoryRecord(recordId, alignment)
        },
        rightSidebarState,
        translationHistory: history,
        translationHistoryRecords: records,
        zoomPercent: zoom,
      }),
    ),
  )
}

const root = createRoot(document.querySelector('#fixture-root'))
window.mountTranslationRailFixture = () => root.render(h(Fixture))
window.unmountTranslationRailFixture = () => root.unmount()
`

let vite: ViteDevServer
let fixtureUrl: string

test.beforeAll(async () => {
  vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'translation-history-rail-playwright-fixture',
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
            <html style="--theme-color-rgb:124 58 237">
              <head><meta charset="UTF-8"><style>
                html, body, #fixture-root { width:100%; height:100%; margin:0; }
                .fixture-shell { width:920px; height:620px; margin:40px; }
                .editor-pane, .editor-surface { width:100%; height:100%; }
              </style></head>
              <body><main id="fixture-root"></main>
                <script type="module">import '${VIRTUAL_FIXTURE_ID}'</script>
              </body>
            </html>`)
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

test('real visual selection released in editor whitespace shows one pointer-position trigger and routes to Sidebar', async ({ page }) => {
  await page.goto(fixtureUrl)
  await page.evaluate(() => {
    (window as typeof window & { mountTranslationRailFixture(): void }).mountTranslationRailFixture()
  })
  await expect(page.locator('.ProseMirror')).toBeVisible()

  const release = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('.ProseMirror')!
    const paragraph = editor.querySelector('p')!
    const text = paragraph.querySelector('.translation-history-highlight')!.firstChild!
    const paragraphRect = paragraph.getBoundingClientRect()
    const surfaceRect = document.querySelector('.editor-surface')!.getBoundingClientRect()
    editor.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: paragraphRect.left + 8,
      clientY: paragraphRect.top + paragraphRect.height / 2,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
    }))
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, text.textContent!.length)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const point = {
      x: surfaceRect.right - 34,
      y: paragraphRect.bottom + 28,
    }
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      clientX: point.x,
      clientY: point.y,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
    }))
    return point
  })

  const popover = page.getByRole('dialog', { name: '划词翻译' })
  const trigger = page.getByRole('button', { name: '翻译选中的文本' })
  await expect(popover).toBeVisible()
  await expect(trigger).toBeVisible()
  await expect(popover.getByRole('button', { name: '翻译记录' })).toHaveCount(0)
  const geometry = await popover.evaluate((node) => {
    const bounds = node.getBoundingClientRect()
    return {
      centerX: bounds.left + bounds.width / 2,
      height: bounds.height,
      width: bounds.width,
      top: bounds.top,
    }
  })
  expect(geometry.width).toBeCloseTo(30, 1)
  expect(geometry.height).toBeCloseTo(30, 1)
  expect(geometry.centerX).toBeCloseTo(release.x, 1)
  expect(geometry.top).toBeCloseTo(release.y + 8, 1)

  await trigger.click()
  await expect(popover).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: '右侧栏' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '翻译' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('正在翻译…')).toBeVisible()
})

test('real editors keep translation highlights and external rails aligned across zoom and DPR', async ({ page }) => {
  await page.goto(fixtureUrl)
  await page.evaluate(() => {
    (window as typeof window & { mountTranslationRailFixture(): void }).mountTranslationRailFixture()
  })
  const surface = page.locator('.editor-surface')
  const visual = page.locator('.visual-editor')
  const visualButtons = page.locator('.translation-history-rail-layer--visual .translation-history-rail-button')
  await expect(visual.locator('.translation-history-highlight')).toContainText('selected')
  await expect(visual.locator('[data-translation-history-anchor-id]')).toHaveCount(2)
  await expect(visualButtons).toHaveCount(2)
  await expect(page.locator('[data-record-id="source-invalid"]')).toHaveCount(0)

  const baselineContentWidth = await visual.locator('.ProseMirror')
    .evaluate((node) => node.getBoundingClientRect().width)
  for (const zoom of [70, 100, 200]) {
    await page.evaluate((value) => {
      (window as typeof window & { translationRailFixture: { setZoom(value: number): void } })
        .translationRailFixture.setZoom(value)
    }, zoom)
    await expect(page.locator('.editor-pane')).toHaveAttribute('data-editor-zoom-percent', String(zoom))
    const geometry = await visualButtons.evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect()
      return { height: box.height, top: box.top, width: box.width }
    }))
    expect(geometry).toHaveLength(2)
    for (const button of geometry) {
      expect(Math.abs(button.width - 30)).toBeLessThan(0.1)
      expect(Math.abs(button.height - 30)).toBeLessThan(0.1)
    }
    expect(Math.abs(geometry[1]!.top - geometry[0]!.top)).toBeGreaterThanOrEqual(34)
    await expect(page.locator('.translation-history-rail-connector-horizontal')).toHaveCount(2)
    await expect(page.locator('.translation-history-rail-connector-vertical')).toHaveCount(2)
    const visualGap = await page.evaluate(() => {
      const content = document.querySelector('.visual-editor .ProseMirror')!.getBoundingClientRect()
      const button = document.querySelector('.translation-history-rail-layer--visual button')!.getBoundingClientRect()
      const horizontal = document.querySelector<HTMLElement>('.translation-history-rail-connector-horizontal')!
      const vertical = document.querySelector<HTMLElement>('.translation-history-rail-connector-vertical')!
      return {
        gap: button.left - content.right,
        horizontalTransform: getComputedStyle(horizontal).transform,
        verticalTransform: getComputedStyle(vertical).transform,
      }
    })
    expect(visualGap.gap).toBeCloseTo(20, 1)
    expect(visualGap.horizontalTransform).toBe('none')
    expect(visualGap.verticalTransform).toBe('none')
  }
  expect(await visual.locator('.translation-history-highlight').evaluate((node) => getComputedStyle(node).backgroundColor))
    .toBe('rgba(124, 58, 237, 0.05)')
  expect(await visual.locator('.ProseMirror').evaluate((node) => node.getBoundingClientRect().width))
    .toBeCloseTo(baselineContentWidth, 1)

  await visualButtons.first().click()
  await expect(page.getByRole('complementary', { name: '右侧栏' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '翻译' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('visual translation one')).toBeVisible()
  const tabStyle = await page.locator('.editor-right-sidebar [role="tab"]').evaluate((node) => {
    const style = getComputedStyle(node)
    return {
      borderBottomColor: style.borderBottomColor,
      color: style.color,
      fontSize: style.fontSize,
      width: node.getBoundingClientRect().width,
    }
  })
  expect(tabStyle.fontSize).toBe('12px')
  expect(tabStyle.width).toBeCloseTo(36, 1)
  expect(tabStyle.color).toBe('rgba(124, 58, 237, 0.6)')
  expect(tabStyle.borderBottomColor).toBe('rgba(124, 58, 237, 0.6)')
  await expect(page.locator('.translation-history-view')).toBeVisible()
  await expect(page.locator('.translation-history-view h2')).toHaveCount(0)

  await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('.visual-editor .ProseMirror')!
    content.style.minHeight = '1600px'
    for (const anchor of content.querySelectorAll<HTMLElement>('[data-translation-history-anchor-id]')) {
      anchor.style.display = 'inline-block'
      anchor.style.transform = 'translateY(500px)'
    }
    const surface = document.querySelector<HTMLElement>('.editor-surface')!
    surface.scrollTop = 250
    surface.dispatchEvent(new Event('scroll'))
  })
  await page.getByRole('button', { name: '下一条' }).click()
  const visualTwo = page.locator('[data-record-id="visual-two"]')
  await expect(visualTwo).toBeVisible()
  await expect.poll(async () => await page.evaluate(() => {
    const surface = document.querySelector('.editor-surface')!.getBoundingClientRect()
    const button = document.querySelector('[data-record-id="visual-two"]')!.getBoundingClientRect()
    return Math.abs((button.top + button.height / 2) - (surface.top + surface.height / 2))
  })).toBeLessThan(2)
  await visualTwo.click()
  await expect(page.locator('.editor-right-sidebar')).toHaveCount(0)
  await expect(visualTwo).toBeFocused()

  await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('.editor-surface')!
    surface.scrollTop = 0;
    (window as typeof window & { translationRailFixture: { toggleMode(): void } })
      .translationRailFixture.toggleMode()
  })
  const source = page.locator('.source-editor')
  const sourceButtons = page.locator('.translation-history-rail-layer--source .translation-history-rail-button')
  await expect(source.locator('.translation-history-highlight').filter({ hasText: 'selected' }).first())
    .toContainText('selected')
  await expect(source.locator('[data-translation-history-anchor-id="source-one"]')).toHaveCount(1)
  await expect(sourceButtons).toHaveCount(2)
  await expect(surface).toHaveClass(/has-source-translation-history-rail/)
  const sourceGeometry = await page.evaluate(() => {
    const surface = document.querySelector('.editor-surface')!.getBoundingClientRect()
    const editor = document.querySelector('.source-editor .cm-editor')!.getBoundingClientRect()
    const button = document.querySelector('.translation-history-rail-layer--source button')!.getBoundingClientRect()
    return {
      buttonHeight: button.height,
      buttonWidth: button.width,
      contentGap: button.left - document.querySelector('.source-editor')!.getBoundingClientRect().right,
      reserved: surface.right - editor.right,
    }
  })
  expect(sourceGeometry.buttonWidth).toBeCloseTo(30, 1)
  expect(sourceGeometry.buttonHeight).toBeCloseTo(30, 1)
  expect(sourceGeometry.contentGap).toBeCloseTo(20, 1)
  expect(sourceGeometry.reserved).toBeCloseTo(50, 1)

  await sourceButtons.first().click()
  await expect(page.getByText('source translation')).toBeVisible()
  await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>('.source-editor .cm-content')!
    content.style.minHeight = '1600px'
    content.style.paddingTop = '500px'
    for (const anchor of content.querySelectorAll<HTMLElement>('[data-translation-history-anchor-id]')) {
      anchor.style.display = 'inline-block'
    }
    const scroller = document.querySelector<HTMLElement>('.source-editor .cm-scroller')!
    scroller.scrollTop = 250
    scroller.dispatchEvent(new Event('scroll'))
  })
  await page.getByRole('button', { name: '下一条' }).click()
  const sourceTwo = page.locator('[data-record-id="source-two"]')
  await expect(sourceTwo).toBeVisible()
  await expect.poll(async () => await page.evaluate(() => {
    const surface = document.querySelector('.editor-surface')!.getBoundingClientRect()
    const button = document.querySelector('[data-record-id="source-two"]')!.getBoundingClientRect()
    return Math.abs((button.top + button.height / 2) - (surface.top + surface.height / 2))
  })).toBeLessThan(2)

  await page.evaluate(() => {
    for (const anchor of document.querySelectorAll<HTMLElement>(
      '.source-editor [data-translation-history-anchor-id]',
    )) anchor.style.transform = 'translateY(1000px)'
    window.dispatchEvent(new Event('resize'))
  })
  await expect(sourceButtons).toHaveCount(0)
  await expect(surface).toHaveClass(/has-source-translation-history-rail/)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => {
    for (const anchor of document.querySelectorAll<HTMLElement>(
      '.source-editor [data-translation-history-anchor-id]',
    )) anchor.style.transform = ''
    window.dispatchEvent(new Event('resize'))
  })
  await expect(sourceButtons).toHaveCount(2)
  expect(await sourceButtons.first().evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0s')
  await sourceButtons.first().click()
  await expect(page.getByText('source translation')).toBeVisible()

  await page.evaluate(() => {
    (window as typeof window & { unmountTranslationRailFixture(): void }).unmountTranslationRailFixture()
  })
  await expect(page.locator('.translation-history-rail-layer')).toHaveCount(0)
})
