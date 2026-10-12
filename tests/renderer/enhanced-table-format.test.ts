import { describe, expect, it } from 'vitest'
import {
  parseEnhancedTableHtml,
  serializeEnhancedTableDescriptor,
} from '../../src/renderer/editor/enhanced-table-format'

const richTable = `
<table data-arkdown-table="1">
  <colgroup><col width="180"><col width="96"></colgroup>
  <thead><tr><th data-align="left"><p>事项</p></th><th data-align="center"><p>状态</p></th></tr></thead>
  <tbody><tr>
    <td data-align="left"><p>第一段</p><blockquote><p>引用</p></blockquote><pre><code>const ok = true</code></pre></td>
    <td data-align="center"><ol><li><p>一</p></li></ol><ul><li><p>二</p></li><li><p><input type="checkbox" checked disabled>完成</p></li></ul></td>
  </tr></tbody>
</table>`

describe('controlled enhanced table HTML', () => {
  it('round-trips widths, alignment, paragraphs, quotes, code, and lists', () => {
    const parsed = parseEnhancedTableHtml(richTable)
    expect(parsed).not.toBeNull()
    expect(parsed?.columnWidths).toEqual([180, 96])
    expect(parsed?.rows[0]?.map((cell) => cell.alignment)).toEqual(['left', 'center'])
    expect(parsed?.rows[1]?.[0]?.html).toContain('<blockquote><p>引用</p></blockquote>')
    expect(parsed?.rows[1]?.[0]?.html).toContain('<pre><code>const ok = true</code></pre>')
    expect(parsed?.rows[1]?.[1]?.html).toContain('<ol><li><p>一</p></li></ol>')
    expect(parsed?.rows[1]?.[1]?.html).toContain('type="checkbox" checked disabled')

    const canonical = serializeEnhancedTableDescriptor(parsed!)
    const reparsed = parseEnhancedTableHtml(canonical)
    expect(reparsed).toEqual(parsed)
    expect(canonical).toContain('<table data-arkdown-table="1">')
    expect(canonical).not.toContain('style=')
  })

  it.each([
    '<script>alert(1)</script>',
    '<p onclick="alert(1)">危险</p>',
    '<p style="color:red">危险</p>',
    '<iframe src="https://example.com"></iframe>',
    '<table><tr><td>嵌套</td></tr></table>',
    '<a href="javascript:alert(1)">危险</a>',
  ])('rejects unsafe or unsupported cell content: %s', (content) => {
    const html = `<table data-arkdown-table="1"><thead><tr><th><p>标题</p></th></tr></thead><tbody><tr><td>${content}</td></tr></tbody></table>`
    expect(parseEnhancedTableHtml(html)).toBeNull()
  })

  it('does not claim ordinary HTML tables', () => {
    expect(parseEnhancedTableHtml('<table><tr><td>普通表格</td></tr></table>')).toBeNull()
  })

  it.each([
    `outside-before${richTable}`,
    `${richTable}outside-after`,
    richTable.replace('<thead>', 'LOST<thead>'),
    richTable.replace('<thead>', '<!-- stray node --><thead>'),
  ])('rejects non-whitespace content outside the controlled table structure', (html) => {
    expect(parseEnhancedTableHtml(html)).toBeNull()
  })

  it.each([
    richTable.replace('</thead>', '</thead><thead><tr><th><p>LOST</p></th><th><p>LOST</p></th></tr></thead>'),
    '<table data-arkdown-table="1"><colgroup><col width="180"></colgroup><colgroup><col width="96"></colgroup><thead><tr><th><p>A</p></th><th><p>B</p></th></tr></thead><tbody><tr><td><p>C</p></td><td><p>D</p></td></tr></tbody></table>',
    '<table data-arkdown-table="1"><thead><tr><th><p>A</p></th></tr></thead><colgroup><col width="180"></colgroup><tbody><tr><td><p>B</p></td></tr></tbody></table>',
    '<table data-arkdown-table="1"><thead><tr><th><p>A</p></th></tr></thead></table>',
    '<table data-arkdown-table="1"><thead><tr><th><p>A</p></th></tr></thead><tbody></tbody></table>',
    '<table data-arkdown-table="1"><thead><tr><th><p>A</p></th></tr><tr><th><p>B</p></th></tr></thead><tbody><tr><td><p>C</p></td></tr></tbody></table>',
    '<table data-arkdown-table="1"><tbody><tr><td><p>A</p></td></tr></tbody></table>',
    '<table data-arkdown-table="1"><thead><tr><th><p>A</p></th></tr></thead><tbody><tr><td><p>B</p></td></tr></tbody><tbody><tr><td><p>C</p></td></tr></tbody></table>',
    '<table data-arkdown-table="1"><tr><td><p>A</p></td></tr><tr><td><p>B</p></td></tr></table>',
  ])('rejects repeated, out-of-order, or incomplete table sections', (html) => {
    expect(parseEnhancedTableHtml(html)).toBeNull()
  })
})
