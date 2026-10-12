import { Fragment, type Node as ProseMirrorNode, type NodeType } from '@milkdown/kit/prose/model'
import { AllSelection, EditorState, Selection, TextSelection, type Transaction } from '@milkdown/kit/prose/state'
import { CellSelection } from '@milkdown/kit/prose/tables'
import { closeHistory } from '@milkdown/kit/prose/history'
import { liftListItem } from '@milkdown/kit/prose/schema-list'

export function splitHardBreaksInSelection(state: EditorState, outsideListsOnly = false): Transaction | null {
  const positions: number[] = []
  const { from, to } = state.selection
  state.doc.nodesBetween(from, to, (node, position) => {
    if (outsideListsOnly && ['ordered_list', 'bullet_list'].includes(node.type.name)) return false
    if (node.type.name === 'hardbreak' && position >= from && position < to) {
      positions.push(position)
    }
  })
  if (!positions.length) return null

  const transaction = state.tr
  positions.sort((left, right) => right - left).forEach((position) => {
    transaction.delete(position, position + 1)
    transaction.split(position)
  })
  return transaction
}

interface ListSelectionOptions {
  checked?: boolean
}

interface ListSelectionView {
  readonly state: EditorState
  dispatch(transaction: Transaction): void
}

export function wrapSelectedLinesInList(
  state: EditorState,
  listType: NodeType,
  options: ListSelectionOptions = {},
): Transaction | null {
  const result = buildListSelectionTransaction(state, state.schema.nodes.list_item!, listType, options)
  return result.status === 'changed' ? result.transaction : null
}

export function convertSelectedListSelection(
  view: ListSelectionView,
  listItemType: NodeType,
  targetListType: NodeType,
  options: ListSelectionOptions = {},
): boolean {
  const result = buildListSelectionTransaction(view.state, listItemType, targetListType, options)
  if (result.status !== 'changed') return false
  view.dispatch(result.transaction)
  return true
}

type ListTransformResult = { status: 'changed'; transaction: Transaction } | { status: 'unchanged' | 'unsupported' }
const isList = (node: ProseMirrorNode) => ['ordered_list', 'bullet_list'].includes(node.type.name)

/** Build the entire conversion privately. Neither validation nor a failed replacement publishes steps. */
export function buildListSelectionTransaction(
  state: EditorState,
  listItemType: NodeType,
  targetListType: NodeType,
  options: ListSelectionOptions & { toggle?: boolean } = {},
): ListTransformResult {
  if (state.selection instanceof CellSelection || !['ordered_list', 'bullet_list'].includes(targetListType.name)) {
    return { status: 'unsupported' }
  }
  try {
    const transaction = splitHardBreaksInSelection(state, true) ?? state.tr
    // A private state must not run live appendTransaction plugins while preparing the command.
    const prepared = EditorState.create({ schema: state.schema, doc: transaction.doc, selection: transaction.selection })
    const { selection, doc } = prepared
    let depth = selection.$from.sharedDepth(selection.to)
    while (depth > 0 && (selection.$from.node(depth).isTextblock || selection.$from.node(depth).type === listItemType)) depth -= 1
    if (isList(selection.$from.node(depth))) depth -= 1
    const parent = selection.$from.node(depth)
    const base = selection.$from.start(depth)
    type Unit = { node: ProseMirrorNode; source?: ProseMirrorNode; index: number }
    const units: Unit[] = []
    const before: ProseMirrorNode[] = []
    const after: ProseMirrorNode[] = []
    const touches = (pos: number, size: number) => selection.empty
      ? selection.from >= pos && selection.from < pos + size
      : selection.from < pos + size && selection.to > pos
    const listPart = (list: ProseMirrorNode, start: number, end: number) => {
      const children = Array.from({ length: end - start }, (_, i) => list.child(start + i))
      const attrs = list.type.name === 'ordered_list' ? { ...list.attrs, order: Number(list.attrs.order) + start } : list.attrs
      return list.type.createChecked(attrs, children, list.marks)
    }
    parent.forEach((node, offset) => {
      const pos = base + offset
      if (!touches(pos, node.nodeSize)) {
        ;(pos < selection.from ? before : after).push(node)
        return
      }
      if (!isList(node)) {
        units.push({ node, index: 0 })
        return
      }
      let first = -1
      let last = -1
      node.forEach((item, itemOffset, index) => {
        if (!touches(pos + 1 + itemOffset, item.nodeSize)) return
        if (first < 0) first = index
        last = index
        units.push({ node: item, source: node, index })
      })
      // Node selections and root boundaries can include a list without entering a textblock.
      if (first < 0) throw new RangeError('No selected list item')
      if (first > 0) before.push(listPart(node, 0, first))
      if (last + 1 < node.childCount) after.push(listPart(node, last + 1, node.childCount))
    })
    const lastUnit = units.at(-1)
    if (units.length > 1 && parent.type === state.schema.topNodeType
      && !lastUnit?.source && lastUnit?.node === parent.lastChild
      && lastUnit.node.type.name === 'paragraph' && lastUnit.node.content.size === 0) {
      // Preserve the production trailing insertion paragraph rather than inventing an empty list item.
      after.unshift(units.pop()!.node)
    }
    if (!units.length) return { status: 'unchanged' }
    const task = typeof options.checked === 'boolean'
    const meaningful = units.filter(unit => unit.source || unit.node.content.size > 0)
    const toggle = options.toggle === true && meaningful.length > 0 && meaningful.every(unit =>
      unit.source?.type === targetListType && (typeof unit.node.attrs.checked === 'boolean') === task)
    if (toggle && parent.type === listItemType) {
      // Preserve the existing nested toggle: lift selected items one level, within the private state.
      let lifted: Transaction | undefined
      if (!liftListItem(listItemType)(prepared, tr => { lifted = tr }) || !lifted) return { status: 'unsupported' }
      for (const step of lifted.steps) transaction.step(step)
      transaction.setSelection(Selection.fromJSON(transaction.doc, lifted.selection.toJSON()))
      return { status: 'changed', transaction: closeHistory(transaction).scrollIntoView() }
    }
    const changed: ProseMirrorNode[] = []
    if (toggle) {
      for (const unit of units) {
        if (unit.source) unit.node.forEach(child => changed.push(child))
        else changed.push(unit.node)
      }
    } else {
      const items = units.map(unit => {
        const content = unit.source ? unit.node.content : Fragment.from(unit.node)
        return listItemType.createChecked({
          ...(unit.source ? unit.node.attrs : {}),
          listType: targetListType.name === 'ordered_list' ? 'ordered' : 'bullet',
          checked: task ? (typeof unit.node.attrs.checked === 'boolean' ? unit.node.attrs.checked : options.checked) : null,
        }, content, unit.source ? unit.node.marks : undefined)
      })
      const first = units[0]!
      const attrs: Record<string, unknown> = first.source?.type === targetListType ? { ...first.source.attrs } : {}
      if (targetListType.name === 'ordered_list') {
        attrs.order = first.source?.type === targetListType ? Number(first.source.attrs.order) + first.index : 1
      }
      changed.push(targetListType.createChecked(attrs, items))
    }
    const replacement = Fragment.fromArray([...before, ...changed, ...after])
    if (!parent.type.validContent(replacement)) return { status: 'unsupported' }
    const edit = prepared.tr.replaceWith(base, base + parent.content.size, replacement)
    if (edit.doc.eq(state.doc)) return { status: 'unchanged' }
    // This transform retains textblocks in document order. Map their occurrences,
    // not object identity: an immutable paragraph can be reused at multiple positions.
    if (selection instanceof AllSelection) edit.setSelection(new AllSelection(edit.doc))
    else if (selection instanceof TextSelection) {
      const originalBlocks: Array<{ node: ProseMirrorNode; start: number }> = []
      const resultingBlocks: Array<{ node: ProseMirrorNode; start: number }> = []
      doc.descendants((node, pos) => { if (node.isTextblock) originalBlocks.push({ node, start: pos + 1 }) })
      edit.doc.descendants((node, pos) => { if (node.isTextblock) resultingBlocks.push({ node, start: pos + 1 }) })
      if (originalBlocks.length !== resultingBlocks.length) return { status: 'unsupported' }
      const locate = (position: number) => {
        const resolved = doc.resolve(position)
        const index = originalBlocks.findIndex(block => block.start === resolved.start())
        const mapped = resultingBlocks[index]
        return mapped && mapped.node === resolved.parent ? mapped.start + resolved.parentOffset : undefined
      }
      const anchor = locate(selection.anchor)
      const head = locate(selection.head)
      if (anchor === undefined || head === undefined) return { status: 'unsupported' }
      edit.setSelection(TextSelection.create(edit.doc, anchor, head))
    }
    for (const step of edit.steps) transaction.step(step)
    transaction.setSelection(Selection.fromJSON(transaction.doc, edit.selection.toJSON()))
    return { status: 'changed', transaction: closeHistory(transaction).scrollIntoView() }
  } catch {
    return { status: 'unsupported' }
  }
}
