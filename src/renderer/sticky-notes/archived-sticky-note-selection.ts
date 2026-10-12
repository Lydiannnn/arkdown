import { isCanonicalStickyNoteId } from '../../shared/sticky-notes'

export interface SelectionModifiers {
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
}

export const ARCHIVED_STICKY_NOTE_CARD_DRAG_TYPE = 'application/x-arknote-card-ids'

export interface ArchivedSelectionState {
  readonly selectedIds: ReadonlySet<string>
  readonly anchorId: string | null
}

interface SelectionRectangle {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export function selectArchivedCard(
  baseline: ArchivedSelectionState,
  id: string,
  order: readonly string[],
  modifiers: SelectionModifiers,
): ArchivedSelectionState {
  if (modifiers.shiftKey) {
    const anchorIndex = baseline.anchorId === null ? -1 : order.indexOf(baseline.anchorId)
    const targetIndex = order.indexOf(id)
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex)
      const end = Math.max(anchorIndex, targetIndex)
      return { selectedIds: new Set(order.slice(start, end + 1)), anchorId: baseline.anchorId }
    }
  }

  if (modifiers.ctrlKey) {
    const selected = new Set(baseline.selectedIds)
    if (selected.has(id)) selected.delete(id)
    else selected.add(id)
    return { selectedIds: selected, anchorId: id }
  }

  if (baseline.selectedIds.has(id)) {
    return { selectedIds: new Set(baseline.selectedIds), anchorId: baseline.anchorId }
  }

  return { selectedIds: new Set([id]), anchorId: id }
}

export function applyArchivedMarquee(
  baseline: ArchivedSelectionState,
  hitIds: readonly string[],
  ctrlKey: boolean,
): ArchivedSelectionState {
  const selected = ctrlKey ? new Set(baseline.selectedIds) : new Set<string>()
  for (const id of hitIds) {
    if (ctrlKey && selected.has(id)) selected.delete(id)
    else selected.add(id)
  }
  return { selectedIds: selected, anchorId: baseline.anchorId }
}

export function rectanglesIntersect(left: SelectionRectangle, right: SelectionRectangle): boolean {
  return left.left <= right.right
    && left.right >= right.left
    && left.top <= right.bottom
    && left.bottom >= right.top
}

export function encodeArchivedStickyNoteDragIds(ids: readonly string[]): string {
  const canonicalIds: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (!isCanonicalStickyNoteId(id) || seen.has(id)) continue
    seen.add(id)
    canonicalIds.push(id)
  }
  return JSON.stringify(canonicalIds)
}

export function decodeArchivedStickyNoteDragIds(payload: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return []
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return []
  if (!parsed.every(isCanonicalStickyNoteId) || new Set(parsed).size !== parsed.length) return []
  return parsed
}
