import { Fragment, Slice } from '@milkdown/kit/prose/model'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { splitBlock } from '@milkdown/kit/prose/commands'
import { CellSelection } from '@milkdown/kit/prose/tables'

interface CellRange {
  position: number
  from: number
  to: number
}

interface TableCellView {
  state: EditorState
  dispatch(transaction: Transaction): void
}

function cellRangeAt(resolved: EditorState['selection']['$from']): CellRange | null {
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const node = resolved.node(depth)
    if (!['table_cell', 'table_header'].includes(node.type.name)) continue
    return {
      position: resolved.before(depth),
      from: resolved.start(depth),
      to: resolved.end(depth),
    }
  }
  return null
}

export function selectionIsInsideSingleTableCell(state: EditorState): boolean {
  if (state.selection instanceof CellSelection) return false
  const from = cellRangeAt(state.selection.$from)
  const to = cellRangeAt(state.selection.$to)
  return Boolean(from && to && from.position === to.position)
}

export function splitParagraphInsideTableCell(
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  return selectionIsInsideSingleTableCell(state) && splitBlock(state, dispatch)
}

export function replaceTextInsideTableCell(
  view: TableCellView,
  text: string,
  selection = view.state.selection,
): boolean {
  const state = view.state
  if (selection instanceof CellSelection) return false
  const fromCell = cellRangeAt(selection.$from)
  const toCell = cellRangeAt(selection.$to)
  if (!fromCell || !toCell || fromCell.position !== toCell.position) return false
  if (selection.from < fromCell.from || selection.to > fromCell.to) return false

  const normalized = text.replace(/\r\n?/g, '\n')
  if (!normalized.includes('\n')) {
    view.dispatch(state.tr.setSelection(selection).insertText(normalized, selection.from, selection.to).scrollIntoView())
    return true
  }

  const paragraph = state.schema.nodes.paragraph
  if (!paragraph) return false
  const blocks = normalized.split('\n').map((line) => paragraph.create(
    null,
    line ? state.schema.text(line) : undefined,
  ))
  try {
    const transaction = state.tr.setSelection(selection).replaceSelection(
      new Slice(Fragment.fromArray(blocks), 0, 0),
    ).scrollIntoView()
    view.dispatch(transaction)
    return true
  } catch {
    return false
  }
}
