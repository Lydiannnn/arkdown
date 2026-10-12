import { Schema, type Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { tableNodes } from '@milkdown/kit/prose/tables'
import { describe, expect, it, vi } from 'vitest'
import {
  parseEnhancedTableHtml,
  serializeEnhancedTableDescriptor,
} from '../../src/renderer/editor/enhanced-table-format'
import {
  descriptorToTableNode,
  prepareEnhancedTables,
  restorePreparedEnhancedTables,
  serializeDocumentWithEnhancedTables,
  serializeEnhancedTableNode,
  tableNeedsEnhancedFormat,
} from '../../src/renderer/editor/enhanced-table-schema'

function schema(): Schema {
  const baseTable = tableNodes({
    tableGroup: 'block',
    cellContent: 'block+',
    cellAttributes: {
      alignment: {
        default: 'left',
        getFromDOM: (dom) => dom.getAttribute('data-align') ?? 'left',
        setDOMAttr: (value, attrs) => { attrs['data-align'] = value },
      },
    },
  })
  return new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'inline*', group: 'block', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
      blockquote: { content: 'block+', group: 'block', parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0] },
      code_block: { content: 'text*', group: 'block', code: true, parseDOM: [{ tag: 'pre' }], toDOM: () => ['pre', ['code', 0]] },
      ordered_list: { content: 'list_item+', group: 'block', attrs: { order: { default: 1 } }, parseDOM: [{ tag: 'ol' }], toDOM: () => ['ol', 0] },
      bullet_list: { content: 'list_item+', group: 'block', parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0] },
      list_item: { content: 'paragraph block*', attrs: { checked: { default: null } }, parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0] },
      table: { ...baseTable.table, content: 'table_header_row table_row+' },
      table_header_row: { ...baseTable.table_row, content: 'table_header+' },
      table_row: { ...baseTable.table_row, content: 'table_cell+' },
      table_header: { ...baseTable.table_header, content: 'block+' },
      table_cell: { ...baseTable.table_cell, content: 'block+' },
      text: { group: 'inline' },
      hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
    },
    marks: {
      strong: { parseDOM: [{ tag: 'strong' }], toDOM: () => ['strong', 0] },
      em: { parseDOM: [{ tag: 'em' }], toDOM: () => ['em', 0] },
      strike_through: { parseDOM: [{ tag: 'del' }], toDOM: () => ['del', 0] },
      inline_code: { parseDOM: [{ tag: 'code' }], toDOM: () => ['code', 0] },
      link: { attrs: { href: {} }, parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute('href') }) }], toDOM: (mark) => ['a', { href: mark.attrs.href }, 0] },
    },
  })
}

const source = '<table data-arkdown-table="1"><colgroup><col width="180"><col width="96"></colgroup><thead><tr><th><p>事项</p></th><th data-align="center"><p>状态</p></th></tr></thead><tbody><tr><td><p>一</p><p>二</p><blockquote><p>引用</p></blockquote></td><td data-align="center"><pre><code>ok()</code></pre></td></tr></tbody>\n</table>'

describe('enhanced table editor schema helpers', () => {
  it('builds rich block cells with persistent column widths and serializes them back', () => {
    const editorSchema = schema()
    const descriptor = parseEnhancedTableHtml(source)!
    const table = descriptorToTableNode(editorSchema, descriptor)
    expect(table).not.toBeNull()
    expect(table?.firstChild?.firstChild?.attrs.colwidth).toEqual([180])
    expect(table?.lastChild?.firstChild?.childCount).toBe(3)
    expect(tableNeedsEnhancedFormat(table!)).toBe(true)

    const serialized = serializeEnhancedTableNode(table!)
    expect(parseEnhancedTableHtml(serialized)).toEqual(descriptor)
  })

  it('keeps plain single-paragraph tables in GFM mode', () => {
    const editorSchema = schema()
    const descriptor = parseEnhancedTableHtml('<table data-arkdown-table="1"><thead><tr><th><p>A</p></th></tr></thead><tbody><tr><td><p>B</p></td></tr></tbody></table>')!
    const table = descriptorToTableNode(editorSchema, descriptor)!
    expect(tableNeedsEnhancedFormat(table)).toBe(false)
  })

  it('extracts controlled table blocks into safe parser placeholders', () => {
    const prepared = prepareEnhancedTables(`# 前文\n\n${source}\n\n后文`)
    expect(prepared.valid).toBe(true)
    expect(prepared.markdown).toContain(prepared.tables[0]!.marker)
    expect(prepared.markdown).not.toContain('<table')
    expect(prepared.tables).toHaveLength(1)
    expect(prepared.tables[0]?.descriptor.columnWidths).toEqual([180, 96])
  })

  it('roundtrips legacy single-line descriptor and node serialization at EOF', () => {
    const editorSchema = schema()
    const descriptor = parseEnhancedTableHtml(source)!
    const legacy = serializeEnhancedTableDescriptor(descriptor)
    const table = descriptorToTableNode(editorSchema, descriptor)!
    const nodeSerialized = serializeEnhancedTableNode(table)
    expect(legacy.endsWith('</table>')).toBe(true)
    expect(nodeSerialized.endsWith('</table>')).toBe(true)
    expect(legacy).not.toContain('\n</table>')
    expect(nodeSerialized).not.toContain('\n</table>')

    for (const markdown of [legacy, nodeSerialized]) {
      const prepared = prepareEnhancedTables(markdown, { createNonce: () => 'legacy' })
      expect(prepared.valid).toBe(true)
      expect(prepared.tables).toHaveLength(1)
      const state = EditorState.create({
        doc: editorSchema.nodes.doc!.create(null,
          editorSchema.nodes.paragraph!.create(null, editorSchema.text(prepared.tables[0]!.marker)),
        ),
      })
      let restored = state.doc
      expect(restorePreparedEnhancedTables({
        state,
        dispatch: (transaction) => { restored = transaction.doc },
      }, prepared.tables)).toBe(true)
      expect(restored.firstChild?.type.name).toBe('table')
      expect(restored.firstChild?.firstChild?.firstChild?.attrs.colwidth).toEqual([180])
    }
  })

  it('uses a collision-free marker family without consuming pre-existing marker text', () => {
    const existing = 'ARKDOWN_ENHANCED_TABLE_0'
    const generatedCollision = 'ARKDOWNENHANCEDTABLEfixedX0END'
    const prepared = prepareEnhancedTables(`${existing}\n${generatedCollision}\n\n${source}`, {
      createNonce: () => 'fixed',
    })

    expect(prepared.tables).toHaveLength(1)
    expect(prepared.markdown).toContain(existing)
    expect(prepared.markdown).toContain(generatedCollision)
    expect(prepared.tables[0]?.marker).not.toBe(generatedCollision)
    expect(`${existing}\n${generatedCollision}\n\n${source}`).not.toContain(prepared.tables[0]!.marker)
  })

  it('extracts only real HTML table blocks outside frontmatter, fenced code, and inline code', () => {
    const inlineTable = '<table data-arkdown-table="1"><thead><tr><th><p>Inline</p></th></tr></thead><tbody><tr><td><p>Value</p></td></tr></tbody></table>'
    const markdown = [
      '---',
      'example: |',
      `  ${inlineTable}`,
      '  ---',
      '  ...',
      '---',
      '',
      `\`${inlineTable}\``,
      '',
      '`multiline code span',
      inlineTable,
      'still code`',
      '',
      '```html',
      inlineTable,
      '```',
      '',
      source,
    ].join('\n')

    const prepared = prepareEnhancedTables(markdown, { createNonce: () => 'syntax' })

    expect(prepared.tables).toHaveLength(1)
    expect(prepared.valid).toBe(true)
    expect(prepared.markdown).toContain(`  ${inlineTable}`)
    expect(prepared.markdown).toContain(`\`${inlineTable}\``)
    expect(prepared.markdown).toContain(`\`multiline code span\n${inlineTable}\nstill code\``)
    expect(prepared.markdown).toContain(`\n${inlineTable}\n\`\`\``)
    expect(prepared.markdown).not.toContain(source)
    expect(prepared.markdown).toContain(prepared.tables[0]!.marker)
  })

  it('fails closed when a controlled table closing tag has trailing text', () => {
    const malformed = source.replace('</table>', '</table> trailing text')
    const prepared = prepareEnhancedTables(`Before\n\n${malformed}\n\nAfter`)

    expect(prepared).toEqual({
      markdown: `Before\n\n${malformed}\n\nAfter`,
      tables: [],
      valid: false,
    })
  })

  it.each([
    source.replace('<thead>', 'LOST<thead>'),
    source.replace('<thead>', '<!-- stray node --><thead>'),
  ])('fails closed when controlled table structure contains orphan content', (malformed) => {
    const markdown = `Before\n\n${malformed}\n\nAfter`

    expect(prepareEnhancedTables(markdown)).toEqual({
      markdown,
      tables: [],
      valid: false,
    })
  })

  it('extracts multiple controlled tables with unique markers', () => {
    const prepared = prepareEnhancedTables(`${source}\n\nBetween\n\n${source}`, {
      createNonce: () => 'multiple',
    })

    expect(prepared.valid).toBe(true)
    expect(prepared.tables).toHaveLength(2)
    expect(new Set(prepared.tables.map((table) => table.marker)).size).toBe(2)
    for (const table of prepared.tables) expect(prepared.markdown).toContain(table.marker)
    expect(prepared.markdown).not.toContain('<table')
  })

  it('preserves two- and three-space table indentation and restores multiple list tables in place', () => {
    const editorSchema = schema()
    const indent = (value: string, spaces: number) => value
      .split('\n')
      .map((line) => `${' '.repeat(spaces)}${line}`)
      .join('\n')
    const markdown = [
      '- first',
      '',
      indent(source, 2),
      '',
      '- second',
      '',
      indent(source, 3),
    ].join('\n')
    const prepared = prepareEnhancedTables(markdown, { createNonce: () => 'indented' })

    expect(prepared.valid).toBe(true)
    expect(prepared.tables).toHaveLength(2)
    expect(prepared.markdown).toContain(`\n\n  ${prepared.tables[0]!.marker}\n\n- second`)
    expect(prepared.markdown).toContain(`\n\n   ${prepared.tables[1]!.marker}`)

    const paragraph = (text: string) => editorSchema.nodes.paragraph!.create(
      null,
      editorSchema.text(text),
    )
    const listItem = (label: string, marker: string) => editorSchema.nodes.list_item!.create(
      null,
      [paragraph(label), paragraph(marker)],
    )
    const doc = editorSchema.nodes.doc!.create(null,
      editorSchema.nodes.bullet_list!.create(null, [
        listItem('first', prepared.tables[0]!.marker),
        listItem('second', prepared.tables[1]!.marker),
      ]),
    )
    const state = EditorState.create({ doc })
    let restored = state.doc

    expect(restorePreparedEnhancedTables({
      state,
      dispatch: (transaction) => { restored = transaction.doc },
    }, prepared.tables)).toBe(true)
    const list = restored.firstChild!
    expect(list.child(0).lastChild?.type.name).toBe('table')
    expect(list.child(1).lastChild?.type.name).toBe('table')
  })

  it('does not dispatch a partial restore when any generated marker is missing', () => {
    const editorSchema = schema()
    const prepared = prepareEnhancedTables(`${source}\n\n${source}`, {
      createNonce: () => 'partial',
    })
    const doc = editorSchema.nodes.doc!.create(null,
      editorSchema.nodes.paragraph!.create(null, editorSchema.text(prepared.tables[0]!.marker)),
    )
    const state = EditorState.create({ doc })
    const dispatch = vi.fn()

    expect(restorePreparedEnhancedTables({ state, dispatch }, prepared.tables)).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('uses a Markdown-safe placeholder while serializing an enhanced table', () => {
    const editorSchema = schema()
    const table = descriptorToTableNode(editorSchema, parseEnhancedTableHtml(source)!)!
    const doc = editorSchema.nodes.doc!.create(null, [editorSchema.nodes.paragraph!.create(null, editorSchema.text('Before')), table])
    const serialized = serializeDocumentWithEnhancedTables(
      doc,
      editorSchema,
      (node) => node.textContent.replaceAll('_', '\\_'),
    )
    expect(serialized).toContain('<table data-arkdown-table="1">')
    expect(serialized).not.toContain('ARKDOWN')
  })

  it('serializes multiple enhanced tables without consuming legacy marker text', () => {
    const editorSchema = schema()
    const table = descriptorToTableNode(editorSchema, parseEnhancedTableHtml(source)!)!
    const markerZero = 'ARKDOWNSERIALIZEDTABLE0END'
    const markerOne = 'ARKDOWNSERIALIZEDTABLE1END'
    const paragraph = (text: string) => editorSchema.nodes.paragraph!.create(
      null,
      editorSchema.text(text),
    )
    const doc = editorSchema.nodes.doc!.create(null, [
      paragraph(markerZero),
      table,
      paragraph(markerOne),
      table,
    ])
    const serialized = serializeDocumentWithEnhancedTables(
      doc,
      editorSchema,
      (node) => {
        const blocks: string[] = []
        node.forEach((child) => { blocks.push(child.textContent) })
        return blocks.join('\n\n')
      },
    )

    expect(serialized.startsWith(`${markerZero}\n\n<table data-arkdown-table="1">`)).toBe(true)
    expect(serialized).toContain(`</table>\n\n${markerOne}\n\n<table data-arkdown-table="1">`)
    expect(serialized.match(/<table data-arkdown-table="1">/gu)).toHaveLength(2)
    expect(serialized.match(/ARKDOWNSERIALIZEDTABLE[01]END/gu)).toEqual([
      markerZero,
      markerOne,
    ])
  })

  it('serializes enhanced tables recursively at two- and three-space list positions', () => {
    const editorSchema = schema()
    const descriptor = parseEnhancedTableHtml(source)!
    const table = descriptorToTableNode(editorSchema, descriptor)!
    const paragraph = (text: string) => editorSchema.nodes.paragraph!.create(
      null,
      editorSchema.text(text),
    )
    const listItem = (label: string, nestedTables: readonly ProseMirrorNode[]) => (
      editorSchema.nodes.list_item!.create(null, [paragraph(label), ...nestedTables])
    )
    const doc = editorSchema.nodes.doc!.create(null, [
      editorSchema.nodes.bullet_list!.create(null, listItem('bullet', [table, table])),
      editorSchema.nodes.ordered_list!.create({ order: 1 }, listItem('ordered', [table])),
      editorSchema.nodes.blockquote!.create(null, [paragraph('quote'), table]),
    ])
    const serializeNode = (node: ProseMirrorNode): string => {
      if (node.type.name === 'paragraph') return node.textContent
      if (node.type.name === 'table') return '| lossy |'
      if (node.type.name === 'list_item') {
        const children: string[] = []
        node.forEach((child) => { children.push(serializeNode(child)) })
        return children.join('\n\n')
      }
      if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') {
        const prefix = node.type.name === 'bullet_list' ? '- ' : '1. '
        const indent = ' '.repeat(prefix.length)
        const items: string[] = []
        node.forEach((child) => {
          const lines = serializeNode(child).split('\n')
          items.push(`${prefix}${lines[0]}${lines.slice(1).map((line) => `\n${indent}${line}`).join('')}`)
        })
        return items.join('\n')
      }
      if (node.type.name === 'blockquote') {
        const children: string[] = []
        node.forEach((child) => { children.push(serializeNode(child)) })
        return children.join('\n\n').split('\n').map((line) => `> ${line}`).join('\n')
      }
      const children: string[] = []
      node.forEach((child) => { children.push(serializeNode(child)) })
      return children.join('\n\n')
    }

    const serialized = serializeDocumentWithEnhancedTables(
      doc,
      editorSchema,
      serializeNode,
    )

    expect(serialized).not.toContain('| lossy |')
    expect(serialized.match(/<table data-arkdown-table="1">/gu)).toHaveLength(4)
    expect(serialized).toMatch(/- bullet\n {2}\n {2}<table data-arkdown-table="1">/u)
    expect(serialized).toMatch(/<\/table>\n {2}\n {2}<table data-arkdown-table="1">/u)
    expect(serialized).toMatch(/1\. ordered\n {3}\n {3}<table data-arkdown-table="1">/u)
    expect(serialized).toContain('> quote\n> \n> <table data-arkdown-table="1">')
    expect(serialized.match(/<col width="180"><col width="96">/gu)).toHaveLength(4)
    expect(serialized.match(/<blockquote><p>引用<\/p><\/blockquote>/gu)).toHaveLength(4)
  })
})
