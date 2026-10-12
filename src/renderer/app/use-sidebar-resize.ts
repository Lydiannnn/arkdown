import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'

interface SidebarResizeOptions {
  initialWidth: number
  minWidth: number
  maxWidth: number
}

export function useSidebarResize({
  initialWidth,
  minWidth,
  maxWidth,
}: SidebarResizeOptions): {
  width: number
  userResizeGeneration: number
  separatorProps: HTMLAttributes<HTMLDivElement>
} {
  const [resize, setResize] = useState({
    width: initialWidth,
    userResizeGeneration: 0,
  })
  const width = resize.width
  const drag = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null)

  const clamp = useCallback((value: number) => {
    const viewportMaximum = Math.floor(window.innerWidth * 0.45)
    return Math.max(minWidth, Math.min(Math.min(maxWidth, viewportMaximum), value))
  }, [maxWidth, minWidth])

  useLayoutEffect(() => {
    setResize((current) => {
      const width = clamp(initialWidth)
      return width === current.width ? current : { ...current, width }
    })
  }, [clamp, initialWidth])

  const setUserWidth = useCallback((nextWidth: number) => {
    setResize((current) => {
      const width = clamp(nextWidth)
      if (width === current.width) return current
      return {
        width,
        userResizeGeneration: current.userResizeGeneration + 1,
      }
    })
  }, [clamp])

  const stopDragging = useCallback(() => {
    drag.current = null
  }, [])
  const move = useCallback((event: globalThis.PointerEvent) => {
    const active = drag.current
    if (!active || event.pointerId !== active.pointerId) return
    setUserWidth(active.startWidth + event.clientX - active.startX)
  }, [setUserWidth])

  useEffect(() => {
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stopDragging)
    window.addEventListener('pointercancel', stopDragging)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stopDragging)
      window.removeEventListener('pointercancel', stopDragging)
    }
  }, [move, stopDragging])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = {
      startX: event.clientX,
      startWidth: width,
      pointerId: event.pointerId,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    setUserWidth(width + (event.key === 'ArrowRight' ? 10 : -10))
    event.preventDefault()
  }

  return {
    width,
    userResizeGeneration: resize.userResizeGeneration,
    separatorProps: {
      'aria-label': '调整侧边栏宽度',
      'aria-orientation': 'vertical',
      'aria-valuemax': Math.min(maxWidth, Math.floor(window.innerWidth * 0.45)),
      'aria-valuemin': minWidth,
      'aria-valuenow': width,
      onDoubleClick: () => setUserWidth(initialWidth),
      onKeyDown,
      onPointerDown,
      role: 'separator',
      tabIndex: 0,
    },
  }
}
