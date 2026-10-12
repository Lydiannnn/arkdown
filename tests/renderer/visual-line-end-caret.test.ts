import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createVisualLineEndCaretPlugin,
  resolveRenderedLineEndPosition,
  type CharacterRectMeasurer,
  type ElementFragmentMeasurer,
  type TextFragmentMeasurer,
} from '../../src/renderer/editor/visual-line-end-caret'

interface RectInput {
  left: number
  right: number
  top: number
  bottom: number
}

function rect(input: RectInput): DOMRect {
  return {
    ...input,
    x: input.left,
    y: input.top,
    width: input.right - input.left,
    height: input.bottom - input.top,
    toJSON: () => input,
  }
}

function fixture(markup: string) {
  const root = document.createElement('div')
  root.className = 'ProseMirror'
  root.innerHTML = markup
  document.body.append(root)
  return root
}

function measurer(entries: Array<[Text, DOMRect[]]>): CharacterRectMeasurer {
  const mapping = new Map(entries)
  return (text, index) => mapping.get(text)?.[index] ?? null
}

function fragmentMeasurer(entries: Array<[Text, DOMRect[]]>): TextFragmentMeasurer {
  const mapping = new Map(entries)
  return (text) => mapping.get(text) ?? []
}

function elementMeasurer(entries: Array<[Element, DOMRect[]]>): ElementFragmentMeasurer {
  const mapping = new Map(entries)
  return (element) => mapping.get(element) ?? []
}

describe('rendered line-end caret resolution', () => {
  it('keeps a click at the end of a wrapped visual row on that row', () => {
    const root = fixture('<p>甲乙丙丁</p>')
    const paragraph = root.querySelector('p')!
    const text = paragraph.firstChild as Text
    const posAtDOM = vi.fn((_node: Node, offset: number) => offset + 1)

    const position = resolveRenderedLineEndPosition({
      root,
      target: paragraph,
      clientX: 180,
      clientY: 18,
      posAtDOM,
      measureCharacter: measurer([[
        text,
        [
          rect({ left: 20, right: 40, top: 10, bottom: 30 }),
          rect({ left: 40, right: 60, top: 10, bottom: 30 }),
          rect({ left: 20, right: 40, top: 36, bottom: 56 }),
          rect({ left: 40, right: 60, top: 36, bottom: 56 }),
        ],
      ]]),
    })

    expect(position).toBe(3)
    expect(posAtDOM).toHaveBeenCalledWith(text, 2, 1)
  })

  it('uses the end of the second rendered row when that row was clicked', () => {
    const root = fixture('<p>甲乙丙丁</p>')
    const paragraph = root.querySelector('p')!
    const text = paragraph.firstChild as Text

    expect(resolveRenderedLineEndPosition({
      root,
      target: paragraph,
      clientX: 180,
      clientY: 44,
      posAtDOM: (_node, offset) => offset + 1,
      measureCharacter: measurer([[
        text,
        [
          rect({ left: 20, right: 40, top: 10, bottom: 30 }),
          rect({ left: 40, right: 60, top: 10, bottom: 30 }),
          rect({ left: 20, right: 40, top: 36, bottom: 56 }),
          rect({ left: 40, right: 60, top: 36, bottom: 56 }),
        ],
      ]]),
    })).toBe(5)
  })

  it('stops before a hard-break placeholder instead of jumping to the next row', () => {
    const root = fixture(
      '<p>甲乙<span data-type="hardbreak" data-is-inline="true"></span>丙丁</p>',
    )
    const paragraph = root.querySelector('p')!
    const [first, second] = Array.from(paragraph.childNodes)
      .filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
    const posAtDOM = vi.fn((node: Node, offset: number) => (
      node === first ? offset + 1 : offset + 4
    ))

    expect(resolveRenderedLineEndPosition({
      root,
      target: paragraph,
      clientX: 180,
      clientY: 18,
      posAtDOM,
      measureCharacter: measurer([
        [first, [
          rect({ left: 20, right: 40, top: 10, bottom: 30 }),
          rect({ left: 40, right: 60, top: 10, bottom: 30 }),
        ]],
        [second, [
          rect({ left: 20, right: 40, top: 36, bottom: 56 }),
          rect({ left: 40, right: 60, top: 36, bottom: 56 }),
        ]],
      ]),
    })).toBe(3)
    expect(posAtDOM).toHaveBeenCalledWith(first, 2, 1)
  })

  it('resolves adjacent block rows against the block that received the click', () => {
    const root = fixture('<p>第一行</p><p>第二行</p>')
    const [firstParagraph, secondParagraph] = Array.from(root.querySelectorAll('p'))
    const first = firstParagraph.firstChild as Text
    const second = secondParagraph.firstChild as Text

    expect(resolveRenderedLineEndPosition({
      root,
      target: firstParagraph,
      clientX: 220,
      clientY: 20,
      posAtDOM: (node, offset) => node === first ? offset + 1 : offset + 10,
      measureCharacter: measurer([
        [first, [
          rect({ left: 20, right: 40, top: 10, bottom: 30 }),
          rect({ left: 40, right: 60, top: 10, bottom: 30 }),
          rect({ left: 60, right: 80, top: 10, bottom: 30 }),
        ]],
        [second, [
          rect({ left: 20, right: 40, top: 34, bottom: 54 }),
          rect({ left: 40, right: 60, top: 34, bottom: 54 }),
          rect({ left: 60, right: 80, top: 34, bottom: 54 }),
        ]],
      ]),
    })).toBe(4)
  })

  it('leaves ordinary clicks inside the rendered text to the browser', () => {
    const root = fixture('<p>甲乙</p>')
    const paragraph = root.querySelector('p')!
    const text = paragraph.firstChild as Text

    expect(resolveRenderedLineEndPosition({
      root,
      target: paragraph,
      clientX: 35,
      clientY: 18,
      posAtDOM: (_node, offset) => offset + 1,
      measureCharacter: measurer([[
        text,
        [
          rect({ left: 20, right: 40, top: 10, bottom: 30 }),
          rect({ left: 40, right: 60, top: 10, bottom: 30 }),
        ],
      ]]),
    })).toBeNull()
  })

  it('rejects a click outside the target block before measuring its text', () => {
    const root = fixture('<p>不会被测量</p>')
    const paragraph = root.querySelector('p')!
    Object.defineProperty(paragraph, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect({ left: 10, right: 220, top: 10, bottom: 30 }),
    })
    const measureCharacter = vi.fn<CharacterRectMeasurer>(() => (
      rect({ left: 20, right: 40, top: 90, bottom: 110 })
    ))

    expect(resolveRenderedLineEndPosition({
      root,
      target: paragraph,
      clientX: 200,
      clientY: 100,
      posAtDOM: () => 1,
      measureCharacter,
    })).toBeNull()
    expect(measureCharacter).not.toHaveBeenCalled()
  })

  it('does not fall back to scanning the whole editor when no line block was targeted', () => {
    const root = fixture('<p>旁边的段落</p>')
    const text = root.querySelector('p')!.firstChild as Text
    const measureCharacter = vi.fn(measurer([[
      text,
      Array.from(text.data, (_, index) => rect({
        left: 20 + index * 10,
        right: 30 + index * 10,
        top: 10,
        bottom: 30,
      })),
    ]]))

    expect(resolveRenderedLineEndPosition({
      root,
      target: root,
      clientX: 240,
      clientY: 18,
      posAtDOM: () => 1,
      measureCharacter,
    })).toBeNull()
    expect(measureCharacter).not.toHaveBeenCalled()
  })

  it('leaves links and other interactive inline controls to their native handlers', () => {
    const root = fixture('<p><span>普通文字</span><a href="https://example.com">链接</a></p>')
    const paragraph = root.querySelector('p')!
    const safeText = paragraph.querySelector('span')!.firstChild as Text
    const measureCharacter = vi.fn(measurer([[
      safeText,
      Array.from(safeText.data, (_, index) => rect({
        left: 20 + index * 12,
        right: 32 + index * 12,
        top: 10,
        bottom: 30,
      })),
    ]]))

    expect(resolveRenderedLineEndPosition({
      root,
      target: paragraph.querySelector('a'),
      clientX: 240,
      clientY: 18,
      posAtDOM: () => 1,
      measureCharacter,
    })).toBeNull()
    expect(measureCharacter).not.toHaveBeenCalled()
  })

  it('uses row fragments and logarithmic character probes for a very long wrapped paragraph', () => {
    const root = fixture(`<p>${'甲'.repeat(8_192)}</p>`)
    const paragraph = root.querySelector('p')!
    const text = paragraph.firstChild as Text
    const measureCharacter = vi.fn<CharacterRectMeasurer>((_text, index) => (
      index < 4_096
        ? rect({ left: 20, right: index === 4_095 ? 180 : 40, top: 10, bottom: 30 })
        : rect({ left: 20, right: 180, top: 36, bottom: 56 })
    ))

    expect(resolveRenderedLineEndPosition({
      root,
      target: paragraph,
      clientX: 220,
      clientY: 18,
      posAtDOM: (_node, offset) => offset,
      measureCharacter,
      measureTextFragments: fragmentMeasurer([[
        text,
        [
          rect({ left: 20, right: 180, top: 10, bottom: 30 }),
          rect({ left: 20, right: 180, top: 36, bottom: 56 }),
        ],
      ]]),
    })).toBe(4_096)
    expect(measureCharacter.mock.calls.length).toBeLessThanOrEqual(32)
  })

  it.each([
    ['inline formula', '<span contenteditable="false" data-type="math_inline">x²</span>'],
    ['inline image', '<img contenteditable="false" alt="diagram">'],
  ])('places the row end after an %s atom', (_label, atomMarkup) => {
    const root = fixture(`<p>甲${atomMarkup}</p>`)
    const paragraph = root.querySelector('p')!
    const text = paragraph.firstChild as Text
    const atom = paragraph.children[0]
    const posAtDOM = vi.fn((node: Node, offset: number) => (
      node === paragraph ? 100 + offset : offset
    ))

    expect(resolveRenderedLineEndPosition({
      root,
      target: paragraph,
      clientX: 220,
      clientY: 18,
      posAtDOM,
      measureCharacter: measurer([[
        text,
        [rect({ left: 20, right: 40, top: 10, bottom: 30 })],
      ]]),
      measureTextFragments: fragmentMeasurer([[
        text,
        [rect({ left: 20, right: 40, top: 10, bottom: 30 })],
      ]]),
      measureElementFragments: elementMeasurer([[
        atom,
        [rect({ left: 40, right: 84, top: 10, bottom: 30 })],
      ]]),
    })).toBe(102)
    expect(posAtDOM).toHaveBeenCalledWith(paragraph, 2, 1)
  })

  it('resolves the only caret position in an empty paragraph', () => {
    const root = fixture('<p><br class="ProseMirror-trailingBreak"></p>')
    const paragraph = root.querySelector('p')!
    const trailingBreak = paragraph.querySelector('br')!
    Object.defineProperty(paragraph, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect({ left: 20, right: 260, top: 10, bottom: 36 }),
    })
    const posAtDOM = vi.fn(() => 1)

    expect(resolveRenderedLineEndPosition({
      root,
      target: paragraph,
      clientX: 240,
      clientY: 22,
      posAtDOM,
      measureElementFragments: elementMeasurer([[
        trailingBreak,
        [rect({ left: 20, right: 20, top: 10, bottom: 36 })],
      ]]),
    })).toBe(1)
    expect(posAtDOM).toHaveBeenCalledWith(paragraph, 0, 1)
  })

  it('resolves the empty visual row between consecutive hard breaks', () => {
    const root = fixture('<p>甲<br><br>乙</p>')
    const paragraph = root.querySelector('p')!
    const [firstText, secondText] = Array.from(paragraph.childNodes)
      .filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
    const [firstBreak, secondBreak] = Array.from(paragraph.querySelectorAll('br'))
    const posAtDOM = vi.fn((node: Node, offset: number) => (
      node === paragraph ? 100 + offset : node === firstText ? offset + 1 : offset + 5
    ))

    expect(resolveRenderedLineEndPosition({
      root,
      target: paragraph,
      clientX: 220,
      clientY: 44,
      posAtDOM,
      measureCharacter: measurer([
        [firstText, [rect({ left: 20, right: 40, top: 10, bottom: 30 })]],
        [secondText, [rect({ left: 20, right: 40, top: 62, bottom: 82 })]],
      ]),
      measureTextFragments: fragmentMeasurer([
        [firstText, [rect({ left: 20, right: 40, top: 10, bottom: 30 })]],
        [secondText, [rect({ left: 20, right: 40, top: 62, bottom: 82 })]],
      ]),
      measureElementFragments: elementMeasurer([
        [firstBreak, [rect({ left: 40, right: 40, top: 10, bottom: 30 })]],
        [secondBreak, [rect({ left: 20, right: 20, top: 36, bottom: 56 })]],
      ]),
    })).toBe(102)
    expect(posAtDOM).toHaveBeenCalledWith(paragraph, 2, 1)
  })
})

const pluginSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
})

let mountedView: EditorView | null = null

afterEach(() => {
  mountedView?.destroy()
  mountedView = null
  document.body.replaceChildren()
})

function mountGestureEditor(resolvePosition: () => number | null) {
  const host = document.body.appendChild(document.createElement('div'))
  const plugin = createVisualLineEndCaretPlugin({ resolvePosition })
  let state = EditorState.create({
    schema: pluginSchema,
    doc: pluginSchema.node('doc', null, [
      pluginSchema.node('paragraph', null, pluginSchema.text('abcd')),
    ]),
    plugins: [plugin],
  })
  mountedView = new EditorView(host, {
    state,
    dispatchTransaction(transaction) {
      state = state.apply(transaction)
      mountedView!.updateState(state)
    },
  })
  mountedView.dom.querySelector('p')!.replaceChildren()
  return { plugin, view: mountedView }
}

function invokeMouse(
  plugin: ReturnType<typeof createVisualLineEndCaretPlugin>,
  view: EditorView,
  target: Element,
  type: string,
  clientX: number,
  clientY: number,
  detail = 1,
): void {
  const handler = plugin.props.handleDOMEvents?.[type]
  if (!handler) return
  const invoke = (event: Event) => handler.call(plugin, view, event)
  target.addEventListener(type, invoke, { once: true })
  target.dispatchEvent(new MouseEvent(type, {
    bubbles: false,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
    detail,
  }))
}

describe('rendered line-end click gesture', () => {
  it('applies a resolved position for a stationary primary click', () => {
    const resolvePosition = vi.fn(() => 3)
    const { plugin, view } = mountGestureEditor(resolvePosition)
    const paragraph = view.dom.querySelector('p')!

    invokeMouse(plugin, view, paragraph, 'mousedown', 100, 20)
    invokeMouse(plugin, view, paragraph, 'mouseup', 100, 20)

    expect(resolvePosition).toHaveBeenCalledOnce()
    expect(view.state.selection.from).toBe(3)
  })

  it('does not collapse a real selection after a short drag', () => {
    const resolvePosition = vi.fn(() => 4)
    const { plugin, view } = mountGestureEditor(resolvePosition)
    const paragraph = view.dom.querySelector('p')!

    invokeMouse(plugin, view, paragraph, 'mousedown', 100, 20)
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)))
    invokeMouse(plugin, view, paragraph, 'mousemove', 106, 20)
    invokeMouse(plugin, view, paragraph, 'mouseup', 106, 20)

    expect(resolvePosition).not.toHaveBeenCalled()
    expect(view.state.selection).toMatchObject({ from: 1, to: 3 })
  })

  it('uses maximum movement so dragging away and returning cannot become a click', () => {
    const resolvePosition = vi.fn(() => 4)
    const { plugin, view } = mountGestureEditor(resolvePosition)
    const paragraph = view.dom.querySelector('p')!

    invokeMouse(plugin, view, paragraph, 'mousedown', 100, 20)
    invokeMouse(plugin, view, paragraph, 'mousemove', 180, 70)
    invokeMouse(plugin, view, paragraph, 'mousemove', 101, 20)
    invokeMouse(plugin, view, paragraph, 'mouseup', 101, 20)

    expect(resolvePosition).not.toHaveBeenCalled()
  })

  it.each([
    ['interactive link', 'link'],
    ['double click', 'double'],
    ['active composition', 'composition'],
  ])('skips an %s gesture', (_label, kind) => {
    const resolvePosition = vi.fn(() => 3)
    const { plugin, view } = mountGestureEditor(resolvePosition)
    const paragraph = view.dom.querySelector('p')!
    const target = kind === 'link'
      ? paragraph.appendChild(document.createElement('a'))
      : paragraph
    if (kind === 'link') target.setAttribute('href', 'https://example.com')
    if (kind === 'composition') {
      Object.defineProperty(view, 'composing', { configurable: true, value: true })
    }
    const detail = kind === 'double' ? 2 : 1

    invokeMouse(plugin, view, target, 'mousedown', 100, 20, detail)
    invokeMouse(plugin, view, target, 'mouseup', 100, 20, detail)

    expect(resolvePosition).not.toHaveBeenCalled()
  })
})
