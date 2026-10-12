import { describe, expect, it, vi } from 'vitest'
import { StickyNoteSessionState } from '../../src/main/sticky-notes/sticky-note-session-state'
import type { StickyNoteDocument } from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const ACTIVE_ID = '00000000-0000-4000-8000-000000000001'
const ARCHIVED_ID = '00000000-0000-4000-8000-000000000002'
const MISSING_ID = '00000000-0000-4000-8000-000000000003'

function note(id: string, status: 'active' | 'archived' = 'active'): StickyNoteDocument {
  const timestamp = '2026-07-31T03:00:00.000Z'
  return {
    record: {
      id,
      name: `便签-${id.at(-1)}`,
      status,
      markdownRelativePath: `${status === 'active' ? 'active' : 'archive'}/${id}/便签.md`,
      resourcesRelativePath: `${status === 'active' ? 'active' : 'archive'}/${id}/resources`,
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: status === 'archived' ? timestamp : null,
      released: status === 'active',
      pinned: status === 'active',
      windowBounds: status === 'active'
        ? { x: 40, y: 60, width: 360, height: 420 }
        : null,
      lastOpenedAt: timestamp,
      fontSizePx: 13,
      lineSpacingMode: 'compact',
    },
    markdown: '# 内容',
  }
}

function setup(initialIds: readonly string[] = []) {
  let storedIds = [...initialIds]
  const writeOpenNoteIds = vi.fn(async (ids: readonly string[]) => {
    storedIds = [...ids]
  })
  const get = vi.fn(async (id: string) => {
    if (id === ACTIVE_ID) return note(id)
    if (id === ARCHIVED_ID) return note(id, 'archived')
    throw new Error('missing')
  })
  const open = vi.fn(async () => undefined)
  const openNoteIds = vi.fn(() => [ACTIVE_ID])
  const flushAll = vi.fn(async () => undefined)
  const reportError = vi.fn()
  const state = new StickyNoteSessionState({
    store: {
      readOpenNoteIds: async () => [...storedIds],
      writeOpenNoteIds,
      get,
    },
    windows: { open, openNoteIds },
    saves: { flushAll },
    reportError,
  })
  return { state, writeOpenNoteIds, get, open, openNoteIds, flushAll, reportError }
}

describe('StickyNoteSessionState', () => {
  it('persists window-open and window-closed changes in order', async () => {
    const { state, writeOpenNoteIds } = setup()

    await state.recordWindowState(ACTIVE_ID, true)
    await state.recordWindowState(ACTIVE_ID, false)

    expect(writeOpenNoteIds.mock.calls.map(([ids]) => ids)).toEqual([
      [ACTIVE_ID],
      [],
    ])
  })

  it('restores only on Arkdown autostart and skips archived, missing, or damaged notes', async () => {
    const { state, open, reportError } = setup([ACTIVE_ID, ARCHIVED_ID, MISSING_ID])

    await expect(state.restore(['C:\\Arkdown\\Arkdown.exe'])).resolves.toBe(0)
    expect(open).not.toHaveBeenCalled()

    await expect(state.restore([
      'C:\\Arkdown\\Arkdown.exe',
      '--arkdown-autostart',
    ])).resolves.toBe(1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(ACTIVE_ID, { focus: false })
    expect(reportError).toHaveBeenCalledTimes(1)
  })

  it('captures the current open set before every shutdown or session-end flush', async () => {
    const { state, writeOpenNoteIds, flushAll } = setup()

    await state.captureAndFlush()

    expect(writeOpenNoteIds).toHaveBeenCalledWith([ACTIVE_ID])
    expect(flushAll).toHaveBeenCalledTimes(1)
    expect(writeOpenNoteIds.mock.invocationCallOrder[0])
      .toBeLessThan(flushAll.mock.invocationCallOrder[0]!)
  })
})
