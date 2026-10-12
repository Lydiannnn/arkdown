import { Schema } from '@milkdown/kit/prose/model'
import { AllSelection, EditorState, Plugin, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { history, undo, redo } from '@milkdown/kit/prose/history'
import { describe, expect, it } from 'vitest'
import {
  convertSelectedListSelection,
  buildListSelectionTransaction,
  splitHardBreaksInSelection,
  wrapSelectedLinesInList,
} from '../../src/renderer/editor/list-selection-transform'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    ordered_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { order: { default: 1 } },
    },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: {
      content: 'paragraph block*',
      attrs: {
        label: { default: '-' },
        listType: { default: 'bullet' },
        checked: { default: null },
      },
    },
    hardbreak: { inline: true, group: 'inline', selectable: false },
    text: { group: 'inline' },
  },
})

function selectedHardBreakDocument(): EditorState {
  const paragraph = schema.nodes.paragraph.create(null, [
    schema.text('one'),
    schema.nodes.hardbreak.create(),
    schema.text('two'),
    schema.nodes.hardbreak.create(),
    schema.text('three'),
  ])
  const doc = schema.nodes.doc.create(null, [paragraph])
  return EditorState.create({
    doc,
    schema,
    selection: TextSelection.create(doc, 1, doc.content.size - 1),
  })
}

describe('splitHardBreaksInSelection', () => {
  it('turns selected hard breaks into separate paragraphs for list wrapping', () => {
    const state = selectedHardBreakDocument()

    const transaction = splitHardBreaksInSelection(state)
    expect(transaction).not.toBeNull()
    const next = state.apply(transaction!)
    expect(next.doc.toJSON()).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
      ],
    })
  })

  it('leaves a visually wrapped paragraph as one logical line', () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('one long visual line'))
    const doc = schema.nodes.doc.create(null, [paragraph])
    const state = EditorState.create({
      doc,
      schema,
      selection: TextSelection.create(doc, 1, doc.content.size - 1),
    })
    expect(splitHardBreaksInSelection(state)).toBeNull()
  })
})

describe('wrapSelectedLinesInList', () => {
  it.each([
    ['ordered', schema.nodes.ordered_list, undefined],
    ['unordered', schema.nodes.bullet_list, undefined],
    ['task', schema.nodes.bullet_list, { checked: false }],
  ] as const)('creates one %s list item per selected hard break line', (_name, listType, options) => {
    const state = selectedHardBreakDocument()
    const transaction = wrapSelectedLinesInList(state, listType, options)
    expect(transaction).not.toBeNull()

    const list = state.apply(transaction!).doc.firstChild!
    expect(list.type).toBe(listType)
    expect(list.childCount).toBe(3)
    expect(Array.from({ length: list.childCount }, (_, index) => list.child(index).textContent))
      .toEqual(['one', 'two', 'three'])
    expect(Array.from({ length: list.childCount }, (_, index) => list.child(index).attrs.checked))
      .toEqual(options?.checked === false ? [false, false, false] : [null, null, null])
  })

  it('keeps a visually wrapped paragraph as one list item', () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('one long visual line'))
    const doc = schema.nodes.doc.create(null, [paragraph])
    const state = EditorState.create({
      doc,
      schema,
      selection: TextSelection.create(doc, 1, doc.content.size - 1),
    })

    const transaction = wrapSelectedLinesInList(state, schema.nodes.ordered_list)
    expect(transaction).not.toBeNull()
    expect(state.apply(transaction!).doc.firstChild!.childCount).toBe(1)
  })
})


function selectedListDocument(
  listType: 'ordered' | 'bullet',
  checked: boolean | null,
  selectedIndexes: readonly number[] = [0, 1, 2],
) {
  const texts = ['one', 'two', 'three']
  const itemNodes = texts.map((text, index) => schema.nodes.list_item.create(
    {
      label: listType === 'ordered' ? `${index + 1}.` : '-',
      listType,
      checked,
    },
    schema.nodes.paragraph.create(null, schema.text(text)),
  ))
  const sourceType = listType === 'ordered'
    ? schema.nodes.ordered_list
    : schema.nodes.bullet_list
  const doc = schema.nodes.doc.create(null, sourceType.create(null, itemNodes))
  const positions: number[] = []
  doc.descendants((node, position) => {
    if (node.type === schema.nodes.list_item) positions.push(position)
  })
  const first = selectedIndexes[0]!
  const last = selectedIndexes.at(-1)!
  let state = EditorState.create({
    doc,
    schema,
    selection: TextSelection.create(
      doc,
      positions[first]! + 2,
      positions[last]! + itemNodes[last]!.nodeSize - 2,
    ),
  })
  const view = {
    get state() {
      return state
    },
    dispatch(transaction: Transaction) {
      state = state.apply(transaction)
    },
  }
  return { view, texts }
}

describe('convertSelectedListSelection', () => {
  it.each([[0, false], [0, true], [1, false], [1, true]] as const)(
    'keeps shared paragraph occurrence %s selected (reverse=%s) and edits only that occurrence', (occurrence, reverse) => {
      const shared = schema.nodes.paragraph.create(null, schema.text('shared'))
      let state = EditorState.create({ doc: schema.nodes.doc.create(null, shared), plugins: [history()] })
      state = state.apply(state.tr.insert(state.doc.content.size, shared))
      expect(state.doc.child(0)).toBe(state.doc.child(1))
      const from = occurrence * shared.nodeSize + 2
      const to = from + 3
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, reverse ? to : from, reverse ? from : to)))
      const before = state.doc.toJSON()
      const result = buildListSelectionTransaction(state, schema.nodes.list_item, schema.nodes.ordered_list)
      expect(result.status).toBe('changed')
      if (result.status !== 'changed') return
      state = state.apply(result.transaction)
      expect(state.selection.anchor).toBe((reverse ? to : from) + 2)
      expect(state.selection.head).toBe((reverse ? from : to) + 2)
      expect(state.selection.$from.depth).toBe(3)
      undo(state, tr => { state = state.apply(tr) })
      expect(state.doc.toJSON()).toEqual(before)
      redo(state, tr => { state = state.apply(tr) })
      state = state.apply(state.tr.insertText('X'))
      expect(state.doc.child(occurrence).textContent).toBe('sXed')
      expect(state.doc.child(1 - occurrence).textContent).toBe('shared')
    },
  )
  it('preserves nested same-type toggle as one-level lift and never runs live plugins while preparing', () => {
    const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text))
    const item = (text: string) => schema.nodes.list_item.create({ checked: true }, p(text))
    const doc = schema.nodes.doc.create(null, schema.nodes.bullet_list.create(null,
      schema.nodes.list_item.create({ checked: false }, [p('parent'), schema.nodes.bullet_list.create(null, [item('nested'), item('unselected')])])) )
    let from = 0
    doc.descendants((node, pos) => { if (node.text === 'nested') from = pos })
    let appends = 0
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, from, from + 6),
      plugins: [new Plugin({ appendTransaction() { appends += 1; return null } })] })
    const result = buildListSelectionTransaction(state, schema.nodes.list_item, schema.nodes.bullet_list, { checked: false, toggle: true })
    expect(result.status).toBe('changed')
    expect(appends).toBe(0)
    if (result.status !== 'changed') return
    const outer = result.transaction.doc.firstChild!
    expect(outer.childCount).toBe(2)
    expect(outer.child(0).textContent).toBe('parent')
    expect(outer.child(1).firstChild?.textContent).toBe('nested')
    expect(outer.child(1).attrs.checked).toBe(true)
    expect(outer.child(1).lastChild?.textContent).toBe('unselected')
  })
  it.each(['ordered', 'bullet', 'task'] as const)('toggles a complete %s list off, retaining nested lists and one undo boundary', kind => {
    const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text))
    const nested = schema.nodes.ordered_list.create({ order: 9 }, schema.nodes.list_item.create({ checked: true }, p('nested')))
    const type = kind === 'ordered' ? schema.nodes.ordered_list : schema.nodes.bullet_list
    const doc = schema.nodes.doc.create(null, [type.create({ order: 5 }, [
      schema.nodes.list_item.create({ checked: kind === 'task' ? true : null }, [p('first'), nested]),
      schema.nodes.list_item.create({ checked: kind === 'task' ? false : null }, p('second')),
    ]), schema.nodes.paragraph.create()])
    const state = EditorState.create({ doc, selection: new AllSelection(doc) })
    const result = buildListSelectionTransaction(state, schema.nodes.list_item, type, { toggle: true, ...(kind === 'task' ? { checked: false } : {}) })
    expect(result.status).toBe('changed')
    if (result.status !== 'changed') return
    const next = state.apply(result.transaction)
    expect(Array.from({ length: next.doc.childCount }, (_, i) => next.doc.child(i).type.name)).toEqual(['paragraph', 'ordered_list', 'paragraph', 'paragraph'])
    expect(next.doc.child(1).toJSON()).toEqual(nested.toJSON())
  })

  it('converts mixed paragraphs and lists without changing nested checks or inline content', () => {
    const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text))
    const nested = schema.nodes.bullet_list.create(null, schema.nodes.list_item.create({ checked: true }, p('nested')))
    const doc = schema.nodes.doc.create(null, [p('before'), schema.nodes.ordered_list.create({ order: 5 }, [
      schema.nodes.list_item.create(null, [p('first'), nested]), schema.nodes.list_item.create(null, p('second')),
    ]), p('after')])
    const state = EditorState.create({ doc, selection: new AllSelection(doc) })
    const result = buildListSelectionTransaction(state, schema.nodes.list_item, schema.nodes.bullet_list, { checked: false })
    expect(result.status).toBe('changed')
    if (result.status !== 'changed') return
    const list = result.transaction.doc.firstChild!
    expect(list.childCount).toBe(4)
    expect(list.child(1).child(1).toJSON()).toEqual(nested.toJSON())
    expect(result.transaction.doc.textContent).toBe(doc.textContent)
  })

  it('preserves unselected ordered offsets and a reverse selection of middle siblings', () => {
    const { view } = selectedListDocument('ordered', null, [1])
    view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { order: 5 }))
    const selection = view.state.selection
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, selection.to, selection.from)))
    expect(convertSelectedListSelection(view, schema.nodes.list_item, schema.nodes.bullet_list)).toBe(true)
    expect(view.state.doc.child(0).attrs.order).toBe(5)
    expect(view.state.doc.child(2).attrs.order).toBe(7)
    expect(view.state.selection.anchor).toBeGreaterThan(view.state.selection.head)
    expect(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to)).toBe('two')
  })

  it('keeps prior typing in a separate history event', () => {
    const initial = selectedListDocument('bullet', null).view.state.doc
    let state = EditorState.create({ doc: initial, plugins: [history()] })
    state = state.apply(state.tr.insertText('typed', 3))
    const typed = state.doc.toJSON()
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)))
    const result = buildListSelectionTransaction(state, schema.nodes.list_item, schema.nodes.ordered_list)
    expect(result.status).toBe('changed')
    if (result.status !== 'changed') return
    state = state.apply(result.transaction)
    undo(state, tr => { state = state.apply(tr) })
    expect(state.doc.toJSON()).toEqual(typed)
    undo(state, tr => { state = state.apply(tr) })
    expect(state.doc.toJSON()).toEqual(initial.toJSON())
  })
  it('converts root AllSelection atomically and restores the exact tree in one undo/redo', () => {
    const fixture = selectedListDocument('bullet', true)
    let state = EditorState.create({ doc: fixture.view.state.doc, plugins: [history()] })
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)))
    const before = state.doc.toJSON()
    const published: Transaction[] = []
    const view = { get state() { return state }, dispatch(tr: Transaction) { published.push(tr); state = state.apply(tr) } }
    expect(convertSelectedListSelection(view, schema.nodes.list_item, schema.nodes.ordered_list)).toBe(true)
    expect(published).toHaveLength(1)
    expect(state.doc.firstChild?.type.name).toBe('ordered_list')
    const after = state.doc.toJSON()
    expect(undo(state, tr => { state = state.apply(tr) })).toBe(true)
    expect(state.doc.toJSON()).toEqual(before)
    expect(redo(state, tr => { state = state.apply(tr) })).toBe(true)
    expect(state.doc.toJSON()).toEqual(after)
  })

  it('does not publish a partial lift when the requested container cannot contain list items', () => {
    const { view } = selectedListDocument('ordered', null, [1])
    const before = view.state.doc
    let count = 0
    const dispatch = view.dispatch
    view.dispatch = tr => { count += 1; dispatch(tr) }
    expect(convertSelectedListSelection(view, schema.nodes.list_item, schema.nodes.paragraph)).toBe(false)
    expect(count).toBe(0)
    expect(view.state.doc).toBe(before)
  })
  it.each([
    ['ordered to unordered', 'ordered', null, schema.nodes.bullet_list, undefined, 'bullet', null],
    ['ordered to task', 'ordered', null, schema.nodes.bullet_list, { checked: false }, 'bullet', false],
    ['unordered to ordered', 'bullet', null, schema.nodes.ordered_list, undefined, 'ordered', null],
    ['unordered to task', 'bullet', null, schema.nodes.bullet_list, { checked: false }, 'bullet', false],
    ['task to ordered', 'bullet', false, schema.nodes.ordered_list, undefined, 'ordered', null],
    ['task to unordered', 'bullet', false, schema.nodes.bullet_list, undefined, 'bullet', null],
  ] as const)(
    'applies %s to every selected row',
    (_name, sourceListType, sourceChecked, targetNodeType, options, targetListType, targetChecked) => {
      const { view, texts } = selectedListDocument(sourceListType, sourceChecked)

      expect(convertSelectedListSelection(
        view,
        schema.nodes.list_item,
        targetNodeType,
        options,
      )).toBe(true)

      const list = view.state.doc.firstChild!
      expect(list.type).toBe(targetNodeType)
      expect(list.childCount).toBe(3)
      expect(Array.from({ length: list.childCount }, (_, index) => list.child(index).textContent))
        .toEqual(texts)
      expect(Array.from({ length: list.childCount }, (_, index) => ({
        listType: list.child(index).attrs.listType,
        checked: list.child(index).attrs.checked,
      }))).toEqual(Array.from({ length: 3 }, () => ({
        listType: targetListType,
        checked: targetChecked,
      })))
    },
  )

  it('changes only the selected middle row and preserves surrounding source rows', () => {
    const { view } = selectedListDocument('ordered', null, [1])

    expect(convertSelectedListSelection(
      view,
      schema.nodes.list_item,
      schema.nodes.bullet_list,
      { checked: false },
    )).toBe(true)

    expect(Array.from(
      { length: view.state.doc.childCount },
      (_, index) => view.state.doc.child(index).type.name,
    )).toEqual(['ordered_list', 'bullet_list', 'ordered_list'])
    const middle = view.state.doc.child(1)
    expect(middle.textContent).toBe('two')
    expect(middle.firstChild?.attrs).toMatchObject({
      listType: 'bullet',
      checked: false,
    })
  })
})
