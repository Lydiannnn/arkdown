import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { IPC_CHANNELS } from '../../src/shared/contracts'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_SESSION_ID = '22222222-2222-4222-8222-222222222222'
const IMAGE_WIDTH = 800
const IMAGE_HEIGHT = 400
const RESPONSIVE_TRANSLATION = '响应式长译文需要在侧栏关闭后重新测量并恢复显示。'.repeat(8)
const OCR_BLOCKS = [
  {
    id: 'line-1',
    text: 'FIRST SOURCE LINE',
    rectPx: { x: 80, y: 70, width: 240, height: 48 },
    words: [{ text: 'FIRST SOURCE LINE', rectPx: { x: 80, y: 70, width: 240, height: 48 } }],
  },
  {
    id: 'line-2',
    text: 'Second source text for geometry',
    rectPx: { x: 400, y: 230, width: 300, height: 64 },
    words: [{ text: 'Second source text for geometry', rectPx: { x: 400, y: 230, width: 300, height: 64 } }],
  },
  {
    id: 'line-3',
    text: 'Responsive source',
    rectPx: { x: 120, y: 310, width: 260, height: 40 },
    words: [{ text: 'Responsive source', rectPx: { x: 120, y: 310, width: 260, height: 40 } }],
  },
  {
    id: 'line-4',
    text: 'Tiny source',
    rectPx: { x: 12, y: 344, width: 34, height: 18 },
    words: [{ text: 'Tiny source', rectPx: { x: 12, y: 344, width: 34, height: 18 } }],
  },
] as const
const TRANSLATIONS = [
  { id: 'line-1', text: '第一行译文' },
  { id: 'line-2', text: 'A translated geometry line that wraps cleanly inside the source rectangle.' },
  { id: 'line-3', text: RESPONSIVE_TRANSLATION },
  { id: 'line-4', text: 'This translation can never fit in the tiny source rectangle.' },
] as const
const COMPLETE_OCR_BLOCKS = OCR_BLOCKS.slice(0, 2)
const COMPLETE_TRANSLATIONS = TRANSLATIONS.slice(0, 2)
const DOCUMENT_OCR_BLOCKS = Array.from({ length: 12 }, (_, index) => {
  const text = `Document source line ${index + 1}`
  const rectPx = { x: 60, y: 30 + index * 28, width: 680, height: 24 }
  return { id: `line-${index + 1}`, text, rectPx, words: [{ text, rectPx }] }
})
const DOCUMENT_PROGRESS_TEXT = Array.from(
  { length: 80 },
  (_, index) => `第 ${index + 1} 行流式文档译文。`,
).join('\n')

interface FixtureCommand {
  channel: string
  input: { generation?: number; sessionId?: string } | undefined
}

let vite: ViteDevServer | undefined
let fixtureUrl = ''
let screenshotSelectionCss = ''

test.beforeAll(async () => {
  const productionHtml = await readFile(path.resolve('src/renderer/index.html'), 'utf8')
  const fixturePath = path.resolve(
    'tests/e2e/fixtures/screenshot-translation-layout-fixture.tsx',
  ).replaceAll('\\', '/')
  screenshotSelectionCss = await readFile(
    path.resolve('src/renderer/screenshot/screenshot-selection.css'),
    'utf8',
  )
  vite = await createServer({
    cacheDir: path.resolve('.native-cache/vite-screenshot-layout', String(process.pid)),
    configFile: path.resolve('vite.renderer.config.ts'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    plugins: [{
      name: 'screenshot-translation-layout-fixture',
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/') {
            next()
            return
          }
          const fixtureHtml = productionHtml.replace(
            '<script type="module" src="/main.tsx"></script>',
            `<script type="module" src="/@fs/${fixturePath}"></script>`,
          )
          const html = await server.transformIndexHtml(request.url ?? '/', fixtureHtml)
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
  fixtureUrl = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await vite?.close()
  vite = undefined
})

async function openSurface(page: Page, sessionId = SESSION_ID, sidebarOpen = false): Promise<void> {
  await page.goto(`${fixtureUrl}/?surface=screenshot-translation&sessionId=${sessionId}`)
  await page.evaluate(async () => await window.screenshotLayoutFixture.ready)
  await expect(page.locator('.screenshot-result-window')).toBeVisible()
  if (!sidebarOpen) {
    await page.getByRole('button', { name: '关闭侧窗', exact: true }).click()
  }
}

test('opens the extraction sidebar by default and labels actions by the destination view', async ({ page }) => {
  await openSurface(page, SESSION_ID, true)
  await expect(page.getByRole('complementary', { name: '提取的文字' })).toBeVisible()
  await expect(page.getByRole('button', { name: '关闭侧窗', exact: true })).toHaveAttribute('aria-expanded', 'true')
  await snapshot(page)
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'ocr-completed', blocks: COMPLETE_OCR_BLOCKS })
  await expect(page.getByRole('button', { name: '显示译文', exact: true })).toBeEnabled()
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'translation-completed', translations: COMPLETE_TRANSLATIONS })
  await expect(page.getByRole('button', { name: '显示原文', exact: true })).toBeEnabled()
  await expect(page.getByRole('complementary')).toContainText('第一行译文')
  await page.getByRole('button', { name: '显示原文', exact: true }).click()
  await expect(page.getByRole('complementary')).toContainText('FIRST SOURCE LINE')
  await page.getByRole('button', { name: '关闭侧窗', exact: true }).click()
  await expect(page.getByRole('button', { name: '打开侧窗', exact: true })).toHaveAttribute('aria-expanded', 'false')
})

async function emit(page: Page, event: unknown): Promise<void> {
  await page.evaluate((payload) => window.screenshotLayoutFixture.emit(payload), event)
}

async function snapshot(page: Page, generation = 1): Promise<void> {
  const dataUrl = await page.evaluate(() => window.screenshotLayoutFixture.createImage())
  await emit(page, {
    sessionId: SESSION_ID,
    generation,
    type: 'snapshot-ready',
    tier: 'small',
    image: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, dataUrl },
  })
  await expect(page.getByRole('img', { name: '截图原文' })).toBeVisible()
  await expect.poll(async () => await page.getByRole('img', { name: '截图原文' }).evaluate(
    (image) => ({ width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight }),
  )).toEqual({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT })
}

async function translated(page: Page, generation = 1): Promise<void> {
  await snapshot(page, generation)
  await emit(page, { sessionId: SESSION_ID, generation, type: 'ocr-completed', blocks: COMPLETE_OCR_BLOCKS })
  await emit(page, { sessionId: SESSION_ID, generation, type: 'translation-started' })
  await emit(page, {
    sessionId: SESSION_ID,
    generation,
    type: 'translation-completed',
    translations: COMPLETE_TRANSLATIONS,
  })
  await expect(page.locator('.screenshot-result-viewport').getByText('第一行译文', { exact: true })).toBeVisible()
}

function containOracle(viewport: DOMRect, imageWidth: number, imageHeight: number) {
  const scale = Math.min(viewport.width / imageWidth, viewport.height / imageHeight)
  const width = imageWidth * scale
  const height = imageHeight * scale
  return {
    left: viewport.left + (viewport.width - width) / 2,
    top: viewport.top + (viewport.height - height) / 2,
    width,
    height,
    scale,
  }
}

async function assertBlockGeometry(page: Page, dpr: number, blockId: 'line-1' | 'line-2') {
  const block = OCR_BLOCKS.find((candidate) => candidate.id === blockId)!
  const geometry = await page.evaluate(({ id, imageWidth, imageHeight, rectPx }) => {
    const viewport = document.querySelector('.screenshot-result-viewport')!.getBoundingClientRect()
    const translatedBlock = document.querySelector<HTMLElement>(`.screenshot-translated-block[data-block-id="${id}"]`)
      ?? [...document.querySelectorAll<HTMLElement>('.screenshot-translated-block')]
        .find((element) => element.textContent?.includes(id === 'line-1' ? '第一行译文' : 'translated geometry'))
    if (!translatedBlock) throw new Error(`Translated block ${id} unavailable`)
    const actual = translatedBlock.getBoundingClientRect()
    const scale = Math.min(viewport.width / imageWidth, viewport.height / imageHeight)
    const imageLeft = viewport.left + (viewport.width - imageWidth * scale) / 2
    const imageTop = viewport.top + (viewport.height - imageHeight * scale) / 2
    return {
      actual: { left: actual.left, top: actual.top, right: actual.right, bottom: actual.bottom },
      expected: {
        left: imageLeft + rectPx.x * scale,
        top: imageTop + rectPx.y * scale,
        right: imageLeft + (rectPx.x + rectPx.width) * scale,
        bottom: imageTop + (rectPx.y + rectPx.height) * scale,
      },
    }
  }, { id: blockId, imageWidth: IMAGE_WIDTH, imageHeight: IMAGE_HEIGHT, rectPx: block.rectPx })
  for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
    expect(Math.abs(geometry.actual[edge] - geometry.expected[edge]) * dpr).toBeLessThanOrEqual(1.1)
  }
}

async function fixtureCommands(page: Page): Promise<readonly FixtureCommand[]> {
  return await page.evaluate(() => window.screenshotLayoutFixture.commands()) as readonly FixtureCommand[]
}

async function assertCompleteTranslationIds(page: Page, expectedIds: readonly string[]): Promise<void> {
  expect(new Set(expectedIds).size).toBe(expectedIds.length)
  const translatedBlocks = page.locator('.screenshot-translated-block')
  await expect(translatedBlocks).toHaveCount(expectedIds.length)
}

async function dragSelectText(page: Page, selector: string): Promise<string> {
  const points = await page.locator(selector).first().evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let current = walker.nextNode()
    while (current) {
      if ((current.textContent ?? '').length > 0) nodes.push(current as Text)
      current = walker.nextNode()
    }
    const first = nodes[0]
    const last = nodes.at(-1)
    if (!first || !last) throw new Error('Selectable text nodes unavailable')
    const point = (node: Text, offset: number, end: boolean) => {
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, Math.min(node.length, offset + 1))
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect()
      return {
        x: end ? rect.right - Math.min(1, rect.width / 4) : rect.left + Math.min(1, rect.width / 4),
        y: rect.top + rect.height / 2,
      }
    }
    return {
      start: point(first, 0, false),
      end: point(last, Math.max(0, last.length - 1), true),
    }
  })
  await page.mouse.move(points.start.x, points.start.y)
  await page.mouse.down()
  await page.mouse.move(points.end.x, points.end.y, { steps: 10 })
  await page.mouse.up()
  return await page.evaluate(() => window.getSelection()?.toString() ?? '')
}

test('boots only the exact route and rejects invalid session, wrong-session and stale events', async ({ page }) => {
  await openSurface(page, 'invalid-session')
  await emit(page, {
    sessionId: SESSION_ID,
    generation: 1,
    type: 'snapshot-ready',
    tier: 'small',
    image: { width: 800, height: 400, dataUrl: await page.evaluate(() => window.screenshotLayoutFixture.createImage()) },
  })
  await expect(page.getByRole('img', { name: '截图原文' })).toHaveCount(0)

  await openSurface(page)
  const dataUrl = await page.evaluate(() => window.screenshotLayoutFixture.createImage())
  await emit(page, { sessionId: SESSION_ID, generation: 3, type: 'snapshot-ready', tier: 'small', image: { width: 800, height: 400, dataUrl }, extra: true })
  await expect(page.getByRole('img', { name: '截图原文' })).toHaveCount(0)
  await emit(page, { sessionId: OTHER_SESSION_ID, generation: 3, type: 'snapshot-ready', tier: 'small', image: { width: 800, height: 400, dataUrl } })
  await expect(page.getByRole('img', { name: '截图原文' })).toHaveCount(0)
  await emit(page, { sessionId: SESSION_ID, generation: 2, type: 'snapshot-ready', tier: 'small', image: { width: 800, height: 400, dataUrl } })
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'ocr-completed', blocks: OCR_BLOCKS })
  await expect(page.getByRole('button', { name: '识别文字中…', exact: true })).toBeDisabled()
})

test('runs deterministic inference through one real module Worker for a small mixed-script crop', async ({ page }) => {
  await openSurface(page)
  const dataUrl = await page.evaluate(() => window.screenshotLayoutFixture.createSmallImage())
  await emit(page, {
    sessionId: SESSION_ID,
    generation: 1,
    type: 'snapshot-ready',
    tier: 'small',
    image: { width: 40, height: 20, dataUrl },
  })
  await page.evaluate(({ sessionId, dataUrl }) => window.screenshotLayoutFixture.emitOcrHost({
    type: 'recognize', sessionId, generation: 1,
    image: { width: 40, height: 20, dataUrl }, tier: 'small', cacheKey: 'small:6.0.0',
  }), { sessionId: SESSION_ID, dataUrl })
  await expect.poll(async () => (await fixtureCommands(page)).filter(
    ({ channel }) => channel === IPC_CHANNELS.submitScreenshotOcr,
  ).length).toBe(1)
  const first = (await fixtureCommands(page)).find(({ channel }) => channel === IPC_CHANNELS.submitScreenshotOcr)!
  expect(first.input).toEqual({
    sessionId: SESSION_ID,
    generation: 1,
    status: 'success',
    result: {
      width: 40,
      height: 20,
      language: 'mul',
      blocks: [
        { id: 'line-1', text: 'Codex', rectPx: { x: 0, y: 0, width: 20, height: 10 }, words: [{ text: 'Codex', rectPx: { x: 0, y: 0, width: 20, height: 10 } }] },
        { id: 'line-2', text: '中英混合', rectPx: { x: 20, y: 10, width: 20, height: 10 }, words: [{ text: '中英混合', rectPx: { x: 20, y: 10, width: 20, height: 10 } }] },
      ],
    },
  })
  expect(await page.evaluate(() => window.screenshotLayoutFixture.workerStats())).toEqual({ created: 1, terminated: 0 })
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'ocr-completed', blocks: (first.input as { result: { blocks: unknown[] } }).result.blocks })
  await expect(page.getByRole('button', { name: '显示译文', exact: true })).toBeEnabled()
})

test('keeps exact contain geometry and two translated blocks aligned at both viewport sizes', async ({ page }, testInfo) => {
  const dpr = Number(testInfo.project.metadata.requestedDpr)
  for (const viewport of [{ width: 480, height: 320 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport)
    await openSurface(page)
    await translated(page)
    const measured = await page.evaluate(() => {
      const viewport = document.querySelector('.screenshot-result-viewport')!.getBoundingClientRect()
      const image = document.querySelector<HTMLImageElement>('.screenshot-result-viewport > img')!
      return {
        viewport: { left: viewport.left, top: viewport.top, width: viewport.width, height: viewport.height },
        image: { width: image.naturalWidth, height: image.naturalHeight },
      }
    })
    const expected = containOracle(measured.viewport as DOMRect, measured.image.width, measured.image.height)
    expect(expected.width).toBeGreaterThan(0)
    expect(expected.height).toBeGreaterThan(0)
    await assertBlockGeometry(page, dpr, 'line-1')
    await assertBlockGeometry(page, dpr, 'line-2')
    await expect(page.locator('.screenshot-translated-block').first()).toHaveCSS(
      'background-color', 'rgba(21, 21, 21, 0.86)',
    )
    await expect(page.locator('.screenshot-translated-block').first()).toHaveCSS('border-radius', '4px')
    expect(await page.locator('.screenshot-translated-block').first().evaluate(
      (element) => getComputedStyle(element).backdropFilter,
    )).toContain('blur(3px)')
  }
})

test('uses equal toolbar widths and restores cached translations without a new request', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openSurface(page)
  await translated(page)

  const toolbarButtons = page.locator('.screenshot-result-toolbar button')
  await expect(toolbarButtons).toHaveCount(3)
  const widths = await toolbarButtons.evaluateAll((buttons) => buttons.map(
    (button) => button.getBoundingClientRect().width,
  ))
  expect(new Set(widths.map((width) => Math.round(width * 100) / 100)).size).toBe(1)

  await page.evaluate(() => window.screenshotLayoutFixture.clearCommands())
  await page.getByRole('button', { name: '显示原文', exact: true }).click()
  await expect(page.locator('.screenshot-translated-block')).toHaveCount(0)
  await page.getByRole('button', { name: '显示译文', exact: true }).click()
  await expect(page.getByText(COMPLETE_TRANSLATIONS[0].text, { exact: true })).toBeVisible()
  expect((await fixtureCommands(page)).filter(
    ({ channel }) => channel === IPC_CHANNELS.startScreenshotTranslation,
  )).toHaveLength(0)

  await page.getByRole('button', { name: '打开侧窗', exact: true }).click()
  await expect(page.getByRole('button', { name: '关闭侧窗', exact: true })).toHaveCSS('width', `${widths[0]}px`)
  await page.getByRole('button', { name: '重新翻译', exact: true }).click()
  await expect.poll(async () => (await fixtureCommands(page)).filter(
    ({ channel }) => channel === IPC_CHANNELS.startScreenshotTranslation,
  ).length).toBe(1)
})

test('renders every translated ID and keeps source OCR retryable after a batch failure', async ({ page }) => {
  await openSurface(page)
  await snapshot(page)
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'ocr-completed', blocks: COMPLETE_OCR_BLOCKS })
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'translation-started' })
  await emit(page, {
    sessionId: SESSION_ID,
    generation: 1,
    type: 'translation-completed',
    translations: COMPLETE_TRANSLATIONS,
  })
  await assertCompleteTranslationIds(page, COMPLETE_OCR_BLOCKS.map(({ id }) => id))

  await snapshot(page, 2)
  await emit(page, { sessionId: SESSION_ID, generation: 2, type: 'ocr-completed', blocks: OCR_BLOCKS })
  await emit(page, { sessionId: SESSION_ID, generation: 2, type: 'translation-started' })
  await emit(page, {
    sessionId: SESSION_ID,
    generation: 2,
    type: 'failed',
    stage: 'translation',
    code: 'TRANSLATION_FAILED',
  })
  await expect(page.getByRole('img', { name: '截图原文' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('翻译未能完成，请尝试将窗口拉大后重试')
  await expect(page.getByRole('button', { name: '显示译文', exact: true })).toBeEnabled()
  await expect(page.locator('.screenshot-translated-block')).toHaveCount(0)
  await page.getByRole('button', { name: '打开侧窗', exact: true }).click()
  await expect(page.locator('.screenshot-text-sidebar__content p:not(.screenshot-text-sidebar__empty)'))
    .toHaveCount(OCR_BLOCKS.length)
})

test('uses a 320px desktop sidebar and keeps both panes beside each other when narrow', async ({ page }, testInfo) => {
  const dpr = Number(testInfo.project.metadata.requestedDpr)
  await page.setViewportSize({ width: 1280, height: 720 })
  await openSurface(page)
  await translated(page)
  const firstTranslation = page.locator('.screenshot-translated-block[data-block-id="line-1"]')
  await expect(firstTranslation).toBeVisible()
  const viewportBefore = await page.locator('.screenshot-result-viewport').boundingBox()
  await page.getByRole('button', { name: '打开侧窗', exact: true }).click()
  const sidebar = page.getByRole('complementary', { name: '提取的文字' })
  await expect(sidebar).toBeVisible()
  const viewportAfter = await page.locator('.screenshot-result-viewport').boundingBox()
  expect((viewportBefore?.width ?? 0) - (viewportAfter?.width ?? 0)).toBeCloseTo(320, 1)
  await expect(firstTranslation).toBeVisible()
  await assertBlockGeometry(page, dpr, 'line-1')
  await page.getByRole('button', { name: '关闭侧窗', exact: true }).click()
  await expect(sidebar).toHaveCount(0)
  await expect(page.getByRole('button', { name: '打开侧窗', exact: true })).toBeFocused()
  await expect(firstTranslation).toBeVisible()

  await page.getByRole('button', { name: '打开侧窗', exact: true }).click()
  for (const width of [480, 600, 719, 720, 1280]) {
    await page.setViewportSize({ width, height: 720 })
    const left = (await page.locator('.screenshot-result-viewport').boundingBox())!
    const right = (await sidebar.boundingBox())!
    expect(left.width).toBeGreaterThanOrEqual(200)
    expect(left.x + left.width).toBeCloseTo(right.x, 1)
    expect(right.x + right.width).toBeLessThanOrEqual(width + 1)
    expect(left.y).toBeCloseTo(right.y, 1)
    await expect(sidebar).toHaveCSS('position', 'relative')
  }
})

test('keeps the bottom toolbar outside scroll content and unobscured at 480x320', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 320 })
  await openSurface(page)
  await snapshot(page)
  const geometry = await page.evaluate(() => {
    const content = document.querySelector('.screenshot-result-content')!.getBoundingClientRect()
    const toolbar = document.querySelector('.screenshot-result-toolbar')!.getBoundingClientRect()
    const viewport = document.querySelector<HTMLElement>('.screenshot-result-viewport')!
    return {
      contentBottom: content.bottom,
      toolbarTop: toolbar.top,
      toolbarBottom: toolbar.bottom,
      viewportBottom: innerHeight,
      overflowX: viewport.scrollWidth > viewport.clientWidth,
      overflowY: viewport.scrollHeight > viewport.clientHeight,
    }
  })
  expect(Math.abs(geometry.toolbarTop - geometry.contentBottom)).toBeLessThanOrEqual(1)
  expect(Math.abs(geometry.toolbarBottom - geometry.viewportBottom)).toBeLessThanOrEqual(1)
  expect(geometry.overflowX).toBe(false)
  expect(geometry.overflowY).toBe(false)
})

test('keeps every nonempty overlay visible in small and enlarged windows without changing translation state', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 320 })
  await openSurface(page)
  await snapshot(page)
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'ocr-completed', blocks: OCR_BLOCKS })
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'translation-started' })
  await emit(page, {
    sessionId: SESSION_ID,
    generation: 1,
    type: 'translation-completed',
    translations: TRANSLATIONS,
  })
  const assertComplete = async () => {
    await expect(page.locator('.screenshot-translated-block')).toHaveCount(4)
    for (const translation of TRANSLATIONS) {
      const block = page.locator(`.screenshot-translated-block[data-block-id="${translation.id}"]`)
      await expect(block).toBeVisible()
      await expect(block).toHaveText(translation.text)
      await expect(block).toHaveAttribute('aria-hidden', 'false')
      // ResizeObserver replaces the measured nodes after a sidebar/viewport
      // change. Poll the final layout, rather than inspect a detached old node.
      await expect.poll(() => block.evaluate(element => ({
        hasWidth: element.getBoundingClientRect().width > 0,
        hasHeight: element.getBoundingClientRect().height > 0,
        fitsWidth: element.scrollWidth - element.clientWidth <= 1,
        fitsHeight: element.scrollHeight - element.clientHeight <= 1,
      }))).toEqual({ hasWidth: true, hasHeight: true, fitsWidth: true, fitsHeight: true })
    }
    await expect(page.getByRole('region', { name: '文档译文' })).toHaveCount(0)
  }
  await assertComplete()
  const smallFont = await page.locator('[data-block-id="line-3"]').evaluate(element => parseFloat(getComputedStyle(element).fontSize))
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '显示原文', exact: true })).toBeEnabled()
  await page.setViewportSize({ width: 1280, height: 720 })
  await assertComplete()
  const largeFont = await page.locator('[data-block-id="line-3"]').evaluate(element => parseFloat(getComputedStyle(element).fontSize))
  expect(largeFont).toBeGreaterThan(smallFont)
  await page.getByRole('button', { name: '打开侧窗', exact: true }).click()
  await page.setViewportSize({ width: 480, height: 320 })
  await assertComplete()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('paints long translations in subpixel source rectangles without clipping the fallback or suppressing overlaps', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 320 })
  await openSurface(page, SESSION_ID, true)
  await snapshot(page)
  const tinyRect = { x: 80, y: 70, width: 1, height: 1 }
  const tinyBlocks = [1, 2].map(index => ({
    id: `line-${index}`, text: 'source', rectPx: tinyRect,
    words: [{ text: 'source', rectPx: tinyRect }],
  }))
  const longText = 'x'.repeat(16 * 1024)
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'ocr-completed', blocks: tinyBlocks })
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'translation-completed',
    translations: [{ id: 'line-1', text: longText }, { id: 'line-2', text: '重叠译文' }] })
  const overlays = page.locator('.screenshot-translated-block')
  await expect(overlays).toHaveCount(2)
  await expect(overlays.first()).toHaveText(longText)
  for (const block of await overlays.all()) {
    await expect(block).toBeVisible()
    await expect(block).toHaveAttribute('aria-hidden', 'false')
    await expect(block).toHaveAttribute('data-fit', 'unfit')
    await expect(block).toHaveCSS('overflow', 'visible')
    const painted = await block.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const box = element.getBoundingClientRect()
      const text = range.getBoundingClientRect()
      return { width: box.width, height: box.height, textWidth: text.width, textHeight: text.height,
        fontSize: parseFloat(getComputedStyle(element).fontSize) }
    })
    expect(painted.width).toBeGreaterThan(0)
    expect(painted.height).toBeGreaterThan(0)
    expect(painted.width).toBeLessThan(1)
    expect(painted.textWidth).toBeGreaterThan(0)
    expect(painted.textHeight).toBeGreaterThan(0)
    expect(painted.fontSize).toBeGreaterThan(0)
  }
  expect(await overlays.first().boundingBox()).toEqual(await overlays.last().boundingBox())
  await expect(page.getByRole('region', { name: '文档译文' })).toHaveCount(0)
})

test('still accepts legacy streamed document events across layout changes', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 320 })
  await openSurface(page)
  await snapshot(page)
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'ocr-completed', blocks: DOCUMENT_OCR_BLOCKS })
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'translation-started' })
  await emit(page, {
    sessionId: SESSION_ID,
    generation: 1,
    type: 'document-translation-progress',
    text: DOCUMENT_PROGRESS_TEXT,
    completedChunks: 1,
    totalChunks: 2,
  })

  const documentTranslation = page.getByRole('region', { name: '文档译文' })
  await expect(documentTranslation).toContainText('第 80 行流式文档译文。')
  await expect(page.getByRole('img', { name: '截图原文' })).toBeVisible()
  await expect(documentTranslation).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.95)')
  expect(await documentTranslation.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await page.evaluate(() => window.screenshotLayoutFixture.clearCommands())
  await page.getByRole('button', { name: '打开侧窗', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '提取的文字' })).toContainText('第 80 行流式文档译文。')
  await page.setViewportSize({ width: 1280, height: 720 })
  await expect(documentTranslation).toContainText('第 80 行流式文档译文。')
  await expect(page.getByRole('alert')).toHaveCount(0)

  await emit(page, {
    sessionId: SESSION_ID,
    generation: 1,
    type: 'document-translation-completed',
    text: `${DOCUMENT_PROGRESS_TEXT}\n完整结束。`,
  })
  await expect(page.getByRole('button', { name: '显示原文', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '显示原文', exact: true }).click()
  await expect(documentTranslation).toHaveCount(0)
  await expect(page.getByRole('img', { name: '截图原文' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '提取的文字' })).toContainText('Document source')
  await page.getByRole('button', { name: '显示译文', exact: true }).click()
  await expect(page.getByRole('region', { name: '文档译文' })).toContainText('完整结束。')
  expect((await fixtureCommands(page)).filter(
    ({ channel }) => channel === IPC_CHANNELS.startScreenshotTranslation,
  )).toHaveLength(0)
})

test('keeps dense new OCR translations in the source rectangles instead of a full-pane document', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await openSurface(page)
  await snapshot(page)
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'ocr-completed', blocks: DOCUMENT_OCR_BLOCKS })
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'translation-started' })
  await expect(page.getByRole('region', { name: '文档译文' })).toHaveCount(0)
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'translation-completed',
    translations: DOCUMENT_OCR_BLOCKS.map(block => ({ id: block.id, text: '定位译文' })) })
  await expect(page.locator('.screenshot-translated-block')).toHaveCount(12)
  await expect(page.getByRole('region', { name: '文档译文' })).toHaveCount(0)
  const first = (await page.locator('.screenshot-translated-block[data-block-id="line-1"]').boundingBox())!
  const viewport = (await page.locator('.screenshot-result-viewport').boundingBox())!
  const scale = Math.min(viewport.width / IMAGE_WIDTH, viewport.height / IMAGE_HEIGHT)
  expect(first.x).toBeCloseTo(viewport.x + (viewport.width - IMAGE_WIDTH * scale) / 2 + 60 * scale, 1)
  expect(first.y).toBeCloseTo(viewport.y + (viewport.height - IMAGE_HEIGHT * scale) / 2 + 30 * scale, 1)
  expect(Number(testInfo.project.metadata.requestedDpr)).toBeGreaterThan(0)
})

test('allows real text selection and rejects copy when the selection is outside the OCR sidebar', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixtureUrl })
  await openSurface(page)
  await translated(page)
  expect(await dragSelectText(page, '.screenshot-translated-block')).toBe('第一行译文')

  await page.getByRole('button', { name: '打开侧窗', exact: true }).click()
  expect(await dragSelectText(page, '.screenshot-text-sidebar__content p')).toBe('第一行译文')
  await page.getByRole('complementary', { name: '提取的文字' }).press('Shift+F10')
  await page.getByRole('menuitem', { name: '复制' }).press('Enter')
  await expect.poll(async () => await page.evaluate(() => navigator.clipboard.readText())).toBe('第一行译文')

  expect(await dragSelectText(page, '.screenshot-translated-block')).toBe('第一行译文')
  await page.getByRole('complementary', { name: '提取的文字' }).press('Shift+F10')
  await expect(page.getByRole('menuitem', { name: '复制' })).toBeDisabled()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('第一行译文')
})

test('offers a 250ms left selection menu, selects only visible left text and closes immediately', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixtureUrl })
  await page.setViewportSize({ width: 1280, height: 720 })
  await openSurface(page, SESSION_ID, true)
  await snapshot(page)
  const viewport = page.getByLabel('截图文字区域')
  await viewport.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '复制' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: '全选' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await translated(page)
  expect(await dragSelectText(page, '.screenshot-translated-block')).toBe('第一行译文')
  await viewport.press('Shift+F10')
  await expect(page.getByRole('menu')).toHaveCSS('animation-duration', '0.25s')
  await expect(page.getByRole('menuitem', { name: '复制' })).toBeEnabled()
  await page.getByRole('menuitem', { name: '全选' }).click()
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selected).toContain('第一行译文')
  expect(selected.match(/第一行译文/g)).toHaveLength(1)
  expect(selected).not.toContain('提取文字')
  expect(selected).not.toContain('重新翻译')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await viewport.press('Shift+F10')
  await page.getByRole('menuitem', { name: '复制' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(selected)
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('uses the accepted generation for rapid cancel, minimize, and close and ignores late old completion', async ({ page }) => {
  await openSurface(page)
  await snapshot(page)
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'ocr-completed', blocks: OCR_BLOCKS })
  await page.evaluate(() => {
    window.screenshotLayoutFixture.clearCommands()
    window.screenshotLayoutFixture.setStartDeferred(true)
  })
  await page.getByRole('button', { name: '显示译文', exact: true }).click()
  await page.getByRole('button', { name: '翻译中…', exact: true }).click()
  await page.getByRole('button', { name: '最小化截图翻译窗口' }).click()
  await page.getByRole('button', { name: '关闭截图翻译窗口' }).click()
  await page.evaluate(() => window.screenshotLayoutFixture.resolveNextStart())
  await expect.poll(async () => (await fixtureCommands(page)).length).toBe(4)
  const commands = await fixtureCommands(page)
  expect(commands.map(({ input }) => input?.generation)).toEqual([1, 2, 2, 2])

  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'translation-completed', translations: TRANSLATIONS })
  await expect(page.getByText('第一行译文', { exact: true })).toHaveCount(0)
})

test('keeps titlebar, toolbar, settings, and sidebar menu keyboard reachable without trapping focus', async ({ page }) => {
  await openSurface(page)
  await snapshot(page)
  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'ocr-completed', blocks: OCR_BLOCKS })
  const minimize = page.getByRole('button', { name: '最小化截图翻译窗口' })
  await minimize.focus()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(minimize).toBeFocused()
  expect(await minimize.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '关闭截图翻译窗口' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('截图文字区域')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '显示译文', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '重新翻译', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  const toggle = page.getByRole('button', { name: '打开侧窗', exact: true })
  await expect(toggle).toBeFocused()
  await page.keyboard.press('Enter')
  const sidebar = page.getByRole('complementary', { name: '提取的文字' })
  await sidebar.focus()
  await sidebar.press('Shift+F10')
  const copy = page.getByRole('menuitem', { name: '复制' })
  await expect(copy).toBeDisabled()
  const selectAll = page.getByRole('menuitem', { name: '全选' })
  await expect(selectAll).toBeFocused()
  expect(await selectAll.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
  await page.keyboard.press('End')
  await expect(page.getByRole('menuitem', { name: '全选' })).toBeFocused()
  await page.keyboard.press('Home')
  await expect(selectAll).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: '全选' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(sidebar).toBeFocused()
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true)

  await emit(page, { sessionId: SESSION_ID, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_NOT_CONFIGURED' })
  const settings = page.getByRole('button', { name: '前往设置' })
  await settings.focus()
  await expect(settings).toBeFocused()
  await settings.press('Enter')
})

test('disables non-essential animation under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openSurface(page)
  await snapshot(page)
  const motion = await page.evaluate(() => {
    const nodes = [
      document.querySelector('.screenshot-result-window')!,
      ...document.querySelectorAll('.screenshot-result-window *'),
    ]
    return nodes.map((node) => {
      const style = getComputedStyle(node)
      return {
        animationDuration: style.animationDuration,
        animationIterationCount: style.animationIterationCount,
        transitionDuration: style.transitionDuration,
      }
    })
  })
  const seconds = (value: string) => value.split(',').map((part) => {
    const trimmed = part.trim()
    return trimmed.endsWith('ms') ? Number.parseFloat(trimmed) / 1000 : Number.parseFloat(trimmed)
  })
  for (const entry of motion) {
    expect(Math.max(...seconds(entry.animationDuration))).toBeLessThanOrEqual(0.001)
    expect(Math.max(...seconds(entry.transitionDuration))).toBeLessThanOrEqual(0.001)
    expect(entry.animationIterationCount).not.toContain('infinite')
  }
})

test('keeps a stopped window candidate clear inside while masking outside and retaining its border', async ({ page }) => {
  await page.setContent(`
    <style>${screenshotSelectionCss}</style>
    <div class="screenshot-selection">
      <div class="screenshot-selection-mask"></div>
      <div class="screenshot-selection-highlight" style="left:40px;top:30px;width:160px;height:90px"></div>
      <div class="screenshot-selection-region" style="left:220px;top:30px;width:160px;height:90px"></div>
    </div>
  `)
  const before = await page.locator('.screenshot-selection-highlight').boundingBox()
  await page.waitForTimeout(50)
  const stopped = await page.locator('.screenshot-selection-highlight').boundingBox()
  const styles = await page.evaluate(() => {
    const highlight = document.querySelector<HTMLElement>('.screenshot-selection-highlight')!
    const region = document.querySelector<HTMLElement>('.screenshot-selection-region')!
    return {
      highlightClass: highlight.className,
      highlightMask: getComputedStyle(highlight, '::after').backgroundColor,
      regionMask: getComputedStyle(region, '::after').backgroundColor,
      outsideMask: getComputedStyle(document.querySelector('.screenshot-selection-mask')!).backgroundColor,
      borderWidth: getComputedStyle(highlight).borderTopWidth,
    }
  })

  expect(before).toEqual({ x: 40, y: 30, width: 160, height: 90 })
  expect(stopped).toEqual(before)
  expect(styles.highlightClass).toBe('screenshot-selection-highlight')
  expect(styles.highlightMask).toBe('rgba(0, 0, 0, 0)')
  expect(styles.regionMask).toBe('rgba(0, 0, 0, 0)')
  expect(styles.outsideMask).toBe('rgba(0, 0, 0, 0.42)')
  expect(styles.borderWidth).toBe('1px')
})


test('wraps screenshot thinking controls at narrow width and saves only screenshot preferences', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 700 })
  await page.goto(`${fixtureUrl}/?surface=screenshot-translation&sessionId=${SESSION_ID}&thinking`)
  await page.evaluate(async () => await window.screenshotLayoutFixture.ready)
  await expect(page.locator('.screenshot-result-window')).toBeVisible()
  expect(await page.evaluate(async () => (await window.arkdown.getLargeModelSettings()).ok)).toBe(true)
  await page.getByRole('button', { name: '关闭侧窗', exact: true }).click()
  await translated(page)
  const toggle = page.getByRole('switch', { name: '截图翻译思考' })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect(page.getByRole('combobox', { name: '截图翻译推理强度' })).toContainText('低')
  await expect(page.getByText('第一行译文', { exact: true })).toBeVisible()
  const boxes = await page.locator('.screenshot-result-toolbar button').evaluateAll((elements) => elements.map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }
  }))
  for (const box of boxes) expect(box.x + box.width).toBeLessThanOrEqual(480)
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]
    expect(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1).toBe(true)
  }
  const commands = await fixtureCommands(page)
  expect(commands.some(({ channel }) => channel === IPC_CHANNELS.setScreenshotTranslationSettings)).toBe(true)
  expect(commands.some(({ channel }) => channel === IPC_CHANNELS.setSelectionTranslationSettings)).toBe(false)
})
