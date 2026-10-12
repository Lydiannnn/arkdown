import { Fragment, type Node as ProseMirrorNode, type NodeSpec, type Schema } from '@milkdown/kit/prose/model'
import { commandsCtx } from '@milkdown/kit/core'
import { DOMParser as ProseMirrorDOMParser } from '@milkdown/kit/prose/model'
import { splitBlock } from '@milkdown/kit/prose/commands'
import { tableCellSchema, tableHeaderSchema } from '@milkdown/kit/preset/gfm'
import { $command, $useKeymap } from '@milkdown/kit/utils'
import { boundedColumnResizingPlugin } from './bounded-column-resizing-plugin'
import {
  parseEnhancedTableHtml,
  serializeEnhancedTableDescriptor,
  type EnhancedTableCellDescriptor,
  type EnhancedTableDescriptor,
  type TableAlignment,
} from './enhanced-table-format'

export const enhancedTableCellSchema = tableCellSchema.extendSchema((previous) => (context) => ({
  ...previous(context),
  content: 'block+',
}))

export const enhancedTableHeaderSchema = tableHeaderSchema.extendSchema((previous) => (context) => ({
  ...previous(context),
  content: 'block+',
}))

export function withRichTableCellContent(spec: NodeSpec): NodeSpec {
  return { ...spec, content: 'block+' }
}

function selectionInsideCell(state: { selection: { $from: { depth: number; node(depth: number): ProseMirrorNode } } }): boolean {
  const resolved = state.selection.$from
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    if (['table_cell', 'table_header'].includes(resolved.node(depth).type.name)) return true
  }
  return false
}

export const splitTableCellParagraphCommand = $command(
  'SplitTableCellParagraph',
  () => () => (state, dispatch) => (
    selectionInsideCell(state) ? splitBlock(state, dispatch) : false
  ),
)
export const enhancedTableEnterKeymap = $useKeymap('enhancedTableEnter', {
  SplitCellParagraph: {
    priority: 200,
    shortcuts: 'Enter',
    command: (context) => {
      const commands = context.get(commandsCtx)
      return () => commands.call(splitTableCellParagraphCommand.key)
    },
  },
})

export const enhancedTableEditorPlugins = [
  enhancedTableCellSchema,
  enhancedTableHeaderSchema,
  boundedColumnResizingPlugin,
  enhancedTableEnterKeymap,
  splitTableCellParagraphCommand,
]

function parseCellContent(schema: Schema, html: string) {
  const container = document.createElement('div')
  container.innerHTML = html
  return ProseMirrorDOMParser.fromSchema(schema).parseSlice(container).content
}

export function descriptorToTableNode(
  schema: Schema,
  descriptor: EnhancedTableDescriptor,
): ProseMirrorNode | null {
  const table = schema.nodes.table
  const headerRow = schema.nodes.table_header_row
  const bodyRow = schema.nodes.table_row
  const headerCell = schema.nodes.table_header
  const bodyCell = schema.nodes.table_cell
  if (!table || !headerRow || !bodyRow || !headerCell || !bodyCell) return null
  if (descriptor.rows.length < 2) return null

  try {
    const rows = descriptor.rows.map((row, rowIndex) => {
      const cells = row.map((cell, columnIndex) => {
        const width = descriptor.columnWidths[columnIndex]
        return (cell.header ? headerCell : bodyCell).createChecked({
          alignment: cell.alignment,
          colspan: 1,
          rowspan: 1,
          colwidth: width === null ? null : [width],
        }, parseCellContent(schema, cell.html))
      })
      return (rowIndex === 0 ? headerRow : bodyRow).createChecked(null, cells)
    })
    return table.createChecked(null, rows)
  } catch {
    return null
  }
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;')
}

function serializeInline(node: ProseMirrorNode): string {
  if (node.type.name === 'hard_break') return '<br>'
  let value = escapeText(node.text ?? node.textContent)
  for (const mark of [...node.marks].reverse()) {
    switch (mark.type.name) {
      case 'strong':
        value = `<strong>${value}</strong>`
        break
      case 'em':
      case 'emphasis':
        value = `<em>${value}</em>`
        break
      case 'strike_through':
      case 'strike':
        value = `<del>${value}</del>`
        break
      case 'inline_code':
        value = `<code>${value}</code>`
        break
      case 'link':
        value = `<a href="${escapeAttribute(String(mark.attrs.href ?? ''))}">${value}</a>`
        break
    }
  }
  return value
}

function serializeInlineContent(node: ProseMirrorNode): string {
  let html = ''
  node.forEach((child) => { html += serializeInline(child) })
  return html
}

function serializeBlocks(node: ProseMirrorNode): string {
  switch (node.type.name) {
    case 'paragraph':
      return `<p>${serializeInlineContent(node)}</p>`
    case 'blockquote': {
      let content = ''
      node.forEach((child) => { content += serializeBlocks(child) })
      return `<blockquote>${content}</blockquote>`
    }
    case 'code_block':
      return `<pre><code>${escapeText(node.textContent)}</code></pre>`
    case 'bullet_list':
    case 'ordered_list': {
      let content = ''
      node.forEach((child) => { content += serializeBlocks(child) })
      const tag = node.type.name === 'ordered_list' ? 'ol' : 'ul'
      return `<${tag}>${content}</${tag}>`
    }
    case 'list_item': {
      let content = ''
      node.forEach((child, _offset, index) => {
        const rendered = serializeBlocks(child)
        if (index === 0 && typeof node.attrs.checked === 'boolean' && rendered.startsWith('<p>')) {
          const checkbox = `<input type="checkbox"${node.attrs.checked ? ' checked' : ''} disabled>`
          content += rendered.replace('<p>', `<p>${checkbox}`)
        } else {
          content += rendered
        }
      })
      return `<li>${content}</li>`
    }
    default:
      return `<p>${escapeText(node.textContent)}</p>`
  }
}

function cellDescriptor(node: ProseMirrorNode): EnhancedTableCellDescriptor {
  let html = ''
  node.forEach((child) => { html += serializeBlocks(child) })
  const alignment = node.attrs.alignment
  return {
    header: node.type.name === 'table_header',
    alignment: alignment === 'center' || alignment === 'right' ? alignment : 'left',
    html: html || '<p></p>',
  }
}

export function tableNodeToDescriptor(node: ProseMirrorNode): EnhancedTableDescriptor {
  const rows: EnhancedTableCellDescriptor[][] = []
  const columnWidths: Array<number | null> = []
  node.forEach((row, _rowOffset, rowIndex) => {
    const cells: EnhancedTableCellDescriptor[] = []
    row.forEach((cell, _cellOffset, columnIndex) => {
      cells.push(cellDescriptor(cell))
      if (rowIndex === 0) {
        const width = Array.isArray(cell.attrs.colwidth) ? Number(cell.attrs.colwidth[0]) : NaN
        columnWidths[columnIndex] = Number.isFinite(width) ? width : null
      }
    })
    rows.push(cells)
  })
  return { columnWidths, rows }
}

export function tableNeedsEnhancedFormat(node: ProseMirrorNode): boolean {
  let enhanced = false
  node.descendants((child) => {
    if (!['table_cell', 'table_header'].includes(child.type.name)) return !enhanced
    if (Array.isArray(child.attrs.colwidth) && child.attrs.colwidth.some((width: unknown) => Number(width) > 0)) {
      enhanced = true
      return false
    }
    if (child.childCount !== 1 || child.firstChild?.type.name !== 'paragraph') {
      enhanced = true
      return false
    }
    return true
  })
  return enhanced
}

export function serializeEnhancedTableNode(node: ProseMirrorNode): string {
  return serializeEnhancedTableDescriptor(tableNodeToDescriptor(node))
}

export interface PreparedEnhancedTable {
  marker: string
  descriptor: EnhancedTableDescriptor
}

export interface PrepareEnhancedTablesOptions {
  readonly createNonce?: () => string
}

interface MarkdownOffsetRange {
  readonly start: number
  readonly end: number
}

function markdownLines(markdown: string): MarkdownOffsetRange[] {
  const lines: MarkdownOffsetRange[] = []
  let start = 0
  while (start < markdown.length) {
    const newline = markdown.indexOf('\n', start)
    const end = newline < 0 ? markdown.length : newline + 1
    lines.push({ start, end })
    start = end
  }
  if (!markdown.length) lines.push({ start: 0, end: 0 })
  return lines
}

function lineText(markdown: string, range: MarkdownOffsetRange): string {
  return markdown.slice(range.start, range.end).replace(/(?:\r?\n)$/u, '')
}

function markdownExcludedRanges(markdown: string): MarkdownOffsetRange[] {
  const lines = markdownLines(markdown)
  const excluded: MarkdownOffsetRange[] = []
  let firstContentLine = 0
  if (lineText(markdown, lines[0]!).replace(/^\uFEFF/u, '').trim() === '---') {
    for (let index = 1; index < lines.length; index += 1) {
      if (/^(?:---|\.\.\.)[ \t]*$/u.test(lineText(markdown, lines[index]!))) {
        excluded.push({ start: lines[0]!.start, end: lines[index]!.end })
        firstContentLine = index + 1
        break
      }
    }
  }

  let fence: { character: '`' | '~'; length: number; start: number } | null = null
  for (let index = firstContentLine; index < lines.length; index += 1) {
    const range = lines[index]!
    const text = lineText(markdown, range)
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`, 'u')
      if (close.test(text)) {
        excluded.push({ start: fence.start, end: range.end })
        fence = null
      }
      continue
    }
    const opening = /^( {0,3})(`{3,}|~{3,})/u.exec(text)
    if (!opening) continue
    const run = opening[2]!
    fence = {
      character: run[0] as '`' | '~',
      length: run.length,
      start: range.start,
    }
  }
  if (fence) excluded.push({ start: fence.start, end: markdown.length })

  let cursor = 0
  while (cursor < markdown.length) {
    const opening = markdown.indexOf('`', cursor)
    if (opening < 0) break
    const openingContainer = excluded.find((range) => opening >= range.start && opening < range.end)
    if (openingContainer) {
      cursor = openingContainer.end
      continue
    }
    let runLength = 1
    while (markdown[opening + runLength] === '`') runLength += 1
    let closingCursor = opening + runLength
    let matched = -1
    while (closingCursor < markdown.length) {
      const closing = markdown.indexOf('`', closingCursor)
      if (closing < 0) break
      const closingContainer = excluded.find((range) => closing >= range.start && closing < range.end)
      if (closingContainer) {
        closingCursor = closingContainer.end
        continue
      }
      let closingLength = 1
      while (markdown[closing + closingLength] === '`') closingLength += 1
      if (closingLength === runLength) {
        matched = closing
        break
      }
      closingCursor = closing + closingLength
    }
    if (matched < 0) {
      cursor = opening + runLength
      continue
    }
    excluded.push({ start: opening, end: matched + runLength })
    cursor = matched + runLength
  }
  return excluded.sort((left, right) => left.start - right.start)
}

function rangeContains(ranges: readonly MarkdownOffsetRange[], offset: number): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end)
}

function enhancedTableBlockRanges(markdown: string): Readonly<{
  blocks: Array<MarkdownOffsetRange & { descriptor: EnhancedTableDescriptor }>
  valid: boolean
}> {
  const excluded = markdownExcludedRanges(markdown)
  const opening = /^( {0,3})<table\b[^>]*data-arkdown-table=["']1["'][^>]*>/gimu
  const closing = /<\/table\s*>/gimu
  const tables: Array<MarkdownOffsetRange & { descriptor: EnhancedTableDescriptor }> = []
  for (const match of markdown.matchAll(opening)) {
    const matchStart = match.index
    if (matchStart === undefined) continue
    const start = matchStart + (match[1]?.length ?? 0)
    if (rangeContains(excluded, start)
      || tables.some((table) => start >= table.start && start < table.end)) continue
    closing.lastIndex = matchStart + match[0].length
    let close: RegExpExecArray | null
    let end = -1
    while ((close = closing.exec(markdown)) !== null) {
      if (!rangeContains(excluded, close.index)) {
        end = close.index + close[0].length
        break
      }
    }
    if (end < 0 || !close) return { blocks: [], valid: false }
    const nextNewline = markdown.indexOf('\n', close.index + close[0].length)
    const lineEnd = nextNewline < 0 ? markdown.length : nextNewline
    const closingTail = markdown.slice(end, lineEnd).replace(/\r$/u, '')
    if (!/^[ \t]*$/u.test(closingTail)) {
      return { blocks: [], valid: false }
    }
    const descriptor = parseEnhancedTableHtml(markdown.slice(start, end))
    if (!descriptor) return { blocks: [], valid: false }
    tables.push({ start, end, descriptor })
  }
  return { blocks: tables, valid: true }
}

function tableMarkerFamily(markdown: string, options: PrepareEnhancedTablesOptions): string {
  const generated = options.createNonce?.()
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  const nonce = generated.replace(/[^0-9A-Za-z]/gu, '') || 'nonce'
  let attempt = 0
  while (true) {
    const family = `ARKDOWNENHANCEDTABLE${nonce}${attempt || ''}X`
    if (!markdown.includes(family)) return family
    attempt += 1
  }
}

export function prepareEnhancedTables(
  markdown: string,
  options: PrepareEnhancedTablesOptions = {},
): {
  markdown: string
  tables: PreparedEnhancedTable[]
  valid: boolean
} {
  const scanned = enhancedTableBlockRanges(markdown)
  if (!scanned.valid) return { markdown, tables: [], valid: false }
  const { blocks } = scanned
  if (!blocks.length) return { markdown, tables: [], valid: true }
  const family = tableMarkerFamily(markdown, options)
  const tables = blocks.map((block, index) => ({
    marker: `${family}${index}END`,
    descriptor: block.descriptor,
  }))
  let prepared = markdown
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]!
    prepared = `${prepared.slice(0, block.start)}${tables[index]!.marker}${prepared.slice(block.end)}`
  }
  return { markdown: prepared, tables, valid: true }
}

function countOccurrences(value: string, search: string): number {
  let count = 0
  let cursor = 0
  while (cursor <= value.length - search.length) {
    const found = value.indexOf(search, cursor)
    if (found < 0) break
    count += 1
    cursor = found + search.length
  }
  return count
}

let serializedTableMarkerInvocation = 0

function serializedTableMarkerFamily(
  documentText: string,
  serializedWithoutTables: string,
): string {
  serializedTableMarkerInvocation = serializedTableMarkerInvocation === Number.MAX_SAFE_INTEGER
    ? 1
    : serializedTableMarkerInvocation + 1
  const generated = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  const nonce = generated.replace(/[^0-9A-Za-z]/gu, '') || 'nonce'
  let attempt = 0
  while (true) {
    const family = `ARKDOWNSERIALIZEDTABLE${serializedTableMarkerInvocation.toString(36)}${nonce}${attempt || ''}X`
    if (!documentText.includes(family) && !serializedWithoutTables.includes(family)) return family
    attempt += 1
  }
}

function documentMarkerCount(documentNode: ProseMirrorNode, marker: string): number {
  let count = 0
  documentNode.forEach((child) => { count += countOccurrences(child.textContent, marker) })
  return count
}

export function restorePreparedEnhancedTables(
  view: { state: { doc: ProseMirrorNode; schema: Schema; tr: any }; dispatch(transaction: any): void },
  tables: readonly PreparedEnhancedTable[],
): boolean {
  if (!tables.length) return false
  if (new Set(tables.map((table) => table.marker)).size !== tables.length) return false
  const byMarker = new Map(tables.map((table) => [table.marker, table.descriptor]))
  const replacements: Array<{ from: number; to: number; node: ProseMirrorNode }> = []
  const matched = new Set<string>()
  view.state.doc.descendants((node, position) => {
    if (node.type.name !== 'paragraph') return true
    const descriptor = byMarker.get(node.textContent)
    if (!descriptor) return true
    const table = descriptorToTableNode(view.state.schema, descriptor)
    if (table && !matched.has(node.textContent)) {
      matched.add(node.textContent)
      replacements.push({ from: position, to: position + node.nodeSize, node: table })
    }
    return false
  })
  if (
    replacements.length !== tables.length
    || tables.some((table) => documentMarkerCount(view.state.doc, table.marker) !== 1)
  ) return false
  let transaction = view.state.tr
  for (const replacement of replacements.reverse()) {
    transaction = transaction.replaceWith(replacement.from, replacement.to, replacement.node)
  }
  if (tables.some((table) => documentMarkerCount(transaction.doc, table.marker) !== 0)) {
    return false
  }
  view.dispatch(transaction)
  return true
}

export function serializeDocumentWithEnhancedTables(
  documentNode: ProseMirrorNode,
  schema: Schema,
  serialize: (node: ProseMirrorNode) => string,
): string {
  const replacements: Array<{ html: string }> = []
  const transform = (
    node: ProseMirrorNode,
    replaceTable: (table: ProseMirrorNode) => ProseMirrorNode,
  ): ProseMirrorNode => {
    if (node.type.name === 'table' && tableNeedsEnhancedFormat(node)) {
      return replaceTable(node)
    }
    if (!node.childCount) return node
    const children: ProseMirrorNode[] = []
    node.forEach((child) => { children.push(transform(child, replaceTable)) })
    return node.copy(Fragment.fromArray(children))
  }
  const contentWithoutTables = transform(
    documentNode,
    (table) => {
      replacements.push({ html: serializeEnhancedTableNode(table) })
      return schema.nodes.paragraph!.create()
    },
  )
  if (!replacements.length) return serialize(documentNode)
  const serializedWithoutTables = serialize(contentWithoutTables)
  const family = serializedTableMarkerFamily(documentNode.textContent, serializedWithoutTables)
  let markerIndex = 0
  const replacementsWithMarkers = replacements.map((replacement, index) => ({
    marker: `${family}${index}END`,
    html: replacement.html,
  }))
  const documentWithMarkers = transform(documentNode, () => {
    const marker = replacementsWithMarkers[markerIndex++]!.marker
    return schema.nodes.paragraph!.create(null, schema.text(marker))
  })
  let markdown = serialize(documentWithMarkers)
  for (const replacement of replacementsWithMarkers) {
    if (countOccurrences(markdown, replacement.marker) !== 1) {
      throw new Error('Enhanced table serialization marker was not preserved exactly once')
    }
    markdown = markdown.replace(replacement.marker, replacement.html)
  }
  return markdown
}
