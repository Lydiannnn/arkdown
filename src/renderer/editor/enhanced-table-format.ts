export type TableAlignment = 'left' | 'center' | 'right'

export interface EnhancedTableCellDescriptor {
  header: boolean
  alignment: TableAlignment
  html: string
}

export interface EnhancedTableDescriptor {
  columnWidths: Array<number | null>
  rows: EnhancedTableCellDescriptor[][]
}

const CELL_TAGS = new Set([
  'p', 'blockquote', 'pre', 'code', 'ol', 'ul', 'li',
  'input', 'strong', 'em', 'del', 'a', 'br',
])

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;')
}

function hasOnlyAttributes(element: Element, names: readonly string[]): boolean {
  const allowed = new Set(names)
  return Array.from(element.attributes).every((attribute) => allowed.has(attribute.name))
}

function hasOnlyStructuralChildren(element: Element, tagNames: readonly string[]): boolean {
  const allowed = new Set(tagNames)
  return Array.from(element.childNodes).every((child) => {
    if (child.nodeType === Node.TEXT_NODE) return !(child.textContent ?? '').trim()
    return child instanceof Element && allowed.has(child.tagName)
  })
}

function safeHref(value: string): boolean {
  if (!value || /^[./#]/.test(value) || !/^[a-z][a-z\d+.-]*:/i.test(value)) return true
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function sanitizeChildren(element: Element): string | null {
  let result = ''
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      result += escapeText(child.textContent ?? '')
      continue
    }
    if (!(child instanceof Element)) return null
    const sanitized = sanitizeElement(child)
    if (sanitized === null) return null
    result += sanitized
  }
  return result
}

function sanitizeElement(element: Element): string | null {
  const tag = element.tagName.toLowerCase()
  if (!CELL_TAGS.has(tag)) return null
  if (tag === 'a') {
    if (!hasOnlyAttributes(element, ['href', 'title'])) return null
    const href = element.getAttribute('href') ?? ''
    if (!safeHref(href)) return null
    const children = sanitizeChildren(element)
    if (children === null) return null
    const title = element.getAttribute('title')
    return `<a href="${escapeAttribute(href)}"${title ? ` title="${escapeAttribute(title)}"` : ''}>${children}</a>`
  }
  if (tag === 'input') {
    if (!hasOnlyAttributes(element, ['type', 'checked', 'disabled'])) return null
    if ((element.getAttribute('type') ?? '').toLowerCase() !== 'checkbox') return null
    return `<input type="checkbox"${element.hasAttribute('checked') ? ' checked' : ''} disabled>`
  }
  if (!hasOnlyAttributes(element, [])) return null
  if (tag === 'br') return '<br>'
  const children = sanitizeChildren(element)
  if (children === null) return null
  return `<${tag}>${children}</${tag}>`
}

function sanitizeCell(cell: HTMLTableCellElement): string | null {
  let html = ''
  for (const child of Array.from(cell.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const value = child.textContent ?? ''
      if (value.trim()) html += `<p>${escapeText(value)}</p>`
      continue
    }
    if (!(child instanceof Element)) return null
    const sanitized = sanitizeElement(child)
    if (sanitized === null) return null
    html += sanitized
  }
  return html || '<p></p>'
}

function alignmentOf(cell: HTMLTableCellElement): TableAlignment | null {
  const value = (cell.getAttribute('data-align') ?? cell.getAttribute('align') ?? 'left').toLowerCase()
  return value === 'left' || value === 'center' || value === 'right' ? value : null
}

function validStructure(table: HTMLTableElement): boolean {
  if (!hasOnlyAttributes(table, ['data-arkdown-table'])) return false
  if (!hasOnlyStructuralChildren(table, ['COLGROUP', 'THEAD', 'TBODY'])) return false
  let seenColgroup = false
  let seenHead = false
  let seenBody = false
  for (const child of Array.from(table.children)) {
    if (child.tagName === 'COLGROUP') {
      if (seenColgroup || seenHead || seenBody) return false
      seenColgroup = true
      if (!hasOnlyAttributes(child, [])) return false
      if (!hasOnlyStructuralChildren(child, ['COL'])) return false
      for (const col of Array.from(child.children)) {
        if (!hasOnlyAttributes(col, ['width'])) return false
      }
      continue
    }
    if (child.tagName === 'THEAD') {
      if (seenHead || seenBody) return false
      seenHead = true
    } else {
      if (seenBody) return false
      seenBody = true
    }
    if (!hasOnlyAttributes(child, [])) return false
    if (!hasOnlyStructuralChildren(child, ['TR'])) return false
    for (const row of Array.from(child.children)) {
      if (!hasOnlyAttributes(row, [])) return false
      if (!hasOnlyStructuralChildren(row, [child.tagName === 'THEAD' ? 'TH' : 'TD'])) return false
      for (const cell of Array.from(row.children)) {
        if (!hasOnlyAttributes(cell, ['align', 'data-align'])) return false
      }
    }
  }
  return seenBody
}

function countExplicitSectionTags(value: string, tag: 'thead' | 'tbody', closing: boolean): number {
  const expression = new RegExp(`<${closing ? '/' : ''}${tag}\\s*>`, 'giu')
  return Array.from(value.matchAll(expression)).length
}

function hasExplicitTableSections(value: string): boolean {
  const headOpen = countExplicitSectionTags(value, 'thead', false)
  const headClose = countExplicitSectionTags(value, 'thead', true)
  const bodyOpen = countExplicitSectionTags(value, 'tbody', false)
  const bodyClose = countExplicitSectionTags(value, 'tbody', true)
  return headOpen === 1
    && headClose === 1
    && bodyOpen === 1
    && bodyClose === 1
}

export function parseEnhancedTableHtml(value: string): EnhancedTableDescriptor | null {
  if (!hasExplicitTableSections(value)) return null
  const container = document.createElement('div')
  container.innerHTML = value.trim()
  if (container.childElementCount !== 1) return null
  const table = container.firstElementChild
  if (!(table instanceof HTMLTableElement)) return null
  if (Array.from(container.childNodes).some((child) => (
    child !== table
    && (child.nodeType !== Node.TEXT_NODE || Boolean((child.textContent ?? '').trim()))
  ))) return null
  if (table.getAttribute('data-arkdown-table') !== '1' || !validStructure(table)) return null

  const columns = Array.from(table.querySelectorAll(':scope > colgroup > col'))
  const columnWidths = columns.map((column) => {
    const value = column.getAttribute('width') ?? ''
    return /^\d+$/.test(value) && Number(value) >= 24 && Number(value) <= 4000
      ? Number(value)
      : null
  })
  if (columns.some((_, index) => columnWidths[index] === null)) return null

  const sourceRows = [
    ...Array.from(table.tHead?.rows ?? []),
    ...Array.from(table.tBodies).flatMap((body) => Array.from(body.rows)),
  ]
  const headerRows = Array.from(table.tHead?.rows ?? [])
  const bodyRows = Array.from(table.tBodies).flatMap((body) => Array.from(body.rows))
  if (headerRows.length !== 1 || bodyRows.length < 1 || sourceRows.length < 2) return null
  const width = sourceRows[0]?.cells.length ?? 0
  if (!width || sourceRows.some((row) => row.cells.length !== width)) return null
  if (columnWidths.length && columnWidths.length !== width) return null

  const rows: EnhancedTableCellDescriptor[][] = []
  for (const row of sourceRows) {
    const cells: EnhancedTableCellDescriptor[] = []
    for (const cell of Array.from(row.cells)) {
      const alignment = alignmentOf(cell)
      const html = sanitizeCell(cell)
      if (!alignment || html === null) return null
      cells.push({ header: cell.tagName === 'TH', alignment, html })
    }
    rows.push(cells)
  }
  return { columnWidths: columnWidths.length ? columnWidths : Array(width).fill(null), rows }
}

export function serializeEnhancedTableDescriptor(table: EnhancedTableDescriptor): string {
  const columns = table.columnWidths.some((width) => width !== null)
    ? `<colgroup>${table.columnWidths.map((width) => `<col width="${width ?? 120}">`).join('')}</colgroup>`
    : ''
  const row = (cells: EnhancedTableCellDescriptor[]) => `<tr>${cells.map((cell) => {
    const tag = cell.header ? 'th' : 'td'
    return `<${tag} data-align="${cell.alignment}">${cell.html}</${tag}>`
  }).join('')}</tr>`
  const headerRows = table.rows.length && table.rows[0]!.every((cell) => cell.header)
    ? [table.rows[0]!]
    : []
  const bodyRows = headerRows.length ? table.rows.slice(1) : table.rows
  return `<table data-arkdown-table="1">${columns}${headerRows.length ? `<thead>${headerRows.map(row).join('')}</thead>` : ''}<tbody>${bodyRows.map(row).join('')}</tbody></table>`
}
