import { Fragment, Schema, Slice, type Mark, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { EditorState, Plugin, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { describe, expect, it, vi } from 'vitest'
import {
  buildVisualDropTransaction,
  createVisualDropInsertionPlugin,
  resolveVisualDropTarget,
  visualDropRequestIdForEvent,
  type VisualDropTargetHandle,
  type VisualDropTarget,
} from '../../src/renderer/editor/visual-drop-insertion'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    blockquote: { content: 'block+', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*' },
    code_block: { content: 'text*', group: 'block', code: true, marks: '' },
    text: { group: 'inline' },
  },
  marks: {
    strong: {},
    link: { attrs: { href: {} } },
  },
})

function paragraph(text: string, marks: readonly Mark[] = []): ProseMirrorNode {
  return schema.node('paragraph', null, text ? schema.text(text, marks) : undefined)
}

function stateWithText(text: string, from?: number, to?: number): EditorState {
  const doc = schema.node('doc', null, paragraph(text))
  return EditorState.create({
    doc,
    selection: from === undefined
      ? undefined
      : TextSelection.create(doc, from, to ?? from),
  })
}

function inlineSlice(text: string, marks: readonly Mark[] = []): Slice {
  return new Slice(Fragment.from(schema.text(text, marks)), 0, 0)
}

function paragraphBoundarySlice(text: string): Slice {
  return new Slice(Fragment.from(paragraph(text)), 1, 0)
}

function target(pos: number): VisualDropTarget {
  return { pos, left: 10, top: 20, height: 18 }
}

function apply(transaction: Transaction | null): EditorState {
  expect(transaction).not.toBeNull()
  return { doc: transaction!.doc } as EditorState
}

function paragraphTexts(doc: ProseMirrorNode): string[] {
  const texts: string[] = []
  doc.forEach((node) => texts.push(node.textContent))
  return texts
}

describe('visual drop target geometry', () => {
  it('clamps the located position and measures a vertical text-line target', () => {
    const state = stateWithText('甲乙丙丁')
    const view = {
      state,
      posAtCoords: vi.fn(() => ({ pos: 99, inside: -1 })),
      coordsAtPos: vi.fn(() => ({ left: 42, right: 42, top: 70, bottom: 88 })),
    } as unknown as EditorView

    expect(resolveVisualDropTarget(view, 120, 240)).toEqual({
      pos: state.doc.content.size,
      left: 42,
      top: 70,
      height: 18,
    })
    expect(view.posAtCoords).toHaveBeenCalledWith({ left: 120, top: 240 })
    expect(view.coordsAtPos).toHaveBeenCalledWith(state.doc.content.size)
  })

  it('returns null when pointer coordinates cannot resolve a connected document position', () => {
    const view = {
      state: stateWithText('alpha'),
      posAtCoords: vi.fn(() => null),
      coordsAtPos: vi.fn(),
    } as unknown as EditorView

    expect(resolveVisualDropTarget(view, 1, 2)).toBeNull()
    expect(view.coordsAtPos).not.toHaveBeenCalled()
  })
})

describe('original ProseMirror slice insertion', () => {
  it('joins inline content literally at the exact target character', () => {
    const result = apply(buildVisualDropTransaction(
      stateWithText('甲乙丙丁'),
      target(3),
      inlineSlice('插入的内容'),
      { move: false },
    ))

    expect(result.doc.textContent).toBe('甲乙插入的内容丙丁')
  })

  it('preserves a carried paragraph boundary without forcing a blank paragraph', () => {
    const result = apply(buildVisualDropTransaction(
      stateWithText('甲乙丙丁'),
      target(3),
      paragraphBoundarySlice('新段落'),
      { move: false },
    ))

    expect(paragraphTexts(result.doc)).toEqual(['甲乙新段落', '丙丁'])
  })

  it('keeps marks on inserted inline content', () => {
    const link = schema.mark('link', { href: 'https://example.com' })
    const strong = schema.mark('strong')
    const result = apply(buildVisualDropTransaction(
      stateWithText('甲乙丙丁'),
      target(3),
      inlineSlice('链接', [link, strong]),
      { move: false },
    ))
    const inserted = result.doc.nodeAt(3)

    expect(inserted?.textContent).toBe('链接')
    expect(inserted?.marks.find((mark) => mark.type === schema.marks.link)?.attrs.href)
      .toBe('https://example.com')
    expect(inserted?.marks.some((mark) => mark.type === schema.marks.strong)).toBe(true)
  })

  it.each([
    ['list', schema.node('bullet_list', null, schema.node('list_item', null, paragraph('列表项')))],
    ['quote', schema.node('blockquote', null, paragraph('引用'))],
    ['code block', schema.node('code_block', null, schema.text('const value = 1'))],
  ])('preserves a complete %s node', (_label, draggedNode) => {
    const state = stateWithText('正文')
    const result = apply(buildVisualDropTransaction(
      state,
      target(state.doc.content.size),
      new Slice(Fragment.from(draggedNode), 0, 0),
      { move: false },
    ))

    expect(result.doc.lastChild?.toJSON()).toEqual(draggedNode.toJSON())
  })

  it('preserves all paragraphs in a multi-paragraph slice', () => {
    const state = stateWithText('正文')
    const slice = new Slice(Fragment.fromArray([
      paragraph('第一段'),
      paragraph('第二段'),
    ]), 0, 0)
    const result = apply(buildVisualDropTransaction(
      state,
      target(state.doc.content.size),
      slice,
      { move: false },
    ))

    expect(paragraphTexts(result.doc)).toEqual(['正文', '第一段', '第二段'])
  })

  it('moves by deleting the source once and mapping the target after that deletion', () => {
    const state = stateWithText('source target', 1, 7)
    const transaction = buildVisualDropTransaction(
      state,
      target(14),
      state.selection.content(),
      { move: true },
    )
    const result = apply(transaction)
    const deletionSteps = transaction!.steps.filter((step) => {
      const json = step.toJSON() as { from?: number; to?: number; slice?: { content?: unknown[] } }
      return json.from === 1 && json.to === 7 && (json.slice?.content?.length ?? 0) === 0
    })

    expect(result.doc.textContent).toBe(' targetsource')
    expect(deletionSteps).toHaveLength(1)
    expect(transaction?.getMeta('uiEvent')).toBe('drop')
  })

  it('copies without deleting the source', () => {
    const state = stateWithText('source target', 1, 7)
    const transaction = buildVisualDropTransaction(
      state,
      target(14),
      state.selection.content(),
      { move: false },
    )

    expect(apply(transaction).doc.textContent).toBe('source targetsource')
    expect(transaction?.steps).toHaveLength(1)
  })

  it.each([1, 4, 7])('rejects a moved self-drop at source-range position %i', (position) => {
    const state = stateWithText('source target', 1, 7)

    expect(buildVisualDropTransaction(
      state,
      target(position),
      state.selection.content(),
      { move: true },
    )).toBeNull()
  })
})

describe('drop caret lifecycle', () => {
  it('keeps the resolved target through Chromium\'s document-capture microtask checkpoint', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const externalDropTarget: VisualDropTargetHandle = { request: { status: 'idle' } }
    const state = EditorState.create({ doc: stateWithText('alpha').doc })
    const view = new EditorView(host, { state })
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 3, inside: -1 })
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({
      left: 20,
      right: 20,
      top: 10,
      bottom: 28,
    })
    const plugin = createVisualDropInsertionPlugin({ externalDropTarget })
    const pluginView = plugin.spec.view?.(view)
    const dragover = new MouseEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 40,
    }) as DragEvent
    plugin.spec.props?.handleDOMEvents?.dragover?.call(plugin, view, dragover)
    expect(document.body.querySelector('.arkdown-visual-drop-caret')).not.toBeNull()

    // Chromium performs a microtask checkpoint after the document capture listener,
    // before ProseMirror receives the same native drop event.
    document.dispatchEvent(new Event('drop', { bubbles: true }))
    await Promise.resolve()
    expect(document.body.querySelector('.arkdown-visual-drop-caret')).toBeNull()

    const drop = new MouseEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 40,
    }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', {
      value: { files: [new File(['notes'], 'notes.txt')], types: ['Files'] },
    })
    expect(plugin.spec.props?.handleDOMEvents?.drop?.call(plugin, view, drop)).toBe(true)
    expect(externalDropTarget.request).toEqual({
      status: 'pending',
      requestId: expect.any(Number),
      target: { pos: 3, left: 20, top: 10, height: 18 },
    })

    pluginView?.destroy?.()
    view.destroy()
    host.remove()
  })

  it('clears an unresolved target after a document drop is not handled by the editor', async () => {
    vi.useFakeTimers()
    const host = document.createElement('div')
    document.body.append(host)
    const externalDropTarget: VisualDropTargetHandle = { request: { status: 'idle' } }
    const state = EditorState.create({ doc: stateWithText('alpha').doc })
    const view = new EditorView(host, { state })
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 3, inside: -1 })
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({
      left: 20,
      right: 20,
      top: 10,
      bottom: 28,
    })
    const plugin = createVisualDropInsertionPlugin({ externalDropTarget })
    const pluginView = plugin.spec.view?.(view)

    try {
      const dragover = new MouseEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 40,
      }) as DragEvent
      plugin.spec.props?.handleDOMEvents?.dragover?.call(plugin, view, dragover)
      expect(externalDropTarget.request).toEqual({ status: 'dragging' })

      document.dispatchEvent(new Event('drop', { bubbles: true }))
      await Promise.resolve()
      expect(document.body.querySelector('.arkdown-visual-drop-caret')).toBeNull()

      await vi.runAllTimersAsync()
      expect(externalDropTarget.request).toEqual({ status: 'idle' })
    } finally {
      pluginView?.destroy?.()
      view.destroy()
      host.remove()
      vi.useRealTimers()
    }
  })

  it('captures an external file drop before an earlier upload handler can consume it', () => {
    const parent = document.createElement('div')
    const host = document.createElement('div')
    parent.append(host)
    document.body.append(parent)
    const externalDropTarget: VisualDropTargetHandle = { request: { status: 'idle' } }
    const competingHandleDrop = vi.fn(() => true)
    const state = EditorState.create({
      doc: stateWithText('alpha').doc,
      plugins: [
        new Plugin({ props: { handleDrop: competingHandleDrop } }),
        createVisualDropInsertionPlugin({ externalDropTarget }),
      ],
    })
    const view = new EditorView(host, { state })
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: 3, inside: -1 })
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({
      left: 20,
      right: 20,
      top: 10,
      bottom: 28,
    })
    const dataTransfer = {
      files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })],
      getData: vi.fn(() => ''),
      types: ['Files'],
    }
    const dragover = new MouseEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 40,
    }) as DragEvent
    Object.defineProperty(dragover, 'dataTransfer', { value: dataTransfer })
    view.dom.dispatchEvent(dragover)
    expect(document.body.querySelector('.arkdown-visual-drop-caret')).not.toBeNull()

    let bubbledRequestId: number | undefined
    parent.addEventListener('drop', (event) => {
      bubbledRequestId = visualDropRequestIdForEvent(event)
    })
    const drop = new MouseEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 40,
    }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
    view.dom.dispatchEvent(drop)

    expect(competingHandleDrop).not.toHaveBeenCalled()
    expect(bubbledRequestId).not.toBeUndefined()
    expect(visualDropRequestIdForEvent(drop)).toBe(bubbledRequestId)
    expect(externalDropTarget.request).toEqual({
      status: 'pending',
      requestId: bubbledRequestId,
      target: { pos: 3, left: 20, top: 10, height: 18 },
    })
    expect(drop.defaultPrevented).toBe(true)
    expect(document.body.querySelector('.arkdown-visual-drop-caret')).toBeNull()

    view.destroy()
    parent.remove()
  })

  it('uses the same resolved target for the caret and internal drop transaction', () => {
    const state = stateWithText('甲乙丙丁', 1, 3)
    let currentState = state
    const parent = document.createElement('div')
    const dom = document.createElement('div')
    dom.style.color = 'rgb(51, 51, 51)'
    parent.append(dom)
    document.body.append(parent)
    const draggedSlice = state.selection.content()
    const dispatch = vi.fn((transaction: Transaction) => {
      currentState = currentState.apply(transaction)
    })
    const view = {
      get state() { return currentState },
      dom,
      dragging: { slice: draggedSlice, move: true },
      editable: true,
      posAtCoords: vi.fn(() => ({ pos: 4, inside: -1 })),
      coordsAtPos: vi.fn(() => ({ left: 64, right: 64, top: 32, bottom: 50 })),
      dispatch,
      focus: vi.fn(),
    } as unknown as EditorView
    const plugin = createVisualDropInsertionPlugin()
    const pluginView = plugin.spec.view?.(view)
    const dragover = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dragover, { clientX: { value: 20 }, clientY: { value: 40 } })

    plugin.spec.props?.handleDOMEvents?.dragover?.call(plugin, view, dragover)
    const caret = document.body.querySelector<HTMLElement>('.arkdown-visual-drop-caret')
    expect(caret?.parentElement).toBe(document.body)
    expect(caret?.dataset.dropPos).toBe('4')
    expect(caret?.style.left).toBe('64px')
    expect(caret?.style.top).toBe('32px')
    expect(caret?.style.height).toBe('18px')
    expect(caret?.style.color).toBe('rgb(51, 51, 51)')

    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    const handled = plugin.spec.props?.handleDrop?.call(plugin, view, drop, Slice.empty, true)

    expect(handled).toBe(true)
    expect(currentState.doc.textContent).toBe('丙甲乙丁')
    expect(document.body.querySelector('.arkdown-visual-drop-caret')).toBeNull()
    pluginView?.destroy?.()
    parent.remove()
  })

  it('lets external files continue bubbling and clears every termination path', () => {
    const state = stateWithText('alpha')
    const parent = document.createElement('div')
    const dom = document.createElement('div')
    parent.append(dom)
    document.body.append(parent)
    const view = {
      state,
      dom,
      dragging: null,
      editable: true,
      posAtCoords: vi.fn(() => ({ pos: 3, inside: -1 })),
      coordsAtPos: vi.fn(() => ({ left: 20, right: 20, top: 10, bottom: 28 })),
    } as unknown as EditorView
    const plugin = createVisualDropInsertionPlugin()
    const pluginView = plugin.spec.view?.(view)
    const dragover = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperties(dragover, { clientX: { value: 20 }, clientY: { value: 40 } })
    plugin.spec.props?.handleDOMEvents?.dragover?.call(plugin, view, dragover)
    expect(document.body.querySelector('.arkdown-visual-drop-caret')).not.toBeNull()

    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ name: 'notes.md' }] } })
    expect(plugin.spec.props?.handleDrop?.call(plugin, view, drop, Slice.empty, false)).toBe(false)
    expect(drop.defaultPrevented).toBe(false)
    expect(document.body.querySelector('.arkdown-visual-drop-caret')).toBeNull()

    plugin.spec.props?.handleDOMEvents?.dragover?.call(plugin, view, dragover)
    plugin.spec.props?.handleDOMEvents?.dragend?.call(plugin, view, new Event('dragend') as DragEvent)
    expect(document.body.querySelector('.arkdown-visual-drop-caret')).toBeNull()

    plugin.spec.props?.handleDOMEvents?.dragover?.call(plugin, view, dragover)
    plugin.spec.props?.handleKeyDown?.call(plugin, view, new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.body.querySelector('.arkdown-visual-drop-caret')).toBeNull()

    plugin.spec.props?.handleDOMEvents?.dragover?.call(plugin, view, dragover)
    pluginView?.destroy?.()
    expect(document.body.querySelector('.arkdown-visual-drop-caret')).toBeNull()
    parent.remove()
  })

  it('rejects an internal drop when no valid visual target was resolved', () => {
    const state = stateWithText('甲乙丙丁', 1, 3)
    const parent = document.createElement('div')
    const dom = document.createElement('div')
    parent.append(dom)
    document.body.append(parent)
    const dispatch = vi.fn()
    const view = {
      state,
      dom,
      dragging: { slice: state.selection.content(), move: true },
      editable: true,
      posAtCoords: vi.fn(() => null),
      coordsAtPos: vi.fn(),
      dispatch,
      focus: vi.fn(),
    } as unknown as EditorView
    const plugin = createVisualDropInsertionPlugin()
    const pluginView = plugin.spec.view?.(view)
    const drop = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent

    expect(plugin.spec.props?.handleDrop?.call(plugin, view, drop, Slice.empty, true)).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
    pluginView?.destroy?.()
    parent.remove()
  })
})
