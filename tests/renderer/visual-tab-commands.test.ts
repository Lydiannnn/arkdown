import { Schema, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { tableNodes } from '@milkdown/kit/prose/tables'
import { describe, expect, it, vi } from 'vitest'
import {
  createVisualTabPlugin,
  runVisualTabCommand,
  type VisualTabDirection,
} from '../../src/renderer/editor/visual-tab-commands'

const tables = tableNodes({ tableGroup: 'block', cellContent: 'block+', cellAttributes: {} })
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    heading: {
      attrs: { level: { default: 1 } },
      content: 'text*',
      group: 'block',
    },
    code_block: { content: 'text*', group: 'block', code: true },
    ordered_list: {
      attrs: { order: { default: 1 } },
      content: 'list_item+',
      group: 'block',
    },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: {
      attrs: {
        checked: { default: null },
        listType: { default: 'bullet' },
      },
      content: 'paragraph block*',
      defining: true,
    },
    table: { ...tables.table, content: 'table_row+' },
    table_row: tables.table_row,
    table_cell: { ...tables.table_cell, content: 'block+' },
    table_header: { ...tables.table_header, content: 'block+' },
    text: { group: 'inline' },
  },
  marks: {
    strong: {},
    link: { attrs: { href: {} } },
    inline_code: { code: true },
  },
})

function textBlock(type: 'paragraph' | 'code_block', text: string): ProseMirrorNode {
  return schema.node(type, null, text ? schema.text(text) : undefined)
}

function paragraph(text: string): ProseMirrorNode {
  return textBlock('paragraph', text)
}

function heading(level: number, text: string): ProseMirrorNode {
  return schema.node('heading', { level }, schema.text(text))
}

function listItem(text: string, options: { checked?: boolean | null; nested?: ProseMirrorNode } = {}): ProseMirrorNode {
  return schema.node('list_item', {
    checked: options.checked ?? null,
    listType: options.checked === undefined ? 'bullet' : 'bullet',
  }, [paragraph(text), ...(options.nested ? [options.nested] : [])])
}

function list(type: 'bullet_list' | 'ordered_list', items: readonly ProseMirrorNode[]): ProseMirrorNode {
  return schema.node(type, type === 'ordered_list' ? { order: 1 } : null, items)
}

function table(text: string): ProseMirrorNode {
  const cell = schema.node('table_cell', null, paragraph(text))
  return schema.node('table', null, schema.node('table_row', null, cell))
}

function document(...blocks: readonly ProseMirrorNode[]): ProseMirrorNode {
  return schema.node('doc', null, blocks)
}

function textPosition(doc: ProseMirrorNode, text: string): number {
  let found = -1
  doc.descendants((node, position) => {
    const offset = node.isText ? node.text?.indexOf(text) ?? -1 : -1
    if (found < 0 && offset >= 0) found = position + offset
  })
  if (found < 0) throw new Error(`Text not found: ${text}`)
  return found
}

function selectedState(doc: ProseMirrorNode, fromText: string, toText = fromText): EditorState {
  const from = textPosition(doc, fromText)
  const to = textPosition(doc, toText) + toText.length
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) })
}

function cursorState(doc: ProseMirrorNode, text: string, offset = 0): EditorState {
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, textPosition(doc, text) + offset),
  })
}

function run(
  state: EditorState,
  direction: VisualTabDirection,
): { handled: boolean; state: EditorState; dispatch: ReturnType<typeof vi.fn> } {
  let current = state
  const dispatch = vi.fn((transaction: Transaction) => {
    current = current.apply(transaction)
  })
  return {
    handled: runVisualTabCommand(state, dispatch, direction),
    get state() { return current },
    dispatch,
  }
}

function listDepth(doc: ProseMirrorNode, text: string): number {
  const $position = doc.resolve(textPosition(doc, text))
  let depth = 0
  for (let index = 0; index <= $position.depth; index += 1) {
    if ($position.node(index).type.name === 'list_item') depth += 1
  }
  return depth
}

function headingLevels(doc: ProseMirrorNode): number[] {
  const levels: number[] = []
  doc.descendants((node) => {
    if (node.type.name === 'heading') levels.push(Number(node.attrs.level))
  })
  return levels
}

describe('runVisualTabCommand paragraph behavior', () => {
  it('adds exactly two full-width spaces to one paragraph and maps its cursor', () => {
    const initial = cursorState(document(paragraph('alpha')), 'alpha', 2)

    const result = run(initial, 'indent')

    expect(result.handled).toBe(true)
    expect(result.dispatch).toHaveBeenCalledOnce()
    expect(result.state.doc.textContent).toBe('　　alpha')
    expect(result.state.selection.from).toBe(initial.selection.from + 2)
    expect(result.state.selection.to).toBe(initial.selection.to + 2)
  })

  it('indents every partially selected paragraph in one transaction and maps both selection ends', () => {
    const doc = document(paragraph('one'), paragraph('two'), paragraph('three'))
    const initial = selectedState(doc, 'one', 'three')

    const result = run(initial, 'indent')

    expect(result.handled).toBe(true)
    expect(result.dispatch).toHaveBeenCalledOnce()
    expect(result.state.doc.toJSON()).toEqual(document(
      paragraph('　　one'),
      paragraph('　　two'),
      paragraph('　　three'),
    ).toJSON())
    expect(result.state.selection.from).toBe(initial.selection.from + 2)
    expect(result.state.selection.to).toBe(initial.selection.to + 6)
  })

  it('removes only one leading full-width level from each changeable selected paragraph', () => {
    const doc = document(paragraph('　　　　one'), paragraph('two'), paragraph('　　three'))

    const result = run(selectedState(doc, 'one', 'three'), 'outdent')

    expect(result.handled).toBe(true)
    expect(result.dispatch).toHaveBeenCalledOnce()
    expect(result.state.doc.toJSON()).toEqual(document(
      paragraph('　　one'),
      paragraph('two'),
      paragraph('three'),
    ).toJSON())
  })

  it('returns false without dispatch when no selected paragraph has a complete leading level', () => {
    const state = selectedState(document(paragraph('　one'), paragraph('two')), 'one', 'two')
    const dispatch = vi.fn()

    expect(runVisualTabCommand(state, dispatch, 'outdent')).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('answers a paragraph query without dispatching or mutating state', () => {
    const state = cursorState(document(paragraph('query')), 'query')

    expect(runVisualTabCommand(state, undefined, 'indent')).toBe(true)
    expect(state.doc.textContent).toBe('query')
  })
})

describe('runVisualTabCommand heading behavior', () => {
  it.each([
    ['indent', 1, 2],
    ['indent', 2, 3],
    ['indent', 3, 4],
    ['indent', 4, 5],
    ['indent', 5, 6],
    ['outdent', 2, 1],
    ['outdent', 3, 2],
    ['outdent', 4, 3],
    ['outdent', 5, 4],
    ['outdent', 6, 5],
  ] as const)('%s changes H%s to H%s', (direction, from, to) => {
    const result = run(cursorState(document(heading(from, 'title')), 'title'), direction)

    expect(result.handled).toBe(true)
    expect(result.dispatch).toHaveBeenCalledOnce()
    expect(headingLevels(result.state.doc)).toEqual([to])
  })

  it.each([
    ['indent', 6],
    ['outdent', 1],
  ] as const)('%s at the H%s boundary returns false without dispatch', (direction, level) => {
    const state = cursorState(document(heading(level, 'boundary')), 'boundary')
    const dispatch = vi.fn()

    expect(runVisualTabCommand(state, dispatch, direction)).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('changes multiple selected headings uniformly in one transaction', () => {
    const doc = document(heading(2, 'first'), heading(5, 'second'))

    const result = run(selectedState(doc, 'first', 'second'), 'indent')

    expect(result.handled).toBe(true)
    expect(result.dispatch).toHaveBeenCalledOnce()
    expect(headingLevels(result.state.doc)).toEqual([3, 6])
  })

  it('rejects a multi-heading selection if any heading is at the requested boundary', () => {
    const doc = document(heading(5, 'first'), heading(6, 'second'))
    const state = selectedState(doc, 'first', 'second')
    const dispatch = vi.fn()

    expect(runVisualTabCommand(state, dispatch, 'indent')).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe.each([
  ['unordered', 'bullet_list', null],
  ['ordered', 'ordered_list', null],
  ['task', 'bullet_list', false],
] as const)('runVisualTabCommand %s list behavior', (_name, listType, checked) => {
  it('sinks an item under its previous sibling and lifts it back one level', () => {
    const doc = document(list(listType, [
      listItem('first', checked === null ? {} : { checked }),
      listItem('second', checked === null ? {} : { checked }),
    ]))

    const sunk = run(cursorState(doc, 'second'), 'indent')
    expect(sunk.handled).toBe(true)
    expect(sunk.dispatch).toHaveBeenCalledOnce()
    expect(listDepth(sunk.state.doc, 'second')).toBe(2)

    const lifted = run(cursorState(sunk.state.doc, 'second'), 'outdent')
    expect(lifted.handled).toBe(true)
    expect(lifted.dispatch).toHaveBeenCalledOnce()
    expect(listDepth(lifted.state.doc, 'second')).toBe(1)
    if (checked !== null) {
      let taskChecked: unknown
      lifted.state.doc.descendants((node) => {
        if (node.type.name === 'list_item' && node.textContent === 'second') taskChecked = node.attrs.checked
      })
      expect(taskChecked).toBe(false)
    }
  })

  it('does not sink the first item or lift a top-level item', () => {
    const doc = document(list(listType, [
      listItem('first', checked === null ? {} : { checked }),
      listItem('second', checked === null ? {} : { checked }),
    ]))
    const first = cursorState(doc, 'first')
    const second = cursorState(doc, 'second')
    const dispatch = vi.fn()

    expect(runVisualTabCommand(first, dispatch, 'indent')).toBe(false)
    expect(runVisualTabCommand(second, dispatch, 'outdent')).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('runVisualTabCommand precedence and fallthrough', () => {
  it('sinks all selected list items as items instead of prefixing their paragraphs', () => {
    const doc = document(list('bullet_list', [
      listItem('first'),
      listItem('second'),
      listItem('third'),
    ]))

    const result = run(selectedState(doc, 'second', 'third'), 'indent')

    expect(result.handled).toBe(true)
    expect(result.dispatch).toHaveBeenCalledOnce()
    expect(listDepth(result.state.doc, 'second')).toBe(2)
    expect(listDepth(result.state.doc, 'third')).toBe(2)
    expect(result.state.doc.textContent).not.toContain('　')
  })

  it.each([
    ['table cell', document(table('cell')), 'cell'],
    ['code block', document(textBlock('code_block', 'code')), 'code'],
  ])('returns false without dispatch for a selection touching %s', (_name, doc, text) => {
    const state = cursorState(doc, text)
    const dispatch = vi.fn()

    expect(runVisualTabCommand(state, dispatch, 'indent')).toBe(false)
    expect(runVisualTabCommand(state, undefined, 'outdent')).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('createVisualTabPlugin', () => {
  it('prevents the default Tab only after a command is handled', () => {
    let state = cursorState(document(paragraph('alpha')), 'alpha')
    const dispatch = vi.fn((transaction: Transaction) => { state = state.apply(transaction) })
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    const plugin = createVisualTabPlugin()
    const handler = plugin.props.handleKeyDown?.bind(plugin)

    expect(handler?.({ state, dispatch, editable: true } as never, event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(state.doc.textContent).toBe('　　alpha')
  })

  it('maps Shift+Tab to one paragraph outdent level', () => {
    let state = cursorState(document(paragraph('　　　　alpha')), 'alpha')
    const dispatch = vi.fn((transaction: Transaction) => { state = state.apply(transaction) })
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })
    const plugin = createVisualTabPlugin()
    const handler = plugin.props.handleKeyDown?.bind(plugin)

    expect(handler?.({ state, dispatch, editable: true } as never, event)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(state.doc.textContent).toBe('　　alpha')
  })

  it('leaves unhandled Tab and unrelated keys available to other plugins', () => {
    const state = cursorState(document(textBlock('code_block', 'code')), 'code')
    const dispatch = vi.fn()
    const plugin = createVisualTabPlugin()
    const handler = plugin.props.handleKeyDown?.bind(plugin)
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    const view = { state, dispatch, editable: true } as never

    expect(handler?.(view, tab)).toBe(false)
    expect(tab.defaultPrevented).toBe(false)
    expect(handler?.(view, enter)).toBe(false)
    expect(enter.defaultPrevented).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('review regressions for visual Tab commands', () => {
  it.each([
    ['strong', undefined],
    ['link', { href: 'https://example.test/' }],
    ['inline_code', undefined],
  ] as const)('inserts an unmarked paragraph prefix before leading %s text', (markName, attrs) => {
    const mark = schema.marks[markName]!.create(attrs)
    const markedText = schema.text('alpha', [mark])
    const doc = document(schema.node('paragraph', null, markedText))

    const result = run(cursorState(doc, 'alpha'), 'indent')

    expect(result.handled).toBe(true)
    const changedParagraph = result.state.doc.firstChild!
    expect(changedParagraph.childCount).toBe(2)
    expect(changedParagraph.child(0).textContent).toBe('　　')
    expect(changedParagraph.child(0).marks).toHaveLength(0)
    expect(changedParagraph.child(1).textContent).toBe('alpha')
    expect(changedParagraph.child(1).marks.map((candidate) => candidate.type.name)).toEqual([markName])
    expect(changedParagraph.child(1).marks[0]?.attrs).toEqual(mark.attrs)
  })

  it('queries movable and boundary headings without changing document or selection', () => {
    const cases = [
      { state: cursorState(document(heading(2, 'movable')), 'movable'), direction: 'indent', handled: true },
      { state: cursorState(document(heading(6, 'h6')), 'h6'), direction: 'indent', handled: false },
      { state: cursorState(document(heading(1, 'h1')), 'h1'), direction: 'outdent', handled: false },
    ] as const

    cases.forEach(({ state, direction, handled }) => {
      const originalDoc = state.doc
      const originalSelection = state.selection
      expect(runVisualTabCommand(state, undefined, direction)).toBe(handled)
      expect(state.doc).toBe(originalDoc)
      expect(state.selection).toBe(originalSelection)
    })
  })

  it('queries sinkable, liftable, and boundary list items without side effects', () => {
    const sinkableDoc = document(list('bullet_list', [listItem('first'), listItem('second')]))
    const nestedDoc = document(list('bullet_list', [
      listItem('parent', { nested: list('bullet_list', [listItem('child')]) }),
    ]))
    const cases = [
      { state: cursorState(sinkableDoc, 'second'), direction: 'indent', handled: true },
      { state: cursorState(nestedDoc, 'child'), direction: 'outdent', handled: true },
      { state: cursorState(sinkableDoc, 'first'), direction: 'indent', handled: false },
      { state: cursorState(sinkableDoc, 'second'), direction: 'outdent', handled: false },
    ] as const

    cases.forEach(({ state, direction, handled }) => {
      const originalDoc = state.doc
      const originalSelection = state.selection
      expect(runVisualTabCommand(state, undefined, direction)).toBe(handled)
      expect(state.doc).toBe(originalDoc)
      expect(state.selection).toBe(originalSelection)
    })
  })

  it.each([
    ['table', 'indent', document(paragraph('　　before'), table('cell'), paragraph('　　after'))],
    ['table', 'outdent', document(paragraph('　　before'), table('cell'), paragraph('　　after'))],
    ['code block', 'indent', document(paragraph('　　before'), textBlock('code_block', 'code'), paragraph('　　after'))],
    ['code block', 'outdent', document(paragraph('　　before'), textBlock('code_block', 'code'), paragraph('　　after'))],
  ] as const)(
    'falls through a paragraph-to-%s-to-paragraph range for %s',
    (_name, direction, doc) => {
      const state = selectedState(doc, 'before', 'after')
      const originalDoc = state.doc
      const originalSelection = state.selection
      const dispatch = vi.fn()

      expect(runVisualTabCommand(state, dispatch, direction)).toBe(false)
      expect(dispatch).not.toHaveBeenCalled()
      expect(state.doc).toBe(originalDoc)
      expect(state.selection).toBe(originalSelection)
    },
  )
})
