import type { ClipboardFormatsSnapshot } from '../../../shared/contracts'
import { DOMSerializer, Fragment, type Node as ProseMirrorNode, type Schema } from '@milkdown/kit/prose/model'
import type { EditorSelectionTarget } from '../editor-selection-target'
import { serializeDocumentWithEnhancedTables } from '../enhanced-table-schema'

function selectionContent(target: EditorSelectionTarget): Fragment {
  const content = target.slice.content
  // Milkdown has a distinct table_header_row; CellSelection slices may start with either row type.
  return target.cells && content.firstChild?.type.name !== 'table'
    ? Fragment.from(target.cells.table.copy(content)) : content
}

export function selectionTargetPlainText(target: EditorSelectionTarget): string {
  if (!target.cells) return target.slice.content.textBetween(0, target.slice.content.size, '\n')
  const table = selectionContent(target).firstChild
  const rows: string[] = []
  table?.forEach(row => {
    const cells: string[] = []
    row.forEach(cell => { cells.push(cell.textBetween(0, cell.content.size, '\n')) })
    rows.push(cells.join('\t'))
  })
  return rows.join('\n')
}

export function selectionTargetHtml(target: EditorSelectionTarget, schema: Schema): string {
  const holder = document.createElement('div')
  holder.append(DOMSerializer.fromSchema(schema).serializeFragment(selectionContent(target)))
  return sanitizeClipboardHtml(holder.innerHTML)
}

export function selectionTargetMarkdown(target: EditorSelectionTarget, schema: Schema, serialize: (node: ProseMirrorNode) => string): string {
  let content = selectionContent(target)
  if (content.firstChild?.isInline && schema.nodes.paragraph) content = Fragment.from(schema.nodes.paragraph.create(null, content))
  return serializeDocumentWithEnhancedTables(schema.topNodeType.create(null, content), schema, serialize).trim()
}

/** A cut may delete only after this promise succeeds. Never treat a missing writer as success. */
export async function writeSelectionClipboard(plain: string, html: string): Promise<void> {
  if (typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([plain], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    })])
    return
  }
  if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable')
  await navigator.clipboard.writeText(plain)
}

export const CLIPBOARD_FORMAT_TOOLTIPS = Object.freeze({
  plain: '仅粘贴文字，不解析 Markdown 或 HTML 格式',
  markdown: '按 Markdown 语法解析标题、列表、链接等格式',
  html: '读取并转换剪贴板中的 HTML 格式',
  htmlUnavailable: '剪贴板中没有 HTML 格式',
})

export function clipboardFormatAvailability(snapshot: ClipboardFormatsSnapshot): {
  plain: boolean
  markdown: boolean
  html: boolean
} {
  return {
    plain: snapshot.plainText.length > 0,
    markdown: (snapshot.markdown ?? snapshot.plainText).length > 0,
    html: snapshot.html !== null && snapshot.html.length > 0,
  }
}

const REMOVE_ELEMENTS = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'link',
  'meta',
  'base',
]

function isWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\/i.test(value)
}

function safeHref(value: string): boolean {
  if (value.startsWith('#') || isWindowsPath(value)) return true
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'https:' || url.protocol === 'http:')
      && url.username === ''
      && url.password === ''
    )
  } catch {
    return false
  }
}

function safeImageSource(value: string): boolean {
  return (
    isWindowsPath(value)
    || /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i.test(value)
  )
}

export function sanitizeClipboardHtml(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll(REMOVE_ELEMENTS.join(',')).forEach((element) => element.remove())

  for (const element of document.body.querySelectorAll('*')) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLocaleLowerCase('en-US')
      if (
        name.startsWith('on')
        || name === 'srcset'
        || name === 'formaction'
        || name === 'poster'
      ) {
        element.removeAttribute(attribute.name)
      }
    }

    const href = element.getAttribute('href')
    if (href !== null && !safeHref(href)) element.removeAttribute('href')

    const source = element.getAttribute('src')
    if (source !== null && !safeImageSource(source)) element.removeAttribute('src')
  }

  return document.body.innerHTML
}

const BLOCK_ELEMENTS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DIV',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'LI',
  'MAIN',
  'NAV',
  'P',
  'PRE',
  'SECTION',
  'TR',
])

export function plainTextFromHtml(html: string): string {
  const document = new DOMParser().parseFromString(sanitizeClipboardHtml(html), 'text/html')
  const chunks: string[] = []

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      chunks.push(node.textContent ?? '')
      return
    }
    if (!(node instanceof Element)) return
    if (node.tagName === 'BR') {
      chunks.push('\n')
      return
    }
    const block = BLOCK_ELEMENTS.has(node.tagName)
    if (block && chunks.length && !chunks.at(-1)?.endsWith('\n')) chunks.push('\n')
    node.childNodes.forEach(visit)
    if (block && !chunks.at(-1)?.endsWith('\n')) chunks.push('\n')
  }

  document.body.childNodes.forEach(visit)
  return chunks.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
