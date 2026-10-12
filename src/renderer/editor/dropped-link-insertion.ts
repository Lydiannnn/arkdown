import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { TextSelection } from '@milkdown/kit/prose/state'
import { documentTypeForPath } from '../../shared/document-types'

export type DroppedLinkKind = 'file' | 'folder'

export interface DroppedInsertionPoint {
  clientX: number
  clientY: number
  visualDropRequestId?: number
}

export interface DroppedLinkInsertion extends DroppedInsertionPoint {
  absolutePath: string
  kind: DroppedLinkKind
}

export interface DroppedMarkdownInsertion extends DroppedInsertionPoint {
  markdown: string
}

const DROPPED_DOCUMENT_LINK_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'docx'])

export function isDroppedDocumentLinkPath(absolutePath: string): boolean {
  const definition = documentTypeForPath(absolutePath)
  return definition?.category === 'document'
    && DROPPED_DOCUMENT_LINK_EXTENSIONS.has(definition.extension)
}

export function droppedLinkInsertionRange(
  position: number,
  selection: { from: number; to: number },
): { from: number; to: number } {
  return selection.from !== selection.to
    && position >= selection.from
    && position <= selection.to
    ? { from: selection.from, to: selection.to }
    : { from: position, to: position }
}

function markdownLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
}

export function droppedLocalFileDisplayName(absolutePath: string): string {
  const separatorIndex = Math.max(absolutePath.lastIndexOf('\\'), absolutePath.lastIndexOf('/'))
  return absolutePath.slice(separatorIndex + 1)
}

function droppedLocalLinkDisplayName(absolutePath: string, kind: DroppedLinkKind): string {
  return kind === 'folder' ? absolutePath : droppedLocalFileDisplayName(absolutePath)
}

export function serializeDroppedLocalLink(
  absolutePath: string,
  kind: DroppedLinkKind = 'file',
): string {
  return `[${markdownLabel(droppedLocalLinkDisplayName(absolutePath, kind))}](<${absolutePath}>)`
}

export function buildVisualDroppedLinkTransaction(
  state: EditorState,
  position: number,
  absolutePath: string,
  kind: DroppedLinkKind = 'file',
  insertionRange?: { from: number; to: number },
): Transaction | null {
  const link = state.schema.marks.link
  if (!link || position < 0 || position > state.doc.content.size || absolutePath.length === 0) {
    return null
  }
  const range = insertionRange ?? droppedLinkInsertionRange(position, state.selection)
  const displayName = droppedLocalLinkDisplayName(absolutePath, kind)
  const transaction = state.tr.replaceWith(
    range.from,
    range.to,
    state.schema.text(displayName, [link.create({ href: absolutePath, title: null })]),
  )
  return transaction
    .setSelection(TextSelection.create(transaction.doc, range.from + displayName.length))
    .removeStoredMark(link)
    .scrollIntoView()
}
