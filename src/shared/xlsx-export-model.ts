export type XlsxExportRow =
  | { kind: 'line'; value: string }
  | { kind: 'table'; cells: string[][] }

interface ParsedTableRow {
  cells: string[]
  hasPipe: boolean
}

function mediaFileName(target: string): string {
  const normalized = target.trim().replace(/^<|>$/gu, '').replace(/\\/gu, '/')
  const pathname = normalized.split(/[?#]/u, 1)[0] ?? ''
  const fileName = pathname.split('/').at(-1) ?? ''
  try {
    return decodeURIComponent(fileName) || target
  } catch {
    return fileName || target
  }
}

function visibleInlineText(source: string): string {
  return source
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, (_match, alt: string, target: string) => (
      alt || mediaFileName(target)
    ))
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*>/giu, '$1')
    .replace(/<[^>]+>/gu, '')
    .replace(/^(?: {0,3}#{1,6}| {0,3}>|\s*(?:[-+*]|\d+[.)]))\s+/u, '')
    .replace(/(\*\*|__|~~)(.*?)\1/gu, '$2')
    .replace(/(?<!\w)([*_])([^\n]+?)\1(?!\w)/gu, '$2')
    .replace(/\\([\\`*{}\[\]()#+.!|_>-])/gu, '$1')
    .trim()
    .normalize('NFC')
}

function parseTableRow(source: string): ParsedTableRow {
  const trimmed = source.trim()
  const hasPipe = trimmed.includes('|')
  let value = trimmed
  if (value.startsWith('|')) value = value.slice(1)
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1)

  const cells: string[] = []
  let current = ''
  let escaped = false
  let inCode = false
  for (const character of value) {
    if (escaped) {
      current += character === '|' || character === '\\' ? character : `\\${character}`
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '`') {
      inCode = !inCode
      current += character
      continue
    }
    if (character === '|' && !inCode) {
      cells.push(visibleInlineText(current))
      current = ''
      continue
    }
    current += character
  }
  if (escaped) current += '\\'
  cells.push(visibleInlineText(current))
  return { cells, hasPipe }
}

function isDelimiterRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell.trim()))
}

function rectangular(cells: string[][]): string[][] {
  const width = cells.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  return cells.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ''),
  ])
}

export function buildXlsxRows(markdown: string): XlsxExportRow[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const output: XlsxExportRow[] = []
  let index = 0
  let fence: { marker: '`' | '~'; length: number } | null = null

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (fence) {
      const close = line.match(/^ {0,3}(`+|~+)\s*$/u)?.[1]
      if (close?.[0] === fence.marker && close.length >= fence.length) fence = null
      else output.push({ kind: 'line', value: line.normalize('NFC') })
      index += 1
      continue
    }

    const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1]
    if (openingFence) {
      fence = { marker: openingFence[0] as '`' | '~', length: openingFence.length }
      index += 1
      continue
    }

    const header = parseTableRow(line)
    const separator = index + 1 < lines.length ? parseTableRow(lines[index + 1] ?? '') : null
    if (
      header.hasPipe
      && header.cells.length >= 2
      && separator?.hasPipe
      && separator.cells.length === header.cells.length
      && isDelimiterRow(separator.cells)
    ) {
      const rows = [header.cells]
      index += 2
      while (index < lines.length) {
        const body = parseTableRow(lines[index] ?? '')
        if (!body.hasPipe || (lines[index] ?? '').trim() === '') break
        rows.push(body.cells)
        index += 1
      }
      output.push({ kind: 'table', cells: rectangular(rows) })
      continue
    }

    output.push({ kind: 'line', value: line === '' ? '' : visibleInlineText(line) })
    index += 1
  }

  return output
}
