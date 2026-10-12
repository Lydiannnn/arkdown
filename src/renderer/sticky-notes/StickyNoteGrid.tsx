import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import type { StickyNoteSummary } from '../../shared/sticky-notes'
import { stickyNoteMaterialPresetIdForStyle } from '../../shared/sticky-note-materials'
import {
  DEFAULT_STICKY_NOTE_PREFERENCES,
  type StickyNotePreferences,
} from '../../shared/sticky-note-preferences'
import {
  ARCHIVED_STICKY_NOTE_CARD_DRAG_TYPE,
  encodeArchivedStickyNoteDragIds,
  rectanglesIntersect,
  type SelectionModifiers,
} from './archived-sticky-note-selection'
import { stickyNoteStyleCssVariables } from './sticky-note-style'

export const STICKY_NOTE_CARD_DRAG_TYPE = 'application/x-arknote-card'

interface StickyNoteGridBaseProps {
  label: string
  notes: readonly StickyNoteSummary[]
  onContextMenu?(event: MouseEvent, note: StickyNoteSummary): void
  onDragStateChange?(dragging: boolean): void
  preferences?: StickyNotePreferences
}

interface ActiveStickyNoteGridProps extends StickyNoteGridBaseProps {
  interactionMode?: 'active'
  showCreate: boolean
  createDisabled?: boolean
  onCreate?(): void
  onOpen(note: StickyNoteSummary): void
  onDropFiles?(files: FileList): void
  onReorder?(noteIds: readonly string[]): boolean | Promise<boolean>
}

interface ArchiveStickyNoteGridProps extends StickyNoteGridBaseProps {
  interactionMode: 'archive'
  selectedIds: ReadonlySet<string>
  onSelectArchived(note: StickyNoteSummary, modifiers: SelectionModifiers): void
  onOpenArchived(note: StickyNoteSummary): void
  onArchiveDragStart(note: StickyNoteSummary): readonly string[]
  onMarqueeChange(hitIds: readonly string[], ctrlKey: boolean): void
}

type StickyNoteGridProps = ActiveStickyNoteGridProps | ArchiveStickyNoteGridProps

interface MarqueeGesture {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  ctrlKey: boolean
}

interface ReorderGesture {
  id: string
  startOrder: readonly string[]
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function moveId(ids: readonly string[], sourceId: string, targetId: string): string[] {
  const from = ids.indexOf(sourceId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, sourceId)
  return next
}

function cardIntersectsGrid(card: DOMRect, grid: DOMRect): boolean {
  return card.left < grid.right
    && card.right > grid.left
    && card.top < grid.bottom
    && card.bottom > grid.top
}

/** Chromium snapshots this node after dragstart returns, so it must be independent
 * from the source whose React state immediately turns it into an empty slot. */
function installActiveDragPreview(event: DragEvent<HTMLButtonElement>): () => void {
  if (typeof event.dataTransfer.setDragImage !== 'function') return () => undefined
  const source = event.currentTarget
  const bounds = source.getBoundingClientRect()
  const preview = source.cloneNode(true) as HTMLButtonElement
  preview.removeAttribute('id')
  preview.removeAttribute('data-reorder-slot')
  preview.removeAttribute('aria-selected')
  preview.classList.remove('sticky-note-card-dragging')
  preview.setAttribute('aria-hidden', 'true')
  preview.tabIndex = -1
  preview.draggable = false
  Object.assign(preview.style, { position: 'fixed', left: '-10000px', top: '0',
    width: `${bounds.width}px`, height: `${bounds.height}px`, opacity: '1',
    transform: 'none', pointerEvents: 'none', font: getComputedStyle(source).font })
  document.body.append(preview)
  let timer: ReturnType<typeof setTimeout> | undefined
  const remove = () => { clearTimeout(timer); timer = undefined; preview.remove() }
  const offset = (coordinate: number, origin: number, size: number) =>
    Number.isFinite(coordinate) ? Math.max(0, Math.min(size, coordinate - origin)) : 0
  try {
    event.dataTransfer.setDragImage(preview,
      offset(event.clientX, bounds.left, bounds.width), offset(event.clientY, bounds.top, bounds.height))
    // A task, not a microtask: retain the clone through Chromium's drag snapshot.
    timer = setTimeout(remove, 0)
  } catch (error) { remove(); throw error }
  return remove
}

function installArchivedDragPreview(
  event: DragEvent<HTMLButtonElement>,
  noteIds: readonly string[],
  cardRefs: ReadonlyMap<string, HTMLButtonElement>,
  grid: HTMLDivElement | null,
): void {
  if (typeof event.dataTransfer.setDragImage !== 'function' || !grid) return
  const gridBounds = grid.getBoundingClientRect()
  const scrollViewport = grid.closest<HTMLElement>('.sticky-note-box-content')
  const scrollBounds = scrollViewport?.getBoundingClientRect()
  const visibleBounds = scrollBounds && scrollBounds.width > 0 && scrollBounds.height > 0
    ? scrollBounds
    : gridBounds
  const visibleCards = noteIds
    .map((id) => cardRefs.get(id))
    .filter((card): card is HTMLButtonElement => Boolean(
      card && cardIntersectsGrid(card.getBoundingClientRect(), visibleBounds),
    ))
  if (visibleCards.length === 0) return
  const preview = document.createElement('div')
  preview.className = 'sticky-note-drag-preview'
  for (const card of visibleCards) {
    const clone = card.cloneNode(true) as HTMLElement
    clone.removeAttribute('id')
    clone.setAttribute('data-sticky-note-drag-preview-card', '')
    clone.removeAttribute('aria-selected')
    preview.append(clone)
  }
  document.body.append(preview)
  event.dataTransfer.setDragImage(preview, 24, 24)
  window.setTimeout(() => preview.remove(), 0)
}

export function StickyNoteGrid(props: StickyNoteGridProps) {
  const {
    label,
    notes,
    onContextMenu,
    onDragStateChange,
    preferences = DEFAULT_STICKY_NOTE_PREFERENCES,
  } = props
  const interactionMode = props.interactionMode ?? 'active'
  const archiveProps = interactionMode === 'archive' ? props as ArchiveStickyNoteGridProps : null
  const activeProps = interactionMode === 'active' ? props as ActiveStickyNoteGridProps : null
  const serverOrder = useMemo(() => notes.map(({ record }) => record.id), [notes])
  const [orderedIds, setOrderedIds] = useState(serverOrder)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [persisting, setPersisting] = useState(false)
  const [marquee, setMarquee] = useState<MarqueeGesture | null>(null)
  const orderRef = useRef(serverOrder)
  const previousServerOrder = useRef(serverOrder)
  const reorderGesture = useRef<ReorderGesture | null>(null)
  const pendingDrop = useRef(false)
  const mounted = useRef(true)
  const dragged = useRef(false)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const cardRefs = useRef(new Map<string, HTMLButtonElement>())
  const animations = useRef(new Map<string, Animation>())
  const previousPositions = useRef<Map<string, DOMRect> | null>(null)
  const removeActiveDragPreview = useRef<(() => void) | null>(null)

  const cancelAnimations = () => {
    for (const animation of animations.current.values()) animation.cancel()
    animations.current.clear()
    previousPositions.current = null
  }

  const changeOrder = (next: readonly string[], sourceId: string) => {
    if (sameOrder(orderRef.current, next)) return
    // Read the current painted positions before cancelling in-flight movement.
    // This also resumes smoothly when a second cell is crossed before 400ms.
    previousPositions.current = new Map()
    for (const [id, card] of cardRefs.current) {
      if (id !== sourceId) previousPositions.current.set(id, card.getBoundingClientRect())
    }
    orderRef.current = [...next]
    setOrderedIds(orderRef.current)
  }

  useLayoutEffect(() => {
    const positions = previousPositions.current
    cancelAnimations()
    if (!positions || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    for (const [id, before] of positions) {
      const card = cardRefs.current.get(id)
      if (!card?.animate) continue
      const after = card.getBoundingClientRect()
      const x = before.left - after.left
      const y = before.top - after.top
      if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue
      const animation = card.animate([
        { transform: `translate(${x}px, ${y}px)` },
        { transform: 'translate(0px, 0px)' },
      ], { duration: 400, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' })
      animations.current.set(id, animation)
      animation.onfinish = () => {
        if (animations.current.get(id) === animation) animations.current.delete(id)
      }
    }
  }, [orderedIds])

  useLayoutEffect(() => {
    if (sameOrder(previousServerOrder.current, serverOrder)) return
    previousServerOrder.current = serverOrder
    // A successful save can echo the displayed order before its promise settles.
    // Keep that layout and its remaining animation intact.
    if (sameOrder(orderRef.current, serverOrder)) return
    // A refreshed membership/order supersedes this gesture. A pending save still
    // holds the drag lock, but its eventual result must not restore stale cards.
    cancelAnimations()
    if (reorderGesture.current) {
      removeActiveDragPreview.current?.()
      reorderGesture.current = null
      setDraggingId(null)
      onDragStateChange?.(false)
    }
    orderRef.current = serverOrder
    setOrderedIds(serverOrder)
  }, [serverOrder])

  useEffect(() => {
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const onChange = () => { if (reducedMotion?.matches) cancelAnimations() }
    reducedMotion?.addEventListener('change', onChange)
    return () => reducedMotion?.removeEventListener('change', onChange)
  }, [])

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      removeActiveDragPreview.current?.()
      reorderGesture.current = null
      cancelAnimations()
    }
  }, [])

  const noteById = useMemo(() => new Map(notes.map((note) => [note.record.id, note])), [notes])
  const orderedNotes = orderedIds.map((id) => noteById.get(id)).filter((note): note is StickyNoteSummary => Boolean(note))

  const acceptDrop = (event: DragEvent) => {
    const gesture = reorderGesture.current
    if (activeProps && gesture && event.dataTransfer.types.includes(STICKY_NOTE_CARD_DRAG_TYPE)) {
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = 'move'
      if (pendingDrop.current || !gridRef.current) return
      const grid = gridRef.current
      const bounds = grid.getBoundingClientRect()
      const x = event.clientX - bounds.left - grid.clientLeft + grid.scrollLeft
      const y = event.clientY - bounds.top - grid.clientTop + grid.scrollTop
      // offsetLeft/Top are stable layout cells; animated visual rectangles and
      // dragenter targets can cross a stationary pointer during FLIP movement.
      const targetId = orderRef.current.find((id) => {
        const card = cardRefs.current.get(id)
        return card && x >= card.offsetLeft && x < card.offsetLeft + card.offsetWidth
          && y >= card.offsetTop && y < card.offsetTop + card.offsetHeight
      })
      if (targetId && targetId !== gesture.id) {
        dragged.current = true
        changeOrder(moveId(orderRef.current, gesture.id, targetId), gesture.id)
      }
      return
    }
    if (!activeProps?.onDropFiles || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const finishDrop = async (event: DragEvent) => {
    const gesture = reorderGesture.current
    if (!activeProps || !gesture || !event.dataTransfer.types.includes(STICKY_NOTE_CARD_DRAG_TYPE)) return
    event.preventDefault()
    event.stopPropagation()
    if (pendingDrop.current) return
    pendingDrop.current = true
    setPersisting(true)
    let persisted = false
    try {
      persisted = (await activeProps.onReorder?.([...orderRef.current])) !== false
    } catch {
      // A rejected persistence request has the same rollback semantics as false.
    } finally {
      pendingDrop.current = false
      if (mounted.current) {
        setPersisting(false)
        if (reorderGesture.current === gesture) {
          if (!persisted) changeOrder(gesture.startOrder, gesture.id)
          reorderGesture.current = null
          setDraggingId(null)
          onDragStateChange?.(false)
        }
      }
    }
  }

  const finishMarquee = (event: PointerEvent<HTMLDivElement>) => {
    if (!archiveProps || !marquee || event.pointerId !== marquee.pointerId) return
    const selectionRectangle = {
      left: Math.min(marquee.startX, event.clientX),
      top: Math.min(marquee.startY, event.clientY),
      right: Math.max(marquee.startX, event.clientX),
      bottom: Math.max(marquee.startY, event.clientY),
    }
    const hitIds = orderedNotes
      .filter((note) => {
        const rect = cardRefs.current.get(note.record.id)?.getBoundingClientRect()
        return rect
          ? rectanglesIntersect(selectionRectangle, {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
            })
          : false
      })
      .map(({ record }) => record.id)
    archiveProps.onMarqueeChange(hitIds, marquee.ctrlKey)
    gridRef.current?.releasePointerCapture?.(event.pointerId)
    setMarquee(null)
  }

  const gridRect = marquee ? gridRef.current?.getBoundingClientRect() : null
  const marqueeStyle = marquee && gridRect
    ? {
        left: Math.min(marquee.startX, marquee.currentX) - gridRect.left,
        top: Math.min(marquee.startY, marquee.currentY) - gridRect.top,
        width: Math.abs(marquee.currentX - marquee.startX),
        height: Math.abs(marquee.currentY - marquee.startY),
      }
    : undefined

  return <div
    aria-label={label}
    className="sticky-note-grid"
    data-dragging={draggingId !== null}
    data-interaction-mode={interactionMode}
    onDragOver={acceptDrop}
    onDrop={(event) => {
      if (activeProps && event.dataTransfer.types.includes(STICKY_NOTE_CARD_DRAG_TYPE)) {
        void finishDrop(event)
        return
      }
      if (!activeProps?.onDropFiles || !event.dataTransfer.types.includes('Files')) return
      event.preventDefault()
      event.stopPropagation()
      activeProps.onDropFiles(event.dataTransfer.files)
    }}
    onPointerCancel={(event) => {
      if (!marquee || event.pointerId !== marquee.pointerId) return
      gridRef.current?.releasePointerCapture?.(event.pointerId)
      setMarquee(null)
    }}
    onPointerDown={(event) => {
      if (!archiveProps || event.target !== event.currentTarget) return
      const gesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        ctrlKey: event.ctrlKey || event.metaKey,
      }
      setMarquee(gesture)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }}
    onPointerMove={(event) => {
      if (!marquee || event.pointerId !== marquee.pointerId) return
      setMarquee((current) => current
        ? { ...current, currentX: event.clientX, currentY: event.clientY }
        : current)
    }}
    onPointerUp={finishMarquee}
    ref={gridRef}
    role="grid"
    style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
  >
    {activeProps?.showCreate && <button
      aria-label="新便签"
      className="sticky-note-card sticky-note-create-card"
      disabled={activeProps.createDisabled ?? false}
      onClick={activeProps.onCreate}
      type="button"
    >
      <span aria-hidden="true" className="sticky-note-create-plus">+</span><span>新便签</span>
    </button>}
    {orderedNotes.map((note) => <button
      aria-label={note.record.name}
      aria-selected={archiveProps ? archiveProps.selectedIds.has(note.record.id) : undefined}
      className={'sticky-note-card' + (draggingId === note.record.id ? ' sticky-note-card-dragging' : '')}
      data-material-preset={stickyNoteMaterialPresetIdForStyle(note.record.style) ?? undefined}
      data-reorder-slot={activeProps !== null && draggingId === note.record.id ? 'empty' : undefined}
      draggable={!persisting && (archiveProps !== null || Boolean(activeProps?.onReorder))}
      key={note.record.id}
      onClick={(event) => {
        if (archiveProps) {
          archiveProps.onSelectArchived(note, {
            ctrlKey: event.ctrlKey || event.metaKey,
            shiftKey: event.shiftKey,
          })
          return
        }
        if (!dragged.current) activeProps?.onOpen(note)
        dragged.current = false
      }}
      onContextMenu={(event) => onContextMenu?.(event, note)}
      onDoubleClick={() => archiveProps?.onOpenArchived(note)}
      onKeyDown={(event) => {
        if (!archiveProps || event.key !== 'Enter') return
        event.preventDefault()
        if (!event.repeat) archiveProps.onOpenArchived(note)
      }}
      onDragEnd={() => {
        removeActiveDragPreview.current?.()
        queueMicrotask(() => { dragged.current = false })
        if (pendingDrop.current) return
        const gesture = reorderGesture.current
        if (activeProps && gesture) changeOrder(gesture.startOrder, gesture.id)
        reorderGesture.current = null
        setDraggingId(null)
        onDragStateChange?.(false)
      }}
      onDragStart={(event) => {
        if (pendingDrop.current) {
          event.preventDefault()
          return
        }
        if (archiveProps) {
          const ids = archiveProps.onArchiveDragStart(note)
          setDraggingId(note.record.id)
          onDragStateChange?.(true)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(
            ARCHIVED_STICKY_NOTE_CARD_DRAG_TYPE,
            encodeArchivedStickyNoteDragIds(ids),
          )
          installArchivedDragPreview(event, ids, cardRefs.current, gridRef.current)
          return
        }
        if (!activeProps?.onReorder) {
          event.preventDefault()
          return
        }
        cancelAnimations()
        removeActiveDragPreview.current?.()
        removeActiveDragPreview.current = installActiveDragPreview(event)
        reorderGesture.current = { id: note.record.id, startOrder: [...orderRef.current] }
        dragged.current = false
        setDraggingId(note.record.id)
        onDragStateChange?.(true)
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(STICKY_NOTE_CARD_DRAG_TYPE, note.record.id)
      }}
      onDrop={(event) => {
        if (activeProps) void finishDrop(event)
      }}
      ref={(element) => {
        if (element) cardRefs.current.set(note.record.id, element)
        else cardRefs.current.delete(note.record.id)
      }}
      style={stickyNoteStyleCssVariables(note.record.style, preferences)}
      type="button"
    >
      <span className="sticky-note-card-paper"><strong>{note.record.name}</strong><span>{note.excerpt || '空便签'}</span></span>
    </button>)}
    {marqueeStyle && <div
      className="sticky-note-selection-marquee"
      data-testid="sticky-note-selection-marquee"
      style={marqueeStyle}
    />}
  </div>
}
