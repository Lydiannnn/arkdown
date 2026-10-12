import { useCallback, useLayoutEffect, useRef, useState } from 'react'

const MINIMUM_THUMB_HEIGHT_PX = 24

export interface StickyScrollbarMetrics {
  clientHeight: number
  scrollHeight: number
  scrollTop: number
}

export interface StickyScrollbarGeometry {
  visible: boolean
  thumbHeight: number
  thumbTop: number
}

export function calculateStickyScrollbarGeometry({
  clientHeight,
  scrollHeight,
  scrollTop,
}: StickyScrollbarMetrics): StickyScrollbarGeometry {
  if (clientHeight <= 0 || scrollHeight <= clientHeight) {
    return { visible: false, thumbHeight: 0, thumbTop: 0 }
  }
  const thumbHeight = Math.min(
    clientHeight,
    Math.max(MINIMUM_THUMB_HEIGHT_PX, clientHeight * clientHeight / scrollHeight),
  )
  const maximumThumbTop = clientHeight - thumbHeight
  const maximumScrollTop = scrollHeight - clientHeight
  const clampedScrollTop = Math.max(0, Math.min(scrollTop, maximumScrollTop))
  return {
    visible: true,
    thumbHeight,
    thumbTop: maximumScrollTop === 0
      ? 0
      : clampedScrollTop / maximumScrollTop * maximumThumbTop,
  }
}

export interface StickyNoteOverlayScrollbarProps {
  scrollElement: HTMLElement | null
  focused: boolean
}

interface DragState {
  pointerId: number
  startClientY: number
  startScrollTop: number
}

const HIDDEN_GEOMETRY: StickyScrollbarGeometry = {
  visible: false,
  thumbHeight: 0,
  thumbTop: 0,
}

export function StickyNoteOverlayScrollbar({
  scrollElement,
  focused,
}: StickyNoteOverlayScrollbarProps) {
  const [geometry, setGeometry] = useState(HIDDEN_GEOMETRY)
  const drag = useRef<DragState | null>(null)

  const synchronize = useCallback(() => {
    if (!focused || !scrollElement) {
      setGeometry(HIDDEN_GEOMETRY)
      return
    }
    setGeometry(calculateStickyScrollbarGeometry({
      clientHeight: scrollElement.clientHeight,
      scrollHeight: scrollElement.scrollHeight,
      scrollTop: scrollElement.scrollTop,
    }))
  }, [focused, scrollElement])

  useLayoutEffect(() => {
    synchronize()
    if (!focused || !scrollElement) return undefined
    scrollElement.addEventListener('scroll', synchronize, { passive: true })
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(synchronize)
    resizeObserver?.observe(scrollElement)
    if (scrollElement.firstElementChild) resizeObserver?.observe(scrollElement.firstElementChild)
    const mutationObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(synchronize)
    mutationObserver?.observe(scrollElement, { childList: true, subtree: true, characterData: true })
    window.addEventListener('resize', synchronize)
    return () => {
      scrollElement.removeEventListener('scroll', synchronize)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', synchronize)
    }
  }, [focused, scrollElement, synchronize])

  if (!focused || !scrollElement || !geometry.visible) return null

  const maximumScrollTop = scrollElement.scrollHeight - scrollElement.clientHeight
  const maximumThumbTop = scrollElement.clientHeight - geometry.thumbHeight

  return (
    <div
      aria-controls="sticky-note-editor-scroller"
      aria-orientation="vertical"
      aria-valuemax={maximumScrollTop}
      aria-valuemin={0}
      aria-valuenow={Math.round(scrollElement.scrollTop)}
      className="sticky-note-overlay-scrollbar"
      role="scrollbar"
    >
      <div
        className="sticky-note-overlay-scrollbar-thumb"
        onPointerCancel={(event) => {
          if (drag.current?.pointerId === event.pointerId) drag.current = null
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          drag.current = {
            pointerId: event.pointerId,
            startClientY: event.clientY,
            startScrollTop: scrollElement.scrollTop,
          }
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }}
        onPointerMove={(event) => {
          const current = drag.current
          if (!current || current.pointerId !== event.pointerId || maximumThumbTop <= 0) return
          event.preventDefault()
          event.stopPropagation()
          const scrollDelta = (event.clientY - current.startClientY)
            * maximumScrollTop / maximumThumbTop
          scrollElement.scrollTop = Math.max(
            0,
            Math.min(maximumScrollTop, current.startScrollTop + scrollDelta),
          )
          synchronize()
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return
          drag.current = null
          event.currentTarget.releasePointerCapture?.(event.pointerId)
        }}
        style={{
          height: `${geometry.thumbHeight}px`,
          transform: `translateY(${geometry.thumbTop}px)`,
        }}
      />
    </div>
  )
}
