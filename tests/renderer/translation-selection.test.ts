import { Fragment, Schema, Slice, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { Serializer as MarkdownSerializer } from '@milkdown/kit/transformer'
import { describe, expect, it } from 'vitest'
import {
  exportSourceTranslationSelection,
  exportVisualTranslationSelection,
  selectionTouchesTable,
} from '../../src/renderer/editor/translation-selection-content'
import {
  createTranslationSelectionProvenance,
  normalizeAnchorRect,
  normalizeSelectionText,
  selectionEndpointRect,
} from '../../src/renderer/editor/translation-selection'

const selectionSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
    blockquote: { content: 'block+', group: 'block' },
    code_block: {
      content: 'text*',
      group: 'block',
      code: true,
      attrs: { language: { default: '' } },
    },
    bullet_list: { content: 'list_item+', group: 'block' },
    ordered_list: {
      content: 'list_item+',
      group: 'block',
      attrs: { order: { default: 1 } },
    },
    list_item: { content: 'paragraph block*' },
    table: { content: 'table_header_row table_row+', group: 'block', tableRole: 'table' },
    table_header_row: { content: 'table_header+', tableRole: 'row' },
    table_row: { content: 'table_cell+', tableRole: 'row' },
    table_header: {
      content: 'block+',
      tableRole: 'header_cell',
      attrs: {
        alignment: { default: 'left' },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
    },
    table_cell: {
      content: 'block+',
      tableRole: 'cell',
      attrs: {
        alignment: { default: 'left' },
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
    },
    image: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { src: {}, alt: { default: '' } },
    },
    text: { group: 'inline' },
  },
  marks: {
    link: { attrs: { href: {} } },
  },
})

function serializeInline(node: ProseMirrorNode): string {
  let result = ''
  node.forEach((child) => {
    if (child.type.name === 'image') {
      result += `![${String(child.attrs.alt ?? '')}](${String(child.attrs.src ?? '')})`
      return
    }
    let value = child.text ?? ''
    const link = child.marks.find((mark) => mark.type.name === 'link')
    if (link) value = `[${value}](${String(link.attrs.href)})`
    result += value
  })
  return result
}

function serializeBlock(node: ProseMirrorNode): string {
  if (node.type.name === 'heading') return `${'#'.repeat(Number(node.attrs.level))} ${serializeInline(node)}`
  if (node.type.name === 'paragraph') return serializeInline(node)
  if (node.type.name === 'blockquote') return serializeBlock(node.firstChild!).split('\n').map((line) => `> ${line}`).join('\n')
  if (node.type.name === 'code_block') return `\`\`\`${String(node.attrs.language)}\n${node.textContent}\n\`\`\``
  if (node.type.name === 'list_item') return Array.from({ length: node.childCount }, (_, index) => serializeBlock(node.child(index))).join('\n')
  if (node.type.name === 'bullet_list') {
    return Array.from({ length: node.childCount }, (_, index) => `- ${serializeBlock(node.child(index))}`).join('\n')
  }
  if (node.type.name === 'ordered_list') {
    const start = Number(node.attrs.order)
    return Array.from({ length: node.childCount }, (_, index) => `${start + index}. ${serializeBlock(node.child(index))}`).join('\n')
  }
  if (node.type.name === 'table') {
    const rows = Array.from({ length: node.childCount }, (_, rowIndex) => {
      const row = node.child(rowIndex)
      return `| ${Array.from({ length: row.childCount }, (_, cellIndex) => serializeBlock(row.child(cellIndex).firstChild!)).join(' | ')} |`
    })
    return [rows[0], '| --- | --- |', ...rows.slice(1)].join('\n')
  }
  return serializeInline(node)
}

const selectionSerializer: MarkdownSerializer = (documentNode) => (
  Array.from(
    { length: documentNode.childCount },
    (_, index) => serializeBlock(documentNode.child(index)),
  ).join('\n\n')
)

function paragraph(text: string): ProseMirrorNode {
  return selectionSchema.nodes.paragraph!.create(null, selectionSchema.text(text))
}

function listItem(text: string): ProseMirrorNode {
  return selectionSchema.nodes.list_item!.create(null, paragraph(text))
}

function tableNode(): ProseMirrorNode {
  const header = (text: string, width: number) => selectionSchema.nodes.table_header!.create(
    { alignment: 'left', colspan: 1, rowspan: 1, colwidth: [width] },
    paragraph(text),
  )
  const cell = (text: string, width: number) => selectionSchema.nodes.table_cell!.create(
    { alignment: 'left', colspan: 1, rowspan: 1, colwidth: [width] },
    paragraph(text),
  )
  return selectionSchema.nodes.table!.create(null, [
    selectionSchema.nodes.table_header_row!.create(null, [header('Name', 180), header('Value', 96)]),
    selectionSchema.nodes.table_row!.create(null, [cell('One', 180), cell('1', 96)]),
  ])
}

function pointer(
  pointerId: number,
  options: {
    button?: number
    isPrimary?: boolean
    pointerType?: string
  } = {},
): PointerEvent {
  return {
    button: options.button ?? 0,
    isPrimary: options.isPrimary ?? true,
    pointerId,
    pointerType: options.pointerType ?? 'mouse',
  } as PointerEvent
}

describe('translation selection provenance', () => {
  it('authorizes one read after a matching primary left-mouse gesture', () => {
    const provenance = createTranslationSelectionProvenance()

    provenance.pointerDown(pointer(7))

    expect(provenance.pointerUp(pointer(7))).toBe(true)
    expect(provenance.pointerUp(pointer(7))).toBe(false)
  })

  it.each([
    ['composition start', (provenance: ReturnType<typeof createTranslationSelectionProvenance>) => provenance.compositionStart()],
    ['composition end', (provenance: ReturnType<typeof createTranslationSelectionProvenance>) => provenance.compositionEnd()],
    ['drag start', (provenance: ReturnType<typeof createTranslationSelectionProvenance>) => provenance.dragStart()],
    ['context menu', (provenance: ReturnType<typeof createTranslationSelectionProvenance>) => provenance.contextMenu()],
    ['keyboard activity', (provenance: ReturnType<typeof createTranslationSelectionProvenance>) => provenance.keyDown()],
    ['explicit reset', (provenance: ReturnType<typeof createTranslationSelectionProvenance>) => provenance.reset()],
  ])('rejects a gesture invalidated by %s', (_name, invalidate) => {
    const provenance = createTranslationSelectionProvenance()
    provenance.pointerDown(pointer(3))

    invalidate(provenance)

    expect(provenance.pointerUp(pointer(3))).toBe(false)
  })

  it('rejects non-left, non-primary, and non-mouse gestures', () => {
    const provenance = createTranslationSelectionProvenance()

    provenance.pointerDown(pointer(1, { button: 2 }))
    expect(provenance.pointerUp(pointer(1))).toBe(false)

    provenance.pointerDown(pointer(2, { isPrimary: false }))
    expect(provenance.pointerUp(pointer(2))).toBe(false)

    provenance.pointerDown(pointer(3, { pointerType: 'touch' }))
    expect(provenance.pointerUp(pointer(3))).toBe(false)
  })

  it('rejects missing and mismatched pointer-down provenance', () => {
    const provenance = createTranslationSelectionProvenance()

    expect(provenance.pointerUp(pointer(4))).toBe(false)

    provenance.pointerDown(pointer(5))
    expect(provenance.pointerUp(pointer(6))).toBe(false)
    expect(provenance.pointerUp(pointer(5))).toBe(false)
  })

  it('requires a new pointer gesture after active composition ends', () => {
    const provenance = createTranslationSelectionProvenance()

    provenance.compositionStart()
    provenance.pointerDown(pointer(8))
    expect(provenance.pointerUp(pointer(8))).toBe(false)

    provenance.compositionEnd()
    expect(provenance.pointerUp(pointer(8))).toBe(false)

    provenance.pointerDown(pointer(9))
    expect(provenance.pointerUp(pointer(9))).toBe(true)
  })

  it('keeps the composition lock active across explicit reset', () => {
    const provenance = createTranslationSelectionProvenance()

    provenance.compositionStart()
    provenance.reset()
    provenance.pointerDown(pointer(10))
    expect(provenance.pointerUp(pointer(10))).toBe(false)

    provenance.compositionEnd()
    provenance.reset()
    provenance.pointerDown(pointer(11))
    expect(provenance.pointerUp(pointer(11))).toBe(true)
  })
})

describe('translation selection normalization', () => {
  it('normalizes the active endpoint line coordinates independently of the full selection', () => {
    expect(selectionEndpointRect({ left: 42, right: 43, top: 80, bottom: 104 })).toEqual({
      left: 42,
      right: 43,
      top: 80,
      bottom: 104,
      width: 1,
      height: 24,
    })
  })

  it('preserves meaningful source text while normalizing newlines', () => {
    expect(normalizeSelectionText('  **bold**\r\nnext\r  ')).toBe('  **bold**\nnext\n  ')
    expect(normalizeSelectionText(' \r\n\t ')).toBeNull()
    expect(normalizeSelectionText('')).toBeNull()
  })

  it('orders finite rectangle edges and rebuilds nonnegative dimensions', () => {
    expect(normalizeAnchorRect({
      left: 30,
      top: 50,
      right: 10,
      bottom: 20,
      width: -20,
      height: -30,
    })).toEqual({
      left: 10,
      top: 20,
      right: 30,
      bottom: 50,
      width: 20,
      height: 30,
    })
  })

  it.each([
    ['left', Number.NaN],
    ['top', Number.POSITIVE_INFINITY],
    ['right', Number.NEGATIVE_INFINITY],
    ['bottom', Number.NaN],
    ['width', Number.POSITIVE_INFINITY],
    ['height', Number.NaN],
  ])('rejects a non-finite %s value', (field, value) => {
    expect(() => normalizeAnchorRect({
      left: 1,
      top: 2,
      right: 3,
      bottom: 4,
      width: 2,
      height: 2,
      [field]: value,
    })).toThrow(RangeError)
  })
})

describe('translation selection content export', () => {
  it('serializes real visual slices as structured Markdown with a readable summary', () => {
    const link = selectionSchema.marks.link!.create({ href: 'https://example.com' })
    const blocks = [
      selectionSchema.nodes.heading!.create({ level: 2 }, selectionSchema.text('Heading')),
      selectionSchema.nodes.paragraph!.create(null, [
        selectionSchema.text('See '),
        selectionSchema.text('site', [link]),
        selectionSchema.text(' and '),
        selectionSchema.nodes.image!.create({ src: 'cover.png', alt: 'Cover' }),
      ]),
      selectionSchema.nodes.bullet_list!.create(null, listItem('Bullet')),
      selectionSchema.nodes.ordered_list!.create({ order: 3 }, listItem('Ordered')),
      selectionSchema.nodes.blockquote!.create(null, paragraph('Quote')),
      selectionSchema.nodes.code_block!.create(
        { language: 'ts' },
        selectionSchema.text('const value = 1'),
      ),
    ]

    expect(exportVisualTranslationSelection({
      slice: new Slice(Fragment.fromArray(blocks), 0, 0),
      schema: selectionSchema,
      serializer: selectionSerializer,
      selectionTouchesTable: false,
    })).toEqual({
      content: {
        markdown: [
          '## Heading',
          '',
          'See [site](https://example.com) and ![Cover](cover.png)',
          '',
          '- Bullet',
          '',
          '3. Ordered',
          '',
          '> Quote',
          '',
          '```ts',
          'const value = 1',
          '```',
        ].join('\n'),
        plainText: [
          'Heading',
          '',
          'See site and Cover',
          '',
          'Bullet',
          '',
          'Ordered',
          '',
          'Quote',
          '',
          'const value = 1',
        ].join('\n'),
      },
      diagnostics: [],
    })
  })

  it('serializes a complete enhanced table without flattening it', () => {
    expect(exportVisualTranslationSelection({
      slice: new Slice(Fragment.from(tableNode()), 0, 0),
      schema: selectionSchema,
      serializer: selectionSerializer,
      selectionTouchesTable: true,
    })).toEqual({
      content: {
        markdown: '<table data-arkdown-table="1"><colgroup><col width="180"><col width="96"></colgroup><thead><tr><th data-align="left"><p>Name</p></th><th data-align="left"><p>Value</p></th></tr></thead><tbody><tr><td data-align="left"><p>One</p></td><td data-align="left"><p>1</p></td></tr></tbody></table>',
        plainText: 'Name\tValue\nOne\t1',
      },
      diagnostics: [],
    })
  })

  it('degrades a real partial table slice to readable text and a diagnostic', () => {
    const documentNode = selectionSchema.nodes.doc!.create(null, tableNode())
    let from = -1
    let to = -1
    documentNode.descendants((node, position) => {
      if (node.isText && node.text === 'One') from = position
      if (node.isText && node.text === '1') to = position + 1
    })
    const result = exportVisualTranslationSelection({
      slice: documentNode.slice(from, to),
      schema: selectionSchema,
      serializer: selectionSerializer,
      selectionTouchesTable: true,
    })

    expect(result).toEqual({
      content: { markdown: 'One\n\n1', plainText: 'One\n\n1' },
      diagnostics: ['局部表格选区已转换为可读文本。'],
    })
    expect(result.content.markdown).not.toContain('|')
  })

  it('detects and degrades a real text-only slice selected inside one table cell', () => {
    const documentNode = selectionSchema.nodes.doc!.create(null, tableNode())
    let textStart = -1
    documentNode.descendants((node, position) => {
      if (node.isText && node.text === 'One') textStart = position
    })
    const from = textStart + 1
    const to = textStart + 2
    const touchesTable = selectionTouchesTable(documentNode, from, to)
    expect(touchesTable).toBe(true)
    expect(exportVisualTranslationSelection({
      slice: documentNode.slice(from, to),
      schema: selectionSchema,
      serializer: selectionSerializer,
      selectionTouchesTable: touchesTable,
    })).toEqual({
      content: { markdown: 'n', plainText: 'n' },
      diagnostics: ['局部表格选区已转换为可读文本。'],
    })
  })

  it('keeps exact source Markdown while deriving plain text from the same selection', () => {
    const markdown = '# Heading\r\n\r\n- **one**\r\n- [two](https://example.com)\r\n\r\n```ts\r\nvalue()\r\n```'

    expect(exportSourceTranslationSelection(markdown)).toEqual({
      content: {
        markdown,
        plainText: 'Heading\n\none\ntwo\n\nvalue()',
      },
      diagnostics: [],
    })
  })
})
