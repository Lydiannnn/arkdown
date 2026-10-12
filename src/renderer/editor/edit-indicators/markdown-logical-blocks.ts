import type { EditIndicatorState } from './line-diff'

export type MarkdownLogicalBlockKind =
  | 'paragraph'
  | 'heading'
  | 'list-item'
  | 'blockquote'
  | 'code-block'
  | 'table-row'

export interface LogicalBlockIndicator {
  index: number
  kind: MarkdownLogicalBlockKind
  fromLine: number
  toLine: number
  semanticFingerprint: string
  state: EditIndicatorState
  lineStates?: readonly EditIndicatorState[]
}

function normalizeSemanticParts(
  kind: MarkdownLogicalBlockKind,
  semanticParts: readonly string[],
): string[] {
  return semanticParts.map((part) => {
    const normalized = part.normalize('NFC')
    return kind === 'code-block'
      ? normalized
      : normalized.trim().replace(/\s+/g, ' ')
  })
}

export function createLogicalBlockSemanticFingerprint(input: {
  kind: MarkdownLogicalBlockKind
  semanticParts: readonly string[]
  occurrence: number
}): string {
  return JSON.stringify([
    input.kind,
    normalizeSemanticParts(input.kind, input.semanticParts),
    input.occurrence,
  ])
}

function inlineText(markdown: string): string {
  let nonceIndex = 0
  let nonce = `\uE000arkdown:${nonceIndex}\uE001`
  while (markdown.includes(nonce)) {
    nonceIndex += 1
    nonce = `\uE000arkdown:${nonceIndex}\uE001`
  }
  const protectedParts: string[] = []
  const protect = (value: string) => {
    const token = `${nonce}${protectedParts.length}\uE002`
    protectedParts.push(value)
    return token
  }
  let text = markdown.replace(
    /(`+)([\s\S]*?)\1/g,
    (_match, _ticks: string, content: string) => protect(content),
  )
  text = text.replace(
    /<([^<>\s]+)>/g,
    (match, destination: string, offset: number, source: string) => {
      let precedingBackslashes = 0
      for (let index = offset - 1; index >= 0 && source[index] === '\\'; index -= 1) {
        precedingBackslashes += 1
      }
      if (precedingBackslashes % 2 !== 0) return match
      return (
        COMMONMARK_URI_AUTOLINK.test(destination)
        || COMMONMARK_EMAIL_AUTOLINK.test(destination)
          ? protect(destination)
          : match
      )
    },
  )
  text = text
    .replace(/\\([\\`*{}\[\]()#+\-.!_|<>~])/g, (_match, escaped: string) => protect(escaped))
    // CommonMark does not treat underscores inside words as emphasis delimiters.
    .replace(/(?<=[\p{L}\p{N}])_+(?=[\p{L}\p{N}])/gu, (literal) => protect(literal))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]+/g, '')
  if (protectedParts.length === 0) return text
  const escapedNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(
    new RegExp(`${escapedNonce}(\\d+)\uE002`, 'g'),
    (token, rawIndex: string) => protectedParts[Number(rawIndex)] ?? token,
  )
}

function blockquoteText(line: string): string {
  let text = line
  while (BLOCKQUOTE.test(text)) text = text.replace(BLOCKQUOTE, '')
  return text
}

function aggregateState(
  lineStates: readonly EditIndicatorState[],
  fromLine: number,
  toLine: number,
): EditIndicatorState {
  let state: EditIndicatorState = 'none'
  for (let line = fromLine; line <= toLine; line += 1) {
    if (lineStates[line] === 'unsaved') return 'unsaved'
    if (lineStates[line] === 'saved') state = 'saved'
  }
  return state
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/
const ATX_HEADING = /^\s{0,3}#{1,6}(?:\s+|$)/
const SETEXT_UNDERLINE = /^\s{0,3}(?:=+|-+)\s*$/
const LIST_ITEM = /^\s{0,3}(?:[-+*]|\d+[.)])\s+/
const BLOCKQUOTE = /^\s{0,3}>\s?/
const INDENTED_CODE = /^(?: {4}|\t)/
const COMMONMARK_URI_AUTOLINK = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\u0000-\u0020\u007f]*$/
const COMMONMARK_EMAIL_DOMAIN_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?'
const COMMONMARK_EMAIL_AUTOLINK = new RegExp(
  `^[A-Za-z0-9.#$%&'*+/=?^_\`{|}~-]+@${COMMONMARK_EMAIL_DOMAIN_LABEL}(?:\\.${COMMONMARK_EMAIL_DOMAIN_LABEL})*$`,
)

function parseTableCells(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let codeFenceLength = 0
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (character === '\\' && line[index + 1] === '|') {
      cell += '|'
      index += 1
      continue
    }
    if (character === '`') {
      let runLength = 1
      while (line[index + runLength] === '`') runLength += 1
      if (codeFenceLength === 0) codeFenceLength = runLength
      else if (codeFenceLength === runLength) codeFenceLength = 0
      cell += '`'.repeat(runLength)
      index += runLength - 1
      continue
    }
    if (character === '|' && codeFenceLength === 0) {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += character
  }
  cells.push(cell)
  if (cells[0]?.trim() === '') cells.shift()
  if (cells.at(-1)?.trim() === '') cells.pop()
  return cells
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableCells(line)
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
}

function isTableHeader(lines: readonly string[], index: number): boolean {
  return index + 1 < lines.length
    && parseTableCells(lines[index]!).length > 1
    && isTableSeparator(lines[index + 1]!)
}

function beginsStructuralBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index]!
  return line.trim() === ''
    || FENCE.test(line)
    || ATX_HEADING.test(line)
    || LIST_ITEM.test(line)
    || BLOCKQUOTE.test(line)
    || INDENTED_CODE.test(line)
    || isTableHeader(lines, index)
    || (index + 1 < lines.length && SETEXT_UNDERLINE.test(lines[index + 1]!))
}

export function scanMarkdownLogicalBlocks(
  markdown: string,
  lineStates: readonly EditIndicatorState[],
): readonly LogicalBlockIndicator[] {
  const lines = markdown.replace(/\r\n|\r/g, '\n').split('\n')
  if (lineStates.length !== lines.length) {
    throw new Error('lineStates must match the visible line count')
  }

  const descriptors: LogicalBlockIndicator[] = []
  const occurrences = new Map<string, number>()
  const emit = (
    kind: MarkdownLogicalBlockKind,
    fromLine: number,
    toLine: number,
    semanticParts: readonly string[],
  ) => {
    const normalizedParts = normalizeSemanticParts(kind, semanticParts)
    const peerKey = JSON.stringify([kind, normalizedParts])
    const occurrence = occurrences.get(peerKey) ?? 0
    occurrences.set(peerKey, occurrence + 1)
    descriptors.push({
      index: descriptors.length,
      kind,
      fromLine,
      toLine,
      semanticFingerprint: createLogicalBlockSemanticFingerprint({
        kind,
        semanticParts: normalizedParts,
        occurrence,
      }),
      state: aggregateState(lineStates, fromLine, toLine),
      ...(kind === 'paragraph' && toLine > fromLine
        ? { lineStates: lineStates.slice(fromLine, toLine + 1) }
        : {}),
    })
  }

  let lineIndex = 0
  while (lineIndex < lines.length) {
    const line = lines[lineIndex]!
    if (line.trim() === '') {
      lineIndex += 1
      continue
    }

    const fence = line.match(FENCE)
    if (fence) {
      const marker = fence[1]![0]!
      const minimumLength = fence[1]!.length
      let endLine = lineIndex + 1
      while (endLine < lines.length && !new RegExp(
        `^\\s{0,3}${marker === '`' ? '`' : '~'}{${minimumLength},}\\s*$`,
      ).test(lines[endLine]!)) endLine += 1
      const closed = endLine < lines.length
      const contentEnd = closed ? endLine : lines.length
      emit('code-block', lineIndex, closed ? endLine : lines.length - 1, [
        lines.slice(lineIndex + 1, contentEnd).join('\n'),
      ])
      lineIndex = closed ? endLine + 1 : lines.length
      continue
    }

    if (INDENTED_CODE.test(line)) {
      let endLine = lineIndex + 1
      while (endLine < lines.length && INDENTED_CODE.test(lines[endLine]!)) endLine += 1
      emit('code-block', lineIndex, endLine - 1, [
        lines.slice(lineIndex, endLine).map((part) => part.replace(INDENTED_CODE, '')).join('\n'),
      ])
      lineIndex = endLine
      continue
    }

    if (ATX_HEADING.test(line)) {
      const content = line
        .replace(/^\s{0,3}#{1,6}(?:\s+|$)/, '')
        .replace(/\s+#+\s*$/, '')
      emit('heading', lineIndex, lineIndex, [inlineText(content)])
      lineIndex += 1
      continue
    }

    if (lineIndex + 1 < lines.length && SETEXT_UNDERLINE.test(lines[lineIndex + 1]!)) {
      emit('heading', lineIndex, lineIndex + 1, [inlineText(line)])
      lineIndex += 2
      continue
    }

    if (isTableHeader(lines, lineIndex)) {
      const emitRow = (rowIndex: number) => {
        emit('table-row', rowIndex, rowIndex, parseTableCells(lines[rowIndex]!).map(inlineText))
      }
      emitRow(lineIndex)
      lineIndex += 2
      while (
        lineIndex < lines.length
        && lines[lineIndex]!.trim() !== ''
        && parseTableCells(lines[lineIndex]!).length > 1
      ) {
        emitRow(lineIndex)
        lineIndex += 1
      }
      continue
    }

    if (LIST_ITEM.test(line)) {
      const parts = [line.replace(LIST_ITEM, '').replace(/^\[[ xX]\]\s*/, '')]
      let endLine = lineIndex + 1
      while (endLine < lines.length) {
        const continuation = lines[endLine]!
        if (/^\s{2,}\S/.test(continuation) && !LIST_ITEM.test(continuation)) {
          parts.push(continuation.trim())
          endLine += 1
          continue
        }
        if (continuation.trim() === '') {
          let nextContentLine = endLine + 1
          while (nextContentLine < lines.length && lines[nextContentLine]!.trim() === '') {
            nextContentLine += 1
          }
          const nextContent = lines[nextContentLine]
          if (
            nextContent !== undefined
            && /^\s{2,}\S/.test(nextContent)
            && !LIST_ITEM.test(nextContent)
          ) {
            endLine = nextContentLine
            continue
          }
        }
        break
      }
      emit('list-item', lineIndex, endLine - 1, [inlineText(parts.join(' '))])
      lineIndex = endLine
      continue
    }

    if (BLOCKQUOTE.test(line)) {
      const parts: string[] = []
      let endLine = lineIndex
      while (endLine < lines.length && BLOCKQUOTE.test(lines[endLine]!)) {
        parts.push(blockquoteText(lines[endLine]!))
        endLine += 1
      }
      emit('blockquote', lineIndex, endLine - 1, [inlineText(parts.join(' '))])
      lineIndex = endLine
      continue
    }

    let endLine = lineIndex + 1
    while (endLine < lines.length && !beginsStructuralBlock(lines, endLine)) endLine += 1
    emit('paragraph', lineIndex, endLine - 1, [
      inlineText(lines.slice(lineIndex, endLine).join(' ')),
    ])
    lineIndex = endLine
  }

  return descriptors
}
