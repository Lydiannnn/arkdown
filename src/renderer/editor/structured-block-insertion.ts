import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { TextSelection } from '@milkdown/kit/prose/state'

export interface StructuredBlockDescriptor {
  language: string
  frontmatter?: boolean
}

export function supportsYamlFrontmatterForDocument(documentPath: string | null): boolean {
  if (documentPath === null) return true
  return /\.(?:md|markdown)$/iu.test(documentPath)
}

function isStructurallyEmptyDocument(state: EditorState): boolean {
  const onlyChild = state.doc.childCount === 1 ? state.doc.firstChild : null
  return Boolean(
    onlyChild
    && onlyChild.type.name === 'paragraph'
    && onlyChild.content.size === 0,
  )
}

export function buildStructuredBlockInsertionTransaction(
  state: EditorState,
  descriptor: StructuredBlockDescriptor,
): Transaction | null {
  const codeBlock = state.schema.nodes.code_block
  if (
    !codeBlock
    || typeof descriptor.language !== 'string'
    || (descriptor.frontmatter !== undefined && typeof descriptor.frontmatter !== 'boolean')
    || (descriptor.frontmatter === true && !isStructurallyEmptyDocument(state))
  ) return null

  try {
    const selectedText = state.selection.empty
      ? ''
      : state.doc.textBetween(state.selection.from, state.selection.to, '\n')
    const content = selectedText ? state.schema.text(selectedText) : undefined
    const transaction = state.tr.replaceSelectionWith(
      codeBlock.createChecked(descriptor, content),
      false,
    )
    const selectionPosition = transaction.selection.from
    let insertedPosition: number | null = null
    transaction.doc.descendants((node, position) => {
      if (
        node.type === codeBlock
        && node.attrs.language === descriptor.language
        && Boolean(node.attrs.frontmatter) === Boolean(descriptor.frontmatter)
        && position < selectionPosition
      ) {
        insertedPosition = position
        return false
      }
      return true
    })
    if (insertedPosition === null) return null
    return transaction
      .setSelection(TextSelection.create(
        transaction.doc,
        insertedPosition + 1 + selectedText.length,
      ))
      .scrollIntoView()
  } catch {
    return null
  }
}
