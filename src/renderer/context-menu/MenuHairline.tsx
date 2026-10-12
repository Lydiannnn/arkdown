import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  getMenuHairlineOffsetCssPx,
  getMenuHairlineThicknessCssPx,
  normalizeMenuHairlineDpr,
} from './menu-hairline'

interface MenuHairlineProps {
  className: string
}

function applyFallback(stroke: HTMLElement): void {
  stroke.style.height = '1px'
  stroke.style.top = '0px'
  stroke.style.transform = 'translateY(0px) scaleY(1)'
}

function synchronizeHairline(wrapper: HTMLElement, stroke: HTMLElement): void {
  if (!wrapper.isConnected || !stroke.isConnected) return
  try {
    const view = wrapper.ownerDocument.defaultView
    const dpr = normalizeMenuHairlineDpr(view?.devicePixelRatio ?? Number.NaN)
    const top = wrapper.getBoundingClientRect().top
    if (!Number.isFinite(top)) {
      applyFallback(stroke)
      return
    }
    const thickness = getMenuHairlineThicknessCssPx(dpr)
    const edgeOffset = getMenuHairlineOffsetCssPx(top, dpr)
    const centerOffset = edgeOffset + (thickness - 1) / 2
    stroke.style.height = '1px'
    stroke.style.top = '0px'
    stroke.style.transform = `translateY(${centerOffset}px) scaleY(${thickness})`
  } catch {
    applyFallback(stroke)
  }
}

export function MenuHairline({ className }: MenuHairlineProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const strokeRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current
    const stroke = strokeRef.current
    if (wrapper && stroke) synchronizeHairline(wrapper, stroke)
  })

  useEffect(() => {
    const wrapper = wrapperRef.current
    const stroke = strokeRef.current
    const view = wrapper?.ownerDocument.defaultView
    if (!wrapper || !stroke || !view) return

    const synchronize = () => synchronizeHairline(wrapper, stroke)
    view.addEventListener('resize', synchronize)
    view.visualViewport?.addEventListener('resize', synchronize)

    let resolutionQuery: MediaQueryList | null = null
    const onResolutionChange = () => {
      if (!wrapper.isConnected || !stroke.isConnected) return
      synchronize()
      bindResolutionQuery()
    }
    const bindResolutionQuery = () => {
      resolutionQuery?.removeEventListener('change', onResolutionChange)
      resolutionQuery = null
      if (typeof view.matchMedia !== 'function') return
      try {
        resolutionQuery = view.matchMedia(
          `(resolution: ${normalizeMenuHairlineDpr(view.devicePixelRatio)}dppx)`,
        )
        resolutionQuery.addEventListener('change', onResolutionChange)
      } catch {
        resolutionQuery = null
      }
    }
    bindResolutionQuery()

    let resizeObserver: ResizeObserver | null = null
    if (typeof view.ResizeObserver === 'function') {
      try {
        resizeObserver = new view.ResizeObserver(synchronize)
        resizeObserver.observe(wrapper)
        const menu = wrapper.closest('[role="menu"]')
        if (menu && menu !== wrapper) resizeObserver.observe(menu)
      } catch {
        resizeObserver?.disconnect()
        resizeObserver = null
      }
    }

    return () => {
      view.removeEventListener('resize', synchronize)
      view.visualViewport?.removeEventListener('resize', synchronize)
      resolutionQuery?.removeEventListener('change', onResolutionChange)
      resizeObserver?.disconnect()
    }
  }, [])

  return (
    <div
      aria-orientation="horizontal"
      className={`menu-hairline ${className}`}
      ref={wrapperRef}
      role="separator"
    >
      <span aria-hidden="true" className="menu-hairline-stroke" ref={strokeRef} />
    </div>
  )
}
