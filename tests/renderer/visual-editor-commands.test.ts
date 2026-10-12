import { expect, it } from 'vitest'
import {
  insertionMarkdownForCommand,
  tableElementToMarkdown,
} from '../../src/renderer/editor/context-menu/visual-editor-commands'
import {
  HORIZONTAL_RULE_STYLES,
  serializeHorizontalRule,
} from '../../src/renderer/editor/horizontal-rule-styles'

it('creates conflict-free structural insertion Markdown', () => {
  expect(insertionMarkdownForCommand('insert-footnote', '')).toBeNull()
  expect(insertionMarkdownForCommand('insert-table', '')).toBe(
    '|   |   |   |\n|---|---|---|\n|   |   |   |',
  )
  expect(insertionMarkdownForCommand('insert-yaml', '# Existing')).toBeNull()
  expect(insertionMarkdownForCommand('insert-yaml', '')).toBeNull()
})

it('inserts every controlled horizontal rule as persistent HTML', () => {
  for (const style of HORIZONTAL_RULE_STYLES) {
    expect(insertionMarkdownForCommand(style.commandId, '# Existing')).toBe(
      `\n\n${serializeHorizontalRule(style)}\n\n`,
    )
  }
})

it('serializes an editor table as compact Markdown', () => {
  const table = document.createElement('table')
  table.innerHTML = `
    <thead><tr><th>Name</th><th>Value</th></tr></thead>
    <tbody><tr><td>A</td><td>1</td></tr></tbody>
  `
  expect(tableElementToMarkdown(table)).toBe(
    '| Name | Value |\n| --- | --- |\n| A | 1 |',
  )
})
