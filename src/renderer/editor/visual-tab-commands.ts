import type { Node as ProseMirrorNode, ResolvedPos } from '@milkdown/kit/prose/model'
import { liftListItem, sinkListItem } from '@milkdown/kit/prose/schema-list'
import { Plugin, type EditorState, type Transaction } from '@milkdown/kit/prose/state'

export type VisualTabDirection = 'indent' | 'outdent'

type Dispatch = ((transaction: Transaction) => void) | undefined

interface SelectedNode {
  node: ProseMirrorNode
  position: number
}

const PARAGRAPH_PREFIX = '　　'
const TAB_FALLTHROUGH_NODES = new Set(['table', 'table_cell', 'table_header', 'code_block'])

function selectionIntersectsNode(
  state: EditorState,
  position: number,
  node: ProseMirrorNode,
): boolean {
  const { selection } = state
  const end = position + node.nodeSize
  return selection.empty
    ? selection.from > position && selection.from < end
    : selection.from < end && selection.to > position
}

function selectedNodes(state: EditorState, name: string): SelectedNode[] {
  const selected: SelectedNode[] = []
  state.doc.descendants((node, position) => {
    if (node.type.name === name && selectionIntersectsNode(state, position, node)) {
      selected.push({ node, position })
    }
  })
  return selected
}

function resolvedPositionTouches($position: ResolvedPos, names: ReadonlySet<string>): boolean {
  for (let depth = $position.depth; depth >= 0; depth -= 1) {
    if (names.has($position.node(depth).type.name)) return true
  }
  return false
}

function selectionTouchesNode(state: EditorState, names: ReadonlySet<string>): boolean {
  if (
    resolvedPositionTouches(state.selection.$from, names)
    || resolvedPositionTouches(state.selection.$to, names)
  ) return true

  let touches = false
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    if (names.has(node.type.name)) touches = true
    return !touches
  })
  return touches
}

function nearestListItem($position: ResolvedPos): { depth: number; position: number } | null {
  let nesting = 0
  let position = -1
  for (let depth = 1; depth <= $position.depth; depth += 1) {
    if ($position.node(depth).type.name !== 'list_item') continue
    nesting += 1
    position = $position.before(depth)
  }
  return nesting > 0 ? { depth: nesting, position } : null
}

function selectedListItems(state: EditorState): Array<{ depth: number; position: number }> {
  const targets = new Map<number, { depth: number; position: number }>()
  if (state.selection.empty) {
    const target = nearestListItem(state.selection.$from)
    if (target) targets.set(target.position, target)
    return [...targets.values()]
  }

  state.doc.descendants((node, position) => {
    if (!node.isTextblock || !selectionIntersectsNode(state, position, node)) return
    const target = nearestListItem(state.doc.resolve(position + 1))
    if (target) targets.set(target.position, target)
  })
  return [...targets.values()]
}

function runListLevelCommand(
  state: EditorState,
  dispatch: Dispatch,
  direction: VisualTabDirection,
): boolean {
  const listItemType = state.schema.nodes.list_item
  const targets = selectedListItems(state)
  if (!listItemType || !targets.length) return false
  if (direction === 'outdent' && targets.some((target) => target.depth <= 1)) return false
  return (direction === 'indent' ? sinkListItem(listItemType) : liftListItem(listItemType))(
    state,
    dispatch,
  )
}

function changeHeadingLevels(
  state: EditorState,
  dispatch: Dispatch,
  direction: VisualTabDirection,
): boolean {
  const headings = selectedNodes(state, 'heading')
  if (!headings.length) return false
  const delta = direction === 'indent' ? 1 : -1
  if (headings.some(({ node }) => {
    const level = Number(node.attrs.level)
    return !Number.isInteger(level) || level + delta < 1 || level + delta > 6
  })) return false
  if (!dispatch) return true

  const transaction = state.tr
  headings.forEach(({ node, position }) => {
    transaction.setNodeMarkup(position, undefined, {
      ...node.attrs,
      level: Number(node.attrs.level) + delta,
    })
  })
  transaction.setSelection(state.selection.map(transaction.doc, transaction.mapping))
  dispatch(transaction.scrollIntoView())
  return true
}

function changeParagraphPrefixes(
  state: EditorState,
  dispatch: Dispatch,
  direction: VisualTabDirection,
): boolean {
  const paragraphs = selectedNodes(state, 'paragraph')
  const changes = direction === 'indent'
    ? paragraphs
    : paragraphs.filter(({ node }) => node.textContent.startsWith(PARAGRAPH_PREFIX))
  if (!changes.length) return false
  if (!dispatch) return true

  const transaction = state.tr
  changes
    .slice()
    .sort((left, right) => right.position - left.position)
    .forEach(({ position }) => {
      const start = position + 1
      if (direction === 'indent') {
        transaction.insert(start, state.schema.text(PARAGRAPH_PREFIX, []))
      } else {
        transaction.delete(start, start + PARAGRAPH_PREFIX.length)
      }
    })
  transaction.setSelection(state.selection.map(transaction.doc, transaction.mapping))
  dispatch(transaction.scrollIntoView())
  return true
}

export function runVisualTabCommand(
  state: EditorState,
  dispatch: Dispatch,
  direction: VisualTabDirection,
): boolean {
  if (selectionTouchesNode(state, TAB_FALLTHROUGH_NODES)) return false
  if (selectedListItems(state).length) return runListLevelCommand(state, dispatch, direction)
  if (selectedNodes(state, 'heading').length) return changeHeadingLevels(state, dispatch, direction)
  return changeParagraphPrefixes(state, dispatch, direction)
}

export function createVisualTabPlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (
          event.key !== 'Tab'
          || event.ctrlKey
          || event.metaKey
          || event.altKey
          || event.isComposing
          || !view.editable
        ) return false
        const handled = runVisualTabCommand(
          view.state,
          (transaction) => view.dispatch(transaction),
          event.shiftKey ? 'outdent' : 'indent',
        )
        if (!handled) return false
        event.preventDefault()
        return true
      },
    },
  })
}
