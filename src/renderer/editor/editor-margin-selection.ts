export interface EditorMarginSelectionPoint {
  clientX: number
  clientY: number
}

export interface EditorMarginSelectionPort {
  isEligibleMarginStart(event: PointerEvent): boolean
  activationPositionAtPoint(point: EditorMarginSelectionPoint): number | null
  positionAtPoint(point: EditorMarginSelectionPoint): number | null
  applySelection(anchor: number, head: number): void
  focus(): void
  scrollContainer(): HTMLElement | null
  beginPointerSelection(event: PointerEvent): void
  cancelPointerSelection(): void
}

export interface MarginSelectionController {
  pointerDown(event: PointerEvent, captureTarget: HTMLElement): void
  cancel(): void
  dispose(): void
}

interface MarginSelectionControllerOptions {
  getPort(): EditorMarginSelectionPort | null
  requestFrame?(callback: FrameRequestCallback): number
  cancelFrame?(frame: number): void
}

interface Gesture {
  active: boolean
  anchor: number | null
  captureTarget: HTMLElement
  downEvent: PointerEvent
  frame: number | null
  latestPoint: EditorMarginSelectionPoint
  pointerId: number
  port: EditorMarginSelectionPort
}

const ACTIVATION_DISTANCE_CSS_PX = 4
const AUTOSCROLL_EDGE_CSS_PX = 32
const AUTOSCROLL_MAX_STEP_CSS_PX = 24
const SCROLLBAR_FALLBACK_CSS_PX = 12

const EXCLUDED_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="listbox"]',
  '[data-drop-target]',
  '[data-dragging="true"]',
  '.tableWrapper',
  'table',
  'td',
  'th',
  '.column-resize-handle',
  'img',
  'audio',
  'video',
  '.arkdown-local-image',
  '.arkdown-image-alignment-toolbar',
  '.arkdown-link-editor-popover',
  '.milkdown-code-block .tools',
  '.milkdown-code-block .language-picker',
  '.milkdown-code-block .list-wrapper',
  '.milkdown-code-block .search-box',
  '.cm-gutters',
  '.cm-gutter',
  '.cm-gutterElement',
  '.translation-history-rail-layer',
  '.translation-history-rail-button',
  '.sidebar',
  '.sidebar-resizer',
  '.editor-right-sidebar-motion-track',
  '.editor-right-sidebar',
  '.editor-right-sidebar-splitter',
].join(',')

function safePointerCapture(
  target: HTMLElement,
  method: 'setPointerCapture' | 'releasePointerCapture',
  pointerId: number,
): void {
  try {
    target[method]?.(pointerId)
  } catch {
    // Capture can be unavailable after native focus/window transitions.
  }
}

function isScrollbarPoint(point: EditorMarginSelectionPoint, scroll: HTMLElement): boolean {
  const rect = scroll.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const scaleX = scroll.offsetWidth > 0 ? rect.width / scroll.offsetWidth : 1
  const scaleY = scroll.offsetHeight > 0 ? rect.height / scroll.offsetHeight : 1
  const clientRight = rect.left + scroll.clientWidth * scaleX
  const clientBottom = rect.top + scroll.clientHeight * scaleY
  const verticalWidth = scroll.scrollHeight > scroll.clientHeight
    ? Math.max(rect.right - clientRight, SCROLLBAR_FALLBACK_CSS_PX)
    : Math.max(0, rect.right - clientRight)
  const horizontalHeight = scroll.scrollWidth > scroll.clientWidth
    ? Math.max(rect.bottom - clientBottom, SCROLLBAR_FALLBACK_CSS_PX)
    : Math.max(0, rect.bottom - clientBottom)
  return (
    verticalWidth > 0
    && point.clientX >= rect.right - verticalWidth
    && point.clientX <= rect.right
    && point.clientY >= rect.top
    && point.clientY <= rect.bottom
  ) || (
    horizontalHeight > 0
    && point.clientY >= rect.bottom - horizontalHeight
    && point.clientY <= rect.bottom
    && point.clientX >= rect.left
    && point.clientX <= rect.right
  )
}

export function isEditorMarginSelectionExcluded(
  event: Pick<PointerEvent, 'clientX' | 'clientY' | 'defaultPrevented'>,
  target: EventTarget | null,
  scrollContainer: HTMLElement | null,
): boolean {
  if (event.defaultPrevented) return true
  if (target instanceof Element && target.closest(EXCLUDED_SELECTOR)) return true
  return Boolean(scrollContainer && isScrollbarPoint(event, scrollContainer))
}

function autoscrollStep(point: EditorMarginSelectionPoint, scroll: HTMLElement): boolean {
  const rect = scroll.getBoundingClientRect()
  if (rect.height <= 0 || scroll.scrollHeight <= scroll.clientHeight) return false
  let intensity = 0
  if (point.clientY < rect.top + AUTOSCROLL_EDGE_CSS_PX) {
    intensity = -Math.min(1, (rect.top + AUTOSCROLL_EDGE_CSS_PX - point.clientY) / AUTOSCROLL_EDGE_CSS_PX)
  } else if (point.clientY > rect.bottom - AUTOSCROLL_EDGE_CSS_PX) {
    intensity = Math.min(1, (point.clientY - (rect.bottom - AUTOSCROLL_EDGE_CSS_PX)) / AUTOSCROLL_EDGE_CSS_PX)
  }
  if (intensity === 0) return false
  const previous = scroll.scrollTop
  const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
  scroll.scrollTop = Math.max(
    0,
    Math.min(maximum, previous + intensity * AUTOSCROLL_MAX_STEP_CSS_PX),
  )
  return Math.abs(scroll.scrollTop - previous) > 0.01
}

export function createMarginSelectionController({
  getPort,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (frame) => cancelAnimationFrame(frame),
}: MarginSelectionControllerOptions): MarginSelectionController {
  let gesture: Gesture | null = null
  let disposed = false

  const removeWindowListeners = () => {
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerUp, true)
    window.removeEventListener('pointercancel', onPointerCancel, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('blur', onWindowBlur)
    window.removeEventListener('dragstart', onExternalInterruption, true)
    window.removeEventListener('dragenter', onExternalInterruption, true)
  }

  const clearGesture = (cancelProvenance: boolean) => {
    const current = gesture
    if (!current) return
    gesture = null
    removeWindowListeners()
    if (current.frame !== null) cancelFrame(current.frame)
    current.captureTarget.removeEventListener('lostpointercapture', onLostPointerCapture)
    safePointerCapture(current.captureTarget, 'releasePointerCapture', current.pointerId)
    if (cancelProvenance && current.active) current.port.cancelPointerSelection()
  }

  const currentGesture = (): Gesture | null => {
    const current = gesture
    if (!current) return null
    if (getPort() !== current.port) {
      clearGesture(true)
      return null
    }
    return current
  }

  const updateGesture = (allowAutoscroll: boolean) => {
    const current = currentGesture()
    if (!current) return
    const distance = Math.hypot(
      current.latestPoint.clientX - current.downEvent.clientX,
      current.latestPoint.clientY - current.downEvent.clientY,
    )
    if (!current.active && distance < ACTIVATION_DISTANCE_CSS_PX) return

    let head = current.port.positionAtPoint(current.latestPoint)
    if (!current.active) {
      const anchor = current.port.positionAtPoint({
        clientX: current.downEvent.clientX,
        clientY: current.downEvent.clientY,
      })
      const activationHead = current.port.activationPositionAtPoint(current.latestPoint)
      if (
        anchor === null
        || activationHead === null
        || head === null
        || anchor === activationHead
        || anchor === head
      ) return
      current.anchor = anchor
      current.active = true
      current.port.beginPointerSelection(current.downEvent)
      current.port.focus()
      current.captureTarget.addEventListener('lostpointercapture', onLostPointerCapture)
      safePointerCapture(current.captureTarget, 'setPointerCapture', current.pointerId)
    }

    const scroll = current.port.scrollContainer()
    const scrolled = Boolean(allowAutoscroll && scroll && autoscrollStep(current.latestPoint, scroll))
    if (scrolled) {
      const remappedHead = current.port.positionAtPoint(current.latestPoint)
      if (remappedHead !== null) head = remappedHead
    }
    if (current.anchor !== null && head !== null) {
      current.port.applySelection(current.anchor, head)
    }
    if (scrolled) scheduleFrame()
  }

  const runFrame: FrameRequestCallback = () => {
    const current = currentGesture()
    if (!current) return
    current.frame = null
    updateGesture(true)
  }

  function scheduleFrame(): void {
    const current = currentGesture()
    if (!current || current.frame !== null) return
    current.frame = requestFrame(runFrame)
  }

  function onPointerMove(event: PointerEvent): void {
    const current = currentGesture()
    if (!current || event.pointerId !== current.pointerId) return
    current.latestPoint = { clientX: event.clientX, clientY: event.clientY }
    if (current.active && event.cancelable) event.preventDefault()
    scheduleFrame()
  }

  function onPointerUp(event: PointerEvent): void {
    const current = currentGesture()
    if (!current || event.pointerId !== current.pointerId || event.button !== 0) return
    current.latestPoint = { clientX: event.clientX, clientY: event.clientY }
    if (current.frame !== null) {
      cancelFrame(current.frame)
      current.frame = null
    }
    updateGesture(false)
    if (currentGesture()?.active && event.cancelable) event.preventDefault()
    clearGesture(false)
  }

  function onPointerCancel(event: PointerEvent): void {
    const current = currentGesture()
    if (current && event.pointerId === current.pointerId) clearGesture(true)
  }

  function onLostPointerCapture(event: PointerEvent): void {
    const current = currentGesture()
    if (current && event.pointerId === current.pointerId) clearGesture(true)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') clearGesture(true)
  }

  function onWindowBlur(): void {
    clearGesture(true)
  }

  function onExternalInterruption(): void {
    clearGesture(true)
  }

  const installWindowListeners = () => {
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerCancel, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('dragstart', onExternalInterruption, true)
    window.addEventListener('dragenter', onExternalInterruption, true)
  }

  return {
    pointerDown(event, captureTarget) {
      if (disposed) return
      clearGesture(true)
      if (
        event.defaultPrevented
        || event.button !== 0
        || !event.isPrimary
        || event.pointerType !== 'mouse'
      ) return
      const port = getPort()
      if (!port || !port.isEligibleMarginStart(event)) return
      gesture = {
        active: false,
        anchor: null,
        captureTarget,
        downEvent: event,
        frame: null,
        latestPoint: { clientX: event.clientX, clientY: event.clientY },
        pointerId: event.pointerId,
        port,
      }
      installWindowListeners()
    },
    cancel: () => clearGesture(true),
    dispose() {
      if (disposed) return
      disposed = true
      clearGesture(true)
    },
  }
}
