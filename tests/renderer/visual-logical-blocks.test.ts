import { Schema, type Mark, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { expect, it } from 'vitest'
import { describeVisualLogicalBlocks } from '../../src/renderer/editor/visual-logical-blocks'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { content: 'inline*', group: 'block' },
    hardbreak: {
      group: 'inline', inline: true, atom: true,
      attrs: { isInline: { default: true } },
    },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
    blockquote: { content: 'block+', group: 'block' },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*' },
    code_block: { content: 'text*', group: 'block', marks: '' },
    table: { content: 'table_header_row table_row*', group: 'block' },
    table_header_row: { content: 'table_header+' },
    table_row: { content: 'table_cell+' },
    table_header: { content: 'block+' },
    table_cell: { content: 'block+' },
    image: {
      group: 'inline', inline: true, atom: true,
      attrs: { src: {}, alt: { default: '' }, title: { default: null } },
    },
  },
  marks: {
    strong: {}, em: {}, link: { attrs: { href: {} } }, code_inline: {},
  },
})

const text = (value: string, marks: readonly Mark[] = []) => schema.text(value, marks)
const paragraph = (...content: ProseMirrorNode[]) => schema.nodes.paragraph!.create(null, content)
const hardbreak = () => schema.nodes.hardbreak!.create({ isInline: true })
const heading = (value: string) => schema.nodes.heading!.create({ level: 1 }, text(value))
const row = (type: 'table_header_row' | 'table_row', cells: readonly string[]) => schema.nodes[type]!.create(
  null,
  cells.map((value) => schema.nodes[type === 'table_header_row' ? 'table_header' : 'table_cell']!
    .create(null, paragraph(text(value)))),
)

it('describes outer blocks in source order without duplicate owned paragraphs', () => {
  const nestedItem = schema.nodes.list_item!.create(null, paragraph(text('inner')))
  const outerItem = schema.nodes.list_item!.create(null, [
    paragraph(text('outer')),
    schema.nodes.bullet_list!.create(null, nestedItem),
  ])
  const doc = schema.nodes.doc!.create(null, [
    heading('Title'),
    paragraph(text('plain')),
    schema.nodes.bullet_list!.create(null, outerItem),
    schema.nodes.blockquote!.create(null, paragraph(text('quote'))),
    schema.nodes.code_block!.create(null, text('  code\n')),
    schema.nodes.table!.create(null, [
      row('table_header_row', ['Head A', 'Head B']),
      row('table_row', ['Cell A', 'Cell B']),
    ]),
  ])

  expect(describeVisualLogicalBlocks(doc).map(({ kind, semanticFingerprint, position }) => ({
    kind, semanticFingerprint: JSON.parse(semanticFingerprint), position,
  }))).toEqual([
    { kind: 'heading', semanticFingerprint: ['heading', ['Title'], 0], position: 0 },
    { kind: 'paragraph', semanticFingerprint: ['paragraph', ['plain'], 0], position: 7 },
    { kind: 'list-item', semanticFingerprint: ['list-item', ['outer'], 0], position: 15 },
    { kind: 'list-item', semanticFingerprint: ['list-item', ['inner'], 0], position: 24 },
    { kind: 'blockquote', semanticFingerprint: ['blockquote', ['quote'], 0], position: 36 },
    { kind: 'code-block', semanticFingerprint: ['code-block', ['  code\n'], 0], position: 45 },
    { kind: 'table-row', semanticFingerprint: ['table-row', ['Head A', 'Head B'], 0], position: 55 },
    { kind: 'table-row', semanticFingerprint: ['table-row', ['Cell A', 'Cell B'], 0], position: 77 },
  ])
})

it('preserves inline semantics and occurrence identity for repeated peers', () => {
  const content = () => paragraph(
    text('label ', [schema.marks.strong!.create()]),
    text('linked', [schema.marks.link!.create({ href: 'https://example.com' })]),
    hardbreak(),
    schema.nodes.image!.create({ src: 'image.png', alt: 'alt' }),
    text(' a_b', [schema.marks.code_inline!.create()]),
  )
  const doc = schema.nodes.doc!.create(null, [content(), content()])
  expect(describeVisualLogicalBlocks(doc).map(block => JSON.parse(block.semanticFingerprint))).toEqual([
    ['paragraph', ['label linked alt a_b'], 0],
    ['paragraph', ['label linked alt a_b'], 1],
  ])
})

it('retains the single empty document block but skips extra empty paragraphs', () => {
  expect(describeVisualLogicalBlocks(schema.nodes.doc!.create(null, paragraph()))
    .map(block => JSON.parse(block.semanticFingerprint))).toEqual([['paragraph', [''], 0]])
  expect(describeVisualLogicalBlocks(schema.nodes.doc!.create(null, [paragraph(), heading('Title')]))
    .map(block => ({ position: block.position, fingerprint: JSON.parse(block.semanticFingerprint) })))
    .toEqual([{ position: 2, fingerprint: ['heading', ['Title'], 0] }])
})
