import type { Node as MarkdownNode, RemarkPluginRaw } from '@milkdown/kit/transformer'
import { toggleMark } from '@milkdown/kit/prose/commands'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { NodeSelection, TextSelection } from '@milkdown/kit/prose/state'
import { $markSchema, $remark } from '@milkdown/kit/utils'

type ExtendedTag = 'u' | 'mark' | 'sup' | 'sub'
type ExtendedNodeType = 'arkdownUnderline' | 'arkdownHighlight' | 'arkdownSuperscript' | 'arkdownSubscript'

interface ParentMarkdownNode extends MarkdownNode {
  children: MarkdownNode[]
}

const TAG_TO_NODE: Readonly<Record<ExtendedTag, ExtendedNodeType>> = {
  u: 'arkdownUnderline',
  mark: 'arkdownHighlight',
  sup: 'arkdownSuperscript',
  sub: 'arkdownSubscript',
}

const NODE_TO_TAG: Readonly<Record<ExtendedNodeType, ExtendedTag>> = {
  arkdownUnderline: 'u',
  arkdownHighlight: 'mark',
  arkdownSuperscript: 'sup',
  arkdownSubscript: 'sub',
}

function htmlValue(node: MarkdownNode): string | null {
  if (node.type !== 'html') return null
  const value = (node as MarkdownNode & { value?: unknown }).value
  return typeof value === 'string' ? value.trim() : null
}

function openTag(node: MarkdownNode): ExtendedTag | null {
  const match = /^<(u|mark|sup|sub)>$/iu.exec(htmlValue(node) ?? '')
  return match ? match[1]!.toLowerCase() as ExtendedTag : null
}

function isCloseTag(node: MarkdownNode, tag: ExtendedTag): boolean {
  return new RegExp(`^<\\/${tag}>$`, 'iu').test(htmlValue(node) ?? '')
}

function hasChildren(node: MarkdownNode): node is ParentMarkdownNode {
  return Array.isArray((node as MarkdownNode & { children?: unknown }).children)
}

export function transformExtendedInlineHtml(tree: MarkdownNode): void {
  if (!hasChildren(tree)) return
  const children = tree.children
  for (let index = 0; index < children.length; index += 1) {
    const tag = openTag(children[index]!)
    if (!tag) {
      transformExtendedInlineHtml(children[index]!)
      continue
    }
    let depth = 1
    let close = index + 1
    for (; close < children.length; close += 1) {
      if (openTag(children[close]!) === tag) depth += 1
      if (isCloseTag(children[close]!, tag)) depth -= 1
      if (depth === 0) break
    }
    if (depth !== 0) continue
    const wrappedChildren = children.slice(index + 1, close)
    const replacement = {
      type: TAG_TO_NODE[tag],
      children: wrappedChildren,
    } as MarkdownNode
    transformExtendedInlineHtml(replacement)
    children.splice(index, close - index + 1, replacement)
  }
}

interface MarkdownStringifierState {
  enter(name: string): () => void
  containerPhrasing(node: MarkdownNode, info: Record<string, unknown>): string
}

type MarkdownHandler = (
  node: MarkdownNode,
  parent: MarkdownNode | undefined,
  state: MarkdownStringifierState,
  info: Record<string, unknown>,
) => string

function htmlMarkHandler(tag: ExtendedTag): MarkdownHandler {
  return (node, _parent, state, info) => {
    const exit = state.enter(`arkdown-${tag}`)
    const content = state.containerPhrasing(node, {
      ...info,
      before: `<${tag}>`,
      after: `</${tag}>`,
    })
    exit()
    return `<${tag}>${content}</${tag}>`
  }
}

function remarkExtendedInlineHtml(this: {
  data(): {
    toMarkdownExtensions?: Array<{ handlers: Record<string, MarkdownHandler> }>
  }
}) {
  const data = this.data()
  const extensions = data.toMarkdownExtensions ?? (data.toMarkdownExtensions = [])
  extensions.push({
    handlers: Object.fromEntries(Object.entries(NODE_TO_TAG).map(([type, tag]) => [
      type,
      htmlMarkHandler(tag),
    ])),
  })
  return transformExtendedInlineHtml
}

export const remarkExtendedInlineMarkPlugin = $remark(
  'arkdownExtendedInlineMarks',
  () => remarkExtendedInlineHtml as unknown as RemarkPluginRaw<unknown>,
)

function createExtendedMark(id: string, nodeType: ExtendedNodeType, tag: ExtendedTag) {
  return $markSchema(id, () => ({
    parseDOM: [{ tag }],
    toDOM: () => [tag, 0] as const,
    parseMarkdown: {
      match: (node) => node.type === nodeType,
      runner: (state, node, markType) => {
        state.openMark(markType)
        state.next((node as MarkdownNode & { children: MarkdownNode[] }).children as Parameters<typeof state.next>[0])
        state.closeMark(markType)
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === id,
      runner: (state, mark) => {
        state.withMark(mark, nodeType)
      },
    },
  }))
}

export const underlineSchema = createExtendedMark('underline', 'arkdownUnderline', 'u')
export const highlightSchema = createExtendedMark('highlight', 'arkdownHighlight', 'mark')
export const superscriptSchema = createExtendedMark('superscript', 'arkdownSuperscript', 'sup')
export const subscriptSchema = createExtendedMark('subscript', 'arkdownSubscript', 'sub')

export const extendedInlineMarkPlugins = [
  remarkExtendedInlineMarkPlugin,
  underlineSchema,
  highlightSchema,
  superscriptSchema,
  subscriptSchema,
] as const

export type ExtendedVisualInlineCommand =
  | 'toggle-underline'
  | 'clear-inline-formatting'
  | 'toggle-inline-formula'
  | 'toggle-highlight'
  | 'toggle-superscript'
  | 'toggle-subscript'

const COMMAND_MARKS: Readonly<Partial<Record<ExtendedVisualInlineCommand, string>>> = {
  'toggle-underline': 'underline',
  'toggle-highlight': 'highlight',
  'toggle-superscript': 'superscript',
  'toggle-subscript': 'subscript',
}

const CLEARABLE_MARKS = [
  'strong',
  'emphasis',
  'strike_through',
  'underline',
  'highlight',
  'superscript',
  'subscript',
  'inline_code',
] as const

function clearVisualInlineFormatting(
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  if (!dispatch) return true
  const { from, to, empty } = state.selection
  let transaction = state.tr
  for (const name of CLEARABLE_MARKS) {
    const mark = state.schema.marks[name]
    if (!mark) continue
    transaction = empty
      ? transaction.removeStoredMark(mark)
      : transaction.removeMark(from, to, mark)
  }
  dispatch(transaction)
  return true
}

function toggleInlineFormula(
  state: EditorState,
  dispatch?: (transaction: Transaction) => void,
): boolean {
  const formula = state.schema.nodes.math_inline
  if (!formula) return false
  const { selection } = state
  if (selection instanceof NodeSelection && selection.node.type === formula) {
    if (!dispatch) return true
    const value = typeof selection.node.attrs.value === 'string' ? selection.node.attrs.value : ''
    const transaction = value
      ? state.tr.replaceSelectionWith(state.schema.text(value))
      : state.tr.deleteSelection()
    dispatch(transaction.setSelection(TextSelection.create(
      transaction.doc,
      selection.from,
      selection.from + value.length,
    )))
    return true
  }
  if (!dispatch) return true
  const value = state.doc.textBetween(selection.from, selection.to)
  const transaction = state.tr.replaceSelectionWith(formula.create({ value }))
  dispatch(transaction.setSelection(NodeSelection.create(transaction.doc, selection.from)))
  return true
}

export function applyExtendedVisualInlineCommand(
  state: EditorState,
  dispatch: ((transaction: Transaction) => void) | undefined,
  command: ExtendedVisualInlineCommand,
): boolean {
  if (command === 'clear-inline-formatting') {
    return clearVisualInlineFormatting(state, dispatch)
  }
  if (command === 'toggle-inline-formula') return toggleInlineFormula(state, dispatch)
  const markName = COMMAND_MARKS[command]
  const mark = markName ? state.schema.marks[markName] : undefined
  return mark ? toggleMark(mark)(state, dispatch) : false
}
