import type { AddressInfo } from 'node:net'
import { expect, test, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

const FIXTURE_PATH = '/__visual-drop-caret-layout-fixture'
const VIRTUAL_FIXTURE_ID = 'virtual:visual-drop-caret-layout-fixture'
const RESOLVED_FIXTURE_ID = `\0${VIRTUAL_FIXTURE_ID}`

const fixtureModule = String.raw`
import { EditorState as CodeMirrorState } from '@codemirror/state'
import { EditorView as CodeMirrorView } from '@codemirror/view'
import { Fragment, Schema, Slice } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { createVisualDropInsertionPlugin } from '/src/renderer/editor/visual-drop-insertion.ts'
import '/src/renderer/app/styles.css'
import '/src/renderer/editor/visual-drop-caret.css'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    text: {},
  },
})
const host = document.querySelector('#editor-host')
const outside = document.querySelector('#outside')
const doc = schema.node('doc', null, schema.node('paragraph', null, schema.text('甲乙丙丁')))
let externalDropBubbles = 0
host.parentElement.addEventListener('drop', () => { externalDropBubbles += 1 })

const view = new EditorView(host, {
  state: EditorState.create({ doc, plugins: [createVisualDropInsertionPlugin()] }),
  dispatchTransaction(transaction) {
    view.updateState(view.state.apply(transaction))
  },
})

const codeMirrorViews = [
  new CodeMirrorView({
    parent: document.querySelector('#source-code-mirror'),
    state: CodeMirrorState.create({ doc: 'source' }),
  }),
  new CodeMirrorView({
    parent: document.querySelector('#rendered-code-mirror'),
    state: CodeMirrorState.create({ doc: 'rendered' }),
  }),
]

for (const [index, codeMirrorView] of codeMirrorViews.entries()) {
  for (const className of ['cm-cursor', 'cm-dropCursor']) {
    const probe = document.createElement('span')
    probe.id = (index === 0 ? 'source-' : 'rendered-') + className
    probe.className = className
    codeMirrorView.scrollDOM.append(probe)
  }
}

function codeMirrorCaretStyle(element) {
  const style = getComputedStyle(element)
  return {
    animationDuration: style.animationDuration,
    animationIterationCount: style.animationIterationCount,
    animationName: style.animationName,
    animationTimingFunction: style.animationTimingFunction,
    borderLeftColor: style.borderLeftColor,
    borderLeftStyle: style.borderLeftStyle,
    borderLeftWidth: style.borderLeftWidth,
    boxSizing: style.boxSizing,
    color: style.color,
    marginLeft: style.marginLeft,
  }
}

function dragEvent(type, position, dataTransfer, relatedTarget = null) {
  const coordinates = position === null
    ? { left: 0, top: 0, bottom: 0 }
    : view.coordsAtPos(position)
  return new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: coordinates.left,
    clientY: coordinates.top + Math.max(1, (coordinates.bottom - coordinates.top) / 2),
    dataTransfer,
    relatedTarget,
  })
}

window.visualDropFixture = {
  setEditorZoom(zoom) {
    host.style.setProperty('--editor-zoom-factor', String(zoom))
  },
  caret() {
    const element = document.querySelector('.arkdown-visual-drop-caret')
    if (!element) return null
    const rect = element.getBoundingClientRect()
    const pos = Number(element.dataset.dropPos)
    return {
      pos,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      coordinates: view.coordsAtPos(pos),
      pointerEvents: getComputedStyle(element).pointerEvents,
      position: getComputedStyle(element).position,
      color: getComputedStyle(element).color,
      backgroundColor: getComputedStyle(element).backgroundColor,
      animationName: getComputedStyle(element).animationName,
      animationTimingFunction: getComputedStyle(element).animationTimingFunction,
      animationIterationCount: getComputedStyle(element).animationIterationCount,
      editorColor: getComputedStyle(view.dom).color,
      editorCaretColor: getComputedStyle(view.dom).caretColor,
    }
  },
  inputCaretColor: () => getComputedStyle(view.dom).caretColor,
  codeMirrorCarets: () => [
    document.querySelector('#source-cm-cursor'),
    document.querySelector('#source-cm-dropCursor'),
    document.querySelector('#rendered-cm-cursor'),
    document.querySelector('#rendered-cm-dropCursor'),
  ].map(codeMirrorCaretStyle),
  dragOver(position) {
    const dataTransfer = new DataTransfer()
    view.dom.dispatchEvent(dragEvent('dragover', position, dataTransfer))
  },
  startInternalMove(from, to) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)))
    view.dragging = { slice: view.state.selection.content(), move: true }
  },
  dropInternal(position) {
    const dataTransfer = new DataTransfer()
    view.dom.dispatchEvent(dragEvent('drop', position, dataTransfer))
  },
  dropExternal(position) {
    view.dragging = null
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['# notes'], 'notes.md', { type: 'text/markdown' }))
    view.dom.dispatchEvent(dragEvent('drop', position, dataTransfer))
  },
  dragEnd() {
    view.dom.dispatchEvent(dragEvent('dragend', null, new DataTransfer()))
  },
  dragLeave() {
    view.dom.dispatchEvent(dragEvent('dragleave', null, new DataTransfer(), outside))
  },
  text: () => view.state.doc.textContent,
  externalDropBubbles: () => externalDropBubbles,
  destroy: () => {
    view.destroy()
    codeMirrorViews.forEach((codeMirrorView) => codeMirrorView.destroy())
  },
}
`

interface VisualDropFixture {
  setEditorZoom(zoom: number): void
  caret(): null | {
    pos: number
    rect: { left: number; top: number; width: number; height: number }
    coordinates: { left: number; right: number; top: number; bottom: number }
    pointerEvents: string
    position: string
    color: string
    backgroundColor: string
    animationName: string
    animationTimingFunction: string
    animationIterationCount: string
    editorColor: string
    editorCaretColor: string
  }
  inputCaretColor(): string
  codeMirrorCarets(): Array<{
    animationDuration: string
    animationIterationCount: string
    animationName: string
    animationTimingFunction: string
    borderLeftColor: string
    borderLeftStyle: string
    borderLeftWidth: string
    boxSizing: string
    color: string
    marginLeft: string
  }>
  dragOver(position: number): void
  startInternalMove(from: number, to: number): void
  dropInternal(position: number): void
  dropExternal(position: number): void
  dragEnd(): void
  dragLeave(): void
  text(): string
  externalDropBubbles(): number
  destroy(): void
}

declare global {
  interface Window {
    visualDropFixture: VisualDropFixture
  }
}

let vite: ViteDevServer
let fixtureUrl = ''

test.beforeAll(async () => {
  vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    plugins: [{
      name: 'visual-drop-caret-playwright-fixture',
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
            <html style="--theme-color-rgb: 124 58 237">
              <head><meta charset="UTF-8"><style>
                html, body { margin: 0; min-height: 100%; }
                #fixture-shell { margin: 80px; width: 560px; padding: 24px; border: 1px solid #ddd; }
                .visual-editor .milkdown { zoom: var(--editor-zoom-factor, 1); }
                .ProseMirror { min-height: 120px; padding: 20px; color: rgb(51 51 51); font: 20px/30px sans-serif; }
                .ProseMirror p { margin: 0; }
                .source-editor, .milkdown-code-block { color: rgb(51 51 51); }
                #outside { width: 40px; height: 40px; }
              </style></head>
              <body><div id="fixture-shell">
                <div class="visual-editor"><div id="editor-host" class="milkdown"></div></div>
                <div class="source-editor"><div id="source-code-mirror"></div></div>
                <div class="visual-editor"><div class="milkdown"><div class="milkdown-code-block"><div id="rendered-code-mirror"></div></div></div></div>
              </div><div id="outside"></div>
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

async function openFixture(page: Page): Promise<void> {
  await page.goto(fixtureUrl)
  await expect(page.locator('.ProseMirror')).toContainText('甲乙丙丁')
}

test('unifies source and rendered CodeMirror input and drop carets', async ({ page }) => {
  await openFixture(page)

  const carets = await page.evaluate(() => window.visualDropFixture.codeMirrorCarets())
  expect(carets).toHaveLength(4)
  for (const caret of carets) {
    expect(caret.borderLeftWidth).toBe('2px')
    expect(caret.borderLeftStyle).toBe('solid')
    expect(caret.borderLeftColor).toBe(caret.color)
    expect(caret.marginLeft).toBe('-1px')
    expect(caret.boxSizing).toBe('border-box')
    expect(caret.animationName).toBe('arkdown-visual-caret-blink')
    expect(caret.animationDuration).toBe('1.06s')
    expect(caret.animationTimingFunction).toMatch(/^steps\(1(?:, (?:end|jump-end))?\)$/)
    expect(caret.animationIterationCount).toBe('infinite')
  }
})

for (const editorZoom of [1, 1.5] as const) {
  test(`renders one exact 2px viewport caret at ${editorZoom * 100}% editor zoom`, async ({ page }, testInfo) => {
    await openFixture(page)
    expect(await page.evaluate(() => devicePixelRatio)).toBe(testInfo.project.metadata.requestedDpr)
    await page.evaluate((zoom) => window.visualDropFixture.setEditorZoom(zoom), editorZoom)
    const inputCaretColorBefore = await page.evaluate(
      () => window.visualDropFixture.inputCaretColor(),
    )
    await page.evaluate(() => window.visualDropFixture.dragOver(3))
    const caret = await page.evaluate(() => window.visualDropFixture.caret())

    expect(caret).not.toBeNull()
    expect(caret?.pos).toBe(3)
    expect(caret?.rect.width).toBe(2)
    expect(caret?.rect.left).toBeCloseTo(caret!.coordinates.left, 1)
    expect(caret?.rect.top).toBeCloseTo(caret!.coordinates.top, 1)
    expect(caret?.rect.height).toBeCloseTo(
      caret!.coordinates.bottom - caret!.coordinates.top,
      1,
    )
    expect(caret?.position).toBe('fixed')
    expect(caret?.pointerEvents).toBe('none')
    expect(caret?.color).toBe(caret?.editorColor)
    expect(caret?.backgroundColor).toBe(caret?.editorColor)
    expect(caret?.animationName).toBe('arkdown-visual-caret-blink')
    expect(caret?.animationTimingFunction).toMatch(/^steps\(1(?:, (?:end|jump-end))?\)$/)
    expect(caret?.animationIterationCount).toBe('infinite')
    expect(caret?.editorCaretColor).toBe(inputCaretColorBefore)
    await expect(page.locator('.arkdown-visual-drop-caret')).toHaveCount(1)
  })
}

test('uses that target for the original internal slice and clears after drop', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => {
    window.visualDropFixture.startInternalMove(1, 3)
    window.visualDropFixture.dragOver(4)
  })
  await expect(page.locator('.arkdown-visual-drop-caret')).toHaveAttribute('data-drop-pos', '4')
  await page.evaluate(() => window.visualDropFixture.dropInternal(4))

  expect(await page.evaluate(() => window.visualDropFixture.text())).toBe('丙甲乙丁')
  await expect(page.locator('.arkdown-visual-drop-caret')).toHaveCount(0)
})

test('lets external file drops bubble and clears on every termination path', async ({ page }) => {
  await openFixture(page)
  await page.evaluate(() => window.visualDropFixture.dragOver(3))
  await page.evaluate(() => window.visualDropFixture.dropExternal(3))
  await expect(page.locator('.arkdown-visual-drop-caret')).toHaveCount(0)
  expect(await page.evaluate(() => window.visualDropFixture.externalDropBubbles())).toBe(1)
  expect(await page.evaluate(() => window.visualDropFixture.text())).toBe('甲乙丙丁')

  await page.evaluate(() => window.visualDropFixture.dragOver(3))
  await page.evaluate(() => window.visualDropFixture.dragLeave())
  await expect(page.locator('.arkdown-visual-drop-caret')).toHaveCount(0)

  await page.evaluate(() => window.visualDropFixture.dragOver(3))
  await page.keyboard.press('Escape')
  await expect(page.locator('.arkdown-visual-drop-caret')).toHaveCount(0)

  await page.evaluate(() => window.visualDropFixture.dragOver(3))
  await page.evaluate(() => window.visualDropFixture.dragEnd())
  await expect(page.locator('.arkdown-visual-drop-caret')).toHaveCount(0)

  await page.evaluate(() => window.visualDropFixture.dragOver(3))
  await page.evaluate(() => window.visualDropFixture.destroy())
  await expect(page.locator('.arkdown-visual-drop-caret')).toHaveCount(0)
})
