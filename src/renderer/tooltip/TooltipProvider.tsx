import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import './tooltip.css'
import { mainAppPortalMarker } from '../app/ui-selection-guard'

interface TooltipState {
  anchor: 'pointer' | 'target'
  label: string
  layer: TooltipLayer
  left: number
  positioned: boolean
  target: HTMLElement
  top: number
}

type TooltipLayer = 'base' | 'modal' | 'context-menu'

const TOOLTIP_DELAY = 400
const VIEWPORT_MARGIN = 8
const TOOLTIP_GAP = 7
const POINTER_OFFSET_X = 12
const POINTER_OFFSET_Y = 16
const TOOLTIP_DISMISS_EVENT = 'arkdown:dismiss-tooltip'

export function dismissTooltip(): void {
  if (typeof document === 'undefined') return
  document.dispatchEvent(new Event(TOOLTIP_DISMISS_EVENT))
}

interface Size {
  width: number
  height: number
}

interface Point {
  left: number
  top: number
}

interface PointerPosition {
  x: number
  y: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function intersects(left: number, top: number, size: Size, obstacle: DOMRect): boolean {
  return left < obstacle.right
    && left + size.width > obstacle.left
    && top < obstacle.bottom
    && top + size.height > obstacle.top
}

function placePointerTooltip(pointer: PointerPosition, size: Size): Point {
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - size.width)
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - size.height)
  const preferredLeft = pointer.x + POINTER_OFFSET_X
  const preferredTop = pointer.y + POINTER_OFFSET_Y
  const left = preferredLeft + size.width > window.innerWidth - VIEWPORT_MARGIN
    ? pointer.x - POINTER_OFFSET_X - size.width
    : preferredLeft
  const top = preferredTop + size.height > window.innerHeight - VIEWPORT_MARGIN
    ? pointer.y - POINTER_OFFSET_Y - size.height
    : preferredTop
  return {
    left: clamp(left, VIEWPORT_MARGIN, maxLeft),
    top: clamp(top, VIEWPORT_MARGIN, maxTop),
  }
}

function placeTooltip(
  target: DOMRect,
  size: Size,
  obstacles: readonly DOMRect[],
): Point {
  const blockedRects = [target, ...obstacles]
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - VIEWPORT_MARGIN - size.width)
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - VIEWPORT_MARGIN - size.height)
  const targetCenterX = target.left + target.width / 2
  const targetCenterY = target.top + target.height / 2
  const xValues = [
    targetCenterX - size.width / 2,
    VIEWPORT_MARGIN,
    maxLeft,
  ]
  const yValues = [
    target.bottom + TOOLTIP_GAP,
    target.top - TOOLTIP_GAP - size.height,
    targetCenterY - size.height / 2,
    VIEWPORT_MARGIN,
    maxTop,
  ]
  for (const obstacle of blockedRects) {
    xValues.push(obstacle.left - TOOLTIP_GAP - size.width, obstacle.right + TOOLTIP_GAP)
    yValues.push(obstacle.top - TOOLTIP_GAP - size.height, obstacle.bottom + TOOLTIP_GAP)
  }

  const candidates: Point[] = []
  const seen = new Set<string>()
  for (const x of xValues) {
    for (const y of yValues) {
      const candidate = {
        left: clamp(x, VIEWPORT_MARGIN, maxLeft),
        top: clamp(y, VIEWPORT_MARGIN, maxTop),
      }
      const key = `${candidate.left}:${candidate.top}`
      if (seen.has(key)) continue
      seen.add(key)
      if (blockedRects.some((obstacle) => intersects(
        candidate.left,
        candidate.top,
        size,
        obstacle,
      ))) continue
      candidates.push(candidate)
    }
  }

  candidates.sort((a, b) => {
    const distance = (point: Point) => (
      (point.left + size.width / 2 - targetCenterX) ** 2
      + (point.top + size.height / 2 - targetCenterY) ** 2
    )
    return distance(a) - distance(b)
  })
  return candidates[0] ?? {
    left: clamp(targetCenterX - size.width / 2, VIEWPORT_MARGIN, maxLeft),
    top: clamp(target.bottom + TOOLTIP_GAP, VIEWPORT_MARGIN, maxTop),
  }
}

function visibleContextMenuRects(): DOMRect[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.context-menu-list'))
    .filter((menu) => {
      const style = getComputedStyle(menu)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })
    .map((menu) => menu.getBoundingClientRect())
    .filter((bounds) => bounds.width > 0 && bounds.height > 0)
}

function tooltipTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>('[data-tooltip]')
    : null
}

function tooltipLayer(target: HTMLElement): TooltipLayer {
  const layer = target.closest<HTMLElement>('[data-tooltip-layer]')
    ?.dataset.tooltipLayer
  return layer === 'modal' || layer === 'context-menu' ? layer : 'base'
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frame = useRef<number | null>(null)
  const active = useRef<HTMLElement | null>(null)
  const activeAnchor = useRef<'pointer' | 'target'>('target')
  const pointer = useRef<PointerPosition>({ x: 0, y: 0 })
  const tooltipElement = useRef<HTMLDivElement | null>(null)
  const warm = useRef(false)
  const inputModality = useRef<'keyboard' | 'pointer'>('keyboard')
  const pointerDown = useRef(false)
  const hovered = useRef<HTMLElement | null>(null)
  const dismissed = useRef<HTMLElement | null>(null)

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])

  const cancelFrame = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null
  }, [])

  const hide = useCallback(() => {
    clearTimer()
    cancelFrame()
    active.current = null
    warm.current = false
    setTooltip(null)
  }, [cancelFrame, clearTimer])

  const show = useCallback((element: HTMLElement, anchor: 'pointer' | 'target') => {
    const label = element.dataset.tooltip?.trim()
    if (!label) return
    clearTimer()
    cancelFrame()
    active.current = element
    activeAnchor.current = anchor
    warm.current = true
    setTooltip({
      anchor,
      label,
      layer: tooltipLayer(element),
      left: VIEWPORT_MARGIN,
      positioned: false,
      target: element,
      top: VIEWPORT_MARGIN,
    })
  }, [cancelFrame, clearTimer])

  const updatePointerTooltip = useCallback(() => {
    frame.current = null
    const target = active.current
    const element = tooltipElement.current
    if (!target || !target.isConnected || !element) {
      hide()
      return
    }
    const bounds = element.getBoundingClientRect()
    const point = placePointerTooltip(pointer.current, {
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height),
    })
    setTooltip((current) => current?.target === target && current.anchor === 'pointer'
      ? { ...current, ...point, positioned: true }
      : current)
  }, [hide])

  const schedulePointerUpdate = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(updatePointerTooltip)
  }, [updatePointerTooltip])

  useLayoutEffect(() => {
    if (!tooltip || tooltip.positioned) return
    const element = tooltipElement.current
    if (!element || !tooltip.target.isConnected) {
      hide()
      return
    }
    const currentLabel = tooltip.target.dataset.tooltip?.trim()
    if (!currentLabel || currentLabel !== tooltip.label) {
      hide()
      return
    }
    const bounds = element.getBoundingClientRect()
    const size = { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) }
    const point = tooltip.anchor === 'pointer'
      ? placePointerTooltip(pointer.current, size)
      : placeTooltip(
          tooltip.target.getBoundingClientRect(),
          size,
          visibleContextMenuRects(),
        )
    setTooltip((current) => current?.target === tooltip.target
      ? { ...current, ...point, positioned: true }
      : current)
  }, [hide, tooltip])

  useEffect(() => {
    const request = (element: HTMLElement, anchor: 'pointer' | 'target') => {
      if (pointerDown.current || element === dismissed.current) return
      if (element === active.current && tooltip && activeAnchor.current === anchor) {
        if (anchor === 'pointer') schedulePointerUpdate()
        return
      }
      clearTimer()
      active.current = element
      activeAnchor.current = anchor
      if (warm.current || tooltip) show(element, anchor)
      else timer.current = setTimeout(() => show(element, anchor), TOOLTIP_DELAY)
    }
    const onPointerOver = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY }
      const target = tooltipTarget(event.target)
      hovered.current = target
      if (target && !event.buttons) request(target, 'pointer')
    }
    const onPointerMove = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY }
      const target = tooltipTarget(event.target)
      if (
        target
        && !pointerDown.current
        && !event.buttons
        && target !== dismissed.current
        && target === active.current
        && activeAnchor.current === 'pointer'
        && tooltip
      ) schedulePointerUpdate()
    }
    const onPointerOut = (event: PointerEvent) => {
      const leaving = tooltipTarget(event.target)
      const entering = tooltipTarget(event.relatedTarget)
      if (!leaving || leaving === entering) return
      hovered.current = entering
      if (dismissed.current === leaving) dismissed.current = null
      if (entering && !event.buttons) request(entering, 'pointer')
      else hide()
    }
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target)
      if (target && inputModality.current === 'keyboard'
        && !pointerDown.current && target !== dismissed.current) show(target, 'target')
    }
    const onFocusOut = (event: FocusEvent) => {
      if (!tooltipTarget(event.relatedTarget)) hide()
    }
    const dismiss = (event: Event) => {
      dismissed.current = tooltipTarget(event.target) ?? active.current ?? hovered.current
      hide()
    }
    const onPointerDown = (event: PointerEvent) => {
      inputModality.current = 'pointer'
      pointerDown.current = true
      dismiss(event)
    }
    const onPointerUp = () => {
      pointerDown.current = false
    }
    const onWindowBlur = () => {
      pointerDown.current = false
      hide()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Keyboard focus can differ from the trigger whose tooltip is showing.
        dismissed.current = active.current ?? hovered.current
        hide()
      } else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
        inputModality.current = 'keyboard'
        // A new keyboard navigation gesture may revisit a dismissed trigger.
        if (event.key === 'Tab') dismissed.current = null
      }
    }
    const observer = new MutationObserver(() => {
      const target = active.current
      if (!target) return
      const label = target.dataset.tooltip?.trim()
      if (
        !target.isConnected
        || !label
        || (tooltip && (
          label !== tooltip.label
          || tooltipLayer(target) !== tooltip.layer
        ))
      ) hide()
    })
    observer.observe(document.body, {
      attributeFilter: ['data-tooltip', 'data-tooltip-layer'],
      attributes: true,
      childList: true,
      subtree: true,
    })
    document.addEventListener('pointerover', onPointerOver)
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerout', onPointerOut)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerUp, true)
    document.addEventListener('click', dismiss, true)
    document.addEventListener(TOOLTIP_DISMISS_EVENT, dismiss)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('scroll', hide, true)
    return () => {
      clearTimer()
      cancelFrame()
      observer.disconnect()
      document.removeEventListener('pointerover', onPointerOver)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerout', onPointerOut)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerUp, true)
      document.removeEventListener('click', dismiss, true)
      document.removeEventListener(TOOLTIP_DISMISS_EVENT, dismiss)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('scroll', hide, true)
    }
  }, [cancelFrame, clearTimer, hide, schedulePointerUpdate, show, tooltip])

  return <>
    {children}
    {tooltip && createPortal(
      <div
        className="global-tooltip"
        data-tooltip-layer={tooltip.layer}
        data-ui-selection-portal={mainAppPortalMarker()}
        ref={tooltipElement}
        role="tooltip"
        style={{
          left: tooltip.left,
          top: tooltip.top,
          visibility: tooltip.positioned ? 'visible' : 'hidden',
        }}
      >
        {tooltip.label}
      </div>,
      document.body,
    )}
  </>
}
