import type { SelectionAnchorRect } from '../../shared/selection-translation'

export interface TranslationSelectionProvenance {
  pointerDown(event: PointerEvent): void
  pointerUp(event: PointerEvent): boolean
  compositionStart(): void
  compositionEnd(): void
  dragStart(): void
  contextMenu(): void
  keyDown(): void
  reset(): void
}

function isPrimaryLeftMouse(event: PointerEvent): boolean {
  return (
    event.button === 0
    && event.isPrimary
    && event.pointerType === 'mouse'
  )
}

export function createTranslationSelectionProvenance(): TranslationSelectionProvenance {
  let pendingPointerId: number | null = null
  let compositionActive = false

  const reset = () => {
    pendingPointerId = null
  }

  return {
    pointerDown(event) {
      reset()
      if (!compositionActive && isPrimaryLeftMouse(event)) {
        pendingPointerId = event.pointerId
      }
    },
    pointerUp(event) {
      const authorized = (
        pendingPointerId !== null
        && isPrimaryLeftMouse(event)
        && event.pointerId === pendingPointerId
      )
      reset()
      return authorized
    },
    compositionStart() {
      compositionActive = true
      reset()
    },
    compositionEnd() {
      compositionActive = false
      reset()
    },
    dragStart: reset,
    contextMenu: reset,
    keyDown: reset,
    reset,
  }
}

export function normalizeSelectionText(value: string): string | null {
  const normalized = value.replace(/\r\n?/gu, '\n')
  return normalized.trim() ? normalized : null
}

export function normalizeAnchorRect(
  rect: DOMRect | SelectionAnchorRect,
): SelectionAnchorRect {
  const values = [
    rect.left,
    rect.top,
    rect.right,
    rect.bottom,
    rect.width,
    rect.height,
  ]
  if (!values.every(Number.isFinite)) {
    throw new RangeError('Selection rectangle must contain only finite values.')
  }

  const left = Math.min(rect.left, rect.right)
  const top = Math.min(rect.top, rect.bottom)
  const right = Math.max(rect.left, rect.right)
  const bottom = Math.max(rect.top, rect.bottom)
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

export function selectionEndpointRect(coords: {
  left: number
  top: number
  right: number
  bottom: number
} | null): SelectionAnchorRect | null {
  if (!coords) return null
  return normalizeAnchorRect({
    left: coords.left,
    top: coords.top,
    right: coords.right,
    bottom: coords.bottom,
    width: coords.right - coords.left,
    height: coords.bottom - coords.top,
  })
}

export function pointerReleaseRect(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
): SelectionAnchorRect | null {
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null
  return {
    left: event.clientX,
    top: event.clientY,
    right: event.clientX,
    bottom: event.clientY,
    width: 0,
    height: 0,
  }
}

export function isDocumentTranslationShortcut(
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey'>,
): boolean {
  return (
    !event.altKey
    && (event.ctrlKey || event.metaKey)
    && event.key.toLowerCase() === 'a'
  )
}
