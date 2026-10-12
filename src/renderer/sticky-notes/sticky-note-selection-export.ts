import { Fragment, type Node as ProseMirrorNode, type Schema, type Slice } from '@milkdown/kit/prose/model'
import type { StickyNoteSelectionResource } from '../../shared/sticky-notes'

export type { StickyNoteSelectionResource } from '../../shared/sticky-notes'

export interface StickyNoteSelectionExport {
  markdown: string
  localResources: readonly StickyNoteSelectionResource[]
  warnings: readonly string[]
}

export interface VisualStickyNoteSelectionInput {
  slice: Slice
  schema: Schema
  serialize: (node: ProseMirrorNode) => string
  selectionTouchesTable?: boolean
  /** Captured with the Slice, never reconstructed from a later live editor selection. */
  listContext?: { documentNode: ProseMirrorNode; from: number; to: number }
}

const PARTIAL_TABLE_WARNING = '局部表格选区已转换为可读文本。'

function normalizeLocalReference(reference: string): string | null {
  const value = reference.trim().replace(/^<|>$/gu, '')
  if (/^[a-z]:[\\/]/iu.test(value)) return value.replaceAll('/', '\\')
  if (/^file:\/\/[a-z]:\//iu.test(value)) {
    try {
      return decodeURIComponent(value.slice('file://'.length)).replaceAll('/', '\\')
    } catch {
      return null
    }
  }
  if (/^file:\/\/[\/][a-z]:\//iu.test(value)) {
    try {
      return decodeURIComponent(value.slice('file:///'.length)).replaceAll('/', '\\')
    } catch {
      return null
    }
  }
  return null
}

function localResources(markdown: string): readonly StickyNoteSelectionResource[] {
  const candidates: string[] = []
  const markdownImage = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\r\n)]+?))(?:\s+["'][^"']*["'])?\s*\)/gu
  const htmlSource = /<(?:img|audio|video|source)\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/giu
  for (const match of markdown.matchAll(markdownImage)) {
    const reference = match[1] ?? match[2]
    if (reference) candidates.push(reference)
  }
  for (const match of markdown.matchAll(htmlSource)) {
    const reference = match[1] ?? match[2] ?? match[3]
    if (reference) candidates.push(reference)
  }

  const resources: StickyNoteSelectionResource[] = []
  const seen = new Set<string>()
  for (const originalReference of candidates) {
    const absolutePath = normalizeLocalReference(originalReference)
    if (!absolutePath) continue
    const key = absolutePath.toLocaleLowerCase('en-US')
    if (seen.has(key)) continue
    seen.add(key)
    resources.push({ originalReference, absolutePath })
  }
  return resources
}

function result(markdown: string, warnings: readonly string[] = []): StickyNoteSelectionExport {
  return { markdown, localResources: localResources(markdown), warnings }
}

function containsTableNode(node: ProseMirrorNode): boolean {
  if (node.type.name === 'table') return true
  let found = false
  node.descendants((child) => {
    if (child.type.name !== 'table') return true
    found = true
    return false
  })
  return found
}

function readableSliceText(slice: Slice): string {
  return slice.content.textBetween(0, slice.content.size, '\n\n', '').trim()
}

function selectedListContent(input: VisualStickyNoteSelectionInput): Fragment {
  if (!input.listContext) return input.slice.content
  const { documentNode, from, to } = input.listContext
  const start = Math.min(from, to)
  const end = Math.max(from, to)
  const $start = documentNode.resolve(start)
  const $end = documentNode.resolve(end)
  const isList = (node: ProseMirrorNode) => ['ordered_list', 'bullet_list'].includes(node.type.name)
  // An inline fragment is still an inline fragment, even when its paragraph is in a list.
  if ($start.sameParent($end) && $start.parent.isTextblock
    && (start > $start.start() || end < $end.end())) {
    return Fragment.from($start.parent.copy($start.parent.content.cut($start.parentOffset, $end.parentOffset)))
  }
  let depth = $start.sharedDepth(end)
  while (depth > 0 && !isList($start.node(depth))) depth -= 1
  const root = $start.node(depth)
  const rootPosition = depth === 0 ? -1 : $start.before(depth)
  // Crop recursively instead of expanding endpoints: only required ancestors and selected content survive.
  const crop = (node: ProseMirrorNode, pos: number): ProseMirrorNode => {
    if (node.isTextblock) return node.copy(node.content.cut(Math.max(0, start - pos - 1), Math.min(node.content.size, end - pos - 1)))
    if (node.isLeaf) return node
    const children: ProseMirrorNode[] = []
    let firstIndex = -1
    node.forEach((child, offset, index) => {
      const childPos = pos + 1 + offset
      if (start >= childPos + child.nodeSize || end <= childPos) return
      if (firstIndex < 0) firstIndex = index
      children.push(crop(child, childPos))
    })
    // A boundary starting in a nested list needs an empty item paragraph, never the unselected parent text.
    const needsEmptyParagraph = node.type.name === 'list_item' && children[0]?.type.name !== 'paragraph'
    if (needsEmptyParagraph) {
      children.unshift(input.schema.nodes.paragraph!.create())
    }
    const attrs = node.type.name === 'ordered_list'
      ? { ...node.attrs, order: Number(node.attrs.order) + Math.max(0, firstIndex) }
      // A blank line after an empty item terminates it in Markdown; keep this scaffold tight.
      : needsEmptyParagraph ? { ...node.attrs, spread: false } : node.attrs
    return node.type.createChecked(attrs, children, node.marks)
  }
  const selected = crop(root, rootPosition)
  return depth > 0 ? Fragment.from(selected) : selected.content
}

export function exportSourceStickyNoteSelection(
  markdown: string,
  from: number,
  to: number,
): StickyNoteSelectionExport {
  const start = Math.max(0, Math.min(markdown.length, Math.min(from, to)))
  const end = Math.max(start, Math.min(markdown.length, Math.max(from, to)))
  return result(markdown.slice(start, end))
}

export function exportVisualStickyNoteSelection(
  input: VisualStickyNoteSelectionInput,
): StickyNoteSelectionExport {
  const first = input.slice.content.firstChild
  const isCompleteTable = input.slice.openStart === 0
    && input.slice.openEnd === 0
    && input.slice.content.childCount === 1
    && first?.type.name === 'table'
  const tableSelection = input.selectionTouchesTable === true
    || (first ? containsTableNode(first) : false)

  if (tableSelection && !isCompleteTable) {
    return result(readableSliceText(input.slice), [PARTIAL_TABLE_WARNING])
  }

  try {
    const document = input.schema.topNodeType.create(null, selectedListContent(input))
    return result(input.serialize(document).trim())
  } catch {
    return result(readableSliceText(input.slice))
  }
}
