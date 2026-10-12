import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_PATH = '/__editor-margin-selection-fixture'
const VIRTUAL_FIXTURE_ID = 'virtual:editor-margin-selection-fixture'
const RESOLVED_FIXTURE_ID = `\0${VIRTUAL_FIXTURE_ID}`

const fixtureModule = String.raw`
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorPane } from '/src/renderer/editor/EditorPane.tsx'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '/src/shared/large-model-settings.ts'
import { modelObservation } from '/tests/helpers/model-observation.ts'
import '/src/renderer/app/styles.css'

const h = React.createElement
const paragraphs = Array.from({ length: 120 }, (_, index) =>
  'Paragraph ' + index + ' has enough words for forward and reverse margin selection coverage.'
)
const markdown = paragraphs.join('\n\n')
const richMarkdown = [
  '[Production link exclusion](https://example.com)',
  '',
  '| First | Second |',
  '| --- | --- |',
  '| Table cell | Value |',
  '',
  '![Production media exclusion](./production.png)',
  '',
  '\`\`\`typescript',
  'const structuredControl = true',
  '\`\`\`',
  '',
  ...paragraphs,
].join('\n')

window.arkdown = {
  cancelTranslation: async () => ({ ok: true, value: null }),
  getLargeModelSettings: async () => ({ ok: true, value: DEFAULT_LARGE_MODEL_SETTINGS }),
  getModelSettingsSnapshot: async () => ({ ok: true, value: modelObservation(DEFAULT_LARGE_MODEL_SETTINGS) }),
  onTranslationEvent: () => () => undefined,
  readClipboardFormats: async () => ({
    ok: true,
    value: { plainText: '', markdown: null, html: null },
  }),
}

function Fixture() {
  const [content, setContent] = useState(markdown)
  const [documentKey, setDocumentKey] = useState('margin-selection.md')
  const [mounted, setMounted] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  useEffect(() => {
    window.marginSelectionFixture = {
      loadRichDocument() {
        setContent(richMarkdown)
        setDocumentKey('margin-selection-rich.md')
      },
      switchDocument() {
        setContent(markdown.replace('Paragraph 0', 'Replacement document'))
        setDocumentKey('margin-selection-next.md')
      },
      setSidebarOpen,
      unmountEditor() { setMounted(false) },
      switchMode() {
        window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
          detail: 'toggle-source-mode',
        }))
      },
    }
  }, [])
  return h('main', { style: { width: '100vw', height: '100vh' } },
    mounted && h(EditorPane, {
      documentAbsolutePath: 'C:\\Fixture\\margin-selection.md',
      documentKey,
      markdown: content,
      onChange: setContent,
      onOpenLargeModelSettings() {},
      rightSidebarState: { open: sidebarOpen, activeTab: 'translation' },
      onOpenRightSidebar() {},
      onCloseRightSidebar() { setSidebarOpen(false) },
    }),
  )
}

createRoot(document.querySelector('#fixture-root')).render(h(Fixture))
`

let vite: ViteDevServer | undefined
let fixtureUrl = ''

test.beforeAll(async () => {
  vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{
      name: 'editor-margin-selection-playwright-fixture',
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
  const address = vite.httpServer?.address() as AddressInfo | null
  if (!address || typeof address === 'string') throw new Error('Ephemeral Vite address unavailable')
  fixtureUrl = `http://127.0.0.1:${address.port}${FIXTURE_PATH}`
})

test.afterAll(async () => {
  await vite?.close()
  vite = undefined
})

async function visualPoints(page: Page, reverse = false) {
  return page.evaluate((isReverse) => {
    const surface = document.querySelector<HTMLElement>('.editor-surface')!
    const proseMirror = document.querySelector<HTMLElement>('.ProseMirror')!
    const paragraphs = proseMirror.querySelectorAll<HTMLElement>('p')
    const surfaceRect = surface.getBoundingClientRect()
    const editorRect = proseMirror.getBoundingClientRect()
    const first = paragraphs[isReverse ? 8 : 2]!.getBoundingClientRect()
    const last = paragraphs[isReverse ? 2 : 8]!.getBoundingClientRect()
    return {
      start: {
        x: isReverse
          ? (editorRect.right + surfaceRect.right - 12) / 2
          : (surfaceRect.left + editorRect.left) / 2,
        y: first.top + first.height / 2,
      },
      end: { x: last.left + Math.min(80, last.width / 2), y: last.top + last.height / 2 },
    }
  }, reverse)
}

async function drag(page: Page, points: { start: { x: number; y: number }; end: { x: number; y: number } }) {
  await page.mouse.move(points.start.x, points.start.y)
  await page.mouse.down()
  await page.mouse.move(points.end.x, points.end.y, { steps: 8 })
  await page.mouse.up()
}

async function selectedText(page: Page) {
  return page.evaluate(() => window.getSelection()?.toString() ?? '')
}

async function installCaptureProbe(page: Page) {
  await page.locator('.editor-surface').evaluate((surface) => {
    surface.dataset.marginCaptureCount = '0'
    surface.dataset.marginReleaseCount = '0'
    if (surface.dataset.marginCaptureProbeInstalled === 'true') return
    surface.dataset.marginCaptureProbeInstalled = 'true'
    const activePointers = new Set()
    const setPointerCapture = surface.setPointerCapture.bind(surface)
    const releasePointerCapture = surface.releasePointerCapture.bind(surface)
    surface.setPointerCapture = (pointerId) => {
      setPointerCapture(pointerId)
      activePointers.add(pointerId)
      surface.dataset.marginCaptureCount = String(Number(surface.dataset.marginCaptureCount) + 1)
    }
    surface.releasePointerCapture = (pointerId) => {
      const wasCaptured = activePointers.delete(pointerId)
      try {
        releasePointerCapture(pointerId)
      } finally {
        if (wasCaptured) {
          surface.dataset.marginReleaseCount = String(Number(surface.dataset.marginReleaseCount) + 1)
        }
      }
    }
  })
}

async function captureCounts(page: Page) {
  return page.locator('.editor-surface').evaluate((surface) => ({
    captured: Number(surface.dataset.marginCaptureCount),
    released: Number(surface.dataset.marginReleaseCount),
  }))
}

async function startActiveVisualGesture(page: Page) {
  const points = await visualPoints(page)
  await page.mouse.move(points.start.x, points.start.y)
  await page.mouse.down()
  await page.mouse.move(points.end.x, points.end.y, { steps: 8 })
  await expect.poll(async () => (await captureCounts(page)).captured).toBeGreaterThan(0)
}

async function switchSourceMode(page: Page) {
  await page.evaluate(() => (window as typeof window & {
    marginSelectionFixture: { switchMode(): void }
  }).marginSelectionFixture.switchMode())
  await expect(page.locator('.source-editor .cm-content')).toBeVisible()
}

test('selects long Visual documents from both margins and Source documents from the right margin with native translation provenance', async ({ page }, testInfo) => {
  await page.goto(fixtureUrl)
  expect(await page.evaluate(() => devicePixelRatio)).toBe(testInfo.project.metadata.requestedDpr)
  await expect(page.locator('.ProseMirror')).toBeVisible()
  const ordinary = await page.locator('.ProseMirror p').nth(1).boundingBox()
  if (!ordinary) throw new Error('Visual paragraph geometry unavailable')
  await drag(page, {
    start: { x: ordinary.x + 8, y: ordinary.y + ordinary.height / 2 },
    end: { x: ordinary.x + Math.min(160, ordinary.width - 8), y: ordinary.y + ordinary.height / 2 },
  })
  await expect(page.locator('.translation-popover')).toBeVisible()
  await page.reload()
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await installCaptureProbe(page)

  const forwardVisual = await visualPoints(page)
  await drag(page, { start: forwardVisual.start, end: forwardVisual.start })
  expect(await selectedText(page)).toBe('')
  await expect(page.locator('.editor-surface')).toHaveAttribute('data-margin-capture-count', '0')

  await drag(page, forwardVisual)
  await expect.poll(() => selectedText(page)).not.toBe('')
  await expect(page.locator('.editor-surface')).toHaveAttribute('data-margin-capture-count', '1')
  expect(await page.evaluate(() => {
    const selection = window.getSelection()
    const range = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null
    const proseMirror = document.querySelector('.ProseMirror')!
    return Boolean(
      range
      && proseMirror.contains(range.startContainer)
      && proseMirror.contains(range.endContainer)
    )
  })).toBe(true)
  await expect(page.locator('.translation-popover')).toBeVisible()

  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await drag(page, await visualPoints(page, true))
  await expect.poll(() => selectedText(page)).not.toBe('')

  await switchSourceMode(page)
  const sourcePoints = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!
    const lines = document.querySelectorAll<HTMLElement>('.cm-line')
    const scrollRect = scroller.getBoundingClientRect()
    const first = lines[2]!.getBoundingClientRect()
    const last = lines[8]!.getBoundingClientRect()
    return {
      start: { x: scrollRect.right - 32, y: first.top + first.height / 2 },
      end: { x: last.left + 40, y: last.top + last.height / 2 },
    }
  })
  await drag(page, { start: sourcePoints.start, end: sourcePoints.start })
  await expect(page.locator('.cm-selectionBackground')).toHaveCount(0)
  await drag(page, sourcePoints)
  await expect(page.locator('.cm-selectionBackground')).not.toHaveCount(0)
  await expect(page.locator('.translation-popover')).toBeVisible()

  await drag(page, { start: { ...sourcePoints.start, y: sourcePoints.end.y }, end: { ...sourcePoints.end, y: sourcePoints.start.y } })
  await expect(page.locator('.cm-selectionBackground')).not.toHaveCount(0)
})

test('autoscrolls after activation and suppresses new gestures during sidebar motion', async ({ page }) => {
  await page.goto(fixtureUrl)
  await expect(page.locator('.ProseMirror')).toBeVisible()
  const surface = page.locator('.editor-surface')
  const points = await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('.editor-surface')!
    const proseMirror = document.querySelector<HTMLElement>('.ProseMirror')!
    const surfaceRect = surface.getBoundingClientRect()
    const editorRect = proseMirror.getBoundingClientRect()
    return {
      start: { x: (surfaceRect.left + editorRect.left) / 2, y: surfaceRect.top + 140 },
      end: { x: editorRect.left + 80, y: surfaceRect.bottom - 4 },
    }
  })
  await page.mouse.move(points.start.x, points.start.y)
  await page.mouse.down()
  await page.mouse.move(points.end.x, points.end.y, { steps: 8 })
  await page.waitForTimeout(300)
  expect(await surface.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await page.mouse.up()

  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges()
    ;(window as typeof window & {
      marginSelectionFixture: { setSidebarOpen(open: boolean): void }
    }).marginSelectionFixture.setSidebarOpen(true)
  })
  await expect(page.locator('.editor-right-sidebar-motion-track')).toHaveAttribute(
    'data-phase',
    /entering|opening/,
  )
  await drag(page, await visualPoints(page))
  expect(await selectedText(page)).toBe('')
})

test('requires text entry before autoscroll and covers Source right-margin scrolling and left-gutter exclusion', async ({ page }) => {
  await page.goto(fixtureUrl)
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await installCaptureProbe(page)
  const visualCandidate = await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('.editor-surface')!
    const proseMirror = document.querySelector<HTMLElement>('.ProseMirror')!
    const surfaceRect = surface.getBoundingClientRect()
    const contentRect = proseMirror.getBoundingClientRect()
    return {
      start: { x: (surfaceRect.left + contentRect.left) / 2, y: surfaceRect.top + 120 },
      end: { x: (surfaceRect.left + contentRect.left) / 2, y: surfaceRect.bottom - 3 },
    }
  })
  const visualScrollBefore = await page.locator('.editor-surface').evaluate((surface) => surface.scrollTop)
  await drag(page, visualCandidate)
  expect(await page.locator('.editor-surface').evaluate((surface) => surface.scrollTop))
    .toBe(visualScrollBefore)
  expect(await captureCounts(page)).toEqual({ captured: 0, released: 0 })
  expect(await selectedText(page)).toBe('')

  await switchSourceMode(page)
  await installCaptureProbe(page)
  const sourceGeometry = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.source-editor .cm-scroller')!
    const gutter = document.querySelector<HTMLElement>('.source-editor .cm-gutters')!
    const lines = document.querySelectorAll<HTMLElement>('.source-editor .cm-line')
    const scrollRect = scroller.getBoundingClientRect()
    const gutterRect = gutter.getBoundingClientRect()
    const first = lines[2]!.getBoundingClientRect()
    return {
      gutter: {
        start: { x: gutterRect.left + gutterRect.width / 2, y: first.top + first.height / 2 },
        end: { x: first.left + 80, y: first.top + first.height / 2 },
      },
      scroll: {
        start: { x: scrollRect.right - 32, y: first.top + first.height / 2 },
        end: { x: first.left + 80, y: scrollRect.bottom - 3 },
      },
    }
  })
  await drag(page, sourceGeometry.gutter)
  expect(await captureCounts(page)).toEqual({ captured: 0, released: 0 })

  const sourceScroller = page.locator('.source-editor .cm-scroller')
  expect(await sourceScroller.evaluate((scroller) => scroller.scrollTop)).toBe(0)
  await page.mouse.move(sourceGeometry.scroll.start.x, sourceGeometry.scroll.start.y)
  await page.mouse.down()
  await page.mouse.move(sourceGeometry.scroll.end.x, sourceGeometry.scroll.end.y, { steps: 10 })
  await page.waitForTimeout(300)
  expect(await sourceScroller.evaluate((scroller) => scroller.scrollTop)).toBeGreaterThan(0)
  expect((await captureCounts(page)).captured).toBe(1)
  await page.mouse.up()
})

test('keeps real tables, media, links, structured controls, gutters, and scrollbars outside margin gestures', async ({ page }) => {
  await page.goto(fixtureUrl)
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await page.evaluate(() => (window as typeof window & {
    marginSelectionFixture: { loadRichDocument(): void }
  }).marginSelectionFixture.loadRichDocument())
  await expect(page.locator('.ProseMirror .tableWrapper td').first()).toBeVisible()
  await expect(page.locator('.ProseMirror a').first()).toBeVisible()
  await expect(page.locator('.ProseMirror .arkdown-local-image').first()).toBeVisible()
  await expect(page.locator('.ProseMirror .milkdown-code-block .tools button').first()).toBeVisible()
  await installCaptureProbe(page)

  const visualExclusions = [
    page.locator('.ProseMirror .tableWrapper td').first(),
    page.locator('.ProseMirror a').first(),
    page.locator('.ProseMirror .arkdown-local-image').first(),
    page.locator('.ProseMirror .milkdown-code-block .tools button').first(),
  ]
  for (const exclusion of visualExclusions) {
    await exclusion.scrollIntoViewIfNeeded()
    const box = await exclusion.boundingBox()
    if (!box) throw new Error('Production exclusion geometry unavailable')
    await drag(page, {
      start: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      end: { x: box.x + box.width / 2 + 32, y: box.y + box.height / 2 + 8 },
    })
  }
  const visualScrollbar = await page.locator('.editor-surface').boundingBox()
  if (!visualScrollbar) throw new Error('Visual scrollbar geometry unavailable')
  await drag(page, {
    start: { x: visualScrollbar.x + visualScrollbar.width - 3, y: visualScrollbar.y + 180 },
    end: { x: visualScrollbar.x + visualScrollbar.width - 3, y: visualScrollbar.y + 240 },
  })
  expect(await captureCounts(page)).toEqual({ captured: 0, released: 0 })

  await switchSourceMode(page)
  await installCaptureProbe(page)
  const sourceExclusions = await page.evaluate(() => {
    const gutter = document.querySelector<HTMLElement>('.source-editor .cm-gutters')!
    const scroller = document.querySelector<HTMLElement>('.source-editor .cm-scroller')!
    const gutterRect = gutter.getBoundingClientRect()
    const scrollRect = scroller.getBoundingClientRect()
    return {
      gutter: { x: gutterRect.left + gutterRect.width / 2, y: gutterRect.top + 90 },
      scrollbar: { x: scrollRect.right - 3, y: scrollRect.top + 180 },
    }
  })
  await drag(page, {
    start: sourceExclusions.gutter,
    end: { x: sourceExclusions.gutter.x + 120, y: sourceExclusions.gutter.y + 16 },
  })
  await drag(page, {
    start: sourceExclusions.scrollbar,
    end: { x: sourceExclusions.scrollbar.x, y: sourceExclusions.scrollbar.y + 60 },
  })
  expect(await captureCounts(page)).toEqual({ captured: 0, released: 0 })
})

test('does not export a seeded Source selection after candidate cancellation or interruption', async ({ page }) => {
  await page.goto(fixtureUrl)
  await switchSourceMode(page)
  const sourcePoints = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.source-editor .cm-scroller')!
    const line = document.querySelectorAll<HTMLElement>('.source-editor .cm-line')[2]!
    const scrollRect = scroller.getBoundingClientRect()
    const lineRect = line.getBoundingClientRect()
    return {
      selectionStart: { x: lineRect.left + 16, y: lineRect.top + lineRect.height / 2 },
      selectionEnd: { x: lineRect.left + 180, y: lineRect.top + lineRect.height / 2 },
      margin: { x: scrollRect.right - 32, y: lineRect.top + lineRect.height / 2 },
    }
  })
  await drag(page, { start: sourcePoints.selectionStart, end: sourcePoints.selectionEnd })
  await expect(page.locator('.source-editor .cm-selectionBackground')).not.toHaveCount(0)
  await expect(page.locator('.translation-popover')).toBeVisible()
  await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      isPrimary: true,
      pointerId: 77,
      pointerType: 'mouse',
    }))
  })
  await expect(page.locator('.translation-popover')).toHaveCount(0)
  await expect(page.locator('.source-editor .cm-selectionBackground')).not.toHaveCount(0)

  await page.mouse.move(sourcePoints.margin.x, sourcePoints.margin.y)
  await page.mouse.down()
  await page.mouse.move(sourcePoints.margin.x, sourcePoints.margin.y + 28)
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: y,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
    }))
  }, { x: sourcePoints.margin.x, y: sourcePoints.margin.y + 28 })
  await page.mouse.up()
  await expect(page.locator('.translation-popover')).toHaveCount(0)

  await page.mouse.move(sourcePoints.margin.x, sourcePoints.margin.y)
  await page.mouse.down()
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.source-editor .cm-content')
      ?.dispatchEvent(new DragEvent('dragstart', { bubbles: true }))
  })
  await page.mouse.up()
  await expect(page.locator('.translation-popover')).toHaveCount(0)

  await page.mouse.move(sourcePoints.margin.x, sourcePoints.margin.y)
  await page.mouse.down()
  await page.evaluate(({ x, y }) => {
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: y,
      isPrimary: true,
      pointerId: 99,
      pointerType: 'mouse',
    }))
  }, sourcePoints.margin)
  await expect(page.locator('.translation-popover')).toHaveCount(0)
  await page.evaluate(({ x, y }) => {
    window.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true,
      button: 0,
      clientX: x,
      clientY: y,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
    }))
  }, sourcePoints.margin)
  await page.mouse.up()
  await expect(page.locator('.translation-popover')).toHaveCount(0)
})

test('cancels active gestures on sidebar opening and closing without exporting stale translation', async ({ page }) => {
  await page.goto(fixtureUrl)
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await installCaptureProbe(page)

  await startActiveVisualGesture(page)
  await page.evaluate(() => (window as typeof window & {
    marginSelectionFixture: { setSidebarOpen(open: boolean): void }
  }).marginSelectionFixture.setSidebarOpen(true))
  await expect.poll(async () => (await captureCounts(page)).released).toBe(1)
  await page.mouse.move(240, 420)
  await page.mouse.up()
  await expect(page.locator('.translation-popover')).toHaveCount(0)
  await expect(page.locator('.editor-right-sidebar-motion-track')).toHaveAttribute('data-phase', 'open')

  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await startActiveVisualGesture(page)
  await page.evaluate(() => (window as typeof window & {
    marginSelectionFixture: { setSidebarOpen(open: boolean): void }
  }).marginSelectionFixture.setSidebarOpen(false))
  await expect.poll(async () => (await captureCounts(page)).released).toBe(2)
  await page.mouse.move(260, 440)
  await page.mouse.up()
  await expect(page.locator('.translation-popover')).toHaveCount(0)
})

test('clears active gesture state across mode, document, and unmount lifecycles', async ({ page }) => {
  await page.goto(fixtureUrl)
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await installCaptureProbe(page)
  await startActiveVisualGesture(page)
  await switchSourceMode(page)
  await page.mouse.up()
  await expect(page.locator('.translation-popover')).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await installCaptureProbe(page)
  await startActiveVisualGesture(page)
  await page.evaluate(() => (window as typeof window & {
    marginSelectionFixture: { switchDocument(): void }
  }).marginSelectionFixture.switchDocument())
  await expect(page.locator('.ProseMirror')).toContainText('Replacement document')
  await page.mouse.up()
  await expect(page.locator('.translation-popover')).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.ProseMirror')).toBeVisible()
  await installCaptureProbe(page)
  await startActiveVisualGesture(page)
  await page.evaluate(() => (window as typeof window & {
    marginSelectionFixture: { unmountEditor(): void }
  }).marginSelectionFixture.unmountEditor())
  await expect(page.locator('.editor-pane')).toHaveCount(0)
  await page.mouse.up()
  await expect(page.locator('.translation-popover')).toHaveCount(0)
})
