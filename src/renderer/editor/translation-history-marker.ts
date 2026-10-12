export const TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE = 'data-translation-history-anchor-id'
export const TRANSLATION_HISTORY_HIGHLIGHT_CLASS = 'translation-history-highlight'

export function createTranslationHistoryDomAnchor(recordId: string): HTMLElement {
  const anchor = document.createElement('span')
  anchor.className = 'translation-history-dom-anchor'
  anchor.setAttribute(TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE, recordId)
  anchor.setAttribute('aria-hidden', 'true')
  anchor.contentEditable = 'false'
  return anchor
}
