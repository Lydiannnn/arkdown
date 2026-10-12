import { useEffect, useRef, useState, type RefObject } from 'react'
import { AppIcon } from '../icons/AppIcon'
import type { EditorMode } from './EditorPane'
import type { TranslationHistoryRecord } from './translation-history'
import { TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE } from './translation-history-marker'
import {
  computeTranslationHistoryRailItems,
  type TranslationHistoryRailItem,
} from './translation-history-rail-geometry'
import './translation-history-rail.css'

export interface TranslationHistoryRailProps {
  centerRequest?: { recordId: string; token: number } | null
  mode: EditorMode
  records: readonly TranslationHistoryRecord[]
  refreshKey: string | number
  surfaceRef: RefObject<HTMLDivElement | null>
  onOpenRecord(recordId: string, initiator: HTMLElement): void
}

interface RailViewport {
  height: number
  scrollLeft: number
  scrollTop: number
  width: number
}

function sameItems(left: readonly TranslationHistoryRailItem[], right: readonly TranslationHistoryRailItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]
    return other?.recordId === item.recordId
      && other.buttonTop === item.buttonTop
      && other.buttonLeft === item.buttonLeft
      && other.connectorLeft === item.connectorLeft
      && other.connectorTop === item.connectorTop
      && other.connectorHorizontalWidth === item.connectorHorizontalWidth
      && other.connectorVerticalLeft === item.connectorVerticalLeft
      && other.connectorVerticalTop === item.connectorVerticalTop
      && other.connectorVerticalHeight === item.connectorVerticalHeight
  })
}

function sameViewport(left: RailViewport, right: RailViewport): boolean {
  return left.height === right.height
    && left.scrollLeft === right.scrollLeft
    && left.scrollTop === right.scrollTop
    && left.width === right.width
}

function centerRequestedRailItems(
  items: readonly TranslationHistoryRailItem[],
  recordId: string,
  viewportHeight: number,
): readonly TranslationHistoryRailItem[] {
  const requested = items.find((item) => item.recordId === recordId)
  if (!requested || viewportHeight <= 0) return items
  const delta = viewportHeight / 2 - (requested.buttonTop + 15)
  if (Math.abs(delta) <= 0.5) return items
  return items.map((item) => {
    const buttonTop = item.buttonTop + delta
    if (item.connectorTop === null) return { ...item, buttonTop }
    const buttonCenter = buttonTop + 15
    return {
      ...item,
      buttonTop,
      connectorVerticalTop: Math.min(item.connectorTop, buttonCenter),
      connectorVerticalHeight: Math.abs(buttonCenter - item.connectorTop),
    }
  })
}

export function TranslationHistoryRail({
  centerRequest = null,
  mode,
  records,
  refreshKey,
  surfaceRef,
  onOpenRecord,
}: TranslationHistoryRailProps) {
  const settledCenterRequestRef = useRef<number | null>(null)
  const [items, setItems] = useState<readonly TranslationHistoryRailItem[]>([])
  const [viewport, setViewport] = useState<RailViewport>({
    height: 0,
    scrollLeft: 0,
    scrollTop: 0,
    width: 0,
  })

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) {
      setItems([])
      return
    }
    const ownerWindow = surface.ownerDocument.defaultView ?? window
    const validRecords = new Map(records
      .filter((record) => record.mode === mode && record.anchor.mode === mode && record.anchor.status === 'valid')
      .map((record) => [record.id, record]))
    let frame = 0
    let generation = 0
    let disposed = false
    let activeRoot: HTMLElement | null = null
    let scrollTarget: HTMLElement | null = null
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => schedule())
    const surfaceObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => schedule())
    const contentObserver = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => schedule())

    const queryActiveRoot = () => surface.querySelector<HTMLElement>(
      mode === 'visual' ? ':scope > .visual-editor' : ':scope > .source-editor-context',
    )

    const bindRoot = () => {
      const nextRoot = queryActiveRoot()
      if (nextRoot === activeRoot) return
      if (activeRoot) resizeObserver?.unobserve(activeRoot)
      contentObserver?.disconnect()
      if (scrollTarget && scrollTarget !== surface) scrollTarget.removeEventListener('scroll', schedule)
      activeRoot = nextRoot
      scrollTarget = mode === 'source'
        ? activeRoot?.querySelector<HTMLElement>('.cm-scroller') ?? null
        : surface
      if (activeRoot) {
        resizeObserver?.observe(activeRoot)
        contentObserver?.observe(activeRoot, { childList: true, subtree: true })
      }
      if (scrollTarget && scrollTarget !== surface) scrollTarget.addEventListener('scroll', schedule, { passive: true })
    }

    const measure = () => {
      frame = 0
      if (disposed) return
      const currentGeneration = ++generation
      bindRoot()
      const root = activeRoot
      const surfaceRect = surface.getBoundingClientRect()
      if (!root || surfaceRect.width <= 0 || surfaceRect.height <= 0) {
        setItems((current) => current.length === 0 ? current : [])
        return
      }
      const content = mode === 'visual'
        ? root.querySelector<HTMLElement>('.ProseMirror') ?? root
        : root.querySelector<HTMLElement>('.source-editor') ?? root
      const anchors = [...root.querySelectorAll<HTMLElement>(`[${TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE}]`)]
        .flatMap((element) => {
          const recordId = element.getAttribute(TRANSLATION_HISTORY_ANCHOR_ATTRIBUTE) ?? ''
          const record = validRecords.get(recordId)
          if (!record) return []
          const rect = element.getBoundingClientRect()
          if (rect.bottom <= surfaceRect.top || rect.top >= surfaceRect.bottom) return []
          return [{ recordId, createdAt: record.createdAt, rect }]
        })
      const measured = computeTranslationHistoryRailItems({
        anchors,
        mode,
        surfaceRect,
        contentRight: content.getBoundingClientRect().right,
      })
      if (currentGeneration !== generation) return
      const pendingCenterRequest = centerRequest
      const requestedItem = pendingCenterRequest
        && pendingCenterRequest.token !== settledCenterRequestRef.current
        ? measured.find(({ recordId }) => recordId === pendingCenterRequest.recordId) ?? null
        : null
      if (requestedItem && scrollTarget && pendingCenterRequest) {
        const visualDelta = requestedItem.buttonTop + 15 - surfaceRect.height / 2
        const viewportHeight = scrollTarget.clientHeight
        const scrollScale = mode === 'source' && viewportHeight > 0
          ? scrollTarget.getBoundingClientRect().height / viewportHeight
          : 1
        const safeScrollScale = Number.isFinite(scrollScale) && scrollScale > 0 ? scrollScale : 1
        const maximumScrollTop = Math.max(0, scrollTarget.scrollHeight - viewportHeight)
        const desiredScrollTop = Math.min(
          maximumScrollTop,
          Math.max(0, scrollTarget.scrollTop + visualDelta / safeScrollScale),
        )
        if (Math.abs(desiredScrollTop - scrollTarget.scrollTop) > 0.5) {
          const previousScrollTop = scrollTarget.scrollTop
          scrollTarget.scrollTop = desiredScrollTop
          if (Math.abs(scrollTarget.scrollTop - previousScrollTop) > 0.5) schedule()
          else settledCenterRequestRef.current = pendingCenterRequest.token
        } else {
          settledCenterRequestRef.current = pendingCenterRequest.token
        }
      }
      const displayed = requestedItem && pendingCenterRequest
        ? centerRequestedRailItems(measured, pendingCenterRequest.recordId, surfaceRect.height)
        : measured
      setItems((current) => sameItems(current, displayed) ? current : displayed)
      const measuredViewport = {
        height: surface.clientHeight || surfaceRect.height,
        scrollLeft: surface.scrollLeft,
        scrollTop: surface.scrollTop,
        width: surface.clientWidth || surfaceRect.width,
      }
      setViewport((current) => sameViewport(current, measuredViewport) ? current : measuredViewport)
    }

    function schedule() {
      if (disposed || frame) return
      frame = ownerWindow.requestAnimationFrame(measure)
    }

    resizeObserver?.observe(surface)
    surfaceObserver?.observe(surface, { childList: true })
    surface.addEventListener('scroll', schedule, { passive: true })
    ownerWindow.addEventListener('resize', schedule)
    bindRoot()
    schedule()
    return () => {
      disposed = true
      generation += 1
      if (frame) ownerWindow.cancelAnimationFrame(frame)
      if (scrollTarget && scrollTarget !== surface) scrollTarget.removeEventListener('scroll', schedule)
      surface.removeEventListener('scroll', schedule)
      ownerWindow.removeEventListener('resize', schedule)
      resizeObserver?.disconnect()
      surfaceObserver?.disconnect()
      contentObserver?.disconnect()
    }
  }, [centerRequest, mode, records, refreshKey, surfaceRef])

  return <div
    aria-label="翻译记录标记"
    className={`translation-history-rail-layer translation-history-rail-layer--${mode}`}
    role="group"
    style={{
      height: `${viewport.height}px`,
      transform: `translate(${viewport.scrollLeft}px, ${viewport.scrollTop}px)`,
      width: `${viewport.width}px`,
    }}
  >
    {items.map((item, index) => <div className="translation-history-rail-item" key={item.recordId}>
      {item.connectorLeft !== null && item.connectorTop !== null && <span
        aria-hidden="true"
        className="translation-history-rail-connector-horizontal"
        style={{
          left: `${item.connectorLeft}px`,
          top: `${item.connectorTop}px`,
          width: `${item.connectorHorizontalWidth}px`,
        }}
      />}
      {item.connectorVerticalLeft !== null && item.connectorVerticalTop !== null && <span
        aria-hidden="true"
        className="translation-history-rail-connector-vertical"
        style={{
          height: `${item.connectorVerticalHeight}px`,
          left: `${item.connectorVerticalLeft}px`,
          top: `${item.connectorVerticalTop}px`,
        }}
      />}
      <button
        aria-label={`打开翻译记录 ${index + 1}`}
        className="translation-history-rail-button"
        data-record-id={item.recordId}
        onClick={(event) => onOpenRecord(item.recordId, event.currentTarget)}
        style={{ left: `${item.buttonLeft}px`, top: `${item.buttonTop}px` }}
        type="button"
      >
        <AppIcon name="translate" size={18} />
      </button>
    </div>)}
  </div>
}
