import { Fragment, Schema, Slice, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { describe, expect, it, vi } from 'vitest'
import {
  exportSourceStickyNoteSelection,
  exportVisualStickyNoteSelection,
} from '../../src/renderer/sticky-notes/sticky-note-selection-export'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } } },
    ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 } } },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*', attrs: { checked: { default: null } } },
    table: { content: 'table_row+', group: 'block', tableRole: 'table' },
    table_row: { content: 'table_cell+', tableRole: 'row' },
    table_cell: { content: 'paragraph+', tableRole: 'cell' },
    image: {
      inline: true,
      group: 'inline',
      attrs: { src: {}, alt: { default: '' } },
    },
    text: { group: 'inline' },
  },
  marks: {
    strong: {},
    emphasis: {},
    link: { attrs: { href: {} } },
  },
})

function tableNode() {
  const paragraph = (text: string) => schema.nodes.paragraph!.create(null, schema.text(text))
  const cell = (text: string) => schema.nodes.table_cell!.create(null, paragraph(text))
  const row = (...cells: string[]) => schema.nodes.table_row!.create(null, cells.map(cell))
  return schema.nodes.table!.create(null, [row('A', 'B'), row('1', '2')])
}

describe('sticky note selection export', () => {
  it.each([false, true])('keeps the minimal nested boundary tree and independent ordered offsets (reverse=%s)', reverse => {
    const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text))
    const item = (...nodes: ProseMirrorNode[]) => schema.nodes.list_item.create(null, nodes)
    const nested = schema.nodes.ordered_list.create({ order: 9 }, [item(p('skip')), item(p('nested'))])
    const doc = schema.nodes.doc.create(null, schema.nodes.ordered_list.create({ order: 5 }, [item(p('outside'), nested), item(p('ending')), item(p('after'))]))
    let from = 0
    let to = 0
    doc.descendants((node, pos) => {
      if (node.isText && node.text === 'nested') from = pos + 2
      if (node.isText && node.text === 'ending') to = pos + 3
    })
    const serialize = vi.fn((node: ProseMirrorNode) => node.textContent)
    exportVisualStickyNoteSelection({ slice: doc.slice(from, to), schema, serialize,
      listContext: { documentNode: doc, from: reverse ? to : from, to: reverse ? from : to } })
    const result = serialize.mock.calls[0]![0]
    result.check()
    expect(result.toJSON()).toEqual(schema.nodes.doc.create(null,
      schema.nodes.ordered_list.create({ order: 5 }, [
        item(schema.nodes.paragraph.create(), schema.nodes.ordered_list.create({ order: 10 }, item(p('sted')))),
        item(p('end')),
      ])).toJSON())
    expect(doc.textContent).toBe('outsideskipnestedendingafter')
  })

  it('keeps a selection entirely inside nested siblings at the nearest list level', () => {
    const p = (text: string) => schema.nodes.paragraph.create(null, schema.text(text))
    const item = (...nodes: ProseMirrorNode[]) => schema.nodes.list_item.create({ checked: true }, nodes)
    const doc = schema.nodes.doc.create(null, schema.nodes.bullet_list.create(null, item(p('parent'),
      schema.nodes.ordered_list.create({ order: 9 }, [item(p('before')), item(p('one')), item(p('two'))]))))
    let from = 0; let to = 0
    doc.descendants((node, pos) => { if (node.text === 'one') from = pos; if (node.text === 'two') to = pos + 3 })
    const serialize = vi.fn((node: ProseMirrorNode) => node.textContent)
    exportVisualStickyNoteSelection({ slice: doc.slice(from, to), schema, serialize, listContext: { documentNode: doc, from, to } })
    const result = serialize.mock.calls[0]![0]
    result.check()
    expect(result.firstChild?.type.name).toBe('ordered_list')
    expect(result.firstChild?.attrs.order).toBe(10)
    expect(result.textContent).toBe('onetwo')
    expect(result.firstChild?.firstChild?.attrs.checked).toBe(true)
  })
  it('retains the selected middle ordered hierarchy with its original starting number', () => {
    const items = ['before', 'middle', 'last', 'after'].map(text => schema.nodes.list_item.create(null,
      schema.nodes.paragraph.create(null, schema.text(text))))
    const doc = schema.nodes.doc.create(null, schema.nodes.ordered_list.create({ order: 5 }, items))
    const from = 1 + items[0]!.nodeSize + 2
    const to = from + items[1]!.nodeSize + items[2]!.nodeSize - 4
    const serialize = vi.fn((node: ProseMirrorNode) => node.textContent)
    exportVisualStickyNoteSelection({ slice: doc.slice(from, to), schema, serialize,
      listContext: { documentNode: doc, from, to } })
    const list = serialize.mock.calls[0]![0].firstChild!
    expect(list.type.name).toBe('ordered_list')
    expect(list.attrs.order).toBe(6)
    expect(list.childCount).toBe(2)
    expect(list.textContent).toBe('middlelast')
  })

  it('exports only a partial inline range, retaining marks without inventing a list item', () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text('beforeboldafter', [schema.marks.strong.create()]))
    const doc = schema.nodes.doc.create(null, schema.nodes.ordered_list.create({ order: 8 }, schema.nodes.list_item.create(null, paragraph)))
    const from = 3 + 6
    const to = from + 4
    const serialize = vi.fn((node: ProseMirrorNode) => node.textContent)
    exportVisualStickyNoteSelection({ slice: doc.slice(from, to), schema, serialize,
      listContext: { documentNode: doc, from, to } })
    const fragment = serialize.mock.calls[0]![0]
    expect(fragment.firstChild?.type.name).toBe('paragraph')
    expect(fragment.textContent).toBe('bold')
    expect(fragment.firstChild?.firstChild?.marks[0]?.type.name).toBe('strong')
  })
  it('returns the exact source-mode selection without normalizing line endings or markup', () => {
    const markdown = '# Before\r\n\r\n- **one**\r\n- [two](https://example.com)\r\n\r\nAfter'
    const from = markdown.indexOf('- **one**')
    const to = markdown.indexOf('\r\n\r\nAfter')

    expect(exportSourceStickyNoteSelection(markdown, from, to)).toEqual({
      markdown: '- **one**\r\n- [two](https://example.com)',
      localResources: [],
      warnings: [],
    })
  })

  it('serializes a complete visual table as a table node instead of flattening it', () => {
    const table = tableNode()
    const serialize = vi.fn((_document: ProseMirrorNode) => '| A | B |\n| - | - |\n| 1 | 2 |')

    const result = exportVisualStickyNoteSelection({
      slice: new Slice(Fragment.from(table), 0, 0),
      schema,
      serialize,
    })

    expect(result.markdown).toContain('| A | B |')
    expect(serialize).toHaveBeenCalledOnce()
    expect(serialize.mock.calls[0]?.[0].firstChild?.type.name).toBe('table')
  })

  it('degrades a partial visual table selection to readable text', () => {
    const cell = tableNode().firstChild!.firstChild!
    const result = exportVisualStickyNoteSelection({
      slice: new Slice(cell.content, 2, 2),
      schema,
      serialize: vi.fn(() => 'must not be used'),
      selectionTouchesTable: true,
    })

    expect(result.markdown).toBe('A')
    expect(result.warnings).toEqual(['局部表格选区已转换为可读文本。'])
  })

  it('reports absolute local resources without copying or rewriting them', () => {
    const markdown = [
      '![封面](C:\\workspace\\images\\cover.png)',
      '<img src="D:\\素材\\detail.jpg" alt="详情">',
      '![网络图](https://example.com/image.png)',
    ].join('\n')

    const result = exportSourceStickyNoteSelection(markdown, 0, markdown.length)

    expect(result.localResources).toEqual([
      { originalReference: 'C:\\workspace\\images\\cover.png', absolutePath: 'C:\\workspace\\images\\cover.png' },
      { originalReference: 'D:\\素材\\detail.jpg', absolutePath: 'D:\\素材\\detail.jpg' },
    ])
    expect(result.markdown).toBe(markdown)
  })
})
