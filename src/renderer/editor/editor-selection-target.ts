import type { Node as ProseMirrorNode, Slice } from '@milkdown/kit/prose/model'
import { NodeSelection, Plugin, PluginKey, type EditorState, type SelectionBookmark } from '@milkdown/kit/prose/state'
import { CellSelection, TableMap } from '@milkdown/kit/prose/tables'
import type { EditorView } from '@milkdown/kit/prose/view'

export interface SelectionTargetIdentity {
  readonly documentKey: string | null | undefined
  readonly lifetime: number
}

export interface EditorSelectionTarget {
  readonly identity: SelectionTargetIdentity
  readonly doc: ProseMirrorNode
  readonly revision: number
  readonly bookmark: SelectionBookmark
  readonly slice: Slice
  readonly kind: 'text' | 'node' | 'cells'
  readonly from: number
  readonly to: number
  readonly cells?: {
    readonly positions: readonly number[]
    readonly tableStart: number
    readonly table: ProseMirrorNode
    readonly rect: Readonly<{ top: number; bottom: number; left: number; right: number }>
    readonly width: number
    readonly height: number
  }
}

const revisionKey = new PluginKey<number>('arkdown-selection-target-revision')

export function isCrossCellSelection(state: EditorState): boolean {
  const selection = state.selection
  return selection instanceof CellSelection && selection.ranges.length > 1
}

/** DOM cell ownership is reliable even when hit-testing its padding finds a neighbour. */
export function tableCellPositionAtDOMTarget(view: EditorView, target: EventTarget | null): number | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  const cell = element?.closest('td, th')
  if (!cell || !view.dom.contains(cell)) return null
  try {
    const resolved = view.state.doc.resolve(view.posAtDOM(cell, 0))
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      if (['table_cell', 'table_header'].includes(resolved.node(depth).type.name)) return resolved.before(depth)
    }
  } catch { /* An obsolete DOM node no longer identifies an editor cell. */ }
  return null
}

function preserveCellsOnSecondaryPress(view: EditorView, event: MouseEvent): boolean {
  const selection = view.state.selection
  if (event.button !== 2 || !(selection instanceof CellSelection) || selection.ranges.length < 2) return false
  const position = tableCellPositionAtDOMTarget(view, event.target)
  if (position === null) return false
  let selected = false
  selection.forEachCell((_cell, cellPosition) => {
    if (position === cellPosition) selected = true
  })
  if (!selected) return false
  // Prevent the browser from replacing the rectangle before ProseMirror's
  // mousedown/contextmenu DOM flush reads a new single-cell text selection.
  event.preventDefault()
  return true
}

/** Versions advance on every document transaction, including undo to identical content. */
export function createSelectionTargetPlugin(): Plugin<number> {
  return new Plugin<number>({
    key: revisionKey,
    state: { init: () => 0, apply: (tr, revision) => tr.docChanged ? revision + 1 : revision },
    props: {
      attributes: (state): Record<string, string> => isCrossCellSelection(state) ? { 'data-arkdown-cross-cell-selection': 'true' } : {},
      handleDOMEvents: {
        pointerdown: preserveCellsOnSecondaryPress,
        mousedown: preserveCellsOnSecondaryPress,
      },
    },
  })
}

export function captureSelectionTarget(state: EditorState, identity: SelectionTargetIdentity): EditorSelectionTarget {
  const selection = state.selection
  let cells: EditorSelectionTarget['cells']
  if (selection instanceof CellSelection) {
    const table = selection.$anchorCell.node(-1)
    const tableStart = selection.$anchorCell.start(-1)
    const map = TableMap.get(table)
    const rect = map.rectBetween(selection.$anchorCell.pos - tableStart, selection.$headCell.pos - tableStart)
    cells = Object.freeze({
      table, tableStart, rect: Object.freeze(rect), width: map.width, height: map.height,
      positions: Object.freeze(map.cellsInRect(rect).map(pos => tableStart + pos)),
    })
  }
  return Object.freeze({
    identity: Object.freeze({ ...identity }), doc: state.doc, revision: revisionKey.getState(state) ?? 0,
    bookmark: selection.getBookmark(), slice: selection.content(),
    kind: cells ? 'cells' : selection instanceof NodeSelection ? 'node' : 'text',
    from: selection.from, to: selection.to, ...(cells ? { cells } : {}),
  })
}

export function targetContainsPosition(target: EditorSelectionTarget, position: number): boolean {
  if (position < 0 || position > target.doc.content.size) return false
  if (!target.cells) return position >= target.from && position <= target.to
  // A cell node boundary (e.g. a right-click on its padding) belongs to that cell too.
  if (target.cells.positions.includes(position)) return true
  const resolved = target.doc.resolve(position)
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    if (['table_cell', 'table_header'].includes(resolved.node(depth).type.name)) {
      return target.cells.positions.includes(resolved.before(depth))
    }
  }
  return false
}

export function resolveSelectionTarget(state: EditorState, identity: SelectionTargetIdentity, target: EditorSelectionTarget) {
  if (state.doc !== target.doc || (revisionKey.getState(state) ?? 0) !== target.revision
    || identity.documentKey !== target.identity.documentKey || identity.lifetime !== target.identity.lifetime) return null
  try { return target.bookmark.resolve(state.doc) } catch { return null }
}
