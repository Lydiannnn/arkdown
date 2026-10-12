import { Schema } from '@milkdown/kit/prose/model'
import { EditorState, TextSelection } from '@milkdown/kit/prose/state'
import { tableNodes } from '@milkdown/kit/prose/tables'
import { expect, it } from 'vitest'
import {
  captureSerializedVisualModePosition,
  captureSourceModePosition,
  captureVisualModePosition,
  resolveSourceModePosition,
  resolveVisualModePosition,
} from '../../src/renderer/editor/editor-mode-position'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'text*', group: 'block' },
    heading: { attrs: { level: { default: 1 } }, content: 'text*', group: 'block' },
    code_block: { content: 'text*', group: 'block', code: true },
    text: {},
  },
})

it('maps a fenced source-code line through its logical block', () => {
  const markdown = ['# Intro', '', '```ts', 'const one = 1', 'const two = 2', '```', '', 'Tail'].join('\n')
  const position = captureSourceModePosition(markdown, 4, 6)

  expect(position).toMatchObject({ blockIndex: 1, lineOffset: 1, column: 6 })
  expect(resolveSourceModePosition(markdown, position!)).toEqual({ line: 4, column: 6 })
})

it('uses the nearest logical block when the source caret is on a blank line', () => {
  const markdown = ['First', '', '', 'Second'].join('\n')
  expect(captureSourceModePosition(markdown, 1, 0)).toMatchObject({ blockIndex: 0 })
  expect(captureSourceModePosition(markdown, 2, 0)).toMatchObject({ blockIndex: 1 })
})

it('preserves a visual code-block line and column', () => {
  const doc = schema.node('doc', null, [
    schema.node('heading', { level: 1 }, schema.text('Intro')),
    schema.node('code_block', null, schema.text('const one = 1\nconst two = 2')),
    schema.node('paragraph', null, schema.text('Tail')),
  ])
  const codeStart = doc.child(0).nodeSize + 1
  const head = codeStart + 'const one = 1\n'.length + 6
  const position = captureVisualModePosition(doc, head)

  expect(position).toMatchObject({ blockIndex: 1, lineOffset: 1, column: 6 })
  expect(resolveVisualModePosition(doc, position!)).toMatchObject({
    blockIndex: 1,
    selection: head,
  })
})

it('clamps a stale block position to the nearest surviving block', () => {
  const markdown = '# Only'
  expect(resolveSourceModePosition(markdown, {
    blockIndex: 99,
    blockFingerprint: 'missing',
    lineOffset: 20,
    column: 20,
  })).toEqual({ line: 0, column: 6 })
})

it('uses the semantic fingerprint when unsupported visual blocks shift the ordinal', () => {
  const markdown = ['# Intro', '', '---', '', 'Target paragraph'].join('\n')
  const sourcePosition = captureSourceModePosition(markdown, 4, 3)!
  const visualDoc = schema.node('doc', null, [
    schema.node('heading', { level: 1 }, schema.text('Intro')),
    schema.node('paragraph', null, schema.text('Target paragraph')),
  ])

  expect(sourcePosition.blockIndex).toBe(2)
  expect(resolveVisualModePosition(visualDoc, sourcePosition)).toMatchObject({
    blockIndex: 1,
  })
})

it('maps a visual table-cell caret through the serialized Markdown delimiters', () => {
  const table = tableNodes({
    tableGroup: 'block',
    cellContent: 'paragraph+',
    cellAttributes: {},
  })
  const tableSchema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block' },
      table: table.table,
      table_row: table.table_row,
      table_cell: table.table_cell,
      table_header: table.table_header,
      text: {},
    },
  })
  const cell = (value: string) => tableSchema.nodes.table_cell!.create(
    null,
    tableSchema.nodes.paragraph!.create(null, tableSchema.text(value)),
  )
  const row = (...values: string[]) => tableSchema.nodes.table_row!.create(
    null,
    values.map(cell),
  )
  const doc = tableSchema.nodes.doc!.create(null, [
    tableSchema.nodes.table!.create(null, [
      row('Header A', 'Header B'),
      row('Alpha', 'Bravo'),
    ]),
  ])
  let bravoStart = -1
  doc.descendants((node, position) => {
    if (node.isText && node.text === 'Bravo') bravoStart = position
  })
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, bravoStart + 2),
  })
  const serialize = (documentNode: typeof doc) => {
    const rows: string[][] = []
    documentNode.firstChild!.forEach((rowNode) => {
      const cells: string[] = []
      rowNode.forEach((cellNode) => cells.push(cellNode.textContent))
      rows.push(cells)
    })
    const widths = rows[0]!.map((_, column) => Math.max(
      3,
      ...rows.map((cells) => cells[column]!.length),
    ))
    const rendered = rows.map((cells) => (
      `| ${cells.map((value, column) => value.padEnd(widths[column]!)).join(' | ')} |`
    ))
    rendered.splice(1, 0, `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`)
    return rendered.join('\n')
  }
  const markdown = [
    '| Header A | Header B |',
    '| --- | --- |',
    '| Alpha | Bravo |',
  ].join('\n')

  const position = captureSerializedVisualModePosition(state, serialize, markdown)

  expect(resolveSourceModePosition(markdown, position!)).toEqual({
    line: 2,
    column: markdown.split('\n')[2]!.indexOf('Bravo') + 2,
  })
})

it('maps a visual caret through inline Markdown markers from imported rich text', () => {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text('prefix label suffix')),
  ])
  const labelStart = 'prefix '.length + 1
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, labelStart + 2),
  })
  const serialize = (documentNode: typeof doc) => {
    const text = documentNode.textContent
    return `prefix **[${text.slice('prefix '.length, -' suffix'.length)}](https://example.com)** suffix`
  }
  const markdown = serialize(doc)

  const position = captureSerializedVisualModePosition(state, serialize)

  expect(resolveSourceModePosition(markdown, position!)).toEqual({
    line: 0,
    column: markdown.indexOf('label') + 2,
  })
})

it('uses the serialized caret for an imported block outside the logical-block scanner', () => {
  const importedSchema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      imported_paragraph: { content: 'text*', group: 'block' },
      text: {},
    },
  })
  const doc = importedSchema.node('doc', null, [
    importedSchema.node('imported_paragraph', null, importedSchema.text('Imported DOCX text')),
  ])
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1 + 'Imported '.length),
  })
  const serialize = (documentNode: typeof doc) => `**${documentNode.textContent}**`
  const markdown = serialize(doc)

  const position = captureSerializedVisualModePosition(state, serialize)

  expect(position).not.toBeNull()
  expect(resolveSourceModePosition(markdown, position!)).toEqual({
    line: 0,
    column: '**Imported '.length,
  })
})
