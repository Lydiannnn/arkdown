import { expect, it } from 'vitest'
import { collectEnabledCommandIds } from '../../src/renderer/context-menu/context-menu-types'
import { buildVisualEditorMenu } from '../../src/renderer/editor/context-menu/editor-menu-model'
import { tableElementToMarkdown } from '../../src/renderer/editor/context-menu/visual-editor-commands'

it('exposes the complete table object menu', () => {
  const ids = collectEnabledCommandIds(buildVisualEditorMenu({
    kind: 'table',
    selectionText: '',
  }))
  expect(ids).toEqual(expect.arrayContaining([
    'table-row-before',
    'table-row-after',
    'table-column-before',
    'table-column-after',
    'table-delete-row',
    'table-delete-column',
    'table-delete',
    'table-align-left',
    'table-align-center',
    'table-align-right',
    'table-move-row-up',
    'table-move-row-down',
    'table-move-column-left',
    'table-move-column-right',
    'table-copy-markdown',
    'table-copy-html',
    'table-format',
  ]))
})

it('serializes the visible table as formatted Markdown', () => {
  const table = document.createElement('table')
  table.innerHTML = `
    <thead><tr><th>名称</th><th>状态</th></tr></thead>
    <tbody><tr><td>A | B</td><td>完成</td></tr></tbody>
  `
  expect(tableElementToMarkdown(table)).toBe(
    '| 名称 | 状态 |\n| --- | --- |\n| A \\| B | 完成 |',
  )
})

it('preserves whole-column alignment when serializing a visible table', () => {
  const table = document.createElement('table')
  table.innerHTML = `
    <thead><tr><th align="left">名称</th><th align="center">状态</th><th align="right">数量</th></tr></thead>
    <tbody><tr><td align="left">A</td><td align="center">完成</td><td align="right">2</td></tr></tbody>
  `
  expect(tableElementToMarkdown(table)).toBe(
    '| 名称 | 状态 | 数量 |\n| :--- | :---: | ---: |\n| A | 完成 | 2 |',
  )
})
