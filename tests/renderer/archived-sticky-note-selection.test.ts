import { describe, expect, it } from 'vitest'
import {
  applyArchivedMarquee,
  ARCHIVED_STICKY_NOTE_CARD_DRAG_TYPE,
  decodeArchivedStickyNoteDragIds,
  encodeArchivedStickyNoteDragIds,
  rectanglesIntersect,
  selectArchivedCard,
  type ArchivedSelectionState,
  type SelectionModifiers,
} from '../../src/renderer/sticky-notes/archived-sticky-note-selection'

const noModifiers: SelectionModifiers = { ctrlKey: false, shiftKey: false }
const order = ['a', 'b', 'c', 'd']
const idA = '10000000-0000-4000-8000-000000000001'
const idB = '10000000-0000-4000-8000-000000000002'

function selection(selectedIds: readonly string[], anchorId: string | null): ArchivedSelectionState {
  return { selectedIds: new Set(selectedIds), anchorId }
}

describe('archived sticky note selection', () => {
  it('selects an unmodified card from empty state so the first archived selection is established', () => {
    const baseline = selection([], null)

    const next = selectArchivedCard(baseline, 'b', order, noModifiers)

    expect(next).toEqual(selection(['b'], 'b'))
    expect(baseline).toEqual(selection([], null))
  })

  it('selects the anchor range on shift press so intermediate archived cards are not skipped', () => {
    const next = selectArchivedCard(selection(['b'], 'b'), 'd', order, {
      ctrlKey: false,
      shiftKey: true,
    })

    expect(next).toEqual(selection(['b', 'c', 'd'], 'b'))
  })

  it('toggles only the ctrl-pressed card so the existing selection is retained', () => {
    const next = selectArchivedCard(selection(['b', 'c'], 'b'), 'd', order, {
      ctrlKey: true,
      shiftKey: false,
    })

    expect(next).toEqual(selection(['b', 'c', 'd'], 'd'))

    const removed = selectArchivedCard(selection(['b', 'c'], 'b'), 'b', order, {
      ctrlKey: true,
      shiftKey: false,
    })

    expect(removed).toEqual(selection(['c'], 'b'))
  })

  it('resets to an unselected pressed card before dragging so it does not drag a stale group', () => {
    const next = selectArchivedCard(selection(['b', 'c'], 'b'), 'd', order, noModifiers)

    expect(next).toEqual(selection(['d'], 'd'))
  })

  it('preserves a selected group when pressing a selected card so group drag remains intact', () => {
    const baseline = selection(['b', 'c'], 'b')

    const next = selectArchivedCard(baseline, 'b', order, noModifiers)

    expect(next).toEqual(selection(['b', 'c'], 'b'))
    expect(next.selectedIds).not.toBe(baseline.selectedIds)
  })

  it('replaces selection with ordinary marquee hits so prior cards do not persist', () => {
    const baseline = selection(['a', 'd'], 'a')

    const next = applyArchivedMarquee(baseline, ['b', 'c'], false)

    expect(next).toEqual(selection(['b', 'c'], 'a'))
    expect(baseline).toEqual(selection(['a', 'd'], 'a'))
  })

  it('xor-toggles marquee hits against the pointerdown baseline when ctrl is pressed', () => {
    const next = applyArchivedMarquee(selection(['a', 'b'], 'a'), ['b', 'c'], true)

    expect(next).toEqual(selection(['a', 'c'], 'a'))
  })

  it('counts touching marquee and card boundaries as intersecting so edge drags select cards', () => {
    expect(rectanglesIntersect(
      { left: 0, top: 0, right: 10, bottom: 10 },
      { left: 10, top: 10, right: 20, bottom: 20 },
    )).toBe(true)
  })

  it('encodes canonical drag ids in first-seen order so group payloads are deterministic', () => {
    expect(encodeArchivedStickyNoteDragIds([idB, idA, idB, 'not-a-note-id'])).toBe(
      '["10000000-0000-4000-8000-000000000002","10000000-0000-4000-8000-000000000001"]',
    )
  })

  it('uses the archived card-ids mime type so active-card reordering stays isolated', () => {
    expect(ARCHIVED_STICKY_NOTE_CARD_DRAG_TYPE).toBe('application/x-arknote-card-ids')
  })

  it.each([
    ['malformed JSON', '{'],
    ['an empty payload array', '[]'],
    ['a non-array payload', JSON.stringify({ id: idA })],
    ['an uppercase non-canonical id', JSON.stringify(['A0000000-0000-4000-8000-000000000001'])],
    ['a duplicate id list', JSON.stringify([idA, idA])],
  ])('rejects %s so invalid drag payloads fail closed', (_caseName, payload) => {
    expect(decodeArchivedStickyNoteDragIds(payload)).toEqual([])
  })

  it('decodes a canonical archived group payload so valid group drops retain every id', () => {
    expect(decodeArchivedStickyNoteDragIds(JSON.stringify([idB, idA]))).toEqual([idB, idA])
  })
})
