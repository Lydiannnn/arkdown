import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_PATH = '/__edit-indicator-layout-fixture'
const VIRTUAL_FIXTURE_ID = 'virtual:edit-indicator-layout-fixture'
const RESOLVED_FIXTURE_ID = `\0${VIRTUAL_FIXTURE_ID}`

const fixtureModule = String.raw`
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextMenuProvider } from '/src/renderer/context-menu/ContextMenuProvider.tsx'
import { EditorPane } from '/src/renderer/editor/EditorPane.tsx'
import { useEditIndicatorModel } from '/src/renderer/editor/edit-indicators/use-edit-indicator-model.ts'
import '/src/renderer/app/styles.css'

const h = React.createElement
const markdown = [
  '# Heading',
  '',
  '- list item',
  '',
  '| Header A | Header B |',
  '| --- | --- |',
  '| Cell A | Cell B |',
  '',
  'Final paragraph',
].join('\n')

window.arkdown = {
  cancelTranslation: async () => ({ ok: true, value: null }),
  onTranslationEvent: () => () => {},
  onAiConversationEvent: () => () => {},
}

function Fixture() {
  const [documentKey, setDocumentKey] = useState('fixture.md')
  const [mode, setMode] = useState('visual')
  const [zoom, setZoom] = useState(100)
  const [visible, setVisible] = useState(false)
  const [current, setCurrent] = useState(markdown)
  const [saved, setSaved] = useState(markdown)
  const opening = ''
  const model = useEditIndicatorModel({
    documentKey,
    openingMarkdown: opening,
    savedMarkdown: saved,
    currentMarkdown: current,
    enabled: mode === 'source',
  })
  useEffect(() => {
    window.editIndicatorFixture = {
      setZoom,
      setVisible,
      setCurrent,
      save() { setSaved(current) },
      load(value) {
        setCurrent(value)
        setDocumentKey((currentKey) => currentKey + ':next')
      },
    }
  }, [current])
  return h(ContextMenuProvider, null,
    h('div', { className: 'fixture-shell' },
      h('output', {
        id: 'edit-indicator-model-state',
        'data-line-count': model.lineStates.length,
        'data-mode': mode,
        'data-status': model.status,
        'data-document-key': documentKey,
        'data-model-version': model.modelVersion,
        'data-current': current,
      }),
      h(EditorPane, {
        documentKey,
        editIndicatorModel: model,
        markdown: current,
        onChange: setCurrent,
        onModeChange: setMode,
        onOpenLargeModelSettings() {},
        showEditIndicators: visible,
        zoomPercent: zoom,
      }),
    ),
  )
}

const root = createRoot(document.querySelector('#fixture-root'))
window.mountEditIndicatorFixture = () => root.render(h(Fixture))
window.unmountEditIndicatorFixture = () => root.unmount()
`

let vite: ViteDevServer
let fixtureUrl: string

test.beforeAll(async () => {
  vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'edit-indicator-playwright-fixture',
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
                .fixture-shell { width:760px; height:620px; margin:40px; }
                .editor-pane { width:100%; height:100%; }
                .editor-surface { width:100%; height:100%; }
                .visual-editor .ProseMirror { min-width:1000px; padding-bottom:1200px !important; }
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

async function mount(page: import('@playwright/test').Page) {
  const startupErrors: string[] = []
  const onPageError = (error: Error) => startupErrors.push(error.stack ?? error.message)
  const onConsole = (message: import('@playwright/test').ConsoleMessage) => {
    if (message.type() === 'error') startupErrors.push(message.text())
  }
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  try {
    await page.goto(fixtureUrl)
    await page.waitForFunction(() => typeof (
      window as typeof window & { mountEditIndicatorFixture?: unknown }
    ).mountEditIndicatorFixture === 'function', undefined, { timeout: 20_000 })
    await page.evaluate(() => {
      (window as typeof window & { mountEditIndicatorFixture(): void }).mountEditIndicatorFixture()
    })
  } catch (error) {
    throw new Error('Edit-indicator fixture initialization failed:\n'
      + (startupErrors.join('\n') || 'No browser pageerror or console.error was reported.'), { cause: error })
  } finally {
    page.off('pageerror', onPageError)
    page.off('console', onConsole)
  }
  await expect(page.locator('.editor-surface > .visual-editor .ProseMirror')).toBeVisible()
  await expect(page.locator('#edit-indicator-model-state')).toHaveAttribute('data-status', 'idle')
  await expect(page.locator('#edit-indicator-model-state')).toHaveAttribute('data-line-count', '0')
  await expect(page.locator('.arkdown-visual-edit-indicator-segment')).toHaveCount(0)
}

test('visual editing stays idle without indicators until source mode starts the module Worker', async ({ page }) => {
  const workerStarts: string[] = []
  page.on('worker', (worker) => {
    if (worker.url().includes('edit-indicator-worker')) workerStarts.push(worker.url())
  })
  await mount(page)
  const state = page.locator('#edit-indicator-model-state')
  const visualIndicators = page.locator([
    '.arkdown-visual-edit-indicator-layer',
    '.arkdown-visual-edit-indicator-segment',
    '.visual-editor [data-arkdown-edit-indicator-state]',
  ].join(','))
  await page.evaluate(() => {
    (window as typeof window & { editIndicatorFixture: { setVisible(value: boolean): void } })
      .editIndicatorFixture.setVisible(true)
  })
  const paragraph = page.locator('.visual-editor .ProseMirror p').filter({ hasText: 'Final paragraph' })
  await paragraph.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText(' visual edit')
  await expect(state).toHaveAttribute('data-current', /Final paragraph visual edit/)
  await page.evaluate(() => {
    (window as typeof window & { editIndicatorFixture: { save(): void } }).editIndicatorFixture.save()
  })
  await page.keyboard.insertText(' unsaved')
  await expect(state).toHaveAttribute('data-current', /Final paragraph visual edit unsaved/)
  // Observe longer than two debounce windows to catch accidental visual-mode work.
  await page.evaluate(() => new Promise<void>((resolve) => {
    const started = performance.now()
    const next = () => performance.now() - started >= 300 ? resolve() : requestAnimationFrame(next)
    requestAnimationFrame(next)
  }))
  await expect(state).toHaveAttribute('data-status', 'idle')
  await expect(state).toHaveAttribute('data-line-count', '0')
  await expect(visualIndicators).toHaveCount(0)
  expect(workerStarts).toEqual([])

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'toggle-source-mode' }))
  })
  await expect(page.locator('.source-editor .cm-editor')).toBeVisible()
  await expect(state).toHaveAttribute('data-mode', 'source')
  await expect(state).toHaveAttribute('data-status', 'ready')
  expect(workerStarts).toHaveLength(1)
  await expect(page.locator('.arkdown-source-edit-indicator--unsaved').last()).toBeVisible()
  await expect(page.locator('.source-editor .cm-content')).toContainText('Final paragraph visual edit unsaved')

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'toggle-source-mode' }))
  })
  await expect(paragraph).toBeVisible()
  await expect(state).toHaveAttribute('data-mode', 'visual')
  await expect(state).toHaveAttribute('data-status', 'idle')
  await expect(state).toHaveAttribute('data-line-count', '0')
  await expect(visualIndicators).toHaveCount(0)
  await expect.poll(() => page.workers().filter((worker) => worker.url().includes('edit-indicator-worker')).length).toBe(0)
  expect(workerStarts).toHaveLength(1)
})

test('mode switches keep the logical cursor block centered in long documents', async ({ page }) => {
  await mount(page)
  const longMarkdown = Array.from(
    { length: 60 },
    (_, index) => `Paragraph ${index + 1} contains enough text to identify its logical block.`,
  ).join('\n\n')
  await page.evaluate((value) => {
    (window as typeof window & { editIndicatorFixture: { load(value: string): void } })
      .editIndicatorFixture.load(value)
  }, longMarkdown)
  await expect(page.locator('.visual-editor .ProseMirror')).toContainText('Paragraph 43')
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'toggle-source-mode' }))
  })

  const targetText = 'Paragraph 43 contains enough text to identify its logical block.'
  const sourceContent = page.locator('.source-editor .cm-content')
  await sourceContent.click()
  await page.keyboard.press('Control+End')
  for (let index = 0; index < 34; index += 1) await page.keyboard.press('ArrowUp')
  await expect(page.locator('.source-editor .cm-activeLine')).toHaveText(targetText)
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'toggle-source-mode' }))
  })

  const visualTarget = page.locator('.visual-editor .ProseMirror p').filter({ hasText: targetText })
  await expect(visualTarget).toBeVisible()
  await expect.poll(async () => visualTarget.evaluate((node) => {
    const target = node.getBoundingClientRect()
    const surface = document.querySelector('.editor-surface')!.getBoundingClientRect()
    return Math.abs((target.top + target.bottom) / 2 - (surface.top + surface.bottom) / 2)
  })).toBeLessThan(140)

  await visualTarget.click()
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'toggle-source-mode' }))
  })
  const restoredSourceTarget = page.locator('.source-editor .cm-line').filter({ hasText: targetText })
  await expect(restoredSourceTarget).toBeVisible()
  await expect(restoredSourceTarget).toHaveClass(/cm-activeLine/)
  await expect.poll(async () => restoredSourceTarget.evaluate((node) => {
    const target = node.getBoundingClientRect()
    const surface = document.querySelector('.editor-surface')!.getBoundingClientRect()
    return Math.abs((target.top + target.bottom) / 2 - (surface.top + surface.bottom) / 2)
  })).toBeLessThan(140)
})

test('visual-to-source switches preserve the caret through table Markdown syntax', async ({ page }) => {
  await mount(page)
  const targetRow = '| Alpha | **Bravo** |'
  const richLine = 'Imported **strong** text with [linked words](https://example.com) and a final suffix.'
  const markdown = `${Array.from(
    { length: 28 },
    (_, index) => `Imported paragraph ${index + 1}.`,
  ).join('\n\n')}\n\n| Header A | Header B |\n| --- | --- |\n${targetRow}\n\n${richLine}`
  await page.evaluate((value) => {
    (window as typeof window & { editIndicatorFixture: { load(value: string): void } })
      .editIndicatorFixture.load(value)
  }, markdown)

  const bravoCell = page.locator('.visual-editor td').filter({ hasText: 'Bravo' })
  await expect(bravoCell).toBeVisible()
  await bravoCell.locator('strong').click()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect.poll(() => page.evaluate(() => ({
    offset: document.getSelection()?.anchorOffset ?? -1,
    text: document.getSelection()?.anchorNode?.textContent ?? '',
  }))).toEqual({ offset: 2, text: 'Bravo' })
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'toggle-source-mode' }))
  })
  const tableLine = page.locator('.source-editor .cm-activeLine')
  await expect(tableLine).toHaveText(targetRow)
  await page.keyboard.insertText('§')
  await expect(tableLine).toHaveText('| Alpha | **Br§avo** |')
})

test('real source editor retains wrapped, folded, unsaved and reduced-motion state across hot updates', async ({ page }) => {
  await mount(page)
  const wrapped = 'unsaved wrapped source line '.repeat(48)
  const overflow = Array.from({ length: 36 }, (_, index) => `overflow ${index}`).join('\n')
  await page.evaluate(({ overflow, wrapped }) => {
    const original = [
      '# Heading', '', '- list item', '', '| Header A | Header B |', '| --- | --- |',
      '| Cell A | Cell B |', '', 'Final paragraph',
    ].join('\n')
    ;(window as typeof window & { editIndicatorFixture: { setCurrent(value: string): void } })
      .editIndicatorFixture.setCurrent(`${original}\n\n# Later\n\n${overflow}\n\n${wrapped}`)
  }, { overflow, wrapped })
  await expect(page.locator('#edit-indicator-model-state')).toHaveAttribute('data-status', 'idle')
  await page.evaluate(() => {
    (window as typeof window & { editIndicatorFixture: { setVisible(value: boolean): void } })
      .editIndicatorFixture.setVisible(true)
    window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'toggle-source-mode' }))
  })

  const source = page.locator('.source-editor .cm-editor')
  const content = source.locator('.cm-content')
  const scroller = source.locator('.cm-scroller')
  await expect(source).toBeVisible()
  await expect(source.locator('.arkdown-source-edit-indicator--saved').first()).toBeVisible()
  const unsaved = source.locator('.arkdown-source-edit-indicator--unsaved').last()
  await expect(unsaved).toBeVisible()
  expect(await unsaved.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(30)
  expect(await unsaved.evaluate((node) => getComputedStyle(node).boxShadow)).not.toBe('none')

  await page.evaluate(() => {
    ;(window as typeof window & { sourceEditorIdentity?: Element }).sourceEditorIdentity =
      document.querySelector('.source-editor .cm-editor')!
  })
  const firstDown = source.locator('.arkdown-source-fold-triangle--down:visible').first()
  await firstDown.click()
  const foldedTriangle = source.locator('.arkdown-source-fold-triangle--right:visible').first()
  await expect(foldedTriangle).toBeVisible()
  await expect(unsaved).toBeVisible()

  await content.click()
  await page.keyboard.press('Control+A')
  const selectionBefore = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  expect(selectionBefore.length).toBeGreaterThan(100)
  await page.evaluate(() => {
    (window as typeof window & { editIndicatorFixture: { setZoom(value: number): void } })
      .editIndicatorFixture.setZoom(70)
    ;(window as typeof window & { editIndicatorFixture: { setVisible(value: boolean): void } })
      .editIndicatorFixture.setVisible(false)
  })
  await expect(source.locator('.arkdown-source-edit-indicator--unsaved')).toHaveCount(0)
  await page.evaluate(() => {
    (window as typeof window & { editIndicatorFixture: { setVisible(value: boolean): void } })
      .editIndicatorFixture.setVisible(true)
  })
  await expect(unsaved).toBeVisible()
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe(selectionBefore)

  await scroller.hover()
  await page.mouse.wheel(0, 120)
  await expect.poll(async () => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  const scrollBefore = await scroller.evaluate((node) => ({
    ratio: node.scrollTop / (node.scrollHeight - node.clientHeight),
  }))
  expect(scrollBefore.ratio).toBeGreaterThan(0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await unsaved.evaluate((node) => getComputedStyle(node).animationName)).toBe('none')
  for (const zoom of [100, 200]) {
    await page.evaluate((value) => {
      (window as typeof window & { editIndicatorFixture: { setZoom(value: number): void } })
        .editIndicatorFixture.setZoom(value)
    }, zoom)
    await page.evaluate(() => {
      (window as typeof window & { editIndicatorFixture: { setVisible(value: boolean): void } })
        .editIndicatorFixture.setVisible(false)
    })
    await expect(source.locator('.arkdown-source-edit-indicator--unsaved')).toHaveCount(0)
    await page.evaluate(() => {
      (window as typeof window & { editIndicatorFixture: { setVisible(value: boolean): void } })
        .editIndicatorFixture.setVisible(true)
    })
    await expect(unsaved).toBeVisible()
    expect(await page.evaluate(() => (
      (window as typeof window & { sourceEditorIdentity?: Element }).sourceEditorIdentity
        === document.querySelector('.source-editor .cm-editor')
    ))).toBe(true)
    await expect.poll(async () => scroller.evaluate((node) => (
      node.scrollTop / (node.scrollHeight - node.clientHeight)
    ))).toBeCloseTo(scrollBefore.ratio, 2)
    const geometry = await unsaved.evaluate((node) => node.getBoundingClientRect().width)
    expect(geometry).toBeCloseTo(5, 1)
  }
  await scroller.evaluate((node) => { node.scrollTop = 0 })
  await expect(foldedTriangle).toBeVisible()
  const replacementIsDetected = await page.evaluate(() => {
    const original = document.querySelector('.source-editor .cm-editor')!
    const replacement = original.cloneNode(false) as HTMLElement
    original.replaceWith(replacement)
    const detected = (window as typeof window & { sourceEditorIdentity?: Element }).sourceEditorIdentity
      !== document.querySelector('.source-editor .cm-editor')
    replacement.replaceWith(original)
    return detected && (
      (window as typeof window & { sourceEditorIdentity?: Element }).sourceEditorIdentity
        === document.querySelector('.source-editor .cm-editor')
    )
  })
  expect(replacementIsDetected).toBe(true)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.evaluate(() => {
    (window as typeof window & { unmountEditIndicatorFixture(): void })
      .unmountEditIndicatorFixture()
  })
})
