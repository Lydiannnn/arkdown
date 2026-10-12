import { horizontalRuleAttributesForElement } from '../horizontal-rule-styles'
import type { EditorContextSnapshot } from './editor-menu-model'

function asElement(target: EventTarget | Node | null): Element | null {
  if (target instanceof Element) return target
  return target instanceof Node ? target.parentElement : null
}

function attributeSource(image: HTMLImageElement): string {
  return image.getAttribute('data-source') ?? image.getAttribute('src') ?? ''
}

function mermaidMode(host: HTMLElement): 'preview' | 'source' {
  return host.dataset.arkdownMermaidMode === 'source' ? 'source' : 'preview'
}

function mermaidRenderState(host: HTMLElement): 'pending' | 'ready' | 'error' {
  const state = host.dataset.arkdownMermaidRenderState
  return state === 'ready' || state === 'error' ? state : 'pending'
}

export function resolveEditorDomContext(
  target: EventTarget | Node | null,
  selectionText: string,
): EditorContextSnapshot {
  const element = asElement(target)

  const horizontalRule = element?.closest('hr')
  if (horizontalRule instanceof HTMLHRElement) {
    return {
      kind: 'horizontal-rule',
      selectionText,
      horizontalRule: {
        attributes: horizontalRuleAttributesForElement(horizontalRule),
        element: horizontalRule,
      },
    }
  }

  const mermaidHost = element?.closest<HTMLElement>('.arkdown-mermaid-block')
  if (mermaidHost) {
    const renderState = mermaidRenderState(mermaidHost)
    const previewImage = mermaidHost.querySelector<HTMLImageElement>(
      '.arkdown-mermaid-preview img',
    )
    const previewImageSource = previewImage ? attributeSource(previewImage) : ''
    return {
      kind: 'mermaid',
      selectionText,
      mermaidMode: mermaidMode(mermaidHost),
      mermaidRenderState: renderState,
      mermaidImageDataUrl: renderState === 'ready' && previewImageSource.startsWith('data:')
        ? previewImageSource
        : undefined,
    }
  }

  const image = element?.closest('img')
    ?? element?.closest('.arkdown-local-image')?.querySelector('img')
  if (image instanceof HTMLImageElement) {
    const wrapper = image.closest<HTMLElement>('.arkdown-local-image')
    const alignment = wrapper?.dataset.alignment
    return {
      kind: 'image',
      selectionText,
      source: attributeSource(image),
      imageAlignment: alignment === 'left' || alignment === 'right' ? alignment : 'center',
    }
  }

  const table = element?.closest('table')
  if (table instanceof HTMLTableElement) {
    const cell = element?.closest('td, th')
    const row = cell?.closest('tr')
    return {
      kind: 'table',
      selectionText,
      table: {
        rowIndex: row instanceof HTMLTableRowElement ? row.rowIndex : 0,
        rowCount: table.rows.length,
        columnIndex: cell instanceof HTMLTableCellElement ? cell.cellIndex : 0,
        columnCount: row instanceof HTMLTableRowElement ? row.cells.length : 0,
      },
    }
  }

  const link = element?.closest('a')
  if (link instanceof HTMLAnchorElement) {
    return { kind: 'link', selectionText, href: link.getAttribute('href') ?? '' }
  }

  if (element?.closest('pre, .milkdown-code-block')
    && !element.closest('[data-arkdown-frontmatter="true"]')) {
    return { kind: 'code', selectionText }
  }

  return { kind: 'text', selectionText }
}
