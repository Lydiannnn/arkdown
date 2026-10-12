import { Fragment, type Schema, type Slice, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { Serializer as MarkdownSerializer } from '@milkdown/kit/transformer'
import type { TranslationSelectionContent } from '../../shared/selection-translation'
import { serializeDocumentWithEnhancedTables } from './enhanced-table-schema'

export interface ExportedTranslationSelection {
  content: TranslationSelectionContent
  diagnostics: readonly string[]
}

const PARTIAL_TABLE_DIAGNOSTIC = '局部表格选区已转换为可读文本。'

function isTableStructure(node: ProseMirrorNode): boolean {
  return [
    'table',
    'table_row',
    'table_header_row',
    'table_cell',
    'table_header',
  ].includes(node.type.name)
}

function containsTable(node: ProseMirrorNode): boolean {
  if (isTableStructure(node)) return true
  let found = false
  node.descendants((child) => {
    if (!isTableStructure(child)) return !found
    found = true
    return false
  })
  return found
}

function sliceContainsTable(slice: Slice): boolean {
  let found = false
  slice.content.forEach((node) => {
    if (!found && containsTable(node)) found = true
  })
  return found
}

export function selectionTouchesTable(
  documentNode: ProseMirrorNode,
  from: number,
  to: number,
): boolean {
  const start = Math.max(0, Math.min(documentNode.content.size, Math.min(from, to)))
  const end = Math.max(start, Math.min(documentNode.content.size, Math.max(from, to)))
  for (const position of [start, end]) {
    const resolved = documentNode.resolve(position)
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      if (resolved.node(depth).type.name === 'table') return true
    }
  }

  let found = false
  documentNode.nodesBetween(start, end, (node) => {
    if (!isTableStructure(node)) return !found
    found = true
    return false
  })
  return found
}

function plainInline(node: ProseMirrorNode): string {
  if (node.isText) return node.text ?? ''
  if (node.type.name === 'image') return String(node.attrs.alt ?? '')
  if (node.type.name === 'hard_break') return '\n'
  let text = ''
  node.forEach((child) => { text += plainInline(child) })
  return text
}

function plainBlock(node: ProseMirrorNode): string {
  if (node.type.name === 'table') {
    const rows: string[] = []
    node.forEach((row) => {
      const cells: string[] = []
      row.forEach((cell) => { cells.push(plainBlock(cell)) })
      rows.push(cells.join('\t'))
    })
    return rows.join('\n')
  }
  if (node.type.name === 'table_row' || node.type.name === 'table_header_row') {
    const cells: string[] = []
    node.forEach((cell) => { cells.push(plainBlock(cell)) })
    return cells.join('\t')
  }
  if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') {
    const items: string[] = []
    node.forEach((item) => { items.push(plainBlock(item)) })
    return items.join('\n')
  }
  if (
    node.type.name === 'list_item'
    || node.type.name === 'blockquote'
    || node.type.name === 'table_cell'
    || node.type.name === 'table_header'
  ) {
    const blocks: string[] = []
    node.forEach((child) => { blocks.push(plainBlock(child)) })
    return blocks.join('\n')
  }
  return plainInline(node)
}

function readableSliceText(slice: Slice): string {
  const blocks: string[] = []
  slice.content.forEach((node) => { blocks.push(plainBlock(node)) })
  return blocks.join('\n\n').trim()
}

function inlineMarkdownToText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^\r\n)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^\r\n)]*\)/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/<(https?:\/\/[^>]+|mailto:[^>]+)>/giu, '$1')
    .replace(/<[^>]*>/gu, '')
    .replace(/(\*\*|__|~~)(.*?)\1/gu, '$2')
    .replace(/(?<!\*)\*([^*\r\n]+)\*(?!\*)/gu, '$1')
    .replace(/(?<!_)_([^_\r\n]+)_(?!_)/gu, '$1')
    .replace(/\\([\\`*_[\]{}()#+.!>|-])/gu, '$1')
}

function sourceMarkdownToPlainText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const output: string[] = []
  let fenced = false
  for (const sourceLine of lines) {
    if (/^\s*(```+|~~~+)/u.test(sourceLine)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      output.push(sourceLine)
      continue
    }
    if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?$/u.test(sourceLine)) continue
    const tableLine = /^\s*\|(.+)\|\s*$/u.exec(sourceLine)
    if (tableLine) {
      output.push(tableLine[1]!.split('|').map((cell) => inlineMarkdownToText(cell.trim())).join('\t'))
      continue
    }
    const withoutBlockSyntax = sourceLine
      .replace(/^\s{0,3}#{1,6}\s+/u, '')
      .replace(/^\s*>\s?/u, '')
      .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, '')
    output.push(inlineMarkdownToText(withoutBlockSyntax).trimEnd())
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

interface SelectionListContext {
  documentNode: ProseMirrorNode
  from: number
  to: number
}

function selectionContentWithListContext(slice: Slice, context?: SelectionListContext): Fragment {
  if (!context) return slice.content
  const { documentNode, from, to } = context
  const start = documentNode.resolve(from)
  const sharedDepth = start.sharedDepth(to)
  const isList = (node: ProseMirrorNode) => (
    node.type.name === 'ordered_list' || node.type.name === 'bullet_list'
  )
  let listDepth = sharedDepth
  while (listDepth > 0 && !isList(start.node(listDepth))) listDepth -= 1
  let startsInList = false
  for (let depth = 1; depth <= start.depth; depth += 1) {
    if (isList(start.node(depth))) startsInList = true
  }
  if (listDepth === 0 && !startsInList) return slice.content

  // Restore only the nearest shared list, without adding unselected siblings.
  const depth = listDepth || sharedDepth
  const source = start.node(depth)
  const content = listDepth > 0
    ? source.content.cut(from - start.start(depth), to - start.start(depth))
    : slice.content
  const adjustFirstItem = (node: ProseMirrorNode, currentDepth: number): ProseMirrorNode => {
    let children = node.content
    if (currentDepth < start.depth && node.firstChild) {
      children = children.replaceChild(0, adjustFirstItem(node.firstChild, currentDepth + 1))
    }
    const attrs = node.type.name === 'ordered_list'
      ? { ...node.attrs, order: Number(node.attrs.order) + start.index(currentDepth) }
      : node.attrs
    return node.type.create(attrs, children, node.marks)
  }
  const restored = adjustFirstItem(source.copy(content), depth)
  return listDepth > 0 ? Fragment.from(restored) : restored.content
}

export function exportVisualTranslationSelection(input: {
  slice: Slice
  schema: Schema
  serializer: MarkdownSerializer
  selectionTouchesTable: boolean
  listContext?: SelectionListContext
}): ExportedTranslationSelection {
  const first = input.slice.content.firstChild
  const completeTable = input.slice.openStart === 0
    && input.slice.openEnd === 0
    && input.slice.content.childCount === 1
    && first?.type.name === 'table'
  const tableSelection = input.selectionTouchesTable
    || sliceContainsTable(input.slice)
  const plainText = readableSliceText(input.slice)
  if (tableSelection && !completeTable) {
    return {
      content: { markdown: plainText, plainText },
      diagnostics: [PARTIAL_TABLE_DIAGNOSTIC],
    }
  }

  try {
    const documentNode = input.schema.topNodeType.create(
      null,
      selectionContentWithListContext(input.slice, input.listContext),
    )
    const markdown = serializeDocumentWithEnhancedTables(
      documentNode,
      input.schema,
      input.serializer,
    ).trim()
    return { content: { markdown, plainText }, diagnostics: [] }
  } catch {
    return { content: { markdown: plainText, plainText }, diagnostics: [] }
  }
}

export function exportSourceTranslationSelection(
  markdown: string,
): ExportedTranslationSelection {
  return {
    content: {
      markdown,
      plainText: sourceMarkdownToPlainText(markdown),
    },
    diagnostics: [],
  }
}
