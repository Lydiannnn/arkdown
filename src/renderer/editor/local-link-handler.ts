import type { ApiResult } from '../../shared/contracts'
import { parseLinkTarget } from '../../shared/link-target'
import { parseDocumentViewLink } from '../../shared/document-view-link'
import { welcomeActionForLink } from '../guide/welcome-actions'

type OpenLink = ((target: string) => Promise<ApiResult<null>>) | undefined
export type OpenDocumentLink = (href: string) => void | Promise<void>

const openableClass = 'arkdown-link-openable'
const dragThreshold = 4

function normalizedTarget(value: unknown): string | null {
  const target = parseLinkTarget(value)
  if (!target) return typeof value === 'string' && parseDocumentViewLink(value) ? value : null
  return target.kind === 'web' ? target.url : target.path
}

function anchorFromEvent(root: HTMLElement, event: Event): HTMLAnchorElement | null {
  const anchor = event.target instanceof Element
    ? event.target.closest<HTMLAnchorElement>('a[href]')
    : null
  if (!anchor || !root.contains(anchor)) return null
  return normalizedTarget(anchor.getAttribute('href')) || welcomeActionForLink(anchor.getAttribute('href')) ? anchor : null
}

export async function openLinkTarget(
  value: unknown,
  open: OpenLink,
  reportError: (message: string) => void,
  openDocument?: OpenDocumentLink,
): Promise<boolean> {
  if (typeof value === 'string' && parseDocumentViewLink(value)) {
    if (!openDocument) {
      reportError('当前窗口不支持查看相对文档链接，请在 Arkdown 文档窗口中打开')
      return false
    }
    try { await openDocument(value) }
    catch (error) { reportError(error instanceof Error ? error.message : '无法打开文档') }
    return true
  }
  const target = normalizedTarget(value)
  if (!target || !open) return false
  const result = await open(target)
  if (!result.ok) reportError(result.error.message)
  return true
}

export function installLinkInteraction(
  root: HTMLElement,
  open: OpenLink,
  reportError: (message: string) => void,
  openDocument?: OpenDocumentLink,
): () => void {
  const eventWindow = root.ownerDocument.defaultView ?? window
  let hovered: HTMLAnchorElement | null = null
  let controlDown = false
  let pointerStart: { x: number; y: number } | null = null
  let pointerMoved = false
  let suppressNextClick = false

  const updateCursor = () => {
    if (
      hovered
      && (!root.contains(hovered) || !normalizedTarget(hovered.getAttribute('href')))
    ) {
      hovered.classList.remove(openableClass)
      hovered = null
    }
    hovered?.classList.toggle(openableClass, controlDown)
  }
  const setHovered = (next: HTMLAnchorElement | null) => {
    if (hovered === next) {
      updateCursor()
      return
    }
    hovered?.classList.remove(openableClass)
    hovered = next
    updateCursor()
  }
  const resetControlState = () => {
    controlDown = false
    hovered?.classList.remove(openableClass)
  }
  const onBlur = () => {
    resetControlState()
    hovered = null
  }
  const onMouseOver = (event: MouseEvent) => {
    controlDown ||= event.ctrlKey
    setHovered(anchorFromEvent(root, event))
  }
  const onMouseOut = (event: MouseEvent) => {
    if (!hovered) return
    const related = event.relatedTarget
    if (related instanceof Node && hovered.contains(related)) return
    if (event.target instanceof Node && hovered.contains(event.target)) setHovered(null)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      const anchor = anchorFromEvent(root, event)
      if (anchor && welcomeActionForLink(anchor.getAttribute('href'))) {
        event.preventDefault(); anchor.click(); return
      }
    }
    if (event.key !== 'Control') return
    controlDown = true
    updateCursor()
  }
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'Control' || !event.ctrlKey) resetControlState()
  }
  const onPointerDown = (event: PointerEvent) => {
    if (!anchorFromEvent(root, event)) {
      pointerStart = null
      return
    }
    pointerStart = { x: event.clientX, y: event.clientY }
    pointerMoved = false
    suppressNextClick = false
  }
  const onPointerMove = (event: PointerEvent) => {
    if (!pointerStart || pointerMoved) return
    pointerMoved = Math.hypot(
      event.clientX - pointerStart.x,
      event.clientY - pointerStart.y,
    ) >= dragThreshold
  }
  const finishPointer = () => {
    if (!pointerStart) return
    suppressNextClick = pointerMoved
    pointerStart = null
    pointerMoved = false
  }
  const onDragStart = (event: DragEvent) => {
    if (anchorFromEvent(root, event)) suppressNextClick = true
  }
  const onClick = (event: MouseEvent) => {
    const anchor = anchorFromEvent(root, event)
    if (!anchor) return
    event.preventDefault()
    const suppressed = suppressNextClick
    suppressNextClick = false
    if (suppressed) return
    const action = welcomeActionForLink(anchor.getAttribute('href'))
    if (action) {
      eventWindow.dispatchEvent(new CustomEvent('arkdown:welcome-action', { detail: action }))
      return
    }
    if (!event.ctrlKey) return
    void openLinkTarget(anchor.getAttribute('href'), open, reportError, openDocument)
  }

  root.addEventListener('mouseover', onMouseOver)
  root.addEventListener('mouseout', onMouseOut)
  root.addEventListener('pointerdown', onPointerDown)
  root.addEventListener('dragstart', onDragStart)
  root.addEventListener('click', onClick)
  eventWindow.addEventListener('keydown', onKeyDown)
  eventWindow.addEventListener('keyup', onKeyUp)
  eventWindow.addEventListener('blur', onBlur)
  eventWindow.addEventListener('pointermove', onPointerMove)
  eventWindow.addEventListener('pointerup', finishPointer)
  eventWindow.addEventListener('pointercancel', finishPointer)

  return () => {
    root.removeEventListener('mouseover', onMouseOver)
    root.removeEventListener('mouseout', onMouseOut)
    root.removeEventListener('pointerdown', onPointerDown)
    root.removeEventListener('dragstart', onDragStart)
    root.removeEventListener('click', onClick)
    eventWindow.removeEventListener('keydown', onKeyDown)
    eventWindow.removeEventListener('keyup', onKeyUp)
    eventWindow.removeEventListener('blur', onBlur)
    eventWindow.removeEventListener('pointermove', onPointerMove)
    eventWindow.removeEventListener('pointerup', finishPointer)
    eventWindow.removeEventListener('pointercancel', finishPointer)
    resetControlState()
    root.querySelectorAll('.' + openableClass).forEach((anchor) => {
      anchor.classList.remove(openableClass)
    })
    hovered = null
    pointerStart = null
    pointerMoved = false
    suppressNextClick = false
  }
}
