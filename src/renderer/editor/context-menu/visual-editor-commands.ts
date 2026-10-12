import {
  adjustHorizontalRule,
  applyHorizontalRuleDomStyle,
  horizontalRuleAttributesForElement,
  horizontalRuleStyleForCommand,
  serializeHorizontalRule,
  type HorizontalRuleAdjustment,
} from '../horizontal-rule-styles'

export type HorizontalRuleCommandId =
  | 'horizontal-rule-height-increase'
  | 'horizontal-rule-height-decrease'
  | 'horizontal-rule-opacity-increase'
  | 'horizontal-rule-opacity-decrease'
  | 'horizontal-rule-copy'

const HORIZONTAL_RULE_COMMAND_IDS: readonly HorizontalRuleCommandId[] = [
  'horizontal-rule-height-increase',
  'horizontal-rule-height-decrease',
  'horizontal-rule-opacity-increase',
  'horizontal-rule-opacity-decrease',
  'horizontal-rule-copy',
]

export function isHorizontalRuleCommandId(
  value: string,
): value is HorizontalRuleCommandId {
  return HORIZONTAL_RULE_COMMAND_IDS.includes(value as HorizontalRuleCommandId)
}

const HORIZONTAL_RULE_ADJUSTMENTS: Readonly<Partial<Record<
  HorizontalRuleCommandId,
  HorizontalRuleAdjustment
>>> = {
  'horizontal-rule-height-increase': 'height-increase',
  'horizontal-rule-height-decrease': 'height-decrease',
  'horizontal-rule-opacity-increase': 'opacity-increase',
  'horizontal-rule-opacity-decrease': 'opacity-decrease',
}

export function horizontalRuleMarkdownForElement(element: HTMLHRElement): string {
  return serializeHorizontalRule(horizontalRuleAttributesForElement(element))
}

export async function executeHorizontalRuleCommand(
  element: HTMLHRElement,
  commandId: HorizontalRuleCommandId,
  writeText: (value: string) => Promise<void> = (value) => (
    navigator.clipboard?.writeText(value) ?? Promise.resolve()
  ),
): Promise<void> {
  if (commandId === 'horizontal-rule-copy') {
    await writeText(horizontalRuleMarkdownForElement(element))
    return
  }
  const action = HORIZONTAL_RULE_ADJUSTMENTS[commandId]
  if (!action) return
  const attributes = adjustHorizontalRule(horizontalRuleAttributesForElement(element), action)
  applyHorizontalRuleDomStyle(element, attributes)
  element.dispatchEvent(new CustomEvent('arkdown:horizontal-rule-change', {
    bubbles: true,
    detail: {
      action,
      attributes,
      markdown: serializeHorizontalRule(attributes),
    },
  }))
}

function nextFootnoteId(markdown: string): number {
  const ids = new Set<number>()
  for (const match of markdown.matchAll(/\[\^(\d+)\]/g)) ids.add(Number(match[1]))
  let candidate = 1
  while (ids.has(candidate)) candidate += 1
  return candidate
}

export function insertionMarkdownForCommand(
  command: string,
  currentMarkdown: string,
): string | null {
  const horizontalRuleStyle = horizontalRuleStyleForCommand(command)
  if (horizontalRuleStyle) {
    return `\n\n${serializeHorizontalRule(horizontalRuleStyle)}\n\n`
  }
  switch (command) {
    case 'removed-insert-footnote': {
      const id = nextFootnoteId(currentMarkdown)
      return `[^${id}]\n\n[^${id}]: `
    }
    case 'insert-link-reference':
      return '[链接文字][ref]\n\n[ref]: https://'
    case 'insert-horizontal-rule':
      return '\n\n---\n\n'
    case 'insert-table':
      return '|   |   |   |\n|---|---|---|\n|   |   |   |'
    case 'insert-toc':
      return '[TOC]'
    default:
      return null
  }
}

function cellText(cell: HTMLTableCellElement): string {
  return (cell.textContent ?? '')
    .trim()
    .replaceAll('|', '\\|')
    .replace(/\s*\n\s*/g, ' ')
}

function cellAlignment(
  cell: HTMLTableCellElement | undefined,
): 'left' | 'center' | 'right' | null {
  const value = cell?.getAttribute('align')?.toLowerCase()
    ?? cell?.style.textAlign.toLowerCase()
    ?? ''
  if (value === 'left' || value === 'center' || value === 'right') return value
  return null
}

function alignmentMarker(alignment: 'left' | 'center' | 'right' | null): string {
  switch (alignment) {
    case 'left': return ':---'
    case 'center': return ':---:'
    case 'right': return '---:'
    default: return '---'
  }
}

export function tableElementToMarkdown(table: HTMLTableElement): string {
  const tableRows = Array.from(table.rows)
  const rows = tableRows.map((row) => Array.from(row.cells).map(cellText))
  if (!rows.length) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const normalized = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ''),
  ])
  const firstRow = tableRows[0]
  const alignments = Array.from(
    { length: width },
    (_, index) => alignmentMarker(cellAlignment(firstRow?.cells[index])),
  )
  const line = (row: readonly string[]) => `| ${row.join(' | ')} |`
  return [line(normalized[0]!), line(alignments), ...normalized.slice(1).map(line)].join('\n')
}
