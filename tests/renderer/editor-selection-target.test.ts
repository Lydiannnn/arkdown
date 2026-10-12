import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { CellSelection, tableNodes } from '@milkdown/kit/prose/tables'
import { describe, expect, it } from 'vitest'
import { captureSelectionTarget, createSelectionTargetPlugin, resolveSelectionTarget, targetContainsPosition } from '../../src/renderer/editor/editor-selection-target'
import { selectionTargetPlainText, selectionTargetHtml } from '../../src/renderer/editor/context-menu/clipboard-formats'

const identity = { documentKey: 'synthetic', lifetime: 1 }
function fixture() {
  const schema = new Schema({ nodes: {
    doc: { content: 'block+' }, paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    ...tableNodes({ tableGroup: 'block', cellContent: 'block+', cellAttributes: {} }), text: {},
  } })
  const rows = [0, 1, 2].map(row => schema.nodes.table_row!.create(null, [0, 1, 2].map(col =>
    schema.nodes.table_cell!.create(null, schema.nodes.paragraph!.create(null, schema.text(`${row}${col}`))))))
  const doc = schema.nodes.doc!.create(null, schema.nodes.table!.create(null, rows))
  const positions: number[] = []
  doc.descendants((node, pos) => { if (node.type.name === 'table_cell') positions.push(pos) })
  const state = EditorState.create({ doc, selection: CellSelection.create(doc, positions[1]!, positions[5]!), plugins: [createSelectionTargetPlugin()] })
  return { schema, doc, positions, state }
}

describe('immutable editor selection targets', () => {
  it('uses rectangle membership, excluding a cell inside the numeric bounding interval', () => {
    const { state, positions } = fixture()
    const target = captureSelectionTarget(state, identity)
    expect(target.cells?.positions).toEqual([positions[1], positions[2], positions[4], positions[5]])
    expect(targetContainsPosition(target, positions[3]! + 2)).toBe(false)
    expect(targetContainsPosition(target, positions[4]! + 2)).toBe(true)
    expect(selectionTargetPlainText(target)).toBe('01\t02\n11\t12')
    const html = selectionTargetHtml(target, state.schema)
    const holder = document.createElement('div'); holder.innerHTML = html
    expect(holder.querySelectorAll('td')).toHaveLength(4)
    expect(holder.textContent).toBe('01021112')
  })
  it('survives selection-only changes but rejects another identity or a changed then restored document', () => {
    const { state, positions, doc } = fixture()
    const target = captureSelectionTarget(state, identity)
    const moved = state.apply(state.tr.setSelection(TextSelection.create(doc, positions[0]! + 2)))
    expect(resolveSelectionTarget(moved, identity, target)).toBeInstanceOf(CellSelection)
    expect(resolveSelectionTarget(moved, { ...identity, lifetime: 2 }, target)).toBeNull()
    const edited = moved.apply(moved.tr.insertText('x'))
    const restored = edited.apply(edited.tr.replaceWith(0, edited.doc.content.size, doc.content))
    expect(resolveSelectionTarget(restored, identity, target)).toBeNull()
  })
  it('deduplicates merged cells and preserves their exact table membership', () => {
    const { schema } = fixture()
    const cell = (text: string, attrs = {}) => schema.nodes.table_cell!.create(attrs,
      schema.nodes.paragraph!.create(null, schema.text(text)))
    const doc = schema.nodes.doc!.create(null, schema.nodes.table!.create(null, [
      schema.nodes.table_row!.create(null, [cell('span', { rowspan: 2 }), cell('upper')]),
      schema.nodes.table_row!.create(null, [cell('lower')]),
    ]))
    const positions: number[] = []
    doc.descendants((node, pos) => { if (node.type.name === 'table_cell') positions.push(pos) })
    const state = EditorState.create({ doc, selection: CellSelection.create(doc, positions[2]!, positions[0]!) })
    const target = captureSelectionTarget(state, identity)
    expect(target.cells?.positions).toEqual(positions)
    expect(target.cells?.rect).toEqual({ top: 0, bottom: 2, left: 0, right: 2 })
    expect(targetContainsPosition(target, positions[0]! + 2)).toBe(true)
    expect(selectionTargetPlainText(target)).toBe('span\tupper\nlower')
  })
})
