import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { EditorState } from '@milkdown/kit/prose/state'
import { scanMarkdownLogicalBlocks } from './edit-indicators/markdown-logical-blocks'
import { describeVisualLogicalBlocks } from './visual-logical-blocks'

export interface EditorModePosition {
  blockIndex: number
  blockFingerprint: string
  lineOffset: number
  column: number
  sourceOffset?: number
}

function normalizedLines(markdown: string): readonly string[] {
  return markdown.replace(/\r\n|\r/g, '\n').split('\n')
}

function markdownBlocks(markdown: string) {
  const lines = normalizedLines(markdown)
  return {
    lines,
    blocks: scanMarkdownLogicalBlocks(markdown, lines.map(() => 'none')),
  }
}

function nearestBlockIndex(
  blocks: ReturnType<typeof scanMarkdownLogicalBlocks>,
  line: number,
): number {
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  blocks.forEach((block, index) => {
    const distance = line < block.fromLine
      ? block.fromLine - line
      : line > block.toLine
        ? line - block.toLine
        : 0
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  })
  return bestIndex
}

function isFencedCodeStart(line: string): boolean {
  return /^\s{0,3}(?:`{3,}|~{3,})/.test(line)
}

export function captureSourceModePosition(
  markdown: string,
  requestedLine: number,
  requestedColumn: number,
): EditorModePosition | null {
  const { blocks, lines } = markdownBlocks(markdown)
  if (!blocks.length) return null
  const line = Math.max(0, Math.min(Math.trunc(requestedLine), lines.length - 1))
  const blockIndex = nearestBlockIndex(blocks, line)
  const block = blocks[blockIndex]!
  const contentStart = block.kind === 'code-block' && isFencedCodeStart(lines[block.fromLine]!)
    ? Math.min(block.toLine, block.fromLine + 1)
    : block.fromLine
  const lineOffset = Math.max(0, Math.min(line - contentStart, block.toLine - contentStart))
  const column = Math.max(0, Math.min(Math.trunc(requestedColumn), lines[line]!.length))
  return { blockIndex, blockFingerprint: block.semanticFingerprint, lineOffset, column }
}

export function resolveSourceModePosition(
  markdown: string,
  position: EditorModePosition,
): { line: number; column: number } | null {
  if (Number.isInteger(position.sourceOffset) && position.sourceOffset! >= 0) {
    const offset = Math.min(position.sourceOffset!, markdown.length)
    const before = markdown.slice(0, offset)
    const lastBreak = before.lastIndexOf('\n')
    return {
      line: before.split('\n').length - 1,
      column: offset - (lastBreak + 1),
    }
  }
  const { blocks, lines } = markdownBlocks(markdown)
  if (!blocks.length) return null
  const matchedIndex = blocks.findIndex(
    ({ semanticFingerprint }) => semanticFingerprint === position.blockFingerprint,
  )
  const blockIndex = matchedIndex >= 0
    ? matchedIndex
    : Math.max(0, Math.min(Math.trunc(position.blockIndex), blocks.length - 1))
  const block = blocks[blockIndex]!
  const contentStart = block.kind === 'code-block' && isFencedCodeStart(lines[block.fromLine]!)
    ? Math.min(block.toLine, block.fromLine + 1)
    : block.fromLine
  const maximumLine = block.kind === 'code-block'
    && isFencedCodeStart(lines[block.fromLine]!)
    && block.toLine > contentStart
    ? block.toLine - 1
    : block.toLine
  const line = Math.max(contentStart, Math.min(
    contentStart + Math.max(0, Math.trunc(position.lineOffset)),
    maximumLine,
  ))
  return {
    line,
    column: Math.max(0, Math.min(Math.trunc(position.column), lines[line]!.length)),
  }
}

function textLinePosition(text: string, offset: number): { lineOffset: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  const lines = before.split('\n')
  return { lineOffset: lines.length - 1, column: lines.at(-1)?.length ?? 0 }
}

function textOffsetAt(text: string, lineOffset: number, column: number): number {
  const lines = text.split('\n')
  const line = Math.max(0, Math.min(Math.trunc(lineOffset), lines.length - 1))
  let offset = 0
  for (let index = 0; index < line; index += 1) offset += lines[index]!.length + 1
  return offset + Math.max(0, Math.min(Math.trunc(column), lines[line]!.length))
}

export function captureVisualModePosition(
  doc: ProseMirrorNode,
  requestedHead: number,
): EditorModePosition | null {
  const blocks = describeVisualLogicalBlocks(doc)
  if (!blocks.length) return null
  const head = Math.max(0, Math.min(Math.trunc(requestedHead), doc.content.size))
  let blockIndex = blocks.findIndex(({ node, position }) => (
    head >= position && head <= position + node.nodeSize
  ))
  if (blockIndex < 0) {
    blockIndex = head < blocks[0]!.position ? 0 : blocks.length - 1
  }
  const block = blocks[blockIndex]!
  const relative = Math.max(0, Math.min(head - block.position - 1, block.node.textContent.length))
  const within = textLinePosition(block.node.textContent, relative)
  return {
    blockIndex,
    blockFingerprint: block.semanticFingerprint,
    ...within,
  }
}

function visualPositionMarker(doc: ProseMirrorNode, markdown: string): string | null {
  for (let codePoint = 0xE000; codePoint <= 0xF8FF; codePoint += 1) {
    const marker = String.fromCharCode(codePoint)
    if (!doc.textContent.includes(marker) && !markdown.includes(marker)) return marker
  }
  return null
}

function mapBoundaryOffset(
  markdown: string,
  before: string,
  after: string,
  approximate: number,
): number | null {
  const maximumContext = Math.min(96, before.length, after.length)
  const contextLengths = [...new Set([
    maximumContext, 64, 48, 32, 24, 16, 12, 8, 6, 4, 3, 2, 1,
  ].filter((length) => length > 0 && length <= maximumContext))].sort((left, right) => right - left)
  for (const contextLength of contextLengths) {
    const left = before.slice(-contextLength)
    const right = after.slice(0, contextLength)
    const candidates: number[] = []
    let searchFrom = 0
    while (searchFrom <= markdown.length) {
      const found = markdown.indexOf(left, searchFrom)
      if (found < 0) break
      const candidate = found + left.length
      if (markdown.startsWith(right, candidate)) candidates.push(candidate)
      searchFrom = found + Math.max(1, left.length)
    }
    if (candidates.length) {
      return candidates.reduce((nearest, candidate) => (
        Math.abs(candidate - approximate) < Math.abs(nearest - approximate) ? candidate : nearest
      ))
    }
  }
  return null
}

function mapSerializedMarkerOffset(
  markdown: string,
  markedMarkdown: string,
  marker: string,
): number | null {
  const markerIndex = markedMarkdown.indexOf(marker)
  if (markerIndex < 0 || markedMarkdown.indexOf(marker, markerIndex + marker.length) >= 0) return null
  if (`${markedMarkdown.slice(0, markerIndex)}${markedMarkdown.slice(markerIndex + marker.length)}` === markdown) {
    return markerIndex
  }
  return mapBoundaryOffset(
    markdown,
    markedMarkdown.slice(0, markerIndex),
    markedMarkdown.slice(markerIndex + marker.length),
    markerIndex * (markdown.length / Math.max(1, markedMarkdown.length)),
  )
}

export function captureSerializedVisualModePosition(
  state: EditorState,
  serialize: (doc: ProseMirrorNode) => string,
  targetMarkdown?: string,
): EditorModePosition | null {
  const head = state.selection.head
  const fallback = captureVisualModePosition(state.doc, head)
  try {
    const markdown = serialize(state.doc)
    const marker = visualPositionMarker(state.doc, markdown)
    if (!marker) return fallback
    const transaction = state.tr.insertText(marker, head)
    if (!transaction.docChanged) return fallback
    const serializedOffset = mapSerializedMarkerOffset(markdown, serialize(transaction.doc), marker)
    if (serializedOffset === null) return fallback
    const sourceOffset = targetMarkdown === undefined || targetMarkdown === markdown
      ? serializedOffset
      : mapBoundaryOffset(
          targetMarkdown,
          markdown.slice(0, serializedOffset),
          markdown.slice(serializedOffset),
          serializedOffset * (targetMarkdown.length / Math.max(1, markdown.length)),
        )
    if (sourceOffset === null) return fallback
    return {
      blockIndex: fallback?.blockIndex ?? 0,
      blockFingerprint: fallback?.blockFingerprint ?? '',
      lineOffset: fallback?.lineOffset ?? 0,
      column: fallback?.column ?? 0,
      sourceOffset,
    }
  } catch {
    return fallback
  }
}

export function resolveVisualModePosition(
  doc: ProseMirrorNode,
  position: EditorModePosition,
): { blockIndex: number; selection: number } | null {
  const blocks = describeVisualLogicalBlocks(doc)
  if (!blocks.length) return null
  const matchedIndex = blocks.findIndex(
    ({ semanticFingerprint }) => semanticFingerprint === position.blockFingerprint,
  )
  const blockIndex = matchedIndex >= 0
    ? matchedIndex
    : Math.max(0, Math.min(Math.trunc(position.blockIndex), blocks.length - 1))
  const block = blocks[blockIndex]!
  const offset = textOffsetAt(block.node.textContent, position.lineOffset, position.column)
  return {
    blockIndex,
    selection: Math.max(block.position + 1, Math.min(
      block.position + 1 + offset,
      block.position + block.node.nodeSize - 1,
    )),
  }
}
