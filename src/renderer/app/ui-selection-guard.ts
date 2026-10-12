const TEXT_SELECTION_SELECTOR = [
  'input',
  'textarea',
  '[contenteditable="true"]',
  '.ProseMirror',
  '.cm-content',
  '.translation-output',
  '[data-ui-selectable="true"]',
].join(',')

const NATIVE_SELECT_ALL_SELECTOR = [
  'input',
  'textarea',
  '[contenteditable="true"]',
  '.ProseMirror',
  '.cm-content',
].join(',')

const MAIN_APP_PORTAL_SELECTOR = '[data-ui-selection-portal="true"]'

function asElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target
  return target instanceof Node ? target.parentElement : null
}

function isPrimarySelectAll(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'a'
    && event.ctrlKey !== event.metaKey
    && !event.altKey
    && !event.shiftKey
}

export function isTextSelectionSurface(target: EventTarget | null): boolean {
  return Boolean(asElement(target)?.closest(TEXT_SELECTION_SELECTOR))
}

export function isNativeSelectAllSurface(target: EventTarget | null): boolean {
  return Boolean(asElement(target)?.closest(NATIVE_SELECT_ALL_SELECTOR))
}

export function selectReadableRegion(element: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(element)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export function mainAppPortalMarker(): 'true' | undefined {
  return document.querySelector('.app-shell') ? 'true' : undefined
}

export function installUiSelectionGuard(root: HTMLElement): () => void {
  const ownerDocument = root.ownerDocument
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = asElement(event.target)
    if (
      event.defaultPrevented
      || event.isComposing
      || !isPrimarySelectAll(event)
      || (!root.contains(target) && !target?.closest(MAIN_APP_PORTAL_SELECTOR))
    ) return

    if (isNativeSelectAllSurface(event.target)) return

    const readableRegion = asElement(event.target)?.closest<HTMLElement>('[data-ui-selectable="true"]')
    event.preventDefault()
    if (readableRegion) selectReadableRegion(readableRegion)
  }

  ownerDocument.addEventListener('keydown', handleKeyDown, true)
  return () => ownerDocument.removeEventListener('keydown', handleKeyDown, true)
}
