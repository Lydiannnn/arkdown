import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { CellSelection, tableNodes } from '@milkdown/kit/prose/tables'
import { describe, expect, it } from 'vitest'
import {
  replaceTextInsideTableCell,
  splitParagraphInsideTableCell,
  selectionIsInsideSingleTableCell,
} from '../../src/renderer/editor/table-cell-transactions'

function fixture() {
  const tables = tableNodes({ tableGroup: 'block', cellContent: 'block+', cellAttributes: {} })
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block', toDOM: () => ['p', 0] },
      table: { ...tables.table, content: 'table_row+' },
      table_row: tables.table_row,
      table_cell: { ...tables.table_cell, content: 'block+' },
      table_header: { ...tables.table_header, content: 'block+' },
      text: { group: 'inline' },
    },
  })
  const paragraph = (value: string) => schema.nodes.paragraph!.create(null, schema.text(value))
  const cell = (value: string) => schema.nodes.table_cell!.create(null, paragraph(value))
  const row = schema.nodes.table_row!.create(null, [cell('A'), cell('B')])
  const doc = schema.nodes.doc!.create(null, schema.nodes.table!.create(null, [row]))
  const positions: number[] = []
  doc.descendants((node, position) => {
    if (node.type.name === 'table_cell') positions.push(position)
  })
  return { schema, doc, positions }
}

describe('table-cell scoped text transactions', () => {
  it.each(['single line', 'two\nlines'])('rejects CellSelection instead of shrinking %s replacement to its head cell', (text) => {
    const { doc, positions } = fixture()
    let state = EditorState.create({ doc, selection: CellSelection.create(doc, positions[0]!, positions[1]!) })
    const view = { get state() { return state }, dispatch(tr: typeof state.tr) { state = state.apply(tr) } }
    expect(selectionIsInsideSingleTableCell(state)).toBe(false)
    expect(replaceTextInsideTableCell(view, text)).toBe(false)
    expect(state.doc).toBe(doc)
  })
  it('turns clipboard newlines into cell paragraphs without replacing table structure', () => {
    const { doc, positions } = fixture()
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, positions[0]! + 2, positions[0]! + 3),
    })
    const view = {
      get state() { return state },
      dispatch(transaction: typeof state.tr) { state = state.apply(transaction) },
    }

    expect(selectionIsInsideSingleTableCell(state)).toBe(true)
    expect(replaceTextInsideTableCell(view, '甲\n乙')).toBe(true)
    const table = state.doc.firstChild!
    expect(table.childCount).toBe(1)
    expect(table.firstChild?.childCount).toBe(2)
    expect(table.firstChild?.firstChild?.childCount).toBe(2)
    expect(table.firstChild?.firstChild?.textContent).toBe('甲乙')
  })

  it('refuses a selection spanning two cells', () => {
    const { doc, positions } = fixture()
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, positions[0]! + 2, positions[1]! + 2),
    })
    const view = {
      get state() { return state },
      dispatch(transaction: typeof state.tr) { state = state.apply(transaction) },
    }
    expect(selectionIsInsideSingleTableCell(state)).toBe(false)
    expect(replaceTextInsideTableCell(view, '不能越界')).toBe(false)
    expect(state.doc.eq(doc)).toBe(true)
  })

  it('splits the current cell paragraph instead of leaving the table', () => {
    const { doc, positions } = fixture()
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, positions[0]! + 3),
    })

    expect(splitParagraphInsideTableCell(state, (transaction) => {
      state = state.apply(transaction)
    })).toBe(true)

    const table = state.doc.firstChild!
    const row = table.firstChild!
    const firstCell = row.firstChild!
    expect(table.childCount).toBe(1)
    expect(row.childCount).toBe(2)
    expect(firstCell.childCount).toBe(2)
    expect(firstCell.child(0).textContent).toBe('A')
    expect(firstCell.child(1).type.name).toBe('paragraph')
  })
})
