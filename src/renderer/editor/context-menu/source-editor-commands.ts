export interface SourceTextCommandResult {
  markdown: string
  anchor: number
  head: number
}

export const SOURCE_TEXT_WRAPPERS = {
  'toggle-strong': ['**', '**'],
  'toggle-emphasis': ['*', '*'],
  'toggle-strike': ['~~', '~~'],
  'toggle-inline-code': ['`', '`'],
  'toggle-link': ['[', '](https://)'],
  'toggle-underline': ['<u>', '</u>'],
  'toggle-inline-formula': ['$', '$'],
  'toggle-highlight': ['<mark>', '</mark>'],
  'toggle-superscript': ['<sup>', '</sup>'],
  'toggle-subscript': ['<sub>', '</sub>'],
} as const satisfies Readonly<Record<string, readonly [string, string]>>

const MAX_CLEAR_FORMAT_SELECTION = 1_000_000

function wrapSelection(
  markdown: string,
  anchor: number,
  head: number,
  before: string,
  after: string,
): SourceTextCommandResult {
  const from = Math.min(anchor, head)
  const to = Math.max(anchor, head)
  const selected = markdown.slice(from, to)
  if (selected.startsWith(before) && selected.endsWith(after)) {
    const replacement = selected.slice(before.length, selected.length - after.length)
    return {
      markdown: markdown.slice(0, from) + replacement + markdown.slice(to),
      anchor: from,
      head: from + replacement.length,
    }
  }
  const replacement = `${before}${selected}${after}`
  if (from === to) {
    const cursor = from + before.length
    return {
      markdown: markdown.slice(0, from) + replacement + markdown.slice(to),
      anchor: cursor,
      head: cursor,
    }
  }
  return {
    markdown: markdown.slice(0, from) + replacement + markdown.slice(to),
    anchor: from,
    head: from + replacement.length,
  }
}

function clearInlineFormatting(selection: string): string {
  const protectedValues: string[] = []
  const protect = (value: string) => {
    const token = `\u0000ARKDOWN${protectedValues.length}\u0000`
    protectedValues.push(value)
    return token
  }
  let result = selection
    .replace(/\[[^\]\n]*\]\([^\n)]*\)/gu, protect)
    .replace(/\$[^$\n]+\$/gu, protect)
    .replace(/<(?:u|mark|sup|sub)>|<\/(?:u|mark|sup|sub)>/giu, '')
    .replace(/(`+)([^\n]*?)\1/gu, '$2')
    .replace(/(\*\*|__)([^\n]*?)\1/gu, '$2')
    .replace(/~~([^\n]*?)~~/gu, '$1')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/gu, '$1')
    .replace(/(?<!_)_([^_\n]+)_(?!_)/gu, '$1')
  result = result.replace(/\u0000ARKDOWN(\d+)\u0000/gu, (_, index: string) => (
    protectedValues[Number(index)] ?? ''
  ))
  return result
}

function clearSelection(
  markdown: string,
  anchor: number,
  head: number,
): SourceTextCommandResult {
  const from = Math.min(anchor, head)
  const to = Math.max(anchor, head)
  if (from === to || to - from > MAX_CLEAR_FORMAT_SELECTION) return { markdown, anchor, head }
  const replacement = clearInlineFormatting(markdown.slice(from, to))
  return {
    markdown: markdown.slice(0, from) + replacement + markdown.slice(to),
    anchor: from,
    head: from + replacement.length,
  }
}

function selectedLineBounds(markdown: string, anchor: number, head: number) {
  const from = Math.min(anchor, head)
  const to = Math.max(anchor, head)
  const start = markdown.lastIndexOf('\n', Math.max(0, from - 1)) + 1
  const nextBreak = markdown.indexOf('\n', to)
  const end = nextBreak === -1 ? markdown.length : nextBreak
  return { start, end }
}

function moveLine(
  markdown: string,
  anchor: number,
  head: number,
  direction: 'up' | 'down',
): SourceTextCommandResult {
  const { start, end } = selectedLineBounds(markdown, anchor, head)
  const selected = markdown.slice(start, end)

  if (direction === 'up') {
    if (start === 0) return { markdown, anchor, head }
    const previousEnd = start - 1
    const previousStart = markdown.lastIndexOf('\n', Math.max(0, previousEnd - 1)) + 1
    const previous = markdown.slice(previousStart, previousEnd)
    return {
      markdown:
        markdown.slice(0, previousStart)
        + selected + '\n' + previous
        + markdown.slice(end),
      anchor: previousStart,
      head: previousStart + selected.length,
    }
  }

  if (end === markdown.length) return { markdown, anchor, head }
  const nextStart = end + 1
  const followingBreak = markdown.indexOf('\n', nextStart)
  const nextEnd = followingBreak === -1 ? markdown.length : followingBreak
  const next = markdown.slice(nextStart, nextEnd)
  const selectionStart = start + next.length + 1
  return {
    markdown:
      markdown.slice(0, start)
      + next + '\n' + selected
      + markdown.slice(nextEnd),
    anchor: selectionStart,
    head: selectionStart + selected.length,
  }
}

export function applySourceTextCommand(
  markdown: string,
  anchor: number,
  head: number,
  command: string,
): SourceTextCommandResult {
  const wrapper = SOURCE_TEXT_WRAPPERS[command as keyof typeof SOURCE_TEXT_WRAPPERS]
  if (wrapper) return wrapSelection(markdown, anchor, head, wrapper[0], wrapper[1])
  if (command === 'clear-inline-formatting') return clearSelection(markdown, anchor, head)
  if (command === 'move-line-up') return moveLine(markdown, anchor, head, 'up')
  if (command === 'move-line-down') return moveLine(markdown, anchor, head, 'down')
  return { markdown, anchor, head }
}
