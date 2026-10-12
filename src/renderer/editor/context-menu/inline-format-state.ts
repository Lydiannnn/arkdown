import type { EditorState } from '@milkdown/kit/prose/state'
import { SOURCE_TEXT_WRAPPERS } from './source-editor-commands'

export type InlineFormatState = 'on' | 'off' | 'mixed'

export interface InlineFormatStates {
  strike: InlineFormatState
  underline: InlineFormatState
  highlight: InlineFormatState
  superscript: InlineFormatState
  subscript: InlineFormatState
}

type InlineFormatName = keyof InlineFormatStates

const FORMAT_MARK_NAMES: Readonly<Record<InlineFormatName, string>> = {
  strike: 'strike_through',
  underline: 'underline',
  highlight: 'highlight',
  superscript: 'superscript',
  subscript: 'subscript',
}

const FORMAT_COMMAND_IDS: Readonly<Record<InlineFormatName, keyof typeof SOURCE_TEXT_WRAPPERS>> = {
  strike: 'toggle-strike',
  underline: 'toggle-underline',
  highlight: 'toggle-highlight',
  superscript: 'toggle-superscript',
  subscript: 'toggle-subscript',
}

const FORMAT_NAMES = Object.keys(FORMAT_MARK_NAMES) as InlineFormatName[]

function emptyStates(): InlineFormatStates {
  return {
    strike: 'off',
    underline: 'off',
    highlight: 'off',
    superscript: 'off',
    subscript: 'off',
  }
}

export function resolveVisualInlineFormatStates(state: EditorState): InlineFormatStates {
  const result = emptyStates()
  const { selection } = state

  if (selection.empty) {
    const marks = state.storedMarks ?? selection.$from.marks()
    for (const format of FORMAT_NAMES) {
      result[format] = marks.some((mark) => mark.type.name === FORMAT_MARK_NAMES[format])
        ? 'on'
        : 'off'
    }
    return result
  }

  const markedSegments: Record<InlineFormatName, number> = {
    strike: 0,
    underline: 0,
    highlight: 0,
    superscript: 0,
    subscript: 0,
  }
  let textSegments = 0
  state.doc.nodesBetween(selection.from, selection.to, (node, position) => {
    if (!node.isText) return
    const segmentFrom = Math.max(selection.from, position)
    const segmentTo = Math.min(selection.to, position + node.nodeSize)
    if (segmentFrom >= segmentTo) return
    textSegments += 1
    for (const format of FORMAT_NAMES) {
      if (node.marks.some((mark) => mark.type.name === FORMAT_MARK_NAMES[format])) {
        markedSegments[format] += 1
      }
    }
  })

  if (textSegments === 0) return result
  for (const format of FORMAT_NAMES) {
    const marked = markedSegments[format]
    result[format] = marked === 0 ? 'off' : marked === textSegments ? 'on' : 'mixed'
  }
  return result
}

interface WrapperRange {
  openStart: number
  contentStart: number
  contentEnd: number
  closeEnd: number
}

interface Span {
  from: number
  to: number
}

interface WrapperAnalysis {
  balanced: WrapperRange[]
  ambiguous: Span[]
}

function isEscapedToken(markdown: string, tokenStart: number): boolean {
  let backslashes = 0
  for (let index = tokenStart - 1; index >= 0 && markdown[index] === '\\'; index -= 1) {
    backslashes += 1
  }
  return backslashes % 2 === 1
}

function findUnescapedToken(markdown: string, token: string, from: number): number {
  let tokenStart = markdown.indexOf(token, from)
  while (tokenStart !== -1 && isEscapedToken(markdown, tokenStart)) {
    tokenStart = markdown.indexOf(token, tokenStart + 1)
  }
  return tokenStart
}

function wrapperRanges(
  markdown: string,
  before: string,
  after: string,
): WrapperAnalysis {
  const balanced: WrapperRange[] = []
  const ambiguous: Span[] = []

  if (before === after) {
    let pending: number | null = null
    let index = 0
    while (index < markdown.length) {
      const token = findUnescapedToken(markdown, before, index)
      if (token === -1) break
      if (pending === null) {
        pending = token
      } else {
        balanced.push({
          openStart: pending,
          contentStart: pending + before.length,
          contentEnd: token,
          closeEnd: token + after.length,
        })
        pending = null
      }
      index = token + before.length
    }
    if (pending !== null) ambiguous.push({ from: pending, to: markdown.length })
    return { balanced, ambiguous }
  }

  const stack: number[] = []
  let index = 0
  while (index < markdown.length) {
    const opening = findUnescapedToken(markdown, before, index)
    const closing = findUnescapedToken(markdown, after, index)
    if (opening === -1 && closing === -1) break
    if (opening !== -1 && (closing === -1 || opening < closing)) {
      stack.push(opening)
      index = opening + before.length
      continue
    }
    if (stack.length === 0) {
      ambiguous.push({ from: closing, to: closing + after.length })
    } else {
      const openStart = stack.pop()!
      balanced.push({
        openStart,
        contentStart: openStart + before.length,
        contentEnd: closing,
        closeEnd: closing + after.length,
      })
    }
    index = closing + after.length
  }
  for (const openStart of stack) ambiguous.push({ from: openStart, to: markdown.length })
  return { balanced, ambiguous }
}

type HtmlFormatName = Exclude<InlineFormatName, 'strike'>

function htmlWrapperRanges(markdown: string): Record<HtmlFormatName, WrapperAnalysis> {
  const result: Record<HtmlFormatName, WrapperAnalysis> = {
    underline: { balanced: [], ambiguous: [] },
    highlight: { balanced: [], ambiguous: [] },
    superscript: { balanced: [], ambiguous: [] },
    subscript: { balanced: [], ambiguous: [] },
  }
  const formats = Object.keys(result) as HtmlFormatName[]
  const tokens = formats.flatMap((format) => {
    const [before, after] = SOURCE_TEXT_WRAPPERS[FORMAT_COMMAND_IDS[format]]
    return [
      { format, token: before, opening: true },
      { format, token: after, opening: false },
    ]
  })
  const stack: Array<{ format: HtmlFormatName; openStart: number; contentStart: number }> = []
  let index = 0

  while (index < markdown.length) {
    let next: (typeof tokens)[number] | null = null
    let tokenStart = -1
    for (const token of tokens) {
      const candidate = findUnescapedToken(markdown, token.token, index)
      if (candidate !== -1 && (tokenStart === -1 || candidate < tokenStart)) {
        next = token
        tokenStart = candidate
      }
    }
    if (!next) break
    if (next.opening) {
      stack.push({
        format: next.format,
        openStart: tokenStart,
        contentStart: tokenStart + next.token.length,
      })
    } else {
      const opening = stack.at(-1)
      if (opening?.format === next.format) {
        stack.pop()
        result[next.format].balanced.push({
          openStart: opening.openStart,
          contentStart: opening.contentStart,
          contentEnd: tokenStart,
          closeEnd: tokenStart + next.token.length,
        })
      } else {
        let matchingIndex = -1
        for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex -= 1) {
          if (stack[stackIndex]?.format === next.format) {
            matchingIndex = stackIndex
            break
          }
        }
        if (matchingIndex === -1) {
          result[next.format].ambiguous.push({
            from: tokenStart,
            to: tokenStart + next.token.length,
          })
        } else {
          const crossed = stack.splice(matchingIndex)
          const recoveryStart = tokenStart + next.token.length
          let recoveryEnd = recoveryStart
          const closingSearchStarts = new Map<HtmlFormatName, number>()

          for (const pending of crossed.slice(1)) {
            const [, closingToken] = SOURCE_TEXT_WRAPPERS[FORMAT_COMMAND_IDS[pending.format]]
            const searchStart = closingSearchStarts.get(pending.format) ?? recoveryStart
            const closingStart = findUnescapedToken(markdown, closingToken, searchStart)
            if (closingStart === -1) {
              recoveryEnd = markdown.length
              break
            }
            const closingEnd = closingStart + closingToken.length
            closingSearchStarts.set(pending.format, closingEnd)
            recoveryEnd = Math.max(recoveryEnd, closingEnd)
          }

          for (const pending of crossed) {
            result[pending.format].ambiguous.push({
              from: pending.openStart,
              to: recoveryEnd,
            })
          }
          index = recoveryEnd
          continue
        }
      }
    }
    index = tokenStart + next.token.length
  }
  for (const pending of stack) {
    result[pending.format].ambiguous.push({ from: pending.openStart, to: markdown.length })
  }
  return result
}

function touches(from: number, to: number, span: Span): boolean {
  if (from === to) return from >= span.from && from <= span.to
  return from < span.to && to > span.from
}

function sourceFormatState(
  anchor: number,
  head: number,
  analysis: WrapperAnalysis,
): InlineFormatState {
  const from = Math.min(anchor, head)
  const to = Math.max(anchor, head)
  const { balanced, ambiguous } = analysis

  if (ambiguous.some((span) => touches(from, to, span))) return 'mixed'
  if (balanced.some((range) => (
    (from >= range.contentStart && to <= range.contentEnd)
    || (from === range.openStart && to === range.closeEnd)
  ))) return 'on'
  if (balanced.some((range) => touches(from, to, {
    from: range.openStart,
    to: range.closeEnd,
  }))) return 'mixed'
  return 'off'
}

export function resolveSourceInlineFormatStates(
  markdown: string,
  anchor: number,
  head: number,
): InlineFormatStates {
  const result = emptyStates()
  const [strikeBefore, strikeAfter] = SOURCE_TEXT_WRAPPERS[FORMAT_COMMAND_IDS.strike]
  result.strike = sourceFormatState(
    anchor,
    head,
    wrapperRanges(markdown, strikeBefore, strikeAfter),
  )
  const htmlRanges = htmlWrapperRanges(markdown)
  for (const format of Object.keys(htmlRanges) as HtmlFormatName[]) {
    result[format] = sourceFormatState(anchor, head, htmlRanges[format])
  }
  return result
}
