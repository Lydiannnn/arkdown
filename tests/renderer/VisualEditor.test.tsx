import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { parserCtx, serializerCtx } from '@milkdown/kit/core'
import { Schema, Slice, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { AllSelection, EditorState, NodeSelection, TextSelection, type Plugin, type Transaction } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { history, redo, undo, undoDepth } from '@milkdown/kit/prose/history'
import { CellSelection, tableNodes } from '@milkdown/kit/prose/tables'
import { createRef, StrictMode, Suspense, startTransition, useState } from 'react'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  buildMarkdownInsertionTransaction,
  buildSelectedBlockStyleTransaction,
  captureProseMirrorSelectionBookmark,
  restorePreparedEnhancedTablesInDocument,
  VISUAL_AI_TRANSACTION_META,
  VisualEditor,
  type VisualEditorHandle,
} from '../../src/renderer/editor/VisualEditor'
import { ContextMenuContext } from '../../src/renderer/context-menu/ContextMenuProvider'
import type { ContextMenuRequest } from '../../src/renderer/context-menu/context-menu-types'
import { resolveSourceModePosition } from '../../src/renderer/editor/editor-mode-position'
import { StickyNoteEditor } from '../../src/renderer/sticky-notes/StickyNoteEditor'
import type {
  TranslationHistoryEditorPort,
  TranslationHistoryRecord,
} from '../../src/renderer/editor/translation-history'
import { createVisualTranslationHistoryAnchor } from '../../src/renderer/editor/translation-history-anchor'
import { visualTranslationHistoryPluginKey } from '../../src/renderer/editor/visual-translation-history-plugin'
import { visualDropRequestIdForEvent } from '../../src/renderer/editor/visual-drop-insertion'
import { codeMirrorTooltips } from '../../src/renderer/editor/codemirror-tooltips'
import { frontmatterEditorPlugins } from '../../src/renderer/editor/frontmatter-code-block'
import { extendedInlineMarkPlugins } from '../../src/renderer/editor/extended-inline-marks'
import { enhancedTableEditorPlugins } from '../../src/renderer/editor/enhanced-table-schema'
import { prepareEnhancedTables } from '../../src/renderer/editor/enhanced-table-schema'
import type {
  MermaidAppearance,
  MermaidRegistryPort,
  MermaidRenderer,
} from '../../src/renderer/editor/mermaid/mermaid-types'

type MarkdownListener = (
  context: unknown,
  markdown: string,
  previousMarkdown: string,
) => void

type Deferred = {
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

type DroppedMarkdownTestHandle = VisualEditorHandle & {
  insertDroppedMarkdown?(input: {
    markdown: string
    clientX: number
    clientY: number
    visualDropRequestId?: number
  }): boolean
}

type ProsePluginMock = {
  spec: {
    filterTransaction?: (transaction: Transaction) => boolean
    key?: unknown
    state?: {
      apply?: (
        transaction: { docChanged: boolean; doc?: ProseMirrorNode; getMeta(key: string): unknown },
        value: null,
      ) => null
    }
    props?: {
      handleKeyDown?: (view: EditorView, event: KeyboardEvent) => boolean
      handleDrop?: (
        view: EditorView,
        event: DragEvent,
        slice: Slice,
        move: boolean,
      ) => boolean
      handleDOMEvents?: {
        dragover?: (view: EditorView, event: DragEvent) => boolean
        dragleave?: (view: EditorView, event: DragEvent) => boolean
        dragend?: (view: EditorView, event: DragEvent) => boolean
      }
    }
    view?: (view: EditorView) => {
      update?: (view: EditorView, previousState: EditorState) => void
      destroy?: () => void
    }
  }
}

type MilkdownPluginMock = {
  factory: () => ProsePluginMock
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const crepeMock = vi.hoisted(() => ({
  instances: [] as Array<{
    config: Record<string, unknown>
    markdown: string
    listener: MarkdownListener | null
    create: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    getMarkdown: ReturnType<typeof vi.fn>
    domForceFlush: ReturnType<typeof vi.fn>
    domFlush: ReturnType<typeof vi.fn>
    viewDispatch: ReturnType<typeof vi.fn>
    viewUpdateState: ReturnType<typeof vi.fn>
    viewFocus: ReturnType<typeof vi.fn>
    viewPosAtDOM: ReturnType<typeof vi.fn<(node: Node, offset: number) => number>>
    viewPosAtCoords: ReturnType<typeof vi.fn<(coordinates: { left: number; top: number }) => { pos: number } | null>>
    viewCoordsAtPos: ReturnType<typeof vi.fn<(position: number) => { left: number; top: number; right: number; bottom: number }>>
    viewComposing: boolean
    viewDom: HTMLElement | null
    viewState: EditorState | null
    viewOverride: EditorView | null
    parser: ReturnType<typeof vi.fn<(markdown: string) => ProseMirrorNode>>
    serializer: ReturnType<typeof vi.fn<(node: ProseMirrorNode) => string>> | null
    usedPlugins: unknown[]
    prosePlugins: ProsePluginMock[]
    applyTransaction: (docChanged?: boolean) => void
    queueDomTransaction: () => void
  }>,
  createPlans: [] as Array<() => Promise<unknown>>,
  destroyPlans: [] as Array<() => Promise<unknown>>,
}))

type RegistryMock = Omit<
  MermaidRegistryPort,
  'refreshAppearance' | 'renderAll' | 'whenIdle' | 'dispose'
> & {
  refreshAppearance: ReturnType<typeof vi.fn<(next: MermaidAppearance) => void>>
  renderAll: ReturnType<typeof vi.fn<() => Promise<void>>>
  whenIdle: ReturnType<typeof vi.fn<() => Promise<void>>>
  dispose: ReturnType<typeof vi.fn<() => void>>
}

const mermaidIntegrationMock = vi.hoisted(() => ({
  createRenderer: vi.fn(),
  getWindowRenderer: vi.fn(),
  createRegistry: vi.fn(),
  createAdaptive: vi.fn(),
  renderers: [] as MermaidRenderer[],
  windowRenderer: null as MermaidRenderer | null,
  registries: [] as RegistryMock[],
  plugin: { mermaidPlugin: true },
}))

vi.mock('../../src/renderer/editor/mermaid/mermaid-render-service', () => ({
  createMermaidRenderService: mermaidIntegrationMock.createRenderer,
  getWindowMermaidRenderService: mermaidIntegrationMock.getWindowRenderer,
}))

vi.mock('../../src/renderer/editor/mermaid/mermaid-view-registry', () => ({
  createMermaidViewRegistry: mermaidIntegrationMock.createRegistry,
}))

vi.mock('../../src/renderer/editor/mermaid/adaptive-code-block-view', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/renderer/editor/mermaid/adaptive-code-block-view')>(),
  createAdaptiveMermaidCodeBlockView: mermaidIntegrationMock.createAdaptive,
}))

vi.mock('@milkdown/kit/utils', () => ({
  $prose: (factory: () => ProsePluginMock): MilkdownPluginMock => ({ factory }),
  $remark: () => [],
  $markSchema: () => [],
  $command: (id: string) => Object.assign({ commandPlugin: true }, { key: id }),
  $useKeymap: () => ({ keymapPlugin: true }),
  $view: () => ({ viewPlugin: true }),
}))

vi.mock('@milkdown/crepe', () => {
  class Crepe {
    static Feature = {
      AI: 'ai',
      BlockEdit: 'block-edit',
      ImageBlock: 'image-block',
      LinkTooltip: 'link-tooltip',
      Latex: 'latex',
      Table: 'table',
      TopBar: 'top-bar',
      Toolbar: 'toolbar',
      Placeholder: 'placeholder',
      CodeMirror: 'code-mirror',
      Cursor: 'cursor',
    }

    config: Record<string, unknown>
    markdown: string
    listener: MarkdownListener | null = null
    create: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    getMarkdown: ReturnType<typeof vi.fn>
    usedPlugins: unknown[] = []
    prosePlugins: ProsePluginMock[] = []
    pendingDomTransaction = false
    domFlushScheduled = false
    domFlush = vi.fn(() => {
      if (this.domFlushScheduled || !this.pendingDomTransaction) return
      this.pendingDomTransaction = false
      this.applyTransaction()
    })
    domForceFlush = vi.fn(() => {
      if (!this.domFlushScheduled) return
      this.domFlushScheduled = false
      this.domFlush()
    })
    viewDispatch = vi.fn()
    viewUpdateState = vi.fn((state: EditorState) => { this.viewState = state })
    viewFocus = vi.fn()
    viewPosAtDOM = vi.fn((_node: Node, offset: number) => offset + 1)
    viewPosAtCoords = vi.fn(() => null)
    viewCoordsAtPos = vi.fn(() => ({ left: 12, top: 20, right: 92, bottom: 38 }))
    viewComposing = false
    viewDom: HTMLElement | null = document.createElement('div')
    viewOverride: EditorView | null = null
    viewAdapter: EditorView | null = null
    viewState: EditorState | null = null
    parser = vi.fn<(markdown: string) => ProseMirrorNode>()
    serializer: ReturnType<typeof vi.fn<(node: ProseMirrorNode) => string>> | null = null
    editor = {
      remove: vi.fn(() => Promise.resolve()),
      config: vi.fn((configure: (context: { update: ReturnType<typeof vi.fn> }) => void) => {
        configure({ update: vi.fn() })
        return this.editor
      }),
      use: vi.fn((plugin: MilkdownPluginMock | { viewPlugin: true }) => {
        this.usedPlugins.push(plugin)
        if ('factory' in plugin) this.prosePlugins.push(plugin.factory())
        return this.editor
      }),
      action: vi.fn((action: (context: { get: (key: unknown) => unknown }) => unknown) => {
        const instance = this
        return action({
          get: (key: unknown) => key === parserCtx
            ? instance.parser
            : key === serializerCtx
              ? instance.serializer
              : instance.viewOverride ?? (instance.viewAdapter ??= {
                domObserver: {
                  forceFlush: instance.domForceFlush,
                  flush: instance.domFlush,
                },
                dispatch: instance.viewDispatch,
                updateState: instance.viewUpdateState,
                setProps: vi.fn(),
                focus: instance.viewFocus,
                get composing() { return instance.viewComposing },
                get dom() { return instance.viewDom },
                posAtDOM: instance.viewPosAtDOM,
                posAtCoords: instance.viewPosAtCoords,
                coordsAtPos: instance.viewCoordsAtPos,
                get state() { return instance.viewState },
              } as unknown as EditorView),
        })
      }),
    }

    constructor(config: Record<string, unknown>) {
      this.config = config
      this.markdown = typeof config.defaultValue === 'string' ? config.defaultValue : ''
      const createPlan = crepeMock.createPlans.shift()
      const destroyPlan = crepeMock.destroyPlans.shift()
      this.create = vi.fn(() => createPlan?.() ?? Promise.resolve({}))
      this.destroy = vi.fn(() => destroyPlan?.() ?? Promise.resolve({}))
      this.getMarkdown = vi.fn(() => this.markdown)
      crepeMock.instances.push(this)
    }

    applyTransaction(docChanged = true) {
      const doc = this.viewState?.doc ?? handleSchema.node('doc', null, paragraph(''))
      this.prosePlugins.forEach((plugin) => {
        plugin.spec.state?.apply?.({
          docChanged,
          doc,
          getMeta: () => undefined,
        }, null)
      })
    }

    queueDomTransaction() {
      this.pendingDomTransaction = true
      this.domFlushScheduled = true
    }

    on(register: (listener: {
      markdownUpdated: (callback: MarkdownListener) => unknown
    }) => void) {
      const listenerApi = {
        markdownUpdated: (callback: MarkdownListener) => {
          this.listener = callback
          return listenerApi
        },
      }
      register(listenerApi)
      return this
    }
  }

  return { Crepe }
})

it.each([false, true])('uses native caret only in sticky notes (sticky=%s)', async (sticky) => {
  render(sticky
    ? <StickyNoteEditor markdown="alpha" onChange={vi.fn()} style={{ mode: 'material', materialPresetId: 'flowing-glass' }} />
    : <VisualEditor markdown="alpha" onChange={vi.fn()} />)
  await waitFor(() => expect(crepeMock.instances[0]?.create).toHaveBeenCalled())
  const mount = document.createElement('div')
  document.body.append(mount)
  const view = new EditorView(mount, { state: EditorState.create({
    schema: handleSchema, doc: handleSchema.node('doc', null, paragraph('alpha')),
  }) })
  const runtimes = crepeMock.instances[0].prosePlugins
    .map((plugin) => plugin.spec.view?.(view)).filter(Boolean)
  try {
    expect(document.querySelector('.arkdown-visual-input-caret') !== null).toBe(!sticky)
  } finally {
    runtimes.forEach((runtime) => runtime?.destroy?.())
    view.destroy()
    mount.remove()
  }
})

beforeEach(() => {
  crepeMock.instances.length = 0
  crepeMock.createPlans.length = 0
  crepeMock.destroyPlans.length = 0
  mermaidIntegrationMock.renderers.length = 0
  mermaidIntegrationMock.registries.length = 0
  mermaidIntegrationMock.windowRenderer = null
  mermaidIntegrationMock.createRenderer.mockReset().mockImplementation(() => {
    const renderer: MermaidRenderer = {
      render: vi.fn(async () => ({
        status: 'ready' as const,
        dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
      })),
    }
    mermaidIntegrationMock.renderers.push(renderer)
    return renderer
  })
  mermaidIntegrationMock.getWindowRenderer.mockReset().mockImplementation(() => {
    if (!mermaidIntegrationMock.windowRenderer) {
      mermaidIntegrationMock.windowRenderer = mermaidIntegrationMock.createRenderer()
    }
    return mermaidIntegrationMock.windowRenderer
  })
  mermaidIntegrationMock.createRegistry.mockReset().mockImplementation((initial: MermaidAppearance) => {
    let appearance = { ...initial }
    const registry: RegistryMock = {
      appearance: () => ({ ...appearance }),
      register: () => () => undefined,
      track: () => undefined,
      refreshAppearance: vi.fn<(next: MermaidAppearance) => void>((next) => {
        appearance = { ...next }
      }),
      renderAll: vi.fn<() => Promise<void>>(async () => undefined),
      whenIdle: vi.fn<() => Promise<void>>(async () => undefined),
      dispose: vi.fn<() => void>(),
    }
    mermaidIntegrationMock.registries.push(registry)
    return registry
  })
  mermaidIntegrationMock.createAdaptive.mockReset()
    .mockReturnValue(mermaidIntegrationMock.plugin)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function firePointer(
  target: Element | Document,
  type: 'pointerdown' | 'pointerup',
  pointerId = 1,
  clientX = 0,
  clientY = 0,
): void {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY })
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: pointerId },
    pointerType: { value: 'mouse' },
  })
  fireEvent(target, event)
}

function firePointerMove(
  target: Element,
  clientX: number,
  clientY: number,
): void {
  const event = new MouseEvent('pointermove', { bubbles: true, clientX, clientY })
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
  })
  fireEvent(target, event)
}

Object.assign(Range.prototype, {
  getClientRects: () => [{ left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1 }],
  getBoundingClientRect: () => new DOMRect(0, 0, 1, 1),
})

const handleSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    heading: { attrs: { level: { default: 1 } }, content: 'text*', group: 'block', toDOM: (node) => [`h${node.attrs.level}`, 0] },
    blockquote: { content: 'block+', group: 'block', toDOM: () => ['blockquote', 0] },
    hardbreak: {
      group: 'inline', inline: true, atom: true,
      attrs: { isInline: { default: true } },
      toDOM: () => ['span', { 'data-type': 'hardbreak' }, ' '],
    },
    text: { group: 'inline' },
    image: { inline: true, group: 'inline', atom: true, attrs: { src: {} }, toDOM: (node) => ['img', { src: node.attrs.src }] },
  },
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
      toDOM: (mark) => ['a', { href: mark.attrs.href }, 0],
    },
  },
})

function paragraph(text: string): ProseMirrorNode {
  return handleSchema.node('paragraph', null, text ? handleSchema.text(text) : undefined)
}

function enhancedTableTestSchema(): Schema {
  const table = tableNodes({
    tableGroup: 'block',
    cellContent: 'block+',
    cellAttributes: {
      alignment: {
        default: 'left',
        getFromDOM: (dom) => dom.getAttribute('data-align') ?? 'left',
        setDOMAttr: (value, attrs) => { attrs['data-align'] = value },
      },
    },
  })
  return new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
      blockquote: { content: 'block+', group: 'block', toDOM: () => ['blockquote', 0] },
      code_block: {
        content: 'text*',
        group: 'block',
        code: true,
        parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
        toDOM: () => ['pre', ['code', 0]],
      },
      bullet_list: { content: 'list_item+', group: 'block', toDOM: () => ['ul', 0] },
      ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 } }, toDOM: () => ['ol', 0] },
      list_item: { content: 'paragraph block*', toDOM: () => ['li', 0] },
      table: { ...table.table, content: 'table_header_row table_row+' },
      table_header_row: { ...table.table_row, content: 'table_header+' },
      table_row: { ...table.table_row, content: 'table_cell+' },
      table_header: { ...table.table_header, content: 'block+' },
      table_cell: { ...table.table_cell, content: 'block+' },
      text: { group: 'inline' },
    },
  })
}

function heading4(text: string): ProseMirrorNode {
  return handleSchema.node('heading', { level: 4 }, handleSchema.text(text))
}

function blockquote(...texts: string[]): ProseMirrorNode {
  return handleSchema.node('blockquote', null, texts.map(paragraph))
}

function stateSelectingAll(blocks: readonly ProseMirrorNode[]): EditorState {
  const doc = handleSchema.node('doc', null, blocks)
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1, doc.content.size - 1),
  })
}

function stateWithDocumentSelection(blocks: readonly ProseMirrorNode[]): EditorState {
  const doc = handleSchema.node('doc', null, blocks)
  return EditorState.create({ doc, selection: new AllSelection(doc) })
}

async function readyEditor(ref: React.RefObject<VisualEditorHandle | null>, onChange = vi.fn()) {
  render(<VisualEditor ref={ref} markdown="alpha\nomega" onChange={onChange} />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const instance = crepeMock.instances[0]!
  instance.viewDispatch.mockImplementation((transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  return { instance, onChange }
}

it.each([false, true])('consumes mixed image paste once at a local bookmark with undo/redo (sticky=%s)', async (sticky) => {
  let resolve!: (value: string) => void
  const readClipboardImage = vi.fn(() => new Promise<string>((done) => { resolve = done }))
  const props = { markdown: 'before after', onChange: vi.fn(), readClipboardImage, documentKey: 'doc-a' }
  const rendered = render(sticky ? <StickyNoteEditor {...props} /> : <VisualEditor {...props} />)
  await act(async () => { await Promise.resolve() })
  const instance = crepeMock.instances[0]!
  const doc = handleSchema.node('doc', null, paragraph('before after'))
  instance.viewState = EditorState.create({ doc, selection: TextSelection.create(doc, 8), plugins: [history()] })
  instance.viewDispatch.mockImplementation((tr) => { instance.viewState = instance.viewState!.apply(tr) })
  instance.parser.mockReturnValue(handleSchema.node('doc', null, handleSchema.node('paragraph', null, handleSchema.node('image', { src: 'assets/clip.png' }))))
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { types: ['image/png', 'text/html', 'text/plain'], items: [{ kind: 'file', type: 'image/png' }], getData: () => 'UNWANTED' } })
  fireEvent(rendered.container.querySelector('.visual-editor')!, event)
  expect(event.defaultPrevented).toBe(true)
  instance.viewState = instance.viewState.apply(instance.viewState.tr.setSelection(TextSelection.create(doc, 1)))
  await act(async () => resolve('![](assets/clip.png)'))
  expect(instance.viewState.doc.child(0).childCount).toBe(3)
  expect(instance.viewState.doc.child(0).child(0).text).toBe('before ')
  expect(instance.viewState.doc.child(0).child(1).attrs.src).toBe('assets/clip.png')
  expect(instance.viewState.doc.child(0).child(2).text).toBe('after')
  expect(readClipboardImage).toHaveBeenCalledOnce()
  undo(instance.viewState, instance.viewDispatch as (tr: Transaction) => void)
  expect(instance.viewState.doc.eq(doc)).toBe(true)
  redo(instance.viewState, instance.viewDispatch as (tr: Transaction) => void)
  expect(instance.viewState.doc.child(0).child(1).attrs.src).toBe('assets/clip.png')
})

it.each([
  { text: '**literal**', lines: ['**literal**'] },
  { text: '**literal**\r\nsecond\n\nlast', lines: ['**literal**', 'second', '', 'last'] },
])('preserves delegated table paste as cell paragraphs: $text', async ({ text, lines }) => {
  let resolveImage!: (value: null) => void
  const readClipboardImage = () => new Promise<null>((done) => { resolveImage = done })
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  onTestFinished(() => {
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
  })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: vi.fn(async () => text) } })
  let request!: ContextMenuRequest
  const rendered = render(
    <ContextMenuContext.Provider value={{ openMenu: (next) => { request = next }, closeMenu: vi.fn(), isOpen: false }}>
      <VisualEditor markdown="table" onChange={vi.fn()} readClipboardImage={readClipboardImage} />
    </ContextMenuContext.Provider>,
  )
  await act(async () => { await Promise.resolve() })
  const instance = crepeMock.instances[0]!
  const schema = enhancedTableTestSchema()
  const p = (value: string) => schema.node('paragraph', null, value ? schema.text(value) : undefined)
  const doc = schema.node('doc', null, schema.node('table', null, [
    schema.node('table_header_row', null, [schema.node('table_header', null, p('head'))]),
    schema.node('table_row', null, [schema.node('table_cell', null, p('old')), schema.node('table_cell', null, p('neighbor'))]),
  ]))
  let from = 0
  doc.descendants((node, pos) => { if (node.isText && node.text === 'old') from = pos })
  instance.viewState = EditorState.create({ doc, selection: TextSelection.create(doc, from, from + 3), plugins: [history()] })
  instance.viewDispatch.mockImplementation((tr) => { instance.viewState = instance.viewState!.apply(tr) })
  instance.parser.mockImplementation((markdown) => schema.node('doc', null, p(markdown.replaceAll('**', '').replace(/\s+/g, ' '))))
  const host = rendered.container.querySelector('.visual-editor')!
  host.innerHTML = '<table><tbody><tr><td>old</td></tr></tbody></table>'
  instance.viewDom = host as HTMLElement
  fireEvent.contextMenu(host.querySelector('td')!)
  expect(request).toBeDefined()
  let pending!: void | Promise<void>
  act(() => { pending = request.execute('paste') })
  instance.viewState = instance.viewState.apply(instance.viewState.tr.setSelection(TextSelection.create(doc, 4)))
  await act(async () => { resolveImage(null); await pending })
  const row = instance.viewState.doc.child(0).child(1)
  const pastedLines: string[] = []
  row.child(0).forEach((node) => { expect(node.type.name).toBe('paragraph'); pastedLines.push(node.textContent) })
  expect(pastedLines).toEqual(lines)
  expect(row.child(1).textContent).toBe('neighbor')
  expect(instance.viewState.doc.child(0).child(0).textContent).toBe('head')
  undo(instance.viewState, instance.viewDispatch as (tr: Transaction) => void)
  expect(instance.viewState.doc.eq(doc)).toBe(true)
  redo(instance.viewState, instance.viewDispatch as (tr: Transaction) => void)
  expect(instance.viewState.doc.child(0).child(1).child(0).textContent).toBe(lines.join(''))
})

it.each(['switch', 'switch-back', 'edit', 'unmount'] as const)('cancels a visual image request after %s', async (change) => {
  let resolve!: (value: string) => void
  const ref = createRef<VisualEditorHandle>()
  const readClipboardImage = () => new Promise<string>((done) => { resolve = done })
  const rendered = render(<VisualEditor ref={ref} markdown="before" documentKey="a" onChange={vi.fn()} readClipboardImage={readClipboardImage} />)
  await act(async () => { await Promise.resolve() })
  const instance = crepeMock.instances[0]!
  instance.viewState = EditorState.create({ doc: handleSchema.node('doc', null, paragraph('before')) })
  instance.parser.mockReturnValue(handleSchema.node('doc', null, paragraph('clipboard image')))
  let pending!: Promise<boolean>
  act(() => { pending = ref.current!.pasteClipboard!() })
  if (change === 'switch') rendered.rerender(<VisualEditor ref={ref} markdown="other" documentKey="b" onChange={vi.fn()} readClipboardImage={readClipboardImage} />)
  if (change === 'switch-back') {
    rendered.rerender(<VisualEditor ref={ref} markdown="before" documentKey="b" onChange={vi.fn()} readClipboardImage={readClipboardImage} />)
    rendered.rerender(<VisualEditor ref={ref} markdown="before" documentKey="a" onChange={vi.fn()} readClipboardImage={readClipboardImage} />)
  }
  if (change === 'edit') instance.viewState = instance.viewState.apply(instance.viewState.tr.insertText('new ', 1))
  if (change === 'unmount') rendered.unmount()
  instance.viewDispatch.mockClear()
  await act(async () => { resolve('![](assets/clip.png)'); await pending })
  expect(instance.viewDispatch).not.toHaveBeenCalled()
})

async function readyExternalVisualDropEditor() {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  root.append(proseMirror)
  const initialDoc = handleSchema.node('doc', null, paragraph('before after'))
  instance.viewDom = proseMirror
  instance.viewState = EditorState.create({ doc: initialDoc })
  instance.viewCoordsAtPos.mockReturnValue({ left: 64, top: 20, right: 64, bottom: 38 })
  const view = {
    get state() { return instance.viewState! },
    dom: proseMirror,
    dragging: null,
    editable: true,
    posAtCoords: instance.viewPosAtCoords,
    coordsAtPos: instance.viewCoordsAtPos,
    dispatch: instance.viewDispatch,
    focus: instance.viewFocus,
  } as unknown as EditorView
  const plugin = instance.prosePlugins.find((candidate) => candidate.spec.props?.handleDrop)
  if (!plugin) throw new Error('visual drop plugin was not installed')
  const pluginView = plugin.spec.view?.(view)
  const dragAt = (pos: number, clientX: number, clientY: number) => {
    instance.viewPosAtCoords.mockReturnValue({ pos })
    const dragover = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dragover, { clientX: { value: clientX }, clientY: { value: clientY } })
    plugin.spec.props?.handleDOMEvents?.dragover?.(view, dragover)
  }
  const dropExternal = () => {
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    plugin.spec.props?.handleDrop?.(view, drop, Slice.empty, false)
    return drop
  }
  return { dragAt, dropExternal, instance, plugin, pluginView, ref, view }
}

it('maps the default system theme and switches to Minimal without recreating Crepe', async () => {
  const rendered = render(<VisualEditor markdown="alpha" onChange={vi.fn()} />)
  await act(async () => { await Promise.resolve() })
  const editor = screen.getByLabelText('Markdown visual editor')
  expect(editor).toHaveAttribute('data-editor-theme', 'system')
  expect(crepeMock.instances).toHaveLength(1)

  rendered.rerender(
    <VisualEditor editorTheme="minimal" markdown="alpha" onChange={vi.fn()} />,
  )
  expect(screen.getByLabelText('Markdown visual editor')).toBe(editor)
  expect(editor).toHaveAttribute('data-editor-theme', 'minimal')
  expect(crepeMock.instances).toHaveLength(1)
})

it('creates a per-mount Mermaid registry around the renderer-window service before create', async () => {
  const appearance: MermaidAppearance = Object.freeze({
    revision: 7,
    editorTheme: 'minimal',
    colorScheme: 'light',
    themeColor: '#336699',
    bodyFontFamily: '"Arial", "Microsoft YaHei"',
  })
  const rendered = render(
    <VisualEditor markdown="alpha" mermaidAppearance={appearance} onChange={vi.fn()} />,
  )
  await act(async () => { await Promise.resolve() })

  const instance = crepeMock.instances[0]!
  const mermaidIndex = instance.usedPlugins.indexOf(mermaidIntegrationMock.plugin)
  expect(mermaidIntegrationMock.createRenderer).toHaveBeenCalledOnce()
  expect(mermaidIntegrationMock.createRegistry).toHaveBeenCalledOnce()
  expect(mermaidIntegrationMock.createRegistry).toHaveBeenCalledWith(appearance)
  expect(mermaidIntegrationMock.createAdaptive).toHaveBeenCalledWith({
    registry: mermaidIntegrationMock.registries[0],
    renderer: mermaidIntegrationMock.renderers[0],
  })
  expect(mermaidIndex).toBeGreaterThanOrEqual(0)
  for (const plugin of [
    ...frontmatterEditorPlugins,
    ...extendedInlineMarkPlugins,
    ...enhancedTableEditorPlugins,
  ]) {
    expect(mermaidIndex).toBeGreaterThan(instance.usedPlugins.indexOf(plugin))
  }
  expect(mermaidIntegrationMock.createAdaptive.mock.invocationCallOrder[0])
    .toBeLessThan(instance.create.mock.invocationCallOrder[0]!)

  rendered.unmount()
  await act(async () => { await Promise.resolve() })
  expect(mermaidIntegrationMock.registries[0]!.dispose).toHaveBeenCalledOnce()
  expect(instance.destroy).toHaveBeenCalledOnce()
})

it('waits for the Mermaid print batch before asking the registry for final idleness', async () => {
  const initial: MermaidAppearance = Object.freeze({
    revision: 2,
    editorTheme: 'minimal',
    colorScheme: 'light',
    themeColor: '#336699',
    bodyFontFamily: '"Arial", "Microsoft YaHei"',
  })
  const next: MermaidAppearance = Object.freeze({
    ...initial,
    revision: 3,
    colorScheme: 'dark',
    themeColor: '#CC5500',
  })
  const ref = createRef<VisualEditorHandle>()
  const mermaidPrintDeadlineEpochMs = 1_788_048_015_000
  const rendered = render(
    <VisualEditor
      ref={ref}
      markdown="alpha"
      mermaidAppearance={initial}
      mermaidPrintDeadlineEpochMs={mermaidPrintDeadlineEpochMs}
      onChange={vi.fn()}
    />,
  )
  await act(async () => { await Promise.resolve() })
  const registry = mermaidIntegrationMock.registries[0]!
  let releaseBatch!: () => void
  const batch = new Promise<void>((resolve) => { releaseBatch = resolve })
  let releaseIdle!: () => void
  const idle = new Promise<void>((resolve) => { releaseIdle = resolve })
  registry.renderAll.mockReturnValueOnce(batch)
  registry.whenIdle.mockReturnValueOnce(idle)

  let barrier!: Promise<void>
  act(() => {
    barrier = ref.current!.whenRenderIdle!()
  })
  expect(registry.renderAll).toHaveBeenCalledWith(mermaidPrintDeadlineEpochMs)
  expect(registry.whenIdle).not.toHaveBeenCalled()

  rendered.rerender(
    <VisualEditor
      ref={ref}
      markdown="alpha"
      mermaidAppearance={next}
      mermaidPrintDeadlineEpochMs={mermaidPrintDeadlineEpochMs}
      onChange={vi.fn()}
    />,
  )
  expect(registry.refreshAppearance).toHaveBeenCalledWith(next)
  expect(crepeMock.instances).toHaveLength(1)

  await act(async () => { releaseBatch() })
  expect(registry.whenIdle).toHaveBeenCalledOnce()
  await act(async () => { releaseIdle() })
  await act(async () => { await barrier })
  const handle = ref.current!
  rendered.unmount()
  registry.renderAll.mockClear()
  registry.whenIdle.mockClear()
  await expect(handle.whenRenderIdle!()).resolves.toBeUndefined()
  expect(registry.renderAll).not.toHaveBeenCalled()
  expect(registry.whenIdle).not.toHaveBeenCalled()
})

it('applies and clears extended inline marks without removing links or block structure', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const schema = new Schema({
    nodes: {
      doc: { content: 'paragraph+' },
      paragraph: { content: 'inline*', group: 'block' },
      text: { group: 'inline' },
      math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
    },
    marks: {
      strong: {},
      emphasis: {},
      strike_through: {},
      inline_code: {},
      underline: {},
      highlight: {},
      superscript: {},
      subscript: {},
      link: { attrs: { href: {} }, inclusive: false },
    },
  })
  const linked = schema.text('linked', [schema.marks.link.create({ href: 'https://example.com' })])
  const doc = schema.node('doc', null, schema.node('paragraph', null, linked))
  instance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1, 7),
  })

  window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'underline' }))
  expect(instance.viewState.doc.nodeAt(1)?.marks.map((mark) => mark.type.name))
    .toEqual(['underline', 'link'])

  window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'clear-inline-formatting' }))
  expect(instance.viewState.doc.nodeAt(1)?.marks.map((mark) => mark.type.name))
    .toEqual(['link'])
  expect(instance.viewState.doc.firstChild?.type.name).toBe('paragraph')
})

it('captures a mode-switch caret before the DOM boundary can replace the editor selection', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const targetText = 'Our man Charles—Charles Keller—was one of them.'
  const doc = handleSchema.node('doc', null, [
    heading4('Chapter 1'),
    paragraph('Earlier paragraph.'),
    paragraph(targetText),
  ])
  const targetStart = doc.child(0).nodeSize + doc.child(1).nodeSize + 1
  instance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, targetStart + targetText.indexOf('Keller') + 3),
  })
  instance.serializer = vi.fn((documentNode) => Array.from(
    { length: documentNode.childCount },
    (_, index) => documentNode.child(index).textContent,
  ).join('\n\n'))
  const checkpoint = instance.serializer(doc)
  instance.domForceFlush.mockImplementation(() => {
    instance.viewState = instance.viewState!.apply(
      instance.viewState!.tr.setSelection(TextSelection.create(instance.viewState!.doc, 1)),
    )
  })

  const snapshot = ref.current?.captureModeSwitch?.(checkpoint)

  expect(snapshot?.checkpoint).toBe(checkpoint)
  expect(resolveSourceModePosition(checkpoint, snapshot!.position!)).toEqual({
    line: 4,
    column: targetText.indexOf('Keller') + 3,
  })
})

it('maps a DOM caret through text that becomes part of the ProseMirror document during flush', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const before = handleSchema.node('doc', null, paragraph('abcd'))
  instance.viewState = EditorState.create({
    doc: before,
    selection: TextSelection.create(before, 3),
  })
  instance.serializer = vi.fn((documentNode) => documentNode.textContent)
  const visualRoot = screen.getByLabelText('Markdown visual editor')
  const text = document.createTextNode('abxcd')
  instance.viewDom!.replaceChildren(text)
  visualRoot.append(instance.viewDom!)
  const range = document.createRange()
  range.setStart(text, 3)
  range.collapse(true)
  const domSelection = document.getSelection()!
  domSelection.removeAllRanges()
  domSelection.addRange(range)
  instance.viewPosAtDOM.mockImplementation((_node, offset) => offset + 1)
  instance.markdown = 'abxcd'
  fireEvent.input(visualRoot)
  instance.domForceFlush.mockImplementation(() => {
    const after = handleSchema.node('doc', null, paragraph('abxcd'))
    instance.viewState = EditorState.create({
      doc: after,
      selection: TextSelection.create(after, 1),
    })
    instance.applyTransaction()
  })

  const snapshot = ref.current?.captureModeSwitch?.('abcd')

  expect(snapshot?.checkpoint).toBe('abxcd')
  expect(resolveSourceModePosition(snapshot!.checkpoint, snapshot!.position!)).toEqual({
    line: 0,
    column: 3,
  })
})

it('still flushes a pending edit when DOM selection mapping throws', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const before = handleSchema.node('doc', null, paragraph('before'))
  instance.viewState = EditorState.create({
    doc: before,
    selection: TextSelection.create(before, 4),
  })
  instance.serializer = vi.fn((documentNode) => documentNode.textContent)
  const visualRoot = screen.getByLabelText('Markdown visual editor')
  const text = document.createTextNode('before!')
  instance.viewDom!.replaceChildren(text)
  visualRoot.append(instance.viewDom!)
  const range = document.createRange()
  range.setStart(text, 4)
  range.collapse(true)
  const domSelection = document.getSelection()!
  domSelection.removeAllRanges()
  domSelection.addRange(range)
  instance.viewPosAtDOM.mockImplementation(() => { throw new Error('stale DOM selection') })
  instance.markdown = 'before!'
  fireEvent.input(visualRoot)
  instance.domForceFlush.mockImplementation(() => {
    const after = handleSchema.node('doc', null, paragraph('before!'))
    instance.viewState = EditorState.create({
      doc: after,
      selection: TextSelection.create(after, 4),
    })
    instance.applyTransaction()
  })

  const snapshot = ref.current?.captureModeSwitch?.('before')

  expect(instance.domForceFlush).toHaveBeenCalledOnce()
  expect(snapshot?.checkpoint).toBe('before!')
  expect(snapshot?.position).not.toBeNull()
})

it('keeps Ctrl+Enter inside a paragraph as an inline line break', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const hardbreak = handleSchema.nodes.hardbreak!.create({ isInline: true })
  const doc = handleSchema.node('doc', null, handleSchema.node('paragraph', null, [
    handleSchema.text('alpha'),
    hardbreak,
    handleSchema.text('beta'),
  ]))
  instance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 9),
  })
  const view = {
    get state() { return instance.viewState! },
    get composing() { return instance.viewComposing },
    dispatch: instance.viewDispatch,
    focus: instance.viewFocus,
  } as unknown as EditorView
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })

  const handled = instance.prosePlugins.some((plugin) => (
    plugin.spec.props?.handleKeyDown?.(view, event) === true
  ))

  expect(handled).toBe(true)
  expect(instance.viewState?.doc.toJSON()).toEqual({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'alpha' },
        { type: 'hardbreak', attrs: { isInline: true } },
        { type: 'text', text: 'be' },
        { type: 'hardbreak', attrs: { isInline: true } },
        { type: 'text', text: 'ta' },
      ],
    }],
  })
})

it('leaves ordinary Enter to the standard keymap at every paragraph position', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const hardbreak = handleSchema.nodes.hardbreak!.create({ isInline: true })
  const doc = handleSchema.node('doc', null, handleSchema.node('paragraph', null, [
    handleSchema.text('alpha'),
    hardbreak,
    handleSchema.text('beta'),
  ]))
  const positions = [1, 6, 7, 9, 11]

  for (const position of positions) {
    instance.viewState = EditorState.create({
      doc,
      selection: TextSelection.create(doc, position),
    })
    const view = {
      get state() { return instance.viewState! },
      get composing() { return instance.viewComposing },
      dispatch: instance.viewDispatch,
      focus: instance.viewFocus,
    } as unknown as EditorView
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    })

    const handled = instance.prosePlugins.some((plugin) => (
      plugin.spec.props?.handleKeyDown?.(view, event) === true
    ))

    expect(handled, `position ${position}`).toBe(false)
    expect(instance.viewState?.doc.eq(doc), `position ${position}`).toBe(true)
  }
})

it('recognizes a typed link before inserting a Ctrl+Enter line break', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const hardbreak = handleSchema.nodes.hardbreak!.create({ isInline: true })
  const url = 'https://example.com'
  const doc = handleSchema.node('doc', null, handleSchema.node('paragraph', null, [
    handleSchema.text('alpha'),
    hardbreak,
    handleSchema.text(`${url} tail`),
  ]))
  instance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 7 + url.length),
  })
  const view = {
    get state() { return instance.viewState! },
    get composing() { return instance.viewComposing },
    dispatch: instance.viewDispatch,
    focus: instance.viewFocus,
  } as unknown as EditorView
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })

  const handled = instance.prosePlugins.some((plugin) => (
    plugin.spec.props?.handleKeyDown?.(view, event) === true
  ))

  expect(handled).toBe(true)
  const linkedText = instance.viewState?.doc.nodeAt(7)
  expect(linkedText?.text).toBe(url)
  expect(linkedText?.marks[0]?.type.name).toBe('link')
  expect(linkedText?.marks[0]?.attrs.href).toBe('https://example.com/')
})

function visualHistoryRecord(id: string, doc: ProseMirrorNode): TranslationHistoryRecord {
  return {
    id,
    requestId: `request-${id}`,
    documentKey: 'doc-a',
    workspaceAbsolutePath: null,
    documentRelativePath: null,
    documentAbsolutePath: null,
    documentRevision: null,
    mode: 'visual',
    source: { markdown: 'alpha', plainText: 'alpha' },
    translatedMarkdown: 'translated',
    modelId: 'model',
    targetLanguage: 'en',
    terminal: 'completed',
    createdAt: Date.UTC(2026, 0, 1),
    anchor: createVisualTranslationHistoryAnchor(doc, 1, 6),
  }
}

it('reports rendered readiness only after Milkdown creation completes', async () => {
  const creation = deferred()
  const onReady = vi.fn()
  crepeMock.createPlans.push(() => creation.promise)

  render(<VisualEditor markdown="# Print" onChange={vi.fn()} onReady={onReady} readOnly />)
  await act(async () => { await Promise.resolve() })
  expect(onReady).not.toHaveBeenCalled()

  await act(async () => {
    creation.resolve({})
    await creation.promise
    await Promise.resolve()
  })

  expect(onReady).toHaveBeenCalledOnce()
})

it('updates native ProseMirror spelling live without rebuilding or disturbing content and selection', async () => {
  const onChange = vi.fn()
  const view = render(
    <VisualEditor markdown="alpha omega" onChange={onChange} spellCheckEnabled={false} />,
  )
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  proseMirror.textContent = 'alpha omega'
  root.append(proseMirror)
  const instance = crepeMock.instances[0]!
  instance.viewDom = proseMirror

  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(proseMirror).toHaveAttribute('spellcheck', 'false')
  const textNode = proseMirror.firstChild!
  const selection = window.getSelection()!
  const range = document.createRange()
  range.setStart(textNode, 2)
  range.setEnd(textNode, 7)
  selection.removeAllRanges()
  selection.addRange(range)

  view.rerender(
    <VisualEditor markdown="alpha omega" onChange={onChange} spellCheckEnabled />,
  )

  expect(proseMirror).toHaveAttribute('spellcheck', 'true')
  expect(root.querySelector('.ProseMirror')).toBe(proseMirror)
  expect(proseMirror).toHaveTextContent('alpha omega')
  expect(selection.anchorNode).toBe(textNode)
  expect(selection.anchorOffset).toBe(2)
  expect(selection.focusOffset).toBe(7)
  expect(crepeMock.instances).toHaveLength(1)
  expect(instance.create).toHaveBeenCalledOnce()
  expect(instance.destroy).not.toHaveBeenCalled()
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
})

it('maps a DOM caret through a real EditorView before inserting Markdown', () => {
  vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined)
  const doc = handleSchema.node('doc', null, [paragraph('alpha'), paragraph('beta')])
  const host = document.body.appendChild(document.createElement('div'))
  const view = new EditorView(host, {
    state: EditorState.create({ doc, selection: TextSelection.create(doc, 2) }),
  })
  try {
    const betaText = view.dom.querySelectorAll('p')[1]!.firstChild!
    const range = document.createRange()
    range.setStart(betaText, 2)
    range.collapse(true)
    const domSelection = window.getSelection()!
    domSelection.removeAllRanges()
    domSelection.addRange(range)
    const clickedPosition = view.posAtDOM(betaText, 2)

    const bookmark = captureProseMirrorSelectionBookmark(view, domSelection)
    expect(view.state.selection).toEqual(TextSelection.create(view.state.doc, clickedPosition))
    const parser = (markdown: string) => handleSchema.node('doc', null, [paragraph(markdown)])
    view.dispatch(buildMarkdownInsertionTransaction(view.state, bookmark, parser, 'X'))

    expect(view.state.doc.child(0).textContent).toBe('alpha')
    expect(view.state.doc.child(1).textContent).toBe('beXta')
  } finally {
    view.destroy()
    host.remove()
  }
})

it('maps a DOM caret through a real EditorView before converting the clicked block', () => {
  const doc = handleSchema.node('doc', null, [paragraph('alpha'), paragraph('beta')])
  const host = document.body.appendChild(document.createElement('div'))
  const view = new EditorView(host, {
    state: EditorState.create({ doc, selection: TextSelection.create(doc, 2) }),
  })
  try {
    const betaText = view.dom.querySelectorAll('p')[1]!.firstChild!
    const range = document.createRange()
    range.setStart(betaText, 1)
    range.collapse(true)
    const domSelection = window.getSelection()!
    domSelection.removeAllRanges()
    domSelection.addRange(range)

    captureProseMirrorSelectionBookmark(view, domSelection)
    const transaction = buildSelectedBlockStyleTransaction(view.state, 'heading-4')
    expect(transaction).not.toBeNull()
    view.dispatch(transaction!)

    expect(view.state.doc.child(0).type.name).toBe('paragraph')
    expect(view.state.doc.child(1).type.name).toBe('heading')
    expect(view.state.doc.child(1).attrs.level).toBe(4)
  } finally {
    view.destroy()
    host.remove()
  }
})

it('normalizes sibling blockquotes to paragraph or H4 and treats annotation as an idempotent no-op', () => {
  const quoteState = stateSelectingAll([blockquote('alpha'), blockquote('beta')])
  const paragraphTransaction = buildSelectedBlockStyleTransaction(quoteState, 'paragraph')
  expect(paragraphTransaction).not.toBeNull()
  const paragraphs = quoteState.apply(paragraphTransaction!).doc
  expect(paragraphs.toJSON()).toMatchObject({ content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'beta' }] },
  ] })

  const headingTransaction = buildSelectedBlockStyleTransaction(quoteState, 'heading-4')
  expect(headingTransaction).not.toBeNull()
  const headings = quoteState.apply(headingTransaction!).doc
  expect(headings.toJSON()).toMatchObject({ content: [
    { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'alpha' }] },
    { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'beta' }] },
  ] })

  expect(buildSelectedBlockStyleTransaction(quoteState, 'blockquote')).toBeNull()
})

it.each([
  ['paragraph then blockquote', [paragraph('alpha'), blockquote('beta')]],
  ['blockquote then paragraph', [blockquote('alpha'), paragraph('beta')]],
] as const)('normalizes a mixed %s selection to every requested style', (_name, blocks) => {
  const originalState = stateSelectingAll(blocks)
  for (const target of ['paragraph', 'heading-4', 'blockquote'] as const) {
    const transaction = buildSelectedBlockStyleTransaction(originalState, target)
    expect(transaction, target).not.toBeNull()
    const document = originalState.apply(transaction!).doc
    if (target === 'blockquote') {
      expect(Array.from({ length: document.childCount }, (_, index) => document.child(index).type.name))
        .toEqual(['blockquote', 'blockquote'])
      let nestedBlockquote = false
      document.descendants((node, _position, parent) => {
        if (node.type.name === 'blockquote' && parent?.type.name === 'blockquote') {
          nestedBlockquote = true
        }
      })
      expect(nestedBlockquote).toBe(false)
      for (let index = 0; index < document.childCount; index += 1) {
        expect(document.child(index).firstChild?.type.name).toBe('paragraph')
      }
    } else {
      expect(Array.from({ length: document.childCount }, (_, index) => document.child(index).type.name))
        .toEqual(target === 'paragraph' ? ['paragraph', 'paragraph'] : ['heading', 'heading'])
    }
  }
})

it('restores a ProseMirror bookmark and inserts exact multiline Markdown once', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  const initialDoc = handleSchema.node('doc', null, [paragraph('alpha'), paragraph('omega')])
  instance.viewState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, 3),
  })
  instance.parser.mockImplementation((markdown) => {
    expect(markdown).toBe('first line\nsecond line')
    return handleSchema.node('doc', null, [paragraph('first line'), paragraph('second line')])
  })
  instance.viewDispatch.mockImplementation((transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
    instance.markdown = 'alfirst line\nsecond linepha\nomega'
  })

  expect(ref.current?.captureSelection()).toBe(true)
  instance.viewState = instance.viewState.apply(
    instance.viewState.tr.setSelection(TextSelection.create(instance.viewState.doc, 10)),
  )

  expect(ref.current?.insertMarkdown('first line\nsecond line')).toBe(true)
  await act(async () => { await Promise.resolve() })

  expect(instance.parser).toHaveBeenCalledOnce()
  expect(instance.viewDispatch).toHaveBeenCalledOnce()
  expect(instance.viewFocus).toHaveBeenCalledTimes(2)
  expect(instance.viewState.doc.childCount).toBe(3)
  expect(instance.viewState.doc.child(0).textContent).toBe('alfirst line')
  expect(instance.viewState.doc.child(1).textContent).toBe('second linepha')
  expect(instance.viewState.doc.child(2).textContent).toBe('omega')
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenCalledWith('alfirst line\nsecond linepha\nomega')
})

it('rejects insertion without a bookmark and when bookmark restoration fails', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  instance.viewState = stateSelectingAll([paragraph('alpha')])

  expect(ref.current?.insertMarkdown('unchanged')).toBe(false)
  const brokenBookmark = { resolve: vi.fn(() => { throw new Error('stale bookmark') }), map: vi.fn() }
  vi.spyOn(instance.viewState.selection, 'getBookmark').mockReturnValue(brokenBookmark)
  expect(ref.current?.captureSelection()).toBe(true)
  instance.viewFocus.mockClear()
  expect(ref.current?.insertMarkdown('unchanged')).toBe(false)

  expect(instance.parser).not.toHaveBeenCalled()
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(instance.viewFocus).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
})

it('dispatches and commits nothing when Markdown parsing or transaction construction fails', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  instance.viewState = stateSelectingAll([paragraph('alpha')])
  expect(ref.current?.captureSelection()).toBe(true)
  instance.viewFocus.mockClear()
  instance.parser.mockImplementation(() => { throw new Error('parse failed') })

  expect(ref.current?.insertMarkdown('broken')).toBe(false)
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()

  instance.parser.mockImplementation(() => handleSchema.node('doc', null, [paragraph('parsed')]))
  const current = instance.viewState
  instance.viewState = {
    selection: current.selection,
    doc: current.doc,
    schema: current.schema,
    get tr() { throw new Error('transaction failed') },
  } as unknown as EditorState

  expect(ref.current?.insertMarkdown('parsed')).toBe(false)
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(instance.viewFocus).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
})

it('dispatches and commits nothing when restoring editor focus fails', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  instance.viewState = stateSelectingAll([paragraph('alpha')])
  instance.parser.mockImplementation(() => handleSchema.node('doc', null, [paragraph('parsed')]))
  expect(ref.current?.captureSelection()).toBe(true)
  instance.viewFocus.mockClear().mockImplementation(() => { throw new Error('focus failed') })

  expect(ref.current?.insertMarkdown('parsed')).toBe(false)
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
})

it('fails closed when block-style focus or second-stage construction throws', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  instance.viewState = stateSelectingAll([heading4('alpha')])
  expect(ref.current?.captureSelection()).toBe(true)
  instance.viewDispatch.mockClear()
  instance.viewFocus.mockClear().mockImplementation(() => { throw new Error('focus failed') })

  expect(ref.current?.setSelectedBlockStyle('paragraph')).toBe(false)
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()

  instance.viewFocus.mockReset()
  const createBlockquote = vi.spyOn(handleSchema.nodes.blockquote!, 'create')
    .mockImplementation(() => { throw new Error('wrap failed') })
  expect(ref.current?.setSelectedBlockStyle('blockquote')).toBe(false)
  expect(createBlockquote).toHaveBeenCalled()
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
})

it('uses one dispatch and one commit for a successful multi-block style change', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  instance.viewState = stateSelectingAll([heading4('alpha'), blockquote('beta')])
  instance.viewDispatch.mockImplementation((transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
    instance.markdown = '> alpha\n\n> beta'
  })
  expect(ref.current?.captureSelection()).toBe(true)
  instance.viewDispatch.mockClear()
  instance.viewFocus.mockClear()

  expect(ref.current?.setSelectedBlockStyle('blockquote')).toBe(true)
  await act(async () => { await Promise.resolve() })

  expect(instance.viewFocus).toHaveBeenCalledOnce()
  expect(instance.viewDispatch).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenCalledWith('> alpha\n\n> beta')
})

it('returns success without dispatch or commit when the selected style is already homogeneous', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  instance.viewState = stateSelectingAll([blockquote('alpha'), blockquote('beta')])
  expect(ref.current?.captureSelection()).toBe(true)
  instance.viewDispatch.mockClear()

  expect(ref.current?.setSelectedBlockStyle('blockquote')).toBe(true)
  await act(async () => { await Promise.resolve() })

  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
})

it('converts multiple selected blocks among H4, paragraph, and blockquote', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  instance.viewState = stateSelectingAll([paragraph('alpha'), paragraph('beta')])
  expect(ref.current?.captureSelection()).toBe(true)
  expect(ref.current?.selectedBlockStyle()).toBe('paragraph')

  expect(ref.current?.setSelectedBlockStyle('heading-4')).toBe(true)
  expect(instance.viewState.doc.toJSON()).toMatchObject({
    content: [
      { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'alpha' }] },
      { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'beta' }] },
    ],
  })
  expect(ref.current?.captureSelection()).toBe(true)
  expect(ref.current?.selectedBlockStyle()).toBe('heading-4')

  expect(ref.current?.setSelectedBlockStyle('blockquote')).toBe(true)
  expect(instance.viewState.doc.toJSON()).toMatchObject({
    content: [{
      type: 'blockquote',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'beta' }] },
      ],
    }],
  })
  expect(ref.current?.captureSelection()).toBe(true)
  expect(ref.current?.selectedBlockStyle()).toBe('blockquote')

  expect(ref.current?.setSelectedBlockStyle('paragraph')).toBe(true)
  expect(instance.viewState.doc.toJSON()).toMatchObject({
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'alpha' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'beta' }] },
    ],
  })
})

it('reports mixed selection instead of checking a homogeneous block style', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  instance.viewState = stateSelectingAll([paragraph('alpha'), heading4('beta')])

  expect(ref.current?.captureSelection()).toBe(true)
  expect(ref.current?.selectedBlockStyle()).toBe('mixed')
})

it('commits the canonical rich-table Markdown instead of the lossy listener value', async () => {
  const onChange = vi.fn()
  render(<VisualEditor markdown="# Initial" onChange={onChange} />)
  const instance = crepeMock.instances[0]!
  const root = screen.getByLabelText('Markdown visual editor')
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  const canonical = '<table data-arkdown-table="1"><colgroup><col width="180"></colgroup><thead><tr><th data-align="left"><p>事项</p></th></tr></thead><tbody><tr><td data-align="left"><ol><li><p>第一项</p></li><li><p>第二项</p></li></ol></td></tr></tbody></table>'
  const lossy = '| 事项 |\n| --- |\n| 第一项 |\n\n2. 第二项'
  instance.markdown = canonical
  fireEvent.input(root)
  instance.applyTransaction()
  instance.listener?.({}, lossy, '# Initial')

  expect(instance.getMarkdown).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledWith(canonical)
  expect(onChange).not.toHaveBeenCalledWith(lossy)
})

it('persists rich-table attributes when the default Markdown appears unchanged', async () => {
  const onChange = vi.fn()
  render(<VisualEditor markdown="# Initial" onChange={onChange} />)
  const instance = crepeMock.instances[0]!
  const root = screen.getByLabelText('Markdown visual editor')
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  const resizedTable = '<table data-arkdown-table="1"><colgroup><col width="320"></colgroup><thead><tr><th data-align="left"><p>事项</p></th></tr></thead><tbody><tr><td data-align="left"><p>内容</p></td></tr></tbody></table>'
  instance.markdown = resizedTable
  fireEvent.pointerDown(root)
  instance.applyTransaction()
  instance.listener?.({}, '# Initial', '# Initial')

  expect(instance.getMarkdown).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledWith(resizedTable)
})

it('prepares a visual AI replacement without mutation and applies it as one undoable transaction', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const rendered = render(
    <VisualEditor ref={ref} documentKey="doc-a" markdown="Before" onChange={onChange} />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const instance = crepeMock.instances[0]!
  instance.viewState = EditorState.create({
    doc: handleSchema.node('doc', null, paragraph('Before')),
    plugins: [history()],
  })
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  instance.parser.mockImplementation((markdown) => (
    handleSchema.node('doc', null, paragraph(markdown.replaceAll('*', '')))
  ))
  instance.viewDispatch.mockImplementation((transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  const port = ref.current!.createWorkspaceAiEditorPort!()
  const capture = await port.captureReadSnapshot({})
  if (capture.status !== 'captured') throw new Error('capture failed')
  const input = {
    operationId: 'visual-operation',
    expectedEditorRevision: capture.editorRevision,
    expectedContentHash: capture.contentHash,
    replacementMarkdown: '**After**',
  }

  expect((await port.planReplacement(input)).status).toBe('planned')
  expect(instance.parser).toHaveBeenCalledWith('**After**')
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(instance.viewState.doc.textContent).toBe('Before')

  const applied = await port.applyTransaction(input)

  expect(applied).toEqual(expect.objectContaining({
    status: 'applied',
    editorRevision: capture.editorRevision + 1,
    dirty: true,
  }))
  expect(instance.viewDispatch).toHaveBeenCalledTimes(1)
  expect((instance.viewDispatch.mock.calls[0]![0] as Transaction).getMeta(
    VISUAL_AI_TRANSACTION_META,
  )).toBe(true)
  expect(instance.viewState.doc.textContent).toBe('After')
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenCalledWith('**After**')

  const exactCapture = await port.captureReadSnapshot({})
  expect(exactCapture).toEqual(expect.objectContaining({
    status: 'captured',
    editorRevision: applied.status === 'applied' ? applied.editorRevision : -1,
    contentHash: applied.status === 'applied' ? applied.contentHash : '',
    markdown: '**After**',
    dirty: true,
  }))
  instance.serializer = vi.fn(() => 'Canonical after controlled replacement')
  rendered.rerender(
    <VisualEditor ref={ref} documentKey="doc-a" markdown="External controlled value" onChange={onChange} />,
  )
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual(expect.objectContaining({ markdown: 'Canonical after controlled replacement' }))
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)

  const dispatch = (transaction: Transaction) => {
    ;(instance.viewDispatch as (next: Transaction) => void)(transaction)
  }
  expect(undo(instance.viewState, dispatch)).toBe(true)
  expect(instance.viewState.doc.textContent).toBe('Before')
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual({ status: 'stale' })
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual(expect.objectContaining({ markdown: 'Before' }))
  expect(redo(instance.viewState, dispatch)).toBe(true)
  expect(instance.viewState.doc.textContent).toBe('After')
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual({ status: 'stale' })
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual(expect.objectContaining({ markdown: 'After' }))

  await expect(port.applyTransaction(input)).resolves.toEqual(applied)
  expect(instance.viewDispatch).toHaveBeenCalledTimes(3)
  rendered.unmount()
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual({ status: 'stale' })
})

it('makes a planned visual replacement stale after an intervening user transaction', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  instance.viewState = EditorState.create({ doc: handleSchema.node('doc', null, paragraph('Before')) })
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  instance.parser.mockImplementation((markdown) => handleSchema.node('doc', null, paragraph(markdown)))
  const port = ref.current!.createWorkspaceAiEditorPort!()
  const capture = await port.captureReadSnapshot({})
  if (capture.status !== 'captured') throw new Error('capture failed')
  const input = {
    operationId: 'visual-stale',
    expectedEditorRevision: capture.editorRevision,
    expectedContentHash: capture.contentHash,
    replacementMarkdown: 'AI',
  }
  expect((await port.planReplacement(input)).status).toBe('planned')

  fireEvent.input(screen.getByLabelText('Markdown visual editor'))
  ;(instance.viewDispatch as (transaction: Transaction) => void)(
    instance.viewState.tr.insertText('User', 1),
  )
  instance.applyTransaction()
  instance.listener?.({}, 'UserBefore', 'Before')

  await expect(port.applyTransaction(input)).resolves.toEqual({ status: 'stale' })
})

it('restores enhanced table placeholders as a pure planning transform', () => {
  const schema = enhancedTableTestSchema()
  const markdown = '<table data-arkdown-table="1"><colgroup><col width="180"></colgroup><thead><tr><th><p>Title</p></th></tr></thead><tbody><tr><td><p>Body</p><pre><code>ok()</code></pre></td></tr></tbody>\n</table>'
  const prepared = prepareEnhancedTables(markdown)
  const placeholder = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(
    null,
    schema.text(prepared.tables[0]!.marker),
  ))
  const before = placeholder.toJSON()

  const restored = restorePreparedEnhancedTablesInDocument(
    placeholder,
    schema,
    prepared.tables,
  )

  expect(placeholder.toJSON()).toEqual(before)
  expect(restored).not.toBe(placeholder)
  if (!restored) throw new Error('enhanced table restore failed')
  expect(restored.firstChild?.type.name).toBe('table')
  expect(restored.firstChild?.firstChild?.firstChild?.attrs.colwidth).toEqual([180])
  expect(restored.textContent).toContain('TitleBodyok()')
})

it('falls back to the original Markdown when initial enhanced-table marker restoration fails', async () => {
  const creation = deferred()
  crepeMock.createPlans.push(() => creation.promise)
  const markdown = '<table data-arkdown-table="1"><thead><tr><th><p>A</p></th></tr></thead><tbody><tr><td><p>B</p></td></tr></tbody></table>'
  render(<VisualEditor markdown={markdown} onChange={vi.fn()} />)
  const instance = crepeMock.instances[0]!
  const configured = String(instance.config.defaultValue)
  const marker = /ARKDOWNENHANCEDTABLE[^\s]+END/u.exec(configured)?.[0]
  expect(marker).toBeTruthy()
  instance.viewState = EditorState.create({
    doc: handleSchema.node('doc', null, paragraph('parser dropped the marker')),
  })
  instance.parser.mockImplementation((input) => handleSchema.node(
    'doc',
    null,
    paragraph(input),
  ))
  instance.viewDispatch.mockImplementation((transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })

  await act(async () => {
    creation.resolve({})
    await creation.promise
    await Promise.resolve()
  })

  expect(instance.parser).toHaveBeenCalledWith(markdown)
  expect(instance.viewState?.doc.textContent).toBe(markdown)
  expect(instance.viewState?.doc.textContent).not.toContain(marker)
})

it('fails closed when enhanced-table markers are missing or duplicated', () => {
  const schema = enhancedTableTestSchema()
  const table = '<table data-arkdown-table="1"><thead><tr><th><p>Title</p></th></tr></thead><tbody><tr><td><p>Body</p></td></tr></tbody>\n</table>'
  const prepared = prepareEnhancedTables(`${table}\n\n${table}`, { createNonce: () => 'residual' })
  const paragraphFor = (text: string) => schema.nodes.paragraph!.create(null, schema.text(text))
  const missing = schema.nodes.doc!.create(null, paragraphFor(prepared.tables[0]!.marker))
  const duplicate = schema.nodes.doc!.create(null, [
    paragraphFor(prepared.tables[0]!.marker),
    paragraphFor(prepared.tables[0]!.marker),
    paragraphFor(prepared.tables[1]!.marker),
  ])

  expect(restorePreparedEnhancedTablesInDocument(missing, schema, prepared.tables)).toBeNull()
  expect(restorePreparedEnhancedTablesInDocument(duplicate, schema, prepared.tables)).toBeNull()
})

it('plans and applies an enhanced HTML table with one real visual transaction', async () => {
  const table = '<table data-arkdown-table="1"><colgroup><col width="180"></colgroup><thead><tr><th><p>Title</p></th></tr></thead><tbody><tr><td><p>Body</p></td></tr></tbody>\n</table>'
  const replacement = `${table}\n\n${table}`
  const schema = enhancedTableTestSchema()
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  instance.viewState = EditorState.create({
    doc: schema.nodes.doc!.create(null, schema.nodes.paragraph!.create(null, schema.text('Before'))),
  })
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  instance.parser.mockImplementation((markdown) => schema.nodes.doc!.create(null,
    markdown.split(/\n+/u).filter(Boolean).map((line) => (
      schema.nodes.paragraph!.create(null, schema.text(line))
    )),
  ))
  instance.viewDispatch.mockImplementation((transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  const port = ref.current!.createWorkspaceAiEditorPort!()
  const capture = await port.captureReadSnapshot({})
  if (capture.status !== 'captured') throw new Error('capture failed')
  const input = {
    operationId: 'enhanced-table-operation',
    expectedEditorRevision: capture.editorRevision,
    expectedContentHash: capture.contentHash,
    replacementMarkdown: replacement,
  }

  expect((await port.planReplacement(input)).status).toBe('planned')
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  const applied = await port.applyTransaction(input)
  expect(applied.status).toBe('applied')
  expect(instance.viewDispatch).toHaveBeenCalledTimes(1)
  expect(instance.viewState.doc.firstChild?.type.name).toBe('table')
  expect(instance.viewState.doc.childCount).toBe(2)
  expect(instance.viewState.doc.lastChild?.type.name).toBe('table')
  expect(instance.viewState.doc.firstChild?.firstChild?.firstChild?.attrs.colwidth).toEqual([180])
  expect(onChange).toHaveBeenCalledWith(replacement)
  const exactCapture = await port.captureReadSnapshot({})
  expect(exactCapture).toEqual(expect.objectContaining({
    status: 'captured',
    markdown: replacement,
  }))
  if (applied.status !== 'applied' || exactCapture.status !== 'captured') {
    throw new Error('enhanced-table AI application was not captured')
  }
  expect(exactCapture.contentHash).toBe(applied.contentHash)
  expect(exactCapture.editorRevision).toBe(applied.editorRevision)
})

it('serializes a rich list table without loss after a user edit clears the exact AI mirror', async () => {
  const table = '<table data-arkdown-table="1"><colgroup><col width="180"></colgroup><thead><tr><th><p>Title</p></th></tr></thead><tbody><tr><td><p>Body</p><pre><code>ok()</code></pre></td></tr></tbody>\n</table>'
  const replacement = `- item\n\n  ${table.replaceAll('\n', '\n  ')}`
  const schema = enhancedTableTestSchema()
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const paragraphFor = (text: string) => schema.nodes.paragraph!.create(
    null,
    schema.text(text),
  )
  instance.viewState = EditorState.create({
    doc: schema.nodes.doc!.create(null, paragraphFor('Before')),
  })
  const serializeNode = (node: ProseMirrorNode): string => {
    if (node.type.name === 'paragraph') return node.textContent
    if (node.type.name === 'table') return '| lossy |'
    const children: string[] = []
    node.forEach((child) => { children.push(serializeNode(child)) })
    if (node.type.name === 'list_item') return children.join('\n\n')
    if (node.type.name === 'bullet_list') {
      return children.map((item) => {
        const lines = item.split('\n')
        return `- ${lines[0]}${lines.slice(1).map((line) => `\n  ${line}`).join('')}`
      }).join('\n')
    }
    return children.join('\n\n')
  }
  instance.serializer = vi.fn(serializeNode)
  instance.parser.mockImplementation((markdown) => {
    const marker = /ARKDOWNENHANCEDTABLE[^\s]+END/u.exec(markdown)?.[0]
    if (!marker) return schema.nodes.doc!.create(null, paragraphFor(markdown))
    return schema.nodes.doc!.create(null,
      schema.nodes.bullet_list!.create(null,
        schema.nodes.list_item!.create(null, [paragraphFor('item'), paragraphFor(marker)]),
      ),
    )
  })
  instance.viewDispatch.mockImplementation((transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  const port = ref.current!.createWorkspaceAiEditorPort!()
  const capture = await port.captureReadSnapshot({})
  if (capture.status !== 'captured') throw new Error('capture failed')
  const input = {
    operationId: 'nested-enhanced-table-operation',
    expectedEditorRevision: capture.editorRevision,
    expectedContentHash: capture.contentHash,
    replacementMarkdown: replacement,
  }

  expect((await port.planReplacement(input)).status).toBe('planned')
  expect((await port.applyTransaction(input)).status).toBe('applied')
  const exact = await port.captureReadSnapshot({})
  expect(exact).toEqual(expect.objectContaining({ status: 'captured', markdown: replacement }))
  let itemEnd = -1
  instance.viewState.doc.descendants((node, position) => {
    if (node.type.name === 'paragraph' && node.textContent === 'item') {
      itemEnd = position + 1 + node.content.size
      return false
    }
    return true
  })
  expect(itemEnd).toBeGreaterThan(0)
  ;(instance.viewDispatch as (transaction: Transaction) => void)(
    instance.viewState.tr.insertText('!', itemEnd),
  )
  instance.applyTransaction()

  const afterEdit = await port.captureReadSnapshot({})
  expect(afterEdit).toEqual(expect.objectContaining({ status: 'captured' }))
  if (afterEdit.status !== 'captured') throw new Error('edited capture failed')
  expect(afterEdit.markdown).toContain('- item!')
  expect(afterEdit.markdown).toContain('  <table data-arkdown-table="1">')
  expect(afterEdit.markdown).toContain('<col width="180">')
  expect(afterEdit.markdown).toContain('<pre><code>ok()</code></pre>')
  expect(afterEdit.markdown).not.toContain('| lossy |')
  expect(afterEdit.markdown).not.toContain('ARKDOWNSERIALIZEDTABLE')
})

it('rejects invalid visual Markdown planning without dispatch and accepts an empty document', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  instance.viewState = EditorState.create({ doc: handleSchema.node('doc', null, paragraph('Before')) })
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  const port = ref.current!.createWorkspaceAiEditorPort!()
  const capture = await port.captureReadSnapshot({})
  if (capture.status !== 'captured') throw new Error('capture failed')
  const base = {
    expectedEditorRevision: capture.editorRevision,
    expectedContentHash: capture.contentHash,
  }

  await expect(port.planReplacement({
    ...base,
    operationId: 'visual-table-tail',
    replacementMarkdown: '<table data-arkdown-table="1"><thead><tr><th><p>A</p></th></tr></thead><tbody><tr><td><p>B</p></td></tr></tbody>\n</table> tail',
  })).resolves.toEqual({ status: 'unavailable' })
  expect(instance.parser).not.toHaveBeenCalled()

  instance.parser.mockImplementationOnce(() => { throw new Error('invalid markdown') })
  await expect(port.planReplacement({
    ...base,
    operationId: 'visual-invalid',
    replacementMarkdown: 'invalid',
  })).resolves.toEqual({ status: 'unavailable' })
  expect(instance.viewDispatch).not.toHaveBeenCalled()

  instance.parser.mockImplementationOnce(() => handleSchema.node('doc', null, paragraph('')))
  const emptyInput = {
    ...base,
    operationId: 'visual-empty',
    replacementMarkdown: '',
  }
  expect((await port.planReplacement(emptyInput)).status).toBe('planned')
  expect((await port.applyTransaction(emptyInput)).status).toBe('applied')
  expect(instance.viewDispatch).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledWith('')
})

it.each([
  '<table data-arkdown-table="1">LOST<thead><tr><th><p>A</p></th></tr></thead><tbody><tr><td><p>B</p></td></tr></tbody></table>',
  '<table data-arkdown-table="1"><thead><tr><th><p>A</p></th></tr></thead><thead><tr><th><p>LOST</p></th></tr></thead><tbody><tr><td><p>B</p></td></tr></tbody></table>',
  '<table data-arkdown-table="1"><colgroup><col width="120"></colgroup><colgroup><col width="140"></colgroup><thead><tr><th><p>A</p></th><th><p>B</p></th></tr></thead><tbody><tr><td><p>C</p></td><td><p>D</p></td></tr></tbody></table>',
  '<table data-arkdown-table="1"><thead><tr><th><p>A</p></th></tr></thead><colgroup><col width="120"></colgroup><tbody><tr><td><p>B</p></td></tr></tbody></table>',
  '<table data-arkdown-table="1"><thead><tr><th><p>A</p></th></tr></thead><tbody><tr><td><p>B</p></td></tr></tbody><tbody><tr><td><p>C</p></td></tr></tbody></table>',
])('rejects a structurally lossy enhanced table without establishing an exact mirror', async (replacementMarkdown) => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  instance.viewState = EditorState.create({ doc: handleSchema.node('doc', null, paragraph('Before')) })
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  const port = ref.current!.createWorkspaceAiEditorPort!()
  const capture = await port.captureReadSnapshot({})
  if (capture.status !== 'captured') throw new Error('capture failed')

  await expect(port.planReplacement({
    operationId: 'visual-table-structural-loss',
    expectedEditorRevision: capture.editorRevision,
    expectedContentHash: capture.contentHash,
    replacementMarkdown,
  })).resolves.toEqual({ status: 'unavailable' })
  expect(instance.parser).not.toHaveBeenCalled()
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
  await expect(port.captureReadSnapshot({})).resolves.toEqual(capture)
})

it('captures the trusted visual session dirty state and observes a save reset', async () => {
  const ref = createRef<VisualEditorHandle>()
  const rendered = render(
    <VisualEditor ref={ref} documentKey="doc-dirty" dirty markdown="Dirty" onChange={vi.fn()} />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const instance = crepeMock.instances[0]!
  instance.viewState = EditorState.create({ doc: handleSchema.node('doc', null, paragraph('Dirty')) })
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  const port = ref.current!.createWorkspaceAiEditorPort!()
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual(expect.objectContaining({ status: 'captured', dirty: true }))

  rendered.rerender(
    <VisualEditor ref={ref} documentKey="doc-dirty" dirty={false} markdown="Dirty" onChange={vi.fn()} />,
  )
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual(expect.objectContaining({ status: 'captured', dirty: false }))
})

it('keeps a fresh visual AI port usable through StrictMode replay and stales it on unmount', async () => {
  const ref = createRef<VisualEditorHandle>()
  const rendered = render(
    <StrictMode>
      <VisualEditor ref={ref} documentKey="strict-doc" markdown="Strict" onChange={vi.fn()} />
    </StrictMode>,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  const instance = crepeMock.instances.at(-1)!
  instance.viewState = EditorState.create({ doc: handleSchema.node('doc', null, paragraph('Strict')) })
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  instance.parser.mockImplementation((markdown) => handleSchema.node('doc', null, paragraph(markdown)))
  instance.viewDispatch.mockImplementation((transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  const port = ref.current!.createWorkspaceAiEditorPort!()
  const capture = await port.captureReadSnapshot({})
  if (capture.status !== 'captured') throw new Error(`strict capture: ${capture.status}`)
  const input = {
    operationId: 'strict-visual-operation',
    expectedEditorRevision: capture.editorRevision,
    expectedContentHash: capture.contentHash,
    replacementMarkdown: 'Replacement',
  }
  expect((await port.planReplacement(input)).status).toBe('planned')
  expect((await port.applyTransaction(input)).status).toBe('applied')

  rendered.unmount()
  await expect(port.captureReadSnapshot({}))
    .resolves.toEqual({ status: 'stale' })
})

it('does not replace the committed visual adapter during an abandoned suspended render', async () => {
  const ref = createRef<VisualEditorHandle>()
  let switchDocument!: (documentKey: string) => void
  const never = new Promise<void>(() => undefined)
  function SuspendOnNextDocument({ documentKey }: { documentKey: string }) {
    if (documentKey === 'doc-b') throw never
    return null
  }
  function Harness() {
    const [documentKey, setDocumentKey] = useState('doc-a')
    switchDocument = setDocumentKey
    return (
      <Suspense fallback={<div>loading</div>}>
        <VisualEditor ref={ref} documentKey={documentKey} markdown="committed" onChange={vi.fn()} />
        <SuspendOnNextDocument documentKey={documentKey} />
      </Suspense>
    )
  }
  const rendered = render(<Harness />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const instance = crepeMock.instances[0]!
  instance.viewState = EditorState.create({ doc: handleSchema.node('doc', null, paragraph('committed')) })
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  const port = ref.current!.createWorkspaceAiEditorPort!()

  await act(async () => {
    startTransition(() => switchDocument('doc-b'))
    await Promise.resolve()
  })

  await expect(port.captureReadSnapshot({})).resolves.toEqual(expect.objectContaining({
    status: 'captured',
    markdown: 'committed',
  }))
  rendered.unmount()
  await expect(port.captureReadSnapshot({})).resolves.toEqual({ status: 'stale' })
})

it('ignores delayed initialization changes until a real user mutation', async () => {
  const creation = deferred()
  crepeMock.createPlans.push(() => creation.promise)
  const firstOnChange = vi.fn()
  const secondOnChange = vi.fn()
  const ref = createRef<VisualEditorHandle>()
  const view = render(
    <VisualEditor ref={ref} markdown="# Initial" onChange={firstOnChange} />,
  )
  const instance = crepeMock.instances[0]!

  expect(instance.config).toEqual(expect.objectContaining({
    defaultValue: '# Initial',
    root: expect.any(HTMLElement),
    featureConfigs: {
      placeholder: { text: '拖入文档或开始输入文字...', mode: 'doc' },
      'code-mirror': {
        copyText: '复制',
        extensions: [codeMirrorTooltips],
        searchPlaceholder: '搜索语言',
        noResultText: '未找到语言',
        previewLabel: '预览',
        previewLoading: '正在生成预览…',
      },
    },
  }))
  expect(instance.config.features).toMatchObject({
    cursor: false,
    'link-tooltip': false,
    toolbar: false,
  })
  expect(instance.prosePlugins).toEqual(expect.arrayContaining([
    expect.objectContaining({
      spec: expect.objectContaining({
        props: expect.objectContaining({
          handlePaste: expect.any(Function),
          handleTextInput: expect.any(Function),
        }),
      }),
    }),
    expect.objectContaining({
      spec: expect.objectContaining({
        props: expect.objectContaining({
          handleDrop: expect.any(Function),
          handleDOMEvents: expect.objectContaining({
            dragover: expect.any(Function),
            dragleave: expect.any(Function),
            dragend: expect.any(Function),
          }),
        }),
      }),
    }),
  ]))
  instance.applyTransaction()
  instance.listener?.({}, '# Create normalization', '# Initial')
  expect(firstOnChange).not.toHaveBeenCalled()

  await act(async () => {
    creation.resolve({})
    await creation.promise
    await Promise.resolve()
  })
  instance.applyTransaction()
  instance.listener?.({}, '# Post-create microtask', '# Create normalization')
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  instance.listener?.({}, '# Post-create timer', '# Post-create microtask')

  expect(firstOnChange).not.toHaveBeenCalled()
  expect(ref.current?.flush()).toBeNull()
  expect(instance.getMarkdown).not.toHaveBeenCalled()

  instance.markdown = '# User edit'
  fireEvent.input(screen.getByLabelText('Markdown visual editor'))
  instance.applyTransaction()
  instance.listener?.({}, '# User edit', '# Post-create timer')
  expect(firstOnChange).toHaveBeenCalledWith('# User edit')

  view.rerender(
    <VisualEditor ref={ref} markdown="# Parent echo" onChange={secondOnChange} />,
  )
  instance.markdown = '# Next edit'
  fireEvent.input(screen.getByLabelText('Markdown visual editor'))
  instance.applyTransaction()
  instance.listener?.({}, '# Next edit', '# User edit')

  expect(crepeMock.instances).toHaveLength(1)
  expect(firstOnChange).toHaveBeenCalledTimes(1)
  expect(secondOnChange).toHaveBeenCalledWith('# Next edit')
})

it('does not mark initialization-normalized Markdown dirty when flushed without user provenance', async () => {
  const onChange = vi.fn()
  const ref = createRef<VisualEditorHandle>()
  render(<VisualEditor ref={ref} markdown="# Initial\n" onChange={onChange} />)
  const instance = crepeMock.instances[0]!
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  // Crepe may normalize source formatting while creating its document. That
  // canonicalization is not a user edit and must not make a clean document
  // appear dirty when a switch/close checkpoint is requested.
  instance.markdown = '# Initial'

  let checkpoint: string | null | undefined
  act(() => {
    checkpoint = ref.current?.flush()
  })

  expect(checkpoint).toBeNull()
  expect(onChange).not.toHaveBeenCalled()
})

it('flushes user Markdown synchronously before the 200ms listener fires', async () => {
  vi.useFakeTimers()
  const onChange = vi.fn()
  const ref = createRef<VisualEditorHandle>()
  render(<VisualEditor ref={ref} markdown="# Initial" onChange={onChange} />)
  const instance = crepeMock.instances[0]!
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  instance.markdown = '# Immediate switch'
  fireEvent.input(screen.getByLabelText('Markdown visual editor'))
  instance.queueDomTransaction()
  setTimeout(() => {
    instance.listener?.({}, '# Immediate switch', '# Initial')
  }, 200)

  let checkpoint: string | null | undefined
  act(() => {
    checkpoint = ref.current?.flush()
  })

  expect(checkpoint).toBe('# Immediate switch')
  expect(instance.domForceFlush).toHaveBeenCalledTimes(1)
  expect(instance.domFlush).toHaveBeenCalledTimes(2)
  expect(instance.getMarkdown).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledWith('# Immediate switch')

  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
  expect(onChange).toHaveBeenCalledTimes(1)
})

it('flushes a DOM-backed deletion before its ProseMirror transaction is pending', async () => {
  const onChange = vi.fn()
  const ref = createRef<VisualEditorHandle>()
  render(<VisualEditor ref={ref} markdown="# Initial" onChange={onChange} />)
  const instance = crepeMock.instances[0]!
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  instance.markdown = '# Initia'
  fireEvent.input(screen.getByLabelText('Markdown visual editor'), {
    inputType: 'deleteContentBackward',
  })

  let checkpoint: string | null | undefined
  act(() => {
    checkpoint = ref.current?.flush()
  })

  expect(checkpoint).toBe('# Initia')
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledWith('# Initia')

  instance.listener?.({}, '# Initia', '# Initial')
  expect(onChange).toHaveBeenCalledTimes(1)
})

it('commits a keydown-only visual range deletion after the DOM observer transaction', async () => {
  vi.useFakeTimers()
  const onChange = vi.fn()
  render(<VisualEditor markdown="# Initial" onChange={onChange} />)
  const instance = crepeMock.instances[0]!
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  instance.markdown = ''
  fireEvent.keyDown(screen.getByLabelText('Markdown visual editor'), { key: 'Delete' })
  setTimeout(() => instance.applyTransaction(), 20)
  setTimeout(() => instance.listener?.({}, '', '# Initial'), 200)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })

  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledWith('')
})

it('publishes only the final Markdown snapshot from an IME composition', async () => {
  const onChange = vi.fn()
  render(<VisualEditor markdown="# Initial" onChange={onChange} />)
  const instance = crepeMock.instances[0]!
  const root = screen.getByLabelText('Markdown visual editor')
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  fireEvent.compositionStart(root, { data: 'q' })
  fireEvent.compositionUpdate(root, { data: '券' })
  instance.markdown = 'transient paragraph normalization'
  instance.applyTransaction()
  instance.listener?.({}, instance.markdown, '# Initial')

  expect(onChange).not.toHaveBeenCalled()

  fireEvent.compositionEnd(root, { data: '券' })
  instance.markdown = '# Initial券'
  instance.applyTransaction()
  instance.listener?.({}, instance.markdown, 'transient paragraph normalization')

  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenCalledWith('# Initial券')
})

it('does not mark an unchanged DOM input checkpoint dirty', async () => {
  const onChange = vi.fn()
  const ref = createRef<VisualEditorHandle>()
  render(<VisualEditor ref={ref} markdown="# Initial" onChange={onChange} />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  fireEvent.input(screen.getByLabelText('Markdown visual editor'))
  act(() => { ref.current?.flush() })

  expect(onChange).not.toHaveBeenCalled()
})

it('tracks toolbar transactions and expires no-op gesture intent', async () => {
  vi.useFakeTimers()
  const onChange = vi.fn()
  render(<VisualEditor markdown="# Initial" onChange={onChange} />)
  const instance = crepeMock.instances[0]!
  const root = screen.getByLabelText('Markdown visual editor')
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  instance.markdown = '**Toolbar edit**'
  fireEvent.pointerDown(root)
  instance.applyTransaction()
  instance.listener?.({}, '**Toolbar edit**', '# Initial')
  expect(onChange).toHaveBeenLastCalledWith('**Toolbar edit**')

  fireEvent.paste(root)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50)
  })
  instance.markdown = '**Normalized**'
  instance.applyTransaction()
  instance.listener?.({}, '**Normalized**', '**Toolbar edit**')

  expect(onChange).toHaveBeenCalledTimes(1)
})

it('consumes a user transaction whose Markdown serialization is unchanged', async () => {
  const onChange = vi.fn()
  render(<VisualEditor markdown="# Initial" onChange={onChange} />)
  const instance = crepeMock.instances[0]!
  const root = screen.getByLabelText('Markdown visual editor')
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  fireEvent.keyDown(root, { key: 'b', ctrlKey: true })
  instance.applyTransaction()
  instance.listener?.({}, '# Initial', '# Initial')

  instance.markdown = '# Programmatic normalization'
  instance.applyTransaction()
  instance.listener?.({}, '# Programmatic normalization', '# Initial')

  expect(onChange).not.toHaveBeenCalled()
})

it('waits for a pending create before destroying once and ignores later events', async () => {
  const creation = deferred()
  crepeMock.createPlans.push(() => creation.promise)
  const onChange = vi.fn()
  const view = render(<VisualEditor markdown="# Initial" onChange={onChange} />)
  const instance = crepeMock.instances[0]!

  view.unmount()
  expect(instance.destroy).not.toHaveBeenCalled()

  await act(async () => {
    creation.resolve({})
    await creation.promise
    await Promise.resolve()
  })
  instance.listener?.({}, '# Too late', '# Initial')

  expect(instance.destroy).toHaveBeenCalledTimes(1)
  expect(onChange).not.toHaveBeenCalled()
})

it('creates and destroys each StrictMode instance exactly once', async () => {
  const view = render(
    <StrictMode>
      <VisualEditor markdown="# Strict" onChange={vi.fn()} />
    </StrictMode>,
  )

  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  view.unmount()
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(crepeMock.instances).toHaveLength(2)
  for (const instance of crepeMock.instances) {
    expect(instance.create).toHaveBeenCalledTimes(1)
    expect(instance.destroy).toHaveBeenCalledTimes(1)
  }
})

it('contains rejected create and destroy promises without an unhandled rejection', async () => {
  crepeMock.createPlans.push(() => Promise.reject(new Error('create failed')))
  crepeMock.destroyPlans.push(() => Promise.reject(new Error('destroy failed')))
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)

  try {
    const view = render(<VisualEditor markdown="# Initial" onChange={vi.fn()} />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    view.unmount()
    await act(async () => {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(crepeMock.instances[0]!.destroy).toHaveBeenCalledTimes(1)
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
})


it('scrolls the selected outline heading into view', async () => {
  render(<VisualEditor markdown={'# One\n\n## Two'} onChange={vi.fn()} />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  proseMirror.innerHTML = '<h1>One</h1><h2>Two</h2>'
  root.append(proseMirror)
  const heading = proseMirror.querySelector('h2')!
  const scrollIntoView = vi.fn()
  Object.defineProperty(heading, 'scrollIntoView', { value: scrollIntoView })

  act(() => {
    window.dispatchEvent(new CustomEvent('arkdown:navigate-heading', {
      detail: { index: 1 },
    }))
  })

  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
})

it('reports rendered text and a finite rectangle after a real mouse selection without editor mutation', async () => {
  const onTranslationSelection = vi.fn()
  render(
    <VisualEditor
      markdown="**Rendered text**"
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const instance = crepeMock.instances[0]!
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  const rendered = document.createTextNode('Rendered text')
  proseMirror.append(rendered)
  root.append(proseMirror)
  instance.viewDom = proseMirror
  instance.viewState = stateSelectingAll([paragraph('Rendered text')])
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  const slice = vi.spyOn(instance.viewState.doc, 'slice')
  const removeAllRanges = vi.fn()
  const selectionToString = vi.fn(() => {
    throw new Error('translation export must not read DOM selection text')
  })
  const range = {
    collapsed: false,
    startContainer: rendered,
    startOffset: 0,
    endContainer: rendered,
    endOffset: 'Rendered text'.length,
    getBoundingClientRect: vi.fn(() => ({
      left: 12,
      top: 20,
      right: 92,
      bottom: 38,
      width: 80,
      height: 18,
    })),
  }
  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    getRangeAt: vi.fn(() => range),
    removeAllRanges,
    toString: selectionToString,
  } as unknown as Selection)

  firePointer(proseMirror, 'pointerdown', 9)
  firePointer(document, 'pointerup', 9, 244, 166)
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(onTranslationSelection).toHaveBeenCalledWith({
    content: { markdown: 'Rendered text', plainText: 'Rendered text' },
    range: { from: 1, to: 14 },
    mode: 'visual',
    anchorRect: {
      left: 12,
      top: 20,
      right: 92,
      bottom: 38,
      width: 80,
      height: 18,
    },
    focusRect: {
      left: 12,
      top: 20,
      right: 92,
      bottom: 38,
      width: 80,
      height: 18,
    },
    releaseRect: {
      left: 244,
      top: 166,
      right: 244,
      bottom: 166,
      width: 0,
      height: 0,
    },
  })
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(instance.viewFocus).not.toHaveBeenCalled()
  expect(removeAllRanges).not.toHaveBeenCalled()
  expect(slice).toHaveBeenCalledWith(1, 14)
  expect(selectionToString).not.toHaveBeenCalled()
})

it.each(['image node', 'single cell', 'multiple cells', 'image click', 'video click'] as const)(
  'does not report a text capsule for a %s even with a retained browser text range', async (kind) => {
    const onTranslationSelection = vi.fn()
    render(<VisualEditor markdown="text" onChange={vi.fn()} onTranslationSelection={onTranslationSelection} />)
    const instance = crepeMock.instances[0]!
    const root = screen.getByLabelText('Markdown visual editor')
    const proseMirror = document.createElement('div')
    proseMirror.className = 'ProseMirror'
    const selected = document.createTextNode('text')
    proseMirror.append(selected)
    root.append(proseMirror)
    instance.viewDom = proseMirror
    if (kind.includes('cell')) {
      const schema = enhancedTableTestSchema()
      const p = () => schema.node('paragraph', null, schema.text('text'))
      const doc = schema.node('doc', null, schema.node('table', null, [
        schema.node('table_header_row', null, schema.node('table_header', null, p())),
        schema.node('table_row', null, schema.node('table_cell', null, p())),
      ]))
      const cells: number[] = []
      doc.descendants((node, pos) => { if (['table_header', 'table_cell'].includes(node.type.name)) cells.push(pos) })
      instance.viewState = EditorState.create({ doc, selection: CellSelection.create(doc, cells[0]!, kind === 'single cell' ? cells[0]! : cells[1]!) })
    } else if (kind === 'image node') {
      const doc = handleSchema.node('doc', null, [paragraph('text'), handleSchema.node('paragraph', null, handleSchema.node('image', { src: 'test.png' }))])
      instance.viewState = EditorState.create({ doc, selection: NodeSelection.create(doc, 7) })
    } else instance.viewState = stateSelectingAll([paragraph('text')])
    instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
    instance.viewPosAtDOM.mockImplementation((_node, offset) => 1 + offset)
    const range = document.createRange()
    range.selectNodeContents(selected)
    const browserSelection = window.getSelection()!
    browserSelection.removeAllRanges()
    browserSelection.addRange(range)
    const target = kind.endsWith('click') ? proseMirror.appendChild(document.createElement(kind === 'image click' ? 'img' : 'video')) : proseMirror
    firePointer(target, 'pointerdown', 99)
    firePointer(target, 'pointerup', 99)
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())) })
    expect(onTranslationSelection.mock.calls.filter(([value]) => value !== null)).toEqual([])
    expect(instance.viewDispatch).not.toHaveBeenCalled()
  },
)

it('reports a full-document translation beside the latest pointer immediately after Ctrl+A', async () => {
  const onTranslationSelection = vi.fn()
  render(
    <VisualEditor
      markdown="Whole document"
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const instance = crepeMock.instances[0]!
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  const rendered = document.createTextNode('Whole document')
  proseMirror.append(rendered)
  root.append(proseMirror)
  instance.viewDom = proseMirror
  instance.viewState = stateWithDocumentSelection([paragraph('Whole document')])
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    focusNode: rendered,
    focusOffset: 'Whole document'.length,
    getRangeAt: vi.fn(() => ({
      collapsed: false,
      startContainer: rendered,
      startOffset: 0,
      endContainer: rendered,
      endOffset: 'Whole document'.length,
      getBoundingClientRect: vi.fn(() => ({
        left: 12,
        top: 20,
        right: 112,
        bottom: 38,
        width: 100,
        height: 18,
      })),
    })),
  } as unknown as Selection)

  firePointerMove(proseMirror, 286, 174)
  fireEvent.keyDown(proseMirror, { key: 'a', ctrlKey: true })
  await waitFor(() => expect(onTranslationSelection).toHaveBeenCalledOnce())

  expect(onTranslationSelection).toHaveBeenCalledOnce()
  expect(onTranslationSelection).toHaveBeenCalledWith(expect.objectContaining({
    content: { markdown: 'Whole document', plainText: 'Whole document' },
    mode: 'visual',
    scope: 'document',
    releaseRect: {
      left: 286,
      top: 174,
      right: 286,
      bottom: 174,
      width: 0,
      height: 0,
    },
  }))

  onTranslationSelection.mockClear()
  fireEvent.keyDown(proseMirror, { key: 'x' })

  expect(onTranslationSelection).toHaveBeenCalledOnce()
  expect(onTranslationSelection).toHaveBeenCalledWith(null)
})

it('reports null when a mouse selection endpoint is outside the ProseMirror root', async () => {
  const onTranslationSelection = vi.fn()
  render(
    <VisualEditor
      markdown="Inside"
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  const inside = document.createTextNode('Inside')
  const outside = document.createTextNode('Outside')
  proseMirror.append(inside)
  root.append(proseMirror, outside)
  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    getRangeAt: () => ({
      collapsed: false,
      startContainer: inside,
      endContainer: outside,
      getBoundingClientRect: () => new DOMRect(0, 0, 10, 10),
    }),
    toString: () => 'InsideOutside',
  } as unknown as Selection)

  firePointer(proseMirror, 'pointerdown')
  firePointer(proseMirror, 'pointerup')
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(onTranslationSelection).toHaveBeenCalledOnce()
  expect(onTranslationSelection).toHaveBeenCalledWith(null)
})

it('ignores programmatic and keyboard-originated visual selections', async () => {
  const onTranslationSelection = vi.fn()
  render(
    <VisualEditor
      markdown="Keyboard selection"
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  root.append(proseMirror)
  const getSelection = vi.spyOn(window, 'getSelection')

  fireEvent(document, new Event('selectionchange', { bubbles: true }))
  firePointer(proseMirror, 'pointerdown')
  fireEvent.keyDown(root, { key: 'ArrowRight', shiftKey: true })
  firePointer(proseMirror, 'pointerup')
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(getSelection).not.toHaveBeenCalled()
  expect(onTranslationSelection).not.toHaveBeenCalled()
})

it('does not capture a seeded selection from wrapper blank or control gestures', async () => {
  const onTranslationSelection = vi.fn()
  render(
    <VisualEditor
      markdown="Seeded selection"
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  const selected = document.createTextNode('Seeded selection')
  proseMirror.append(selected)
  const control = document.createElement('button')
  root.append(proseMirror, control)
  const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    getRangeAt: () => ({
      collapsed: false,
      startContainer: selected,
      endContainer: selected,
      getBoundingClientRect: () => new DOMRect(0, 0, 20, 10),
    }),
    toString: () => 'Seeded selection',
  } as unknown as Selection)

  firePointer(root, 'pointerdown', 20)
  firePointer(root, 'pointerup', 20)
  firePointer(control, 'pointerdown', 21)
  firePointer(control, 'pointerup', 21)
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(getSelection).not.toHaveBeenCalled()
  expect(onTranslationSelection).not.toHaveBeenCalled()
})

it('keeps a content gesture armed across focus movement inside the visual editor', async () => {
  const onTranslationSelection = vi.fn()
  render(
    <VisualEditor
      markdown="Internal focus"
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  const selected = document.createTextNode('Internal focus')
  proseMirror.append(selected)
  const internalControl = document.createElement('button')
  root.append(proseMirror, internalControl)
  const instance = crepeMock.instances[0]!
  instance.viewDom = proseMirror
  instance.viewState = stateSelectingAll([paragraph('Internal focus')])
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  const slice = vi.spyOn(instance.viewState.doc, 'slice')
  const selectionToString = vi.fn(() => {
    throw new Error('translation export must not read DOM selection text')
  })
  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    getRangeAt: () => ({
      collapsed: false,
      startContainer: selected,
      startOffset: 0,
      endContainer: selected,
      endOffset: 'Internal focus'.length,
      getBoundingClientRect: () => new DOMRect(10, 10, 40, 18),
    }),
    toString: selectionToString,
  } as unknown as Selection)

  firePointer(proseMirror, 'pointerdown', 22)
  fireEvent.blur(proseMirror, { relatedTarget: internalControl })
  firePointer(proseMirror, 'pointerup', 22)
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(onTranslationSelection).toHaveBeenCalledOnce()
  expect(onTranslationSelection).toHaveBeenCalledWith(expect.objectContaining({
    content: { markdown: 'Internal focus', plainText: 'Internal focus' },
    mode: 'visual',
  }))
  expect(slice).toHaveBeenCalledWith(1, 15)
  expect(selectionToString).not.toHaveBeenCalled()
})

it('invalidates a content gesture when focus leaves the visual editor', async () => {
  const onTranslationSelection = vi.fn()
  render(
    <VisualEditor
      markdown="External focus"
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  const selected = document.createTextNode('External focus')
  proseMirror.append(selected)
  root.append(proseMirror)
  const externalControl = document.body.appendChild(document.createElement('button'))
  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    getRangeAt: () => ({
      collapsed: false,
      startContainer: selected,
      startOffset: 0,
      endContainer: selected,
      endOffset: 'Internal focus'.length,
      getBoundingClientRect: () => new DOMRect(10, 10, 40, 18),
    }),
    toString: () => 'External focus',
  } as unknown as Selection)

  firePointer(proseMirror, 'pointerdown', 23)
  fireEvent.blur(proseMirror, { relatedTarget: externalControl })
  firePointer(proseMirror, 'pointerup', 23)
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(onTranslationSelection).not.toHaveBeenCalled()
})

it('drops a queued visual capture when its ProseMirror surface is replaced', async () => {
  const onTranslationSelection = vi.fn()
  render(
    <VisualEditor
      markdown="Old surface"
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  const selected = document.createTextNode('Old surface')
  proseMirror.append(selected)
  root.append(proseMirror)
  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    getRangeAt: () => ({
      collapsed: false,
      startContainer: selected,
      endContainer: selected,
      getBoundingClientRect: () => new DOMRect(0, 0, 30, 10),
    }),
    toString: () => 'Old surface',
  } as unknown as Selection)

  firePointer(proseMirror, 'pointerdown', 24)
  firePointer(proseMirror, 'pointerup', 24)
  const replacement = document.createElement('div')
  replacement.className = 'ProseMirror'
  proseMirror.replaceWith(replacement)
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(onTranslationSelection).not.toHaveBeenCalled()
})

it('drops a queued visual capture after a newer gesture starts', async () => {
  const onTranslationSelection = vi.fn()
  render(
    <VisualEditor
      markdown="Stale gesture"
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  const selected = document.createTextNode('Stale gesture')
  proseMirror.append(selected)
  root.append(proseMirror)
  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    getRangeAt: () => ({
      collapsed: false,
      startContainer: selected,
      endContainer: selected,
      getBoundingClientRect: () => new DOMRect(0, 0, 30, 10),
    }),
    toString: () => 'Stale gesture',
  } as unknown as Selection)

  firePointer(proseMirror, 'pointerdown', 25)
  firePointer(proseMirror, 'pointerup', 25)
  firePointer(proseMirror, 'pointerdown', 26)
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(onTranslationSelection).not.toHaveBeenCalled()
})

it('handles visual Tab through the installed plugin and commits canonical Markdown exactly once', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  const root = screen.getByLabelText('Markdown visual editor')
  const doc = handleSchema.node('doc', null, paragraph('alpha'))
  instance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 3),
  })
  instance.viewDispatch.mockImplementation((transaction: Transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
    instance.markdown = '　　alpha'
    instance.applyTransaction(transaction.docChanged)
  })
  const plugin = instance.prosePlugins.find((candidate) => candidate.spec.props?.handleKeyDown)
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  root.dispatchEvent(event)

  const handled = plugin?.spec.props?.handleKeyDown?.({
    get state() { return instance.viewState! },
    dispatch: instance.viewDispatch,
    editable: true,
  } as unknown as EditorView, event)
  instance.listener?.({}, 'lossy listener value', 'alpha')
  instance.listener?.({}, 'second listener value', 'lossy listener value')

  expect(plugin).toBeDefined()
  expect(handled).toBe(true)
  expect(event.defaultPrevented).toBe(true)
  expect(instance.viewDispatch).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenCalledOnce()
  expect(onChange).toHaveBeenCalledWith('　　alpha')
})

it('does not prevent or commit when the installed visual Tab plugin declines the command', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  const root = screen.getByLabelText('Markdown visual editor')
  const doc = handleSchema.node('doc', null, handleSchema.node(
    'heading',
    { level: 6 },
    handleSchema.text('boundary'),
  ))
  instance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 3),
  })
  const plugin = instance.prosePlugins.find((candidate) => candidate.spec.props?.handleKeyDown)
  const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  root.dispatchEvent(event)

  const handled = plugin?.spec.props?.handleKeyDown?.({
    get state() { return instance.viewState! },
    dispatch: instance.viewDispatch,
    editable: true,
  } as unknown as EditorView, event)
  instance.listener?.({}, '# boundary', '# boundary')

  expect(plugin).toBeDefined()
  expect(handled).toBe(false)
  expect(event.defaultPrevented).toBe(false)
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
})

it('inserts a dropped local link at the ProseMirror position under the release point', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  const initialDoc = handleSchema.node('doc', null, paragraph('before after'))
  instance.viewState = EditorState.create({ doc: initialDoc })
  instance.viewDispatch.mockImplementation((transaction: Transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  instance.viewPosAtCoords.mockReturnValue({ pos: 8 })

  expect(ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\raw.bin',
    clientX: 120,
    clientY: 240,
    kind: 'file',
  })).toBe(true)

  expect(instance.viewPosAtCoords).toHaveBeenCalledWith({ left: 120, top: 240 })
  expect(instance.viewState.doc.textContent).toBe('before raw.binafter')
})

it('inserts an external file at the exact target already shown by the visual drop caret', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  root.append(proseMirror)
  const initialDoc = handleSchema.node('doc', null, paragraph('before after'))
  instance.viewDom = proseMirror
  instance.viewState = EditorState.create({ doc: initialDoc })
  instance.viewDispatch.mockImplementation((transaction: Transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  instance.viewPosAtCoords.mockReturnValue({ pos: 8 })
  instance.viewCoordsAtPos.mockReturnValue({ left: 64, top: 20, right: 64, bottom: 38 })
  const view = {
    get state() { return instance.viewState! },
    dom: proseMirror,
    dragging: null,
    editable: true,
    posAtCoords: instance.viewPosAtCoords,
    coordsAtPos: instance.viewCoordsAtPos,
    dispatch: instance.viewDispatch,
    focus: instance.viewFocus,
  } as unknown as EditorView
  const plugin = instance.prosePlugins.find((candidate) => candidate.spec.props?.handleDrop)
  expect(plugin).toBeDefined()
  if (!plugin) return
  const pluginView = plugin.spec.view?.(view)
  const dragover = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperties(dragover, { clientX: { value: 120 }, clientY: { value: 240 } })
  plugin.spec.props?.handleDOMEvents?.dragover?.(view, dragover)
  expect(document.body.querySelector('.arkdown-visual-drop-caret'))
    .toHaveAttribute('data-drop-pos', '8')

  const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
  expect(plugin.spec.props?.handleDrop?.(view, drop, Slice.empty, false)).toBe(false)
  instance.viewPosAtCoords.mockReturnValue({ pos: 3 })

  expect(ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\raw.bin',
    clientX: 120,
    clientY: 240,
    kind: 'file',
  })).toBe(true)
  expect(instance.viewState.doc.textContent).toBe('before raw.binafter')
  pluginView?.destroy?.()
})

it('preserves a selection changed while dropped-path inspection is pending', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  root.append(proseMirror)
  const initialDoc = handleSchema.node('doc', null, paragraph('before after'))
  instance.viewDom = proseMirror
  instance.viewState = EditorState.create({ doc: initialDoc })
  instance.viewPosAtCoords.mockReturnValue({ pos: 8 })
  instance.viewCoordsAtPos.mockReturnValue({ left: 64, top: 20, right: 64, bottom: 38 })
  const view = {
    get state() { return instance.viewState! },
    dom: proseMirror,
    dragging: null,
    editable: true,
    posAtCoords: instance.viewPosAtCoords,
    coordsAtPos: instance.viewCoordsAtPos,
    dispatch: instance.viewDispatch,
    focus: instance.viewFocus,
  } as unknown as EditorView
  const plugin = instance.prosePlugins.find((candidate) => candidate.spec.props?.handleDrop)
  expect(plugin).toBeDefined()
  if (!plugin) return
  const pluginView = plugin.spec.view?.(view)
  const dragover = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperties(dragover, { clientX: { value: 120 }, clientY: { value: 240 } })
  plugin.spec.props?.handleDOMEvents?.dragover?.(view, dragover)
  plugin.spec.props?.handleDrop?.(view, new Event('drop') as DragEvent, Slice.empty, false)

  const inspection = deferred()
  const pendingInsertion = inspection.promise.then(() => ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\raw.bin',
    clientX: 120,
    clientY: 240,
    kind: 'file',
  }))
  instance.viewState = instance.viewState.apply(
    instance.viewState.tr.setSelection(TextSelection.create(instance.viewState.doc, 4, 11)),
  )
  instance.viewPosAtCoords.mockClear()
  inspection.resolve(undefined)

  expect(await pendingInsertion).toBe(true)
  expect(instance.viewState.doc.textContent).toBe('before raw.binafter')
  expect(instance.viewPosAtCoords).not.toHaveBeenCalled()
  pluginView?.destroy?.()
})

it('inserts delayed asset Markdown at the cached visual caret after the selection moves', async () => {
  const { dragAt, dropExternal, instance, pluginView, ref } = await readyExternalVisualDropEditor()
  dragAt(8, 120, 240)
  const requestId = visualDropRequestIdForEvent(dropExternal())
  expect(requestId).not.toBeUndefined()
  const link = handleSchema.marks.link!.create({ href: 'arkdown-asset:guide.pdf', title: null })
  instance.parser.mockImplementation((markdown) => {
    expect(markdown).toBe('[guide.pdf](arkdown-asset:guide.pdf)')
    return handleSchema.node('doc', null, handleSchema.node(
      'paragraph',
      null,
      handleSchema.text('guide.pdf', [link]),
    ))
  })
  instance.viewState = instance.viewState!.apply(
    instance.viewState!.tr.setSelection(TextSelection.create(instance.viewState!.doc, 2, 7)),
  )
  instance.viewDispatch.mockClear()
  instance.viewPosAtCoords.mockClear()

  const handle = ref.current as DroppedMarkdownTestHandle | null
  expect(handle?.insertDroppedMarkdown?.({
    markdown: '[guide.pdf](arkdown-asset:guide.pdf)',
    clientX: 120,
    clientY: 240,
    visualDropRequestId: requestId,
  })).toBe(true)

  expect(instance.viewState!.doc.textContent).toBe('before guide.pdfafter')
  expect(handleSchema.marks.link!.isInSet(instance.viewState!.doc.nodeAt(8)?.marks ?? [])?.attrs.href)
    .toBe('arkdown-asset:guide.pdf')
  expect(instance.viewPosAtCoords).not.toHaveBeenCalled()
  expect(instance.viewDispatch).toHaveBeenCalledOnce()
  pluginView?.destroy?.()
})

it('maps a pending visual drop target through intervening document edits', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  root.append(proseMirror)
  const initialDoc = handleSchema.node('doc', null, paragraph('before after'))
  instance.viewDom = proseMirror
  instance.viewPosAtCoords.mockReturnValue({ pos: 8 })
  instance.viewCoordsAtPos.mockReturnValue({ left: 64, top: 20, right: 64, bottom: 38 })
  const plugin = instance.prosePlugins.find((candidate) => candidate.spec.props?.handleDrop)
  expect(plugin).toBeDefined()
  if (!plugin) return
  instance.viewState = EditorState.create({ doc: initialDoc, plugins: [plugin as never] })
  const view = {
    get state() { return instance.viewState! },
    dom: proseMirror,
    dragging: null,
    editable: true,
    posAtCoords: instance.viewPosAtCoords,
    coordsAtPos: instance.viewCoordsAtPos,
    dispatch: instance.viewDispatch,
    focus: instance.viewFocus,
  } as unknown as EditorView
  const pluginView = plugin.spec.view?.(view)
  const dragover = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperties(dragover, { clientX: { value: 120 }, clientY: { value: 240 } })
  plugin.spec.props?.handleDOMEvents?.dragover?.(view, dragover)
  plugin.spec.props?.handleDrop?.(view, new Event('drop') as DragEvent, Slice.empty, false)

  const inspection = deferred()
  const pendingInsertion = inspection.promise.then(() => ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\raw.bin',
    clientX: 120,
    clientY: 240,
    kind: 'file',
  }))
  const previousState = instance.viewState
  ;(instance.viewDispatch as unknown as (transaction: Transaction) => void)(
    previousState.tr.insertText('new ', 1),
  )
  pluginView?.update?.(view, previousState)
  const beforeSelection = instance.viewState
  instance.viewState = beforeSelection.apply(
    beforeSelection.tr.setSelection(TextSelection.create(beforeSelection.doc, 6, 15)),
  )
  pluginView?.update?.(view, beforeSelection)
  instance.viewPosAtCoords.mockClear()
  instance.viewPosAtCoords.mockReturnValue({ pos: 3 })
  inspection.resolve(undefined)

  expect(await pendingInsertion).toBe(true)
  expect(instance.viewState.doc.textContent).toBe('new before raw.binafter')
  expect(instance.viewPosAtCoords).not.toHaveBeenCalled()
  pluginView?.destroy?.()
})

it('rejects a pending visual drop target deleted during dropped-path inspection', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  root.append(proseMirror)
  const initialDoc = handleSchema.node('doc', null, paragraph('before after'))
  instance.viewDom = proseMirror
  instance.viewPosAtCoords.mockReturnValue({ pos: 8 })
  instance.viewCoordsAtPos.mockReturnValue({ left: 64, top: 20, right: 64, bottom: 38 })
  const plugin = instance.prosePlugins.find((candidate) => candidate.spec.props?.handleDrop)
  expect(plugin).toBeDefined()
  if (!plugin) return
  instance.viewState = EditorState.create({ doc: initialDoc, plugins: [plugin as never] })
  const view = {
    get state() { return instance.viewState! },
    dom: proseMirror,
    dragging: null,
    editable: true,
    posAtCoords: instance.viewPosAtCoords,
    coordsAtPos: instance.viewCoordsAtPos,
    dispatch: instance.viewDispatch,
    focus: instance.viewFocus,
  } as unknown as EditorView
  const pluginView = plugin.spec.view?.(view)
  const dragover = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperties(dragover, { clientX: { value: 120 }, clientY: { value: 240 } })
  plugin.spec.props?.handleDOMEvents?.dragover?.(view, dragover)
  plugin.spec.props?.handleDrop?.(view, new Event('drop') as DragEvent, Slice.empty, false)

  const inspection = deferred()
  const pendingInsertion = inspection.promise.then(() => ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\raw.bin',
    clientX: 120,
    clientY: 240,
    kind: 'file',
  }))
  const previousState = instance.viewState
  ;(instance.viewDispatch as unknown as (transaction: Transaction) => void)(
    previousState.tr.delete(7, 10),
  )
  pluginView?.update?.(view, previousState)
  instance.viewDispatch.mockClear()
  instance.viewPosAtCoords.mockClear()
  instance.viewPosAtCoords.mockReturnValue({ pos: 3 })
  inspection.resolve(undefined)

  expect(await pendingInsertion).toBe(false)
  expect(instance.viewState.doc.textContent).toBe('beforeter')
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(instance.viewPosAtCoords).not.toHaveBeenCalled()
  pluginView?.destroy?.()
})

it('keeps an accepted external drop pending through the Windows drag termination sequence', async () => {
  const {
    dragAt,
    dropExternal,
    instance,
    plugin,
    pluginView,
    ref,
    view,
  } = await readyExternalVisualDropEditor()
  dragAt(8, 120, 240)
  const drop = dropExternal()
  const requestId = visualDropRequestIdForEvent(drop)
  expect(requestId).not.toBeUndefined()

  const inspection = deferred()
  const pendingInsertion = inspection.promise.then(() => ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\raw.bin',
    clientX: 120,
    clientY: 240,
    kind: 'file',
    visualDropRequestId: requestId,
  }))
  instance.viewState = instance.viewState!.apply(
    instance.viewState!.tr.setSelection(TextSelection.create(instance.viewState!.doc, 4, 11)),
  )

  const dragleave = new Event('dragleave', { bubbles: true }) as DragEvent
  Object.defineProperty(dragleave, 'relatedTarget', { value: null })
  plugin.spec.props?.handleDOMEvents?.dragleave?.(view, dragleave)
  plugin.spec.props?.handleDOMEvents?.dragend?.(view, new Event('dragend') as DragEvent)
  view.dom.ownerDocument.defaultView?.dispatchEvent(new Event('blur'))

  instance.viewDispatch.mockClear()
  instance.viewPosAtCoords.mockClear()
  instance.viewPosAtCoords.mockReturnValue({ pos: 5 })
  inspection.resolve(undefined)

  expect(await pendingInsertion).toBe(true)
  expect(instance.viewState!.doc.textContent).toBe('before raw.binafter')
  expect(instance.viewDispatch).toHaveBeenCalledOnce()
  expect(instance.viewPosAtCoords).not.toHaveBeenCalled()
  pluginView?.destroy?.()
})

it.each([
  'Escape',
  'editor teardown',
] as const)('invalidates an accepted external drop after %s', async (termination) => {
  const {
    dragAt,
    dropExternal,
    instance,
    plugin,
    pluginView,
    ref,
    view,
  } = await readyExternalVisualDropEditor()
  dragAt(8, 120, 240)
  const drop = dropExternal()
  const requestId = visualDropRequestIdForEvent(drop)
  expect(requestId).not.toBeUndefined()

  const inspection = deferred()
  const pendingInsertion = inspection.promise.then(() => ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\raw.bin',
    clientX: 120,
    clientY: 240,
    kind: 'file',
    visualDropRequestId: requestId,
  }))
  instance.viewState = instance.viewState!.apply(
    instance.viewState!.tr.setSelection(TextSelection.create(instance.viewState!.doc, 4, 11)),
  )

  if (termination === 'Escape') {
    plugin.spec.props?.handleKeyDown?.(view, new KeyboardEvent('keydown', { key: 'Escape' }))
  } else {
    pluginView?.destroy?.()
  }

  instance.viewDispatch.mockClear()
  instance.viewPosAtCoords.mockClear()
  inspection.resolve(undefined)

  expect(await pendingInsertion).toBe(false)
  expect(instance.viewState!.doc.textContent).toBe('before after')
  expect(instance.viewState!.selection).toEqual(TextSelection.create(instance.viewState!.doc, 4, 11))
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(instance.viewPosAtCoords).not.toHaveBeenCalled()
  if (termination === 'Escape') pluginView?.destroy?.()
})

it('keeps an older completion out of a new drag and lets the new request resolve', async () => {
  const { dragAt, dropExternal, instance, pluginView, ref } = await readyExternalVisualDropEditor()
  dragAt(8, 120, 240)
  dropExternal()

  const firstInspection = deferred()
  const firstInsertion = firstInspection.promise.then(() => ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\first.bin',
    clientX: 120,
    clientY: 240,
    kind: 'file',
  }))

  dragAt(3, 30, 40)
  expect(document.body.querySelector('.arkdown-visual-drop-caret'))
    .toHaveAttribute('data-drop-pos', '3')
  instance.viewDispatch.mockClear()
  instance.viewPosAtCoords.mockClear()
  firstInspection.resolve(undefined)

  expect(await firstInsertion).toBe(false)
  expect(instance.viewState!.doc.textContent).toBe('before after')
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(instance.viewPosAtCoords).not.toHaveBeenCalled()
  expect(document.body.querySelector('.arkdown-visual-drop-caret'))
    .toHaveAttribute('data-drop-pos', '3')

  dropExternal()
  instance.viewPosAtCoords.mockClear()
  expect(ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\second.bin',
    clientX: 30,
    clientY: 40,
    kind: 'file',
  })).toBe(true)
  expect(instance.viewState!.doc.textContent).toBe('besecond.binfore after')
  expect(instance.viewPosAtCoords).not.toHaveBeenCalled()
  pluginView?.destroy?.()
})

it('does not let an older external inspection consume a newer pending drop', async () => {
  const { dragAt, dropExternal, instance, pluginView, ref } = await readyExternalVisualDropEditor()
  dragAt(8, 120, 240)
  const firstDrop = dropExternal()
  const firstRequestId = visualDropRequestIdForEvent(firstDrop)

  dragAt(3, 30, 40)
  const secondDrop = dropExternal()
  const secondRequestId = visualDropRequestIdForEvent(secondDrop)
  expect(firstRequestId).not.toBeUndefined()
  expect(secondRequestId).not.toBeUndefined()
  expect(secondRequestId).not.toBe(firstRequestId)

  instance.viewDispatch.mockClear()
  instance.viewPosAtCoords.mockClear()
  expect(ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\first.bin',
    clientX: 120,
    clientY: 240,
    kind: 'file',
    visualDropRequestId: firstRequestId,
  })).toBe(false)
  expect(instance.viewState!.doc.textContent).toBe('before after')
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(instance.viewPosAtCoords).not.toHaveBeenCalled()

  expect(ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\second.bin',
    clientX: 30,
    clientY: 40,
    kind: 'file',
    visualDropRequestId: secondRequestId,
  })).toBe(true)
  expect(instance.viewState!.doc.textContent).toBe('besecond.binfore after')
  expect(instance.viewPosAtCoords).not.toHaveBeenCalled()
  pluginView?.destroy?.()
})

it('keeps the full folder path as the visual link label and href', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const initialDoc = handleSchema.node('doc', null, paragraph('before after'))
  instance.viewState = EditorState.create({ doc: initialDoc })
  instance.viewDispatch.mockImplementation((transaction: Transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  instance.viewPosAtCoords.mockReturnValue({ pos: 8 })

  expect(ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Workspace Folder',
    clientX: 44,
    clientY: 88,
    kind: 'folder',
  })).toBe(true)

  const linked = instance.viewState.doc.nodeAt(8)
  expect(instance.viewState.doc.textContent).toBe('before C:\\Workspace Folderafter')
  expect(linked?.textContent).toBe('C:\\Workspace Folder')
  expect(handleSchema.marks.link!.isInSet(linked?.marks ?? [])?.attrs.href)
    .toBe('C:\\Workspace Folder')
})

it('exposes a live margin-selection port that clamps into ProseMirror and dispatches only selection', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  const { instance } = await readyEditor(ref, onChange)
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  root.append(proseMirror)
  instance.viewDom = proseMirror
  instance.viewState = EditorState.create({
    doc: handleSchema.node('doc', null, [paragraph('alpha omega')]),
  })
  instance.viewPosAtCoords.mockReturnValue({ pos: 4 })
  Object.defineProperty(root, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(0, 0, 600, 400),
  })
  Object.defineProperty(proseMirror, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(100, 20, 400, 300),
  })
  const marginEvent = new MouseEvent('pointerdown', {
    bubbles: true, button: 0, clientX: 50, clientY: 100,
  })
  Object.defineProperties(marginEvent, {
    isPrimary: { value: true }, pointerId: { value: 61 }, pointerType: { value: 'mouse' },
  })
  root.dispatchEvent(marginEvent)

  const port = ref.current?.marginSelectionPort?.()
  expect(port).not.toBeNull()
  expect(port?.isEligibleMarginStart(marginEvent as unknown as PointerEvent)).toBe(true)
  expect(port?.activationPositionAtPoint).toBeTypeOf('function')
  expect(port?.activationPositionAtPoint({ clientX: 50, clientY: 100 })).toBeNull()
  expect(port?.activationPositionAtPoint({ clientX: 120, clientY: 100 })).toBe(4)
  expect(instance.viewPosAtCoords).toHaveBeenLastCalledWith({ left: 120, top: 100 })
  expect(port?.positionAtPoint({ clientX: 50, clientY: 100 })).toBe(4)
  expect(instance.viewPosAtCoords).toHaveBeenLastCalledWith({ left: 100.5, top: 100 })

  instance.viewDispatch.mockClear()
  port?.focus()
  port?.applySelection(1, 6)
  expect(instance.viewFocus).toHaveBeenCalled()
  expect(instance.viewState?.selection).toEqual(TextSelection.create(instance.viewState.doc, 1, 6))
  expect(onChange).not.toHaveBeenCalled()
})

it('authorizes an activated visual margin gesture for the existing translation exporter', async () => {
  const ref = createRef<VisualEditorHandle>()
  const onTranslationSelection = vi.fn()
  render(
    <VisualEditor
      ref={ref}
      markdown="Margin translation"
      onChange={vi.fn()}
      onTranslationSelection={onTranslationSelection}
    />,
  )
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  const instance = crepeMock.instances[0]!
  const root = screen.getByLabelText('Markdown visual editor')
  const proseMirror = document.createElement('div')
  proseMirror.className = 'ProseMirror'
  const text = document.createTextNode('Margin translation')
  proseMirror.append(text)
  root.append(proseMirror)
  instance.viewDom = proseMirror
  instance.viewState = stateSelectingAll([paragraph('Margin translation')])
  instance.serializer = vi.fn((node: ProseMirrorNode) => node.textContent)
  vi.spyOn(window, 'getSelection').mockReturnValue({
    rangeCount: 1,
    focusNode: text,
    focusOffset: text.length,
    getRangeAt: () => ({
      collapsed: false,
      startContainer: text,
      startOffset: 0,
      endContainer: text,
      endOffset: text.length,
      getBoundingClientRect: () => new DOMRect(10, 10, 80, 18),
    }),
  } as unknown as Selection)
  const down = new MouseEvent('pointerdown', { bubbles: true, button: 0 })
  Object.defineProperties(down, {
    isPrimary: { value: true }, pointerId: { value: 62 }, pointerType: { value: 'mouse' },
  })

  ref.current?.marginSelectionPort?.()?.beginPointerSelection(down as unknown as PointerEvent)
  firePointer(document, 'pointerup', 62, 240, 160)
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })

  expect(onTranslationSelection).toHaveBeenCalledWith(expect.objectContaining({
    content: { markdown: 'Margin translation', plainText: 'Margin translation' },
    mode: 'visual',
  }))
})

it('replaces a visual selection when a dropped document lands inside it', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const initialDoc = handleSchema.node('doc', null, paragraph('before after'))
  instance.viewState = EditorState.create({
    doc: initialDoc,
    selection: TextSelection.create(initialDoc, 8, 13),
  })
  instance.viewDispatch.mockImplementation((transaction: Transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  instance.viewPosAtCoords.mockReturnValue({ pos: 10 })

  expect(ref.current?.insertDroppedLink?.({
    absolutePath: 'C:\\Files\\chapter.md',
    clientX: 120,
    clientY: 240,
    kind: 'file',
  })).toBe(true)

  expect(instance.viewState.doc.textContent).toBe('before chapter.md')
})

it('splits a table-cell paragraph on Enter without recognizing its URL-shaped text', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const tableSchema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      table: { content: 'table_row+', group: 'block', isolating: true, toDOM: () => ['table', ['tbody', 0]] },
      table_row: { content: 'table_cell+', toDOM: () => ['tr', 0] },
      table_cell: { content: 'paragraph+', isolating: true, toDOM: () => ['td', 0] },
      paragraph: { content: 'text*', toDOM: () => ['p', 0] },
      text: {},
    },
    marks: {
      link: {
        attrs: { href: {}, title: { default: null } },
        inclusive: false,
        toDOM: (mark) => ['a', { href: mark.attrs.href }, 0],
      },
    },
  })
  const target = 'www.example.com/table'
  const doc = tableSchema.node('doc', null, tableSchema.node(
    'table',
    null,
    tableSchema.node('table_row', null, tableSchema.node(
      'table_cell',
      null,
      tableSchema.node('paragraph', null, tableSchema.text(target)),
    )),
  ))
  let cursor = 0
  doc.descendants((node, position) => {
    if (node.isText) cursor = position + node.nodeSize
  })
  instance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, cursor),
  })
  instance.viewDispatch.mockImplementation((transaction: Transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  const root = screen.getByLabelText('Markdown visual editor')
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  })

  root.dispatchEvent(event)

  const cell = instance.viewState.doc.firstChild!.firstChild!.firstChild!
  const firstLine = cell.firstChild!.firstChild!
  expect(event.defaultPrevented).toBe(true)
  expect(cell.childCount).toBe(2)
  expect(firstLine.textContent).toBe(target)
  expect(tableSchema.marks.link!.isInSet(firstLine.marks)).toBeUndefined()
})

it('opens the shared manual link editor for the visual link command', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  const doc = handleSchema.node('doc', null, paragraph('selected label'))
  instance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1, 15),
  })
  instance.viewDispatch.mockImplementation((transaction: Transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })

  window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'link' }))
  const input = document.querySelector<HTMLInputElement>('.arkdown-link-editor-popover input')

  expect(input).not.toBeNull()
  input!.value = 'www.example.com/command'
  input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(instance.viewState.doc.textContent).toBe('selected label')
  expect(instance.viewState.doc.firstChild!.firstChild!.marks[0]?.attrs.href)
    .toBe('https://www.example.com/command')
})

it('closes the active manual link editor before destroying VisualEditor on unmount', async () => {
  const rendered = render(<VisualEditor markdown="selected label" onChange={vi.fn()} />)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const instance = crepeMock.instances[0]!
  const doc = handleSchema.node('doc', null, paragraph('selected label'))
  instance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1, 15),
  })

  window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'link' }))
  const popover = document.querySelector<HTMLFormElement>('.arkdown-link-editor-popover')
  expect(popover).not.toBeNull()

  await act(async () => {
    rendered.unmount()
    await Promise.resolve()
  })

  expect(popover!.isConnected).toBe(false)
  expect(instance.viewFocus).toHaveBeenCalledOnce()
  expect(instance.destroy).toHaveBeenCalledOnce()
  expect(instance.viewFocus.mock.invocationCallOrder[0])
    .toBeLessThan(instance.destroy.mock.invocationCallOrder[0]!)
})

it('closes the outgoing document link editor when VisualEditor switches documents', async () => {
  const rendered = render(
    <VisualEditor key="doc-a" documentKey="doc-a" markdown="selected label" onChange={vi.fn()} />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const firstInstance = crepeMock.instances[0]!
  const doc = handleSchema.node('doc', null, paragraph('selected label'))
  firstInstance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1, 15),
  })

  window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'link' }))
  const outgoingPopover = document.querySelector<HTMLFormElement>('.arkdown-link-editor-popover')
  expect(outgoingPopover).not.toBeNull()

  rendered.rerender(
    <VisualEditor key="doc-b" documentKey="doc-b" markdown="next document" onChange={vi.fn()} />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(outgoingPopover!.isConnected).toBe(false)
  expect(firstInstance.viewFocus).toHaveBeenCalledOnce()
  expect(firstInstance.destroy).toHaveBeenCalledOnce()
  expect(firstInstance.viewFocus.mock.invocationCallOrder[0])
    .toBeLessThan(firstInstance.destroy.mock.invocationCallOrder[0]!)
})

it('inserts an exact plain-text local target before Milkdown can parse its backslashes', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  instance.viewState = EditorState.create({
    schema: handleSchema,
    doc: handleSchema.node('doc', null, paragraph('')),
  })
  const root = screen.getByLabelText('Markdown visual editor')
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: ['text/plain'],
      getData: (type: string) => type === 'text/plain'
        ? 'C:\\Workspace\\My Guide.md'
        : '',
    },
  })

  root.dispatchEvent(event)

  expect(event.defaultPrevented).toBe(true)
  expect(instance.viewState.doc.textContent).toBe('C:\\Workspace\\My Guide.md')
  expect(instance.viewState.doc.firstChild!.firstChild!.marks[0]?.attrs.href)
    .toBe('C:\\Workspace\\My Guide.md')
})

it('leaves an exact supported paste to ProseMirror while the active EditorView is composing', async () => {
  const ref = createRef<VisualEditorHandle>()
  const { instance } = await readyEditor(ref)
  instance.viewState = EditorState.create({
    schema: handleSchema,
    doc: handleSchema.node('doc', null, paragraph('composing text')),
  })
  instance.viewComposing = true
  instance.viewDispatch.mockClear()
  const initialState = instance.viewState
  const root = screen.getByLabelText('Markdown visual editor')
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      types: ['text/plain'],
      getData: (type: string) => type === 'text/plain'
        ? 'https://example.com/pasted'
        : '',
    },
  })

  root.dispatchEvent(event)

  expect(event.defaultPrevented).toBe(false)
  expect(instance.viewState).toBe(initialState)
  expect(instance.viewDispatch).not.toHaveBeenCalled()
})

it('reveals a valid history anchor with a scrolling TextSelection', async () => {
  const ref = createRef<VisualEditorHandle>()
  const doc = handleSchema.node('doc', null, paragraph('alpha omega'))
  const history: TranslationHistoryEditorPort = {
    recordsForDocument: vi.fn(() => [visualHistoryRecord('history-1', doc)]),
    onAnchorsChanged: vi.fn(),
    onOpenRecord: vi.fn(),
  }
  render(
    <VisualEditor
      ref={ref}
      markdown="alpha omega"
      documentKey="doc-a"
      translationHistory={history}
      onChange={vi.fn()}
    />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const instance = crepeMock.instances[0]!
  const plugin = instance.prosePlugins.find((candidate) => candidate.spec.key === visualTranslationHistoryPluginKey)!
  expect(plugin).toBeDefined()
  if (!plugin) return
  instance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 8),
    plugins: [plugin as never],
  })
  instance.viewDispatch.mockImplementation((transaction: Transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })

  expect(ref.current?.revealTranslationHistoryRecord?.('history-1')).toBe(true)
  expect(instance.viewState.selection).toEqual(TextSelection.create(doc, 1, 6))
  expect(instance.viewDispatch.mock.calls[0]?.[0].scrolledIntoView).toBe(true)
})

it('exposes an unexpected visual history operation error', async () => {
  const ref = createRef<VisualEditorHandle>()
  const doc = handleSchema.node('doc', null, paragraph('alpha omega'))
  const history: TranslationHistoryEditorPort = {
    recordsForDocument: vi.fn(() => [visualHistoryRecord('history-1', doc)]),
    onAnchorsChanged: vi.fn(),
    onOpenRecord: vi.fn(),
  }
  render(
    <VisualEditor
      ref={ref}
      markdown="alpha omega"
      documentKey="doc-a"
      translationHistory={history}
      onChange={vi.fn()}
    />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const instance = crepeMock.instances[0]!
  const plugin = instance.prosePlugins.find((candidate) => (
    candidate.spec.key === visualTranslationHistoryPluginKey
  ))!
  expect(plugin).toBeDefined()
  if (!plugin) return
  instance.viewState = EditorState.create({ doc, plugins: [plugin as never] })
  instance.viewDispatch.mockImplementation((transaction: Transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  const failure = new Error('visual history focus failed')
  instance.viewFocus.mockImplementationOnce(() => { throw failure })

  expect(() => ref.current?.revealTranslationHistoryRecord('history-1')).toThrow(failure)
})

it('does not change selection when a history anchor fingerprint mismatches', async () => {
  const ref = createRef<VisualEditorHandle>()
  const doc = handleSchema.node('doc', null, paragraph('alpha omega'))
  const historyRecord = visualHistoryRecord('history-mismatch', doc)
  historyRecord.anchor = {
    ...historyRecord.anchor,
    fingerprint: { ...historyRecord.anchor.fingerprint, selected: 'different' },
  }
  const history: TranslationHistoryEditorPort = {
    recordsForDocument: vi.fn(() => [historyRecord]),
    onAnchorsChanged: vi.fn(),
    onOpenRecord: vi.fn(),
  }
  render(
    <VisualEditor
      ref={ref}
      markdown="alpha omega"
      documentKey="doc-a"
      translationHistory={history}
      onChange={vi.fn()}
    />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const instance = crepeMock.instances[0]!
  const plugin = instance.prosePlugins.find((candidate) => candidate.spec.key === visualTranslationHistoryPluginKey)!
  expect(plugin).toBeDefined()
  if (!plugin) return
  instance.viewState = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 8),
    plugins: [plugin as never],
  })

  expect(ref.current?.revealTranslationHistoryRecord?.('history-mismatch')).toBe(false)
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(instance.viewState.selection).toEqual(TextSelection.create(doc, 8))
})

it('reinstalls explicitly keyed history decorations after a keyed remount', async () => {
  const firstDoc = handleSchema.node('doc', null, paragraph('alpha omega'))
  const secondDoc = handleSchema.node('doc', null, paragraph('bravo omega'))
  const first = visualHistoryRecord('history-a', firstDoc)
  const second = { ...visualHistoryRecord('history-b', secondDoc), documentKey: 'doc-b' }
  const history: TranslationHistoryEditorPort = {
    recordsForDocument: vi.fn((documentKey) => documentKey === 'doc-a' ? [first] : [second]),
    onAnchorsChanged: vi.fn(),
    onOpenRecord: vi.fn(),
  }
  const rendered = render(
    <VisualEditor
      key="doc-a"
      markdown="alpha omega"
      documentKey="doc-a"
      translationHistory={history}
      onChange={vi.fn()}
    />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const firstInstance = crepeMock.instances[0]!
  const firstPlugin = firstInstance.prosePlugins.find((candidate) => candidate.spec.key === visualTranslationHistoryPluginKey)!
  expect(firstPlugin).toBeDefined()
  if (!firstPlugin) return
  const firstState = EditorState.create({ doc: firstDoc, plugins: [firstPlugin as never] })

  rendered.rerender(
    <VisualEditor
      key="doc-b"
      markdown="bravo omega"
      documentKey="doc-b"
      translationHistory={history}
      onChange={vi.fn()}
    />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const secondInstance = crepeMock.instances[1]!
  const secondPlugin = secondInstance.prosePlugins.find((candidate) => candidate.spec.key === visualTranslationHistoryPluginKey)!
  expect(secondPlugin).toBeDefined()
  if (!secondPlugin) return
  const secondState = EditorState.create({ doc: secondDoc, plugins: [secondPlugin as never] })

  expect(history.recordsForDocument).toHaveBeenNthCalledWith(1, 'doc-a')
  expect(history.recordsForDocument).toHaveBeenNthCalledWith(2, 'doc-b')
  expect(visualTranslationHistoryPluginKey.getState(firstState)?.records.has('history-a')).toBe(true)
  expect(visualTranslationHistoryPluginKey.getState(secondState)?.records.has('history-b')).toBe(true)
  expect(visualTranslationHistoryPluginKey.getState(secondState)?.decorations.find()).toHaveLength(2)
})

it('hot-syncs same-key records and routes marker and mapping callbacks to the latest port', async () => {
  const doc = handleSchema.node('doc', null, paragraph('alpha omega'))
  const oldHistory: TranslationHistoryEditorPort = {
    recordsForDocument: vi.fn(() => []),
    onAnchorsChanged: vi.fn(),
    onOpenRecord: vi.fn(),
  }
  const nextRecord = visualHistoryRecord('history-hot', doc)
  const nextHistory: TranslationHistoryEditorPort = {
    recordsForDocument: vi.fn(() => [nextRecord]),
    onAnchorsChanged: vi.fn(),
    onOpenRecord: vi.fn(),
  }
  const rendered = render(
    <VisualEditor
      markdown="alpha omega"
      documentKey="doc-a"
      translationHistory={oldHistory}
      onChange={vi.fn()}
    />,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const instance = crepeMock.instances[0]!
  const plugin = instance.prosePlugins.find((candidate) => candidate.spec.key === visualTranslationHistoryPluginKey)
  expect(plugin).toBeDefined()
  if (!plugin) return
  instance.viewState = EditorState.create({ doc, plugins: [plugin as never] })
  instance.viewDispatch.mockImplementation((transaction: Transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })

  rendered.rerender(
    <VisualEditor
      markdown="alpha omega"
      documentKey="doc-a"
      translationHistory={nextHistory}
      onChange={vi.fn()}
    />,
  )

  expect(crepeMock.instances).toHaveLength(1)
  const hotState = visualTranslationHistoryPluginKey.getState(instance.viewState)
  expect(hotState?.records.has('history-hot')).toBe(true)
  expect(hotState?.decorations.find()).toHaveLength(2)

  const widget = hotState?.decorations.find().find((decoration) => decoration.from === decoration.to)
  const anchor = ((widget as unknown as { type: {
    toDOM(view: EditorView, getPos: () => number): Node
  } }).type).toDOM({} as EditorView, () => 1) as HTMLElement
  expect(anchor).toHaveAttribute('data-translation-history-anchor-id', 'history-hot')
  expect(anchor.querySelector('button')).toBeNull()
  expect(nextHistory.onOpenRecord).not.toHaveBeenCalled()
  expect(oldHistory.onOpenRecord).not.toHaveBeenCalled()

  const previousState = instance.viewState
  ;(instance.viewDispatch as unknown as (transaction: Transaction) => void)(
    instance.viewState.tr.insertText('new ', 1),
  )
  const currentView = {
    get state() { return instance.viewState! },
  } as EditorView
  const pluginView = plugin.spec.view?.(currentView)
  pluginView?.update?.(currentView, previousState)

  expect(nextHistory.onAnchorsChanged).toHaveBeenCalledWith('doc-a', [
    expect.objectContaining({ recordId: 'history-hot' }),
  ])
  expect(oldHistory.onAnchorsChanged).not.toHaveBeenCalled()
})

it.each([false, true])('ignores obsolete visual indicator input without changing editor state (initial=%s)', async (initial) => {
  const creation = deferred()
  crepeMock.createPlans.push(() => creation.promise)
  const onChange = vi.fn()
  // Runtime callers may still pass the removed prop while their UI updates.
  const legacyInput = { editIndicators: { expectedModelVersion: 1, payload: null } }
  const mounted = render(<VisualEditor documentKey="doc-a" markdown="alpha"
    onChange={onChange} {...(initial ? legacyInput : {})} />)
  const instance = crepeMock.instances[0]!
  const doc = handleSchema.node('doc', null, paragraph('alpha'))
  const originalState = EditorState.create({ doc, plugins: [history()],
    selection: TextSelection.create(doc, 3),
  })
  instance.viewState = originalState
  instance.viewDispatch.mockImplementation((transaction: Transaction) => {
    instance.viewState = instance.viewState!.apply(transaction)
  })
  await act(async () => { creation.resolve(undefined); await Promise.resolve() })

  expect(instance.prosePlugins.some(plugin => (
    (plugin.spec.key as { key?: string } | undefined)?.key?.startsWith('visual-edit-indicators')
  ))).toBe(false)
  mounted.rerender(<VisualEditor documentKey="doc-a" markdown="alpha"
    onChange={onChange} {...legacyInput} />)

  expect(instance.viewState).toBe(originalState)
  expect(instance.viewDispatch).not.toHaveBeenCalled()
  expect(instance.viewUpdateState).not.toHaveBeenCalled()
  expect(onChange).not.toHaveBeenCalled()
  expect(crepeMock.instances).toHaveLength(1)
})

it('keeps a real ProseMirror view and undo while rejecting acceptance-lock writes and AI', async () => {
  const creation = deferred()
  crepeMock.createPlans.push(() => creation.promise)
  const ref = createRef<VisualEditorHandle>()
  const onChange = vi.fn()
  let completeClipboard!: (text: string) => void
  const clipboard = new Promise<string>(resolve => { completeClipboard = resolve })
  const editor = (locked: boolean) => <VisualEditor ref={ref} documentKey="locked.md"
    markdown="Before" interactionLocked={locked} readClipboardImage={() => clipboard} onChange={onChange} />
  const mounted = render(editor(false))
  await waitFor(() => expect(crepeMock.instances[0]?.create).toHaveBeenCalled())
  const instance = crepeMock.instances[0]!
  const host = document.createElement('div')
  mounted.container.append(host)
  const lockPlugin = instance.prosePlugins.find(plugin => plugin.spec.filterTransaction) as Plugin
  expect(lockPlugin).toBeDefined()
  const view = new EditorView(host, { state: EditorState.create({
    doc: handleSchema.node('doc', null, paragraph('Before')), plugins: [history(), lockPlugin],
  }) })
  instance.viewOverride = view
  instance.serializer = vi.fn(node => node.textContent)
  instance.parser.mockImplementation(text => handleSchema.node('doc', null, paragraph(text)))
  await act(async () => { creation.resolve(undefined); await Promise.resolve() })
  onTestFinished(() => { mounted.unmount(); view.destroy() })
  act(() => {
    const transaction = view.state.tr.insertText(' edit', 7)
    view.dispatch(transaction.setSelection(TextSelection.create(transaction.doc, 2, 5)))
  })
  const selection = view.state.selection
  const depth = undoDepth(view.state)
  const port = ref.current!.createWorkspaceAiEditorPort!()
  const capture = await port.captureReadSnapshot({})
  if (capture.status !== 'captured') throw new Error('capture failed')
  const input = { operationId: 'locked-ai', expectedEditorRevision: capture.editorRevision,
    expectedContentHash: capture.contentHash, replacementMarkdown: 'AI text' }
  expect((await port.planReplacement(input)).status).toBe('planned')
  const pendingPaste = ref.current!.pasteClipboard!(true)
  mounted.rerender(editor(true))
  completeClipboard('Late paste')
  expect(await pendingPaste).toBe(false)
  expect(crepeMock.instances).toHaveLength(1)
  expect(instance.viewOverride).toBe(view)
  expect(view.editable).toBe(false)
  act(() => {
    const transaction = view.state.tr.insertText('Blocked', 1)
    view.dispatch(transaction.setSelection(TextSelection.create(transaction.doc, 1)))
  })
  expect((await port.applyTransaction(input)).status).not.toBe('applied')
  expect(ref.current!.insertDroppedMarkdown!({ markdown: 'Blocked tool', clientX: 1, clientY: 1 })).toBe(false)
  expect(view.state.doc.textContent).toBe('Before edit')
  expect(view.state.selection.eq(selection)).toBe(true)
  expect(undoDepth(view.state)).toBe(depth)
  mounted.rerender(editor(false))
  expect(view.editable).toBe(true)
  expect(instance.viewOverride).toBe(view)
  act(() => { expect(undo(view.state, view.dispatch)).toBe(true) })
  expect(view.state.doc.textContent).toBe('Before')
})
