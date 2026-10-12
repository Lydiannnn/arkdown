import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import type {
  CaptureDisplaySnapshot,
  ScreenshotCaptureCommitInput,
  ScreenshotRect,
  ScreenshotWindowHighlight,
} from '../../shared/screenshot-translation'
import type { ArkdownApi } from '../../shared/contracts'
import './screenshot-selection.css'

interface DragState {
  start: { x: number; y: number }
  current: { x: number; y: number }
  regionMode: boolean
}

type PointerProbeResult = Awaited<ReturnType<NonNullable<ArkdownApi['updateScreenshotCapturePointer']>>> | undefined

export function createLatestPointerProbe<T, TResult>(send: (value: T) => Promise<TResult> | TResult) {
  let disposed = false
  let inFlight = false
  let pending: { value: T; resolve: (result: TResult | undefined) => void } | undefined

  const run = (job: { value: T; resolve: (result: TResult | undefined) => void }) => {
    inFlight = true
    void Promise.resolve()
      .then(() => send(job.value))
      .then(
        (result) => { job.resolve(disposed ? undefined : result) },
        () => { job.resolve(undefined) },
      )
      .finally(() => {
        inFlight = false
        if (disposed) {
          pending?.resolve(undefined)
          pending = undefined
          return
        }
        const next = pending
        pending = undefined
        if (next) run(next)
      })
  }

  return {
    probe(value: T): Promise<TResult | undefined> {
      return new Promise((resolve) => {
        if (disposed) {
          resolve(undefined)
          return
        }
        if (inFlight) {
          pending?.resolve(undefined)
          pending = { value, resolve }
          return
        }
        run({ value, resolve })
      })
    },
    dispose() {
      disposed = true
      pending?.resolve(undefined)
      pending = undefined
    },
  }
}

function safePointerCapture(element: HTMLElement | null, method: 'setPointerCapture' | 'releasePointerCapture', pointerId: number) {
  try { element?.[method]?.(pointerId) } catch { /* browsers may reject capture after focus/window changes */ }
}

export function ScreenshotSelectionSurface({ sessionId, displayId }: { sessionId: string; displayId: string }) {
  const [display, setDisplay] = useState<CaptureDisplaySnapshot | null>(null)
  const [highlight, setHighlight] = useState<ScreenshotWindowHighlight | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [committing, setCommitting] = useState(false)
  const displayRef = useRef<CaptureDisplaySnapshot | null>(null)
  const highlightRef = useRef<ScreenshotWindowHighlight | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const pointerId = useRef<number | null>(null)
  const captureElement = useRef<HTMLElement | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const finished = useRef(false)
  const pointerProbe = useRef<ReturnType<typeof createLatestPointerProbe<{ x: number; y: number }, PointerProbeResult>> | null>(null)

  const setDragState = (next: DragState | null) => {
    dragRef.current = next
    if (mounted.current) setDrag(next)
  }

  const cancel = () => {
    if (finished.current) return
    finished.current = true
    void (async () => {
      try {
        const result = await window.arkdown.cancelScreenshotCapture?.({ sessionId })
        if (mounted.current && !result?.ok) finished.current = false
      } catch {
        if (mounted.current) finished.current = false
      }
    })()
  }

  useEffect(() => {
    mounted.current = true
    pointerProbe.current = createLatestPointerProbe(sendPointer)
    const unsubscribe = window.arkdown.onScreenshotCaptureEvent?.((event) => {
      if (!mounted.current || event.sessionId !== sessionId) return
      if (event.type === 'selection-ready' && event.display.displayId === displayId) {
        displayRef.current = event.display
        setDisplay(event.display)
      } else if (event.type === 'window-highlight' && event.displayId === displayId) {
        highlightRef.current = event.hit
        setHighlight(event.hit)
      } else if (event.type === 'committing') {
        finished.current = true
        setCommitting(true)
      } else if (event.type === 'cancelled' || event.type === 'failed') {
        finished.current = true
        setCommitting(true)
        highlightRef.current = null
        setHighlight(null)
        setDragState(null)
      }
    })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      mounted.current = false
      pointerProbe.current?.dispose()
      pointerProbe.current = null
      unsubscribe?.()
      document.removeEventListener('keydown', onKeyDown)
      if (pointerId.current !== null) {
        safePointerCapture(captureElement.current, 'releasePointerCapture', pointerId.current)
      }
      pointerId.current = null
      captureElement.current = null
      dragRef.current = null
    }
  }, [displayId, sessionId])

  useEffect(() => {
    if (!display || display.displayId !== displayId || !window.arkdown.readyScreenshotCapture) return undefined
    let cancelled = false
    const staticImage = new Image()
    const decoded = new Promise<void>((resolve, reject) => {
      staticImage.onload = () => resolve()
      staticImage.onerror = () => reject(new Error('CAPTURE_UNAVAILABLE'))
      staticImage.src = display.dataUrl
      if (typeof staticImage.decode === 'function') void staticImage.decode().then(resolve, reject)
    })
    const committedPaint = () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
    void decoded
      .then(committedPaint)
      .then(() => {
        if (!cancelled) return window.arkdown.readyScreenshotCapture?.({ sessionId, displayId })
        return undefined
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      staticImage.onload = null
      staticImage.onerror = null
    }
  }, [display, displayId, sessionId])

  const local = (event: ReactPointerEvent) => ({
    x: Math.max(0, Math.min(window.innerWidth, event.clientX)),
    y: Math.max(0, Math.min(window.innerHeight, event.clientY)),
  })

  const regionFor = (activeDrag: DragState | null): ScreenshotRect | undefined => {
    const activeDisplay = displayRef.current
    if (!activeDrag || !activeDisplay) return undefined
    const left = Math.min(activeDrag.start.x, activeDrag.current.x)
    const top = Math.min(activeDrag.start.y, activeDrag.current.y)
    const width = Math.abs(activeDrag.current.x - activeDrag.start.x)
    const height = Math.abs(activeDrag.current.y - activeDrag.start.y)
    return width > 0 && height > 0
      ? { x: activeDisplay.boundsDip.x + left, y: activeDisplay.boundsDip.y + top, width, height }
      : undefined
  }

  const sendPointer = async (point: { x: number; y: number }) => {
    const activeDisplay = displayRef.current
    if (!activeDisplay) return undefined
    try {
      return await window.arkdown.updateScreenshotCapturePointer?.({
        sessionId,
        displayId,
        screenPointDip: { x: activeDisplay.boundsDip.x + point.x, y: activeDisplay.boundsDip.y + point.y },
      })
    } catch {
      return undefined
    }
  }

  const currentHighlight = () => highlightRef.current

  const probePointer = (point: { x: number; y: number }) => {
    void pointerProbe.current?.probe(point)
  }

  const commit = async (input: ScreenshotCaptureCommitInput) => {
    if (finished.current) return
    finished.current = true
    if (mounted.current) setCommitting(true)
    let result
    try {
      result = await window.arkdown.commitScreenshotCapture?.(input)
    } catch {
      result = undefined
    }
    if (!mounted.current || result?.ok) return
    finished.current = false
    setCommitting(false)
  }

  const finish = async (event: ReactPointerEvent) => {
    const activeDrag = dragRef.current
    const activePointerId = pointerId.current
    if (!activeDrag || activePointerId === null || event.pointerId !== activePointerId
      || committing || finished.current) return
    safePointerCapture(captureElement.current, 'releasePointerCapture', activePointerId)
    pointerId.current = null
    captureElement.current = null

    if (activeDrag.regionMode) {
      const selection = regionFor(activeDrag)
      setDragState(null)
      if (selection) {
        await commit({ sessionId, displayId, kind: 'region', rectDip: selection })
      }
      return
    }

    const releasePoint = local(event)
    const response = await pointerProbe.current?.probe(releasePoint)
    if (!mounted.current) return
    setDragState(null)
    if (!response?.ok) {
      return
    }
    const releaseHit = response?.ok ? response.value : null
    const activeDisplay = displayRef.current
    const globalReleasePoint = activeDisplay
      ? { x: activeDisplay.boundsDip.x + releasePoint.x, y: activeDisplay.boundsDip.y + releasePoint.y }
      : undefined
    if (releaseHit && globalReleasePoint
      && globalReleasePoint.x >= releaseHit.rectDip.x
      && globalReleasePoint.y >= releaseHit.rectDip.y
      && globalReleasePoint.x < releaseHit.rectDip.x + releaseHit.rectDip.width
      && globalReleasePoint.y < releaseHit.rectDip.y + releaseHit.rectDip.height) {
      await commit({
        sessionId,
        displayId,
        kind: 'window',
        rectDip: releaseHit.rectDip,
        processId: releaseHit.processId,
      })
    }
  }

  const selection = regionFor(drag)
  const physicalWidth = selection && display
    ? Math.ceil((selection.x + selection.width - display.boundsDip.x) * display.imageSizePx.width / display.boundsDip.width)
      - Math.floor((selection.x - display.boundsDip.x) * display.imageSizePx.width / display.boundsDip.width)
    : 0
  const physicalHeight = selection && display
    ? Math.ceil((selection.y + selection.height - display.boundsDip.y) * display.imageSizePx.height / display.boundsDip.height)
      - Math.floor((selection.y - display.boundsDip.y) * display.imageSizePx.height / display.boundsDip.height)
    : 0

  const cutoutStyle = (left: number, top: number, width: number, height: number): CSSProperties => ({
    left,
    top,
    width,
    height,
    backgroundImage: display ? `url(${display.dataUrl})` : undefined,
    backgroundSize: `${window.innerWidth}px ${window.innerHeight}px`,
    backgroundPosition: `${-left}px ${-top}px`,
  })
  const regionLeft = drag ? Math.min(drag.start.x, drag.current.x) : 0
  const regionTop = drag ? Math.min(drag.start.y, drag.current.y) : 0
  const regionWidth = drag ? Math.abs(drag.current.x - drag.start.x) : 0
  const regionHeight = drag ? Math.abs(drag.current.y - drag.start.y) : 0
  const labelTop = regionTop + regionHeight + 4 <= window.innerHeight - 22
    ? regionTop + regionHeight + 4
    : Math.max(0, regionTop - 22)

  return <div
    ref={root}
    role="application"
    aria-label="截图选择"
    aria-busy={committing ? 'true' : undefined}
    aria-disabled={!display || committing ? 'true' : undefined}
    tabIndex={0}
    className={`screenshot-selection ${display ? 'is-ready' : ''}`}
    style={display ? { backgroundImage: `url(${display.dataUrl})` } : undefined}
    onContextMenu={(event) => { event.preventDefault(); cancel() }}
    onPointerDown={(event) => {
      if (!displayRef.current || committing || finished.current || pointerId.current !== null || event.button !== 0) return
      const point = local(event)
      const next = { start: point, current: point, regionMode: false }
      pointerId.current = event.pointerId
      captureElement.current = event.currentTarget
      safePointerCapture(event.currentTarget, 'setPointerCapture', event.pointerId)
      setDragState(next)
      probePointer(point)
    }}
    onPointerMove={(event) => {
      if (!displayRef.current || committing || finished.current) return
      const activeDrag = dragRef.current
      const point = local(event)
      if (!activeDrag) {
        probePointer(point)
        return
      }
      if (pointerId.current === null || event.pointerId !== pointerId.current) return
      const regionMode = activeDrag.regionMode
        || Math.hypot(point.x - activeDrag.start.x, point.y - activeDrag.start.y) >= 4
      const next = { ...activeDrag, current: point, regionMode }
      setDragState(next)
      if (!regionMode) probePointer(point)
    }}
    onPointerCancel={(event) => {
      if (pointerId.current !== event.pointerId) return
      safePointerCapture(captureElement.current, 'releasePointerCapture', event.pointerId)
      pointerId.current = null
      captureElement.current = null
      setDragState(null)
    }}
    onPointerUp={(event) => { void finish(event) }}
  >
    <div className="screenshot-selection-mask" style={{ backgroundColor: 'rgba(0, 0, 0, 0.42)' }} />
    {highlight && !drag?.regionMode && display && <div
      className="screenshot-selection-highlight"
      style={cutoutStyle(
        highlight.rectDip.x - display.boundsDip.x,
        highlight.rectDip.y - display.boundsDip.y,
        highlight.rectDip.width,
        highlight.rectDip.height,
      )}
    />}
    {drag?.regionMode && selection && <>
      <div
        className="screenshot-selection-region"
        style={cutoutStyle(regionLeft, regionTop, regionWidth, regionHeight)}
      />
      <output
        className="screenshot-selection-size"
        style={{ left: regionLeft, top: labelTop }}
      >{physicalWidth} × {physicalHeight} 像素</output>
    </>}
    <span className="sr-only" aria-live="polite">
      {committing ? '正在截取…' : display ? '拖动选择截图区域' : '正在准备截图'}
    </span>
  </div>
}
