import { EditorView as CodeMirror } from '@codemirror/view'
import { Crepe } from '@milkdown/crepe'
import { editorViewCtx } from '@milkdown/kit/core'
import { undo, redo, closeHistory } from '@milkdown/kit/prose/history'
import { NodeSelection } from '@milkdown/kit/prose/state'
import { createVisualContextMenuHandler } from '../../src/renderer/editor/context-menu/visual-context-menu'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, expect, it, vi } from 'vitest'
import { createAdaptiveMermaidCodeBlockView } from '../../src/renderer/editor/mermaid/adaptive-code-block-view'
import { createMermaidRenderService } from '../../src/renderer/editor/mermaid/mermaid-render-service'
import { createMermaidViewRegistry } from '../../src/renderer/editor/mermaid/mermaid-view-registry'
import type {
  MermaidAppearance,
  MermaidRegistryPort,
  MermaidRenderRequest,
  MermaidRenderResult,
  MermaidRenderable,
  MermaidRenderer,
} from '../../src/renderer/editor/mermaid/mermaid-types'
import { MERMAID_MAX_BLOCKS } from '../../src/renderer/editor/mermaid/mermaid-types'

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []

  readonly root = null
  readonly rootMargin: string
  readonly thresholds = [0]
  readonly targets = new Set<Element>()

  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.rootMargin = typeof options?.rootMargin === 'string' ? options.rootMargin : '0px'
    IntersectionObserverStub.instances.push(this)
  }

  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  takeRecords(): IntersectionObserverEntry[] { return [] }

  trigger(target: Element, isIntersecting = true) {
    this.callback([{
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null,
      time: performance.now(),
    } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
}

const initialAppearance: MermaidAppearance = {
  revision: 1,
  editorTheme: 'minimal',
  colorScheme: 'light',
  themeColor: '#336699',
  bodyFontFamily: 'sans-serif',
}

class RegistryFake implements MermaidRegistryPort {
  currentAppearance = initialAppearance
  readonly views = new Set<MermaidRenderable>()
  readonly tracked: Promise<unknown>[] = []

  appearance = () => this.currentAppearance

  register = (view: MermaidRenderable) => {
    this.views.add(view)
    return () => this.views.delete(view)
  }

  track = (_instanceId: string, _generation: number, task: Promise<unknown>) => {
    this.tracked.push(task)
  }

  refreshAppearance = (next: MermaidAppearance) => {
    this.currentAppearance = next
    this.views.forEach((view) => view.refresh('theme'))
  }

  renderAll = async () => { this.views.forEach((view) => view.refresh('print')) }
  whenIdle = async () => { await Promise.allSettled(this.tracked) }
  dispose = () => this.views.clear()
}

const editors: Crepe[] = []

interface EditorHarness<T extends MermaidRegistryPort> {
  block: HTMLElement
  crepe: Crepe
  registry: T
  view: EditorView
}

async function createEditor(
  renderer: MermaidRenderer,
  defaultValue?: string,
): Promise<EditorHarness<RegistryFake>>
async function createEditor<T extends MermaidRegistryPort>(
  renderer: MermaidRenderer,
  defaultValue: string,
  registry: T,
): Promise<EditorHarness<T>>
async function createEditor(
  renderer: MermaidRenderer,
  defaultValue = '```mermaid\ngraph TD\n  A --> B\n```',
  registry: MermaidRegistryPort = new RegistryFake(),
): Promise<EditorHarness<MermaidRegistryPort>> {
  const root = document.createElement('div')
  document.body.append(root)
  const crepe = new Crepe({
    root,
    defaultValue,
    features: {
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.BlockEdit]: false,
      [Crepe.Feature.Cursor]: false,
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.LinkTooltip]: false,
      [Crepe.Feature.Placeholder]: false,
      [Crepe.Feature.Table]: false,
      [Crepe.Feature.Toolbar]: false,
      [Crepe.Feature.TopBar]: false,
      [Crepe.Feature.CodeMirror]: true,
      [Crepe.Feature.Latex]: true,
    },
  })
  crepe.editor.use(createAdaptiveMermaidCodeBlockView({ registry, renderer }))
  editors.push(crepe)
  await crepe.create()
  const view = crepe.editor.ctx.get(editorViewCtx)
  const block = view.dom.querySelector<HTMLElement>('.arkdown-mermaid-block')
  expect(block).toBeInstanceOf(HTMLElement)
  return { block: block!, crepe, registry, view }
}

function codeBlock(doc: ProseMirrorNode): { node: ProseMirrorNode; position: number } {
  return codeBlocks(doc).at(-1)!
}

function codeBlocks(doc: ProseMirrorNode): Array<{ node: ProseMirrorNode; position: number }> {
  const found: Array<{ node: ProseMirrorNode; position: number }> = []
  doc.descendants((node, position) => {
    if (node.type.name === 'code_block') found.push({ node, position })
  })
  expect(found).not.toHaveLength(0)
  return found
}

function reveal(block: HTMLElement) {
  const observer = IntersectionObserverStub.instances.find((candidate) => candidate.targets.has(block))
  expect(observer?.rootMargin).toBe('300px')
  observer!.trigger(block)
}

function sourceButton(block: HTMLElement): HTMLButtonElement {
  const button = block.querySelector<HTMLButtonElement>('[data-action="toggle-source"]')
  expect(button).toBeInstanceOf(HTMLButtonElement)
  return button!
}

function openSource(block: HTMLElement): CodeMirror {
  sourceButton(block).click()
  const editorElement = block.querySelector<HTMLElement>('.cm-editor')
  expect(editorElement).toBeInstanceOf(HTMLElement)
  const cm = CodeMirror.findFromDOM(editorElement!)
  expect(cm).not.toBeNull()
  return cm!
}

function key(target: HTMLElement, value: string, options: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
    ...options,
  }))
}

function ready(dataUrl: string): Promise<MermaidRenderResult> {
  return Promise.resolve({ status: 'ready', dataUrl })
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(editors.splice(0).map((crepe) => crepe.destroy()))
  IntersectionObserverStub.instances.length = 0
  document.body.replaceChildren()
})

it('returns to an untyped code block preserving exact text and attributes through undo and redo', async () => {
  const { block, view } = await createEditor({ render: () => ready('data:image/svg+xml;base64,QQ==') })
  const current = codeBlock(view.state.doc)
  view.dispatch(closeHistory(view.state.tr.insertText('  \n  B --> C\n', current.position + current.node.nodeSize - 1)))
  const before = codeBlock(view.state.doc).node.toJSON()
  view.dispatch(closeHistory(view.state.tr))
  const back = block.querySelector<HTMLButtonElement>('[data-action="return-code-block"]')
  expect(back).toBeInstanceOf(HTMLButtonElement)
  expect(back).toHaveAttribute('aria-label', '返回普通代码块')
  back!.click()
  expect(codeBlock(view.state.doc).node.toJSON()).toEqual({
    ...before, attrs: { ...before.attrs, language: '' },
  })
  expect(view.dom.querySelector('.arkdown-mermaid-block')).toBeNull()
  expect(undo(view.state, view.dispatch)).toBe(true)
  expect(codeBlock(view.state.doc).node.toJSON()).toEqual(before)
  expect(view.dom.querySelector('.arkdown-mermaid-block')).not.toBeNull()
  expect(redo(view.state, view.dispatch)).toBe(true)
  expect(codeBlock(view.state.doc).node.toJSON()).toEqual({
    ...before, attrs: { ...before.attrs, language: '' },
  })
})

it.each(['mermaid-copy-image', 'mermaid-save-image', 'cancel-save', 'escape'] as const)(
  'keeps a real preview NodeView selected and unchanged after %s and menu focus restoration',
  async (command) => {
    const { block, view, crepe, registry } = await createEditor({
      render: () => ready('data:image/svg+xml;base64,PHN2Zy8+'),
    }, 'Before\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter')
    await registry.renderAll()
    await registry.whenIdle()
    const before = view.state.doc.toJSON()
    const api = window.arkdown
    window.arkdown = {
      copyMermaidImage: vi.fn(async () => ({ ok: true, value: null })),
      saveMermaidImage: vi.fn(async () => ({ ok: true, value: null })),
    } as unknown as typeof api
    let request: ContextMenuRequest | undefined
    const handler = createVisualContextMenuHandler({
      crepe,
      menu: { openMenu: (next) => { request = next }, closeMenu() {}, isOpen: false },
      commit: vi.fn(),
      getMarkdown: () => crepe.getMarkdown(),
      rasterizeMermaidImage: async () => 'data:image/png;base64,UE5H',
    })
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
    view.dom.addEventListener('contextmenu', handler)
    try {
      block.querySelector('img')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
      expect(request).toBeDefined()
      expect(view.state.selection).toBeInstanceOf(NodeSelection)
      // ContextMenu closes and restores focus before executing the selected action.
      request!.restoreFocus()
      if (command !== 'escape') {
        await request!.execute(command === 'cancel-save' ? 'mermaid-save-image' : command)
      }
      expect(block).toHaveAttribute('data-arkdown-mermaid-mode', 'preview')
      expect(block.querySelector('.cm-editor')).toBeNull()
      expect(view.state.doc.toJSON()).toEqual(before)
    } finally {
      view.dom.removeEventListener('contextmenu', handler)
      window.arkdown = api
    }
  },
)

it('starts in preview mode and lazily creates the source editor on demand', async () => {
  const { block } = await createEditor({ render: () => ready('data:image/svg+xml;base64,QQ==') })

  expect(block).toHaveAttribute('data-arkdown-mermaid-mode', 'preview')
  expect(block).toHaveAttribute('data-arkdown-mermaid-render-state', 'pending')
  expect(block.querySelector('.arkdown-mermaid-preview')).toBeVisible()
  expect(block.querySelector('.cm-editor')).toBeNull()
  expect(sourceButton(block)).toHaveTextContent('编辑源码')

  openSource(block)
  expect(block.querySelector('.arkdown-mermaid-preview')).not.toBeVisible()
  expect(sourceButton(block)).toHaveTextContent('显示图形')
})

it('accepts Mermaid mode events and reflects source, preview, and render states on its host', async () => {
  const { block } = await createEditor({ render: () => ready('data:image/svg+xml;base64,QQ==') })

  block.dispatchEvent(new CustomEvent('arkdown:mermaid-set-mode', { detail: { mode: 'source' } }))
  expect(block).toHaveAttribute('data-arkdown-mermaid-mode', 'source')
  expect(block.querySelector('.arkdown-mermaid-preview')).not.toBeVisible()

  block.dispatchEvent(new CustomEvent('arkdown:mermaid-set-mode', { detail: { mode: 'preview' } }))
  expect(block).toHaveAttribute('data-arkdown-mermaid-mode', 'preview')
  expect(block.querySelector('.arkdown-mermaid-preview')).toBeVisible()

  reveal(block)
  await new Promise((resolve) => setTimeout(resolve, 260))
  expect(block).toHaveAttribute('data-arkdown-mermaid-render-state', 'ready')
})

it('retries a transient queue limit while the Mermaid block remains visible', async () => {
  vi.useFakeTimers()
  const render = vi.fn<MermaidRenderer['render']>()
    .mockResolvedValueOnce({
      status: 'resource-error',
      code: 'QUEUE_LIMIT',
      message: 'Mermaid 图形生成队列已满',
    })
    .mockResolvedValueOnce({
      status: 'ready',
      dataUrl: 'data:image/svg+xml;base64,UkVUUkJFRA==',
    })
  const { block, registry } = await createEditor({ render })

  reveal(block)
  await vi.advanceTimersByTimeAsync(251)

  expect(render).toHaveBeenCalledTimes(1)
  expect(block.querySelector('.arkdown-mermaid-preview')).toHaveAttribute('role', 'status')
  expect(block.querySelector('.arkdown-mermaid-preview')).toHaveTextContent('正在生成 Mermaid 图形…')
  let idle = false
  const waiting = registry.whenIdle().then(() => { idle = true })
  await Promise.resolve()
  expect(idle).toBe(false)

  await vi.advanceTimersByTimeAsync(1_000)
  await waiting

  expect(render).toHaveBeenCalledTimes(2)
  expect(idle).toBe(true)
  expect(block.querySelector<HTMLImageElement>('.arkdown-mermaid-preview img')?.src)
    .toBe('data:image/svg+xml;base64,UkVUUkJFRA==')
})

it('defers a queue-limit retry after the Mermaid block leaves the viewport', async () => {
  vi.useFakeTimers()
  const render = vi.fn<MermaidRenderer['render']>()
    .mockResolvedValueOnce({
      status: 'resource-error',
      code: 'QUEUE_LIMIT',
      message: 'Mermaid 图形生成队列已满',
    })
    .mockResolvedValueOnce({
      status: 'ready',
      dataUrl: 'data:image/svg+xml;base64,UkVUVVJO',
    })
  const { block } = await createEditor({ render })

  reveal(block)
  await vi.advanceTimersByTimeAsync(251)
  const observer = IntersectionObserverStub.instances.find((candidate) => candidate.targets.has(block))!
  observer.trigger(block, false)
  await vi.advanceTimersByTimeAsync(1_000)

  expect(render).toHaveBeenCalledTimes(1)
  expect(block.querySelector('.arkdown-mermaid-preview')).toHaveTextContent('正在生成 Mermaid 图形…')

  observer.trigger(block)
  await vi.advanceTimersByTimeAsync(251)

  expect(render).toHaveBeenCalledTimes(2)
  expect(block.querySelector<HTMLImageElement>('.arkdown-mermaid-preview img')?.src)
    .toBe('data:image/svg+xml;base64,UkVUVVJO')
})

it('renders the first 30 blocks after a real service queue burst and keeps block 31 limited', async () => {
  vi.useFakeTimers()
  let queueLimitResponses = 0
  const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path d="M0 0L2 2"/></svg>'
  const mermaid = {
    initialize: vi.fn((_config: Record<string, unknown>) => undefined),
    parse: vi.fn(async (_source: string, _options: { suppressErrors: true }) => true),
    render: vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 300))
      return { svg: safeSvg }
    }),
  }
  const service = createMermaidRenderService({
    loadMermaid: async () => mermaid,
    hash: async (value) => value,
  })
  const renderer: MermaidRenderer = {
    render: async (request) => {
      const result = await service.render(request)
      if (result.status === 'resource-error' && result.code === 'QUEUE_LIMIT') {
        queueLimitResponses += 1
      }
      return result
    },
  }
  const markdown = Array.from({ length: MERMAID_MAX_BLOCKS + 1 }, (_, index) => [
    '```mermaid',
    `flowchart LR; D${index}A --> D${index}B`,
    '```',
  ].join('\n')).join('\n\n')
  const registry = createMermaidViewRegistry(initialAppearance)
  const { view } = await createEditor(renderer, markdown, registry)
  const blocks = [...view.dom.querySelectorAll<HTMLElement>('.arkdown-mermaid-block')]

  blocks.slice(0, MERMAID_MAX_BLOCKS).forEach(reveal)
  await vi.runAllTimersAsync()
  await registry.whenIdle()

  expect(blocks).toHaveLength(MERMAID_MAX_BLOCKS + 1)
  expect(queueLimitResponses).toBeGreaterThan(0)
  expect(mermaid.render).toHaveBeenCalledTimes(MERMAID_MAX_BLOCKS)
  expect(blocks.slice(0, MERMAID_MAX_BLOCKS)
    .every((block) => block.querySelector('img') !== null)).toBe(true)
  expect(blocks.slice(0, MERMAID_MAX_BLOCKS)
    .some((block) => block.querySelector('[role="alert"]') !== null)).toBe(false)
  expect(blocks[MERMAID_MAX_BLOCKS]!.querySelector('[role="alert"]'))
    .toHaveTextContent(`Mermaid 图块超过 ${MERMAID_MAX_BLOCKS} 个限制`)
})

it('keeps the editor usable when Mermaid blocks exceed the per-editor capacity', async () => {
  const render = vi.fn<MermaidRenderer['render']>(() => ready('data:image/svg+xml;base64,QQ=='))
  const markdown = Array.from({ length: MERMAID_MAX_BLOCKS + 1 }, (_, index) => [
    '```mermaid',
    `graph TD; A${index} --> B${index}`,
    '```',
  ].join('\n')).join('\n\n')

  const registry = createMermaidViewRegistry(initialAppearance)
  const { view } = await createEditor({ render }, markdown, registry)
  const blocks = [...view.dom.querySelectorAll<HTMLElement>('.arkdown-mermaid-block')]
  const overflow = blocks[MERMAID_MAX_BLOCKS]!

  expect(blocks).toHaveLength(MERMAID_MAX_BLOCKS + 1)
  expect(overflow.querySelector('[role="alert"]'))
    .toHaveTextContent(`Mermaid 图块超过 ${MERMAID_MAX_BLOCKS} 个限制`)
  expect(IntersectionObserverStub.instances.some((observer) => observer.targets.has(overflow))).toBe(false)
  expect(render).not.toHaveBeenCalled()

  await registry.renderAll()
  await registry.whenIdle()
  expect(render).toHaveBeenCalledTimes(MERMAID_MAX_BLOCKS)
  expect(overflow.querySelector('[role="alert"]'))
    .toHaveTextContent(`Mermaid 图块超过 ${MERMAID_MAX_BLOCKS} 个限制`)

  const source = openSource(overflow)
  expect(source.state.doc.toString())
    .toBe(`graph TD; A${MERMAID_MAX_BLOCKS} --> B${MERMAID_MAX_BLOCKS}`)
  source.focus()
  source.dispatch({
    changes: {
      from: 0,
      to: source.state.doc.length,
      insert: 'graph TD; OVERFLOW --> EDITED',
    },
  })
  await vi.waitFor(() => {
    expect(codeBlock(view.state.doc).node.textContent).toBe('graph TD; OVERFLOW --> EDITED')
  })
})

it('recovers a BLOCK_LIMIT NodeView when a registered block changes language', async () => {
  const render = vi.fn<MermaidRenderer['render']>(() => ready('data:image/svg+xml;base64,QQ=='))
  const markdown = Array.from({ length: MERMAID_MAX_BLOCKS + 1 }, (_, index) => [
    '```mermaid',
    `graph TD; A${index} --> B${index}`,
    '```',
  ].join('\n')).join('\n\n')
  const registry = createMermaidViewRegistry(initialAppearance)
  const { view } = await createEditor({ render }, markdown, registry)
  const blocks = [...view.dom.querySelectorAll<HTMLElement>('.arkdown-mermaid-block')]
  const overflow = blocks[MERMAID_MAX_BLOCKS]!

  await registry.renderAll()
  await registry.whenIdle()
  expect(render).toHaveBeenCalledTimes(MERMAID_MAX_BLOCKS)
  expect(overflow.querySelector('[role="alert"]'))
    .toHaveTextContent(`Mermaid 图块超过 ${MERMAID_MAX_BLOCKS} 个限制`)
  expect(IntersectionObserverStub.instances.some((observer) => observer.targets.has(overflow))).toBe(false)

  const first = codeBlocks(view.state.doc)[0]!
  view.dispatch(view.state.tr.setNodeAttribute(first.position, 'language', 'javascript'))

  await vi.waitFor(() => {
    expect(overflow.querySelector('[role="status"]')).toHaveTextContent('正在生成 Mermaid 图形…')
    expect(IntersectionObserverStub.instances.some((observer) => observer.targets.has(overflow))).toBe(true)
  })

  vi.useFakeTimers()
  reveal(overflow)
  await vi.advanceTimersByTimeAsync(250)
  expect(render).toHaveBeenCalledTimes(MERMAID_MAX_BLOCKS + 1)
  expect(overflow.querySelector('img')).toHaveAttribute('alt', 'Mermaid diagram')

  await registry.renderAll()
  await registry.whenIdle()
  expect(render).toHaveBeenCalledTimes((MERMAID_MAX_BLOCKS * 2) + 1)
})

it('renders a safe image element from the renderer data URL without injecting SVG into the host DOM', async () => {
  vi.useFakeTimers()
  const dataUrl = 'data:image/svg+xml;base64,PHN2Zz48dGV4dD5PSzwvdGV4dD48L3N2Zz4='
  const { block } = await createEditor({ render: () => ready(dataUrl) })

  reveal(block)
  await vi.advanceTimersByTimeAsync(250)

  const image = block.querySelector<HTMLImageElement>('.arkdown-mermaid-preview img')
  expect(image).toBeInstanceOf(HTMLImageElement)
  expect(image).toHaveAttribute('alt', 'Mermaid diagram')
  expect(image).toHaveAttribute('src', dataUrl)
  expect(block.querySelector('svg')).toBeNull()
})

it('opens the clicked vector snapshot without dispatching editor changes or moving its selection', async () => {
  vi.useFakeTimers()
  const openMermaidViewer = vi.fn(async () => ({ ok: true as const, value: null }))
  const previousApi = window.arkdown
  window.arkdown = { ...previousApi, openMermaidViewer }
  try {
    const dataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'
    const { block, view, registry } = await createEditor({ render: () => ready(dataUrl) })
    reveal(block)
    await vi.advanceTimersByTimeAsync(250)
    const doc = view.state.doc.toJSON()
    const selection = view.state.selection.toJSON()
    const image = block.querySelector<HTMLImageElement>('.arkdown-mermaid-preview img')!
    image.click()
    await vi.waitFor(() => expect(openMermaidViewer).toHaveBeenCalledExactlyOnceWith({ svgDataUrl: dataUrl, colorScheme: 'light', themeColor: '#336699' }))
    expect(view.state.doc.toJSON()).toEqual(doc)
    expect(view.state.selection.toJSON()).toEqual(selection)
    expect(block.dataset.arkdownMermaidMode).toBe('preview')
  } finally { window.arkdown = previousApi }
})

it('invalidates a ready export generation immediately when Mermaid source changes', async () => {
  vi.useFakeTimers()
  const dataUrl = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
  const { block, view } = await createEditor({ render: () => ready(dataUrl) })
  reveal(block)
  await vi.advanceTimersByTimeAsync(250)
  expect(block.dataset.arkdownMermaidRenderState).toBe('ready')
  const readyGeneration = block.dataset.arkdownMermaidRenderGeneration

  const current = codeBlock(view.state.doc)
  view.dispatch(view.state.tr.insertText('flowchart', current.position + 1, current.position + 1 + 5))

  expect(block.dataset.arkdownMermaidRenderState).toBe('pending')
  expect(block.dataset.arkdownMermaidRenderGeneration).not.toBe(readyGeneration)
})

it('writes CodeMirror text and selection changes into ProseMirror transactions', async () => {
  const { block, view } = await createEditor({ render: () => ready('data:image/svg+xml;base64,QQ==') })
  const cm = openSource(block)
  cm.focus()
  const insert = '\n  B --> C'

  cm.dispatch({
    changes: { from: cm.state.doc.length, insert },
    selection: { anchor: cm.state.doc.length + insert.length },
  })

  const current = codeBlock(view.state.doc)
  expect(current.node.textContent).toBe('graph TD\n  A --> B\n  B --> C')
  expect(view.state.selection.from).toBe(current.position + 1 + current.node.textContent.length)
  expect(view.state.selection.to).toBe(view.state.selection.from)
})

it('preserves a reverse CodeMirror selection direction in ProseMirror', async () => {
  const { block, view } = await createEditor({ render: () => ready('data:image/svg+xml;base64,QQ==') })
  const cm = openSource(block)
  cm.focus()
  const current = codeBlock(view.state.doc)

  cm.dispatch({ selection: { anchor: cm.state.doc.length, head: 2 } })

  expect(view.state.selection.anchor).toBe(current.position + 1 + cm.state.doc.length)
  expect(view.state.selection.head).toBe(current.position + 1 + 2)
  expect(view.state.selection.anchor).toBeGreaterThan(view.state.selection.head)
})

it('applies ProseMirror text updates to CodeMirror without dispatching a feedback transaction', async () => {
  const { block, view } = await createEditor({ render: () => ready('data:image/svg+xml;base64,QQ==') })
  const cm = openSource(block)
  const current = codeBlock(view.state.doc)
  const dispatch = vi.spyOn(view, 'dispatch')

  view.dispatch(view.state.tr.insertText('flowchart', current.position + 1, current.position + 1 + 'graph'.length))

  expect(cm.state.doc.toString()).toBe('flowchart TD\n  A --> B')
  expect(dispatch).toHaveBeenCalledTimes(1)
})

it('routes undo and redo from CodeMirror through ProseMirror history', async () => {
  const { block, view } = await createEditor({ render: () => ready('data:image/svg+xml;base64,QQ==') })
  const cm = openSource(block)
  cm.focus()
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: '\n  B --> C' } })
  expect(codeBlock(view.state.doc).node.textContent).toContain('B --> C')

  key(cm.contentDOM, 'z', { ctrlKey: true })
  expect(codeBlock(view.state.doc).node.textContent).toBe('graph TD\n  A --> B')
  expect(cm.state.doc.toString()).toBe('graph TD\n  A --> B')

  key(cm.contentDOM, 'y', { ctrlKey: true })
  expect(codeBlock(view.state.doc).node.textContent).toContain('B --> C')
  expect(cm.state.doc.toString()).toContain('B --> C')
})

it('defers ProseMirror synchronization until IME composition ends', async () => {
  const { block, view } = await createEditor({ render: () => ready('data:image/svg+xml;base64,QQ==') })
  const cm = openSource(block)
  cm.focus()

  cm.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: '节点' } })
  expect(codeBlock(view.state.doc).node.textContent).toBe('graph TD\n  A --> B')

  cm.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  await Promise.resolve()
  expect(codeBlock(view.state.doc).node.textContent).toBe('graph TD\n  A --> B节点')
})

it('turns an empty Mermaid block into a paragraph on Backspace', async () => {
  const { block, view } = await createEditor(
    { render: () => ready('data:image/svg+xml;base64,QQ==') },
    '```mermaid\n\n```',
  )
  const cm = openSource(block)
  cm.focus()
  cm.dispatch({ selection: { anchor: 0 } })

  key(cm.contentDOM, 'Backspace')

  expect(view.state.doc.firstChild?.type.name).toBe('paragraph')
  expect(view.state.selection.$from.parent.type.name).toBe('paragraph')
})

it('escapes at code boundaries and uses Mod-Enter to exit the code block', async () => {
  const source = 'before\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nafter'
  const { block, view } = await createEditor(
    { render: () => ready('data:image/svg+xml;base64,QQ==') },
    source,
  )
  const cm = openSource(block)
  cm.focus()
  const current = codeBlock(view.state.doc)
  cm.dispatch({ selection: { anchor: 0 } })

  key(cm.contentDOM, 'ArrowUp')
  expect(view.state.selection.from).toBeLessThan(current.position)

  cm.focus()
  cm.dispatch({ selection: { anchor: 1 } })
  key(cm.contentDOM, 'Enter', { ctrlKey: true })
  expect(view.state.selection.from).toBeGreaterThan(current.position + current.node.nodeSize)
})

it('debounces source renders for 250 ms and submits only the latest source', async () => {
  vi.useFakeTimers()
  const render = vi.fn<MermaidRenderer['render']>(() => ready('data:image/svg+xml;base64,QQ=='))
  const { block } = await createEditor({ render })
  reveal(block)

  await vi.advanceTimersByTimeAsync(249)
  expect(render).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(render).toHaveBeenCalledTimes(1)

  const cm = openSource(block)
  cm.focus()
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: '1' } })
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: '2' } })
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: '3' } })
  await vi.advanceTimersByTimeAsync(249)
  expect(render).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)

  expect(render).toHaveBeenCalledTimes(2)
  expect(render.mock.calls[1]?.[0].source).toBe('graph TD\n  A --> B123')
})

it('discards an older generation that resolves after the latest render', async () => {
  vi.useFakeTimers()
  const pending: Array<{
    request: MermaidRenderRequest
    resolve: (result: MermaidRenderResult) => void
  }> = []
  const renderer: MermaidRenderer = {
    render: (request) => new Promise((resolve) => pending.push({ request, resolve })),
  }
  const { block } = await createEditor(renderer)
  reveal(block)
  await vi.advanceTimersByTimeAsync(250)

  const cm = openSource(block)
  cm.focus()
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: '\n  B --> C' } })
  await vi.advanceTimersByTimeAsync(250)
  expect(pending).toHaveLength(2)

  pending[1]!.resolve({ status: 'ready', dataUrl: 'data:image/svg+xml;base64,TkVX' })
  await Promise.resolve()
  expect(block.querySelector('img')).toHaveAttribute('src', 'data:image/svg+xml;base64,TkVX')

  pending[0]!.resolve({ status: 'ready', dataUrl: 'data:image/svg+xml;base64,T0xE' })
  await Promise.resolve()
  expect(block.querySelector('img')).toHaveAttribute('src', 'data:image/svg+xml;base64,TkVX')
})

it('refreshes a connected preview with the latest appearance revision', async () => {
  vi.useFakeTimers()
  const render = vi.fn<MermaidRenderer['render']>((request) => ready(
    `data:image/svg+xml;base64,UkVWSVNJT04t${request.appearance.revision}`,
  ))
  const { block, registry } = await createEditor({ render })
  reveal(block)
  await vi.advanceTimersByTimeAsync(250)
  expect(block.querySelector('img')).toHaveAttribute('src', 'data:image/svg+xml;base64,UkVWSVNJT04t1')

  registry.refreshAppearance({ ...initialAppearance, revision: 2, colorScheme: 'dark' })
  await vi.runAllTimersAsync()

  expect(render.mock.calls.at(-1)?.[0].appearance.revision).toBe(2)
  expect(block.querySelector('img')).toHaveAttribute('src', 'data:image/svg+xml;base64,UkVWSVNJT04t2')
})

it('tracks a print render synchronously so an immediate whenIdle call waits for it', async () => {
  vi.useFakeTimers()
  let resolve!: (result: MermaidRenderResult) => void
  const render = vi.fn<MermaidRenderer['render']>(() => new Promise((done) => { resolve = done }))
  const { registry } = await createEditor({ render })

  registry.renderAll()
  let idle = false
  const waiting = registry.whenIdle().then(() => { idle = true })
  await Promise.resolve()

  expect(render).toHaveBeenCalledTimes(1)
  expect(registry.tracked).toHaveLength(1)
  expect(idle).toBe(false)

  resolve({ status: 'ready', dataUrl: 'data:image/svg+xml;base64,UFJJTlQ=' })
  await waiting
  expect(idle).toBe(true)
})

it('turns a pending print render into a timeout terminal and ignores its late result', async () => {
  let resolve!: (result: MermaidRenderResult) => void
  let request!: MermaidRenderRequest
  const render = vi.fn<MermaidRenderer['render']>((next) => {
    request = next
    return new Promise((done) => { resolve = done })
  })
  const { block, registry } = await createEditor({ render })

  void registry.renderAll()
  expect(block).toHaveTextContent('正在生成 Mermaid 图形…')
  const current = [...registry.views][0]!
  current.finishPrintTimeout()

  expect(request.signal.aborted).toBe(true)
  expect(block).toHaveTextContent('Mermaid 图形生成超时')
  expect(block.querySelector('img')).toBeNull()

  resolve({ status: 'ready', dataUrl: 'data:image/svg+xml;base64,TEFURQ==' })
  await Promise.resolve()
  expect(block).toHaveTextContent('Mermaid 图形生成超时')
  expect(block.querySelector('img')).toBeNull()
})

it('freezes a deadline-owned print view against late visibility and theme refreshes', async () => {
  vi.useFakeTimers()
  const render = vi.fn<MermaidRenderer['render']>(() => new Promise(() => undefined))
  const { block, registry } = await createEditor({ render })
  const current = [...registry.views][0]!
  const observer = IntersectionObserverStub.instances.find((candidate) => candidate.targets.has(block))!

  current.preparePrint(true)
  current.refresh('print')
  current.finishPrintTimeout()
  expect(observer.targets.has(block)).toBe(false)
  observer.trigger(block)
  registry.refreshAppearance({ ...initialAppearance, revision: 2, colorScheme: 'dark' })
  await vi.advanceTimersByTimeAsync(350)

  expect(render).toHaveBeenCalledOnce()
  expect(block).toHaveTextContent('Mermaid 图形生成超时')
  expect(block.querySelector('img')).toBeNull()
})

it('shows a bounded app-owned syntax summary whose action opens the source editor', async () => {
  vi.useFakeTimers()
  const { block } = await createEditor({
    render: async () => ({
      status: 'syntax-error',
      message: '<img src=x onerror=alert(1)> C:\\private\\module.js private_customer_name',
      summary: { kind: 'line', line: 12 },
    }),
  })
  const preview = block.querySelector<HTMLElement>('.arkdown-mermaid-preview')!
  expect(preview).toHaveAttribute('role', 'status')
  expect(preview).toHaveAttribute('aria-live', 'polite')
  reveal(block)
  await vi.advanceTimersByTimeAsync(250)

  expect(block).toHaveTextContent('Mermaid 语法错误')
  const summary = block.querySelector<HTMLElement>('.arkdown-mermaid-error-summary')
  expect(summary).toHaveTextContent('第 12 行附近存在语法错误')
  expect(summary!.textContent!.length).toBeLessThanOrEqual(500)
  expect(block).not.toHaveTextContent('private_customer_name')
  expect(block).not.toHaveTextContent('module.js')
  expect(block.querySelector('img')).toBeNull()
  expect(preview).toHaveAttribute('role', 'alert')
  expect(preview).toHaveAttribute('aria-live', 'assertive')
  const edit = block.querySelector<HTMLButtonElement>('[data-action="edit-error-source"]')
  expect(edit).toBeInstanceOf(HTMLButtonElement)
  edit!.click()
  expect(block.querySelector('.cm-editor')).toBeInstanceOf(HTMLElement)
})

it('keeps CodeMirror read-only when the ProseMirror view is not editable', async () => {
  const { block, view } = await createEditor({ render: () => ready('data:image/svg+xml;base64,QQ==') })
  const cm = openSource(block)
  expect(cm.state.readOnly).toBe(false)

  view.setProps({ editable: () => false })
  const current = codeBlock(view.state.doc)
  view.dispatch(view.state.tr.setNodeAttribute(current.position, 'language', ' MERMAID '))
  expect(cm.state.readOnly).toBe(true)

  cm.dispatch({ changes: { from: cm.state.doc.length, insert: 'blocked' } })
  expect(cm.state.doc.toString()).toBe('graph TD\n  A --> B')
  expect(codeBlock(view.state.doc).node.textContent).toBe('graph TD\n  A --> B')
})

it.each([
  ['Mod-Enter', 'Enter', { ctrlKey: true }, 1],
  ['Backspace', 'Backspace', {}, 0],
] as const)('does not dispatch %s from a read-only Mermaid source editor', async (
  _name,
  pressedKey,
  options,
  anchor,
) => {
  const { block, view } = await createEditor(
    { render: () => ready('data:image/svg+xml;base64,QQ==') },
    '```mermaid\ngraph TD\n```',
  )
  const cm = openSource(block)
  cm.focus()
  cm.dispatch({ selection: { anchor } })
  view.setProps({ editable: () => false })
  const before = view.state.doc.toJSON()
  const dispatch = vi.spyOn(view, 'dispatch')

  key(cm.contentDOM, pressedKey, options)

  expect(dispatch).not.toHaveBeenCalled()
  expect(view.state.doc.toJSON()).toEqual(before)
})

it('does not dispatch undo from a read-only Mermaid source editor', async () => {
  const { block, view } = await createEditor({ render: () => ready('data:image/svg+xml;base64,QQ==') })
  const cm = openSource(block)
  cm.focus()
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: '\n  B --> C' } })
  view.setProps({ editable: () => false })
  const before = view.state.doc.toJSON()
  const dispatch = vi.spyOn(view, 'dispatch')

  key(cm.contentDOM, 'z', { ctrlKey: true })

  expect(dispatch).not.toHaveBeenCalled()
  expect(view.state.doc.toJSON()).toEqual(before)
})

it('does not dispatch redo from a read-only Mermaid source editor', async () => {
  const { block, view } = await createEditor({ render: () => ready('data:image/svg+xml;base64,QQ==') })
  const cm = openSource(block)
  cm.focus()
  cm.dispatch({ changes: { from: cm.state.doc.length, insert: '\n  B --> C' } })
  key(cm.contentDOM, 'z', { ctrlKey: true })
  view.setProps({ editable: () => false })
  const before = view.state.doc.toJSON()
  const dispatch = vi.spyOn(view, 'dispatch')

  key(cm.contentDOM, 'y', { ctrlKey: true })

  expect(dispatch).not.toHaveBeenCalled()
  expect(view.state.doc.toJSON()).toEqual(before)
})

it('aborts an in-flight render and unregisters when the NodeView is destroyed', async () => {
  vi.useFakeTimers()
  let request: MermaidRenderRequest | undefined
  let resolve!: (result: MermaidRenderResult) => void
  const renderer: MermaidRenderer = {
    render: (next) => {
      request = next
      return new Promise((done) => { resolve = done })
    },
  }
  const { block, crepe, registry } = await createEditor(renderer)
  reveal(block)
  await vi.advanceTimersByTimeAsync(250)
  expect(registry.views.size).toBe(1)
  expect(request?.signal.aborted).toBe(false)

  editors.splice(editors.indexOf(crepe), 1)
  await crepe.destroy()

  expect(request?.signal.aborted).toBe(true)
  expect(registry.views.size).toBe(0)
  resolve({ status: 'ready', dataUrl: 'data:image/svg+xml;base64,TEFURQ==' })
  await Promise.resolve()
  expect(block.querySelector('img')).toBeNull()
})
