import { afterEach, describe, expect, it, vi } from 'vitest'
import { StickyNoteSaveCoordinator } from '../../src/main/sticky-notes/sticky-note-save-coordinator'
import type { StickyNoteDocument } from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const NOTE_A = '00000000-0000-4000-8000-000000000001'
const NOTE_B = '00000000-0000-4000-8000-000000000002'

function savedDocument(noteId: string, markdown: string): StickyNoteDocument {
  const timestamp = '2026-08-01T00:00:00.000Z'
  return {
    record: {
      id: noteId,
      name: noteId === NOTE_A ? 'Note A' : 'Note B',
      status: 'active',
      markdownRelativePath: `active/${noteId}/note.md`,
      resourcesRelativePath: `active/${noteId}/resources`,
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      released: true,
      pinned: false,
      windowBounds: null,
      lastOpenedAt: null,
      fontSizePx: 13,
      lineSpacingMode: 'compact',
    },
    markdown,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('sticky note shutdown persistence', () => {
  it('rejects shutdown flush when any staged note fails instead of swallowing the error', async () => {
    const writeMarkdown = vi.fn(async (noteId: string, markdown: string) => {
      if (noteId === NOTE_B) throw new Error('disk full')
      return savedDocument(noteId, markdown)
    })
    const coordinator = new StickyNoteSaveCoordinator({
      store: { writeMarkdown },
      reportError: vi.fn(),
    })
    coordinator.stage(NOTE_A, 'saved before shutdown')
    coordinator.stage(NOTE_B, 'must remain staged')

    await expect(coordinator.flushAll()).rejects.toThrow('disk full')

    expect(coordinator.state(NOTE_A)).toMatchObject({ status: 'saved' })
    expect(coordinator.state(NOTE_B)).toEqual({
      status: 'error',
      revision: 1,
      message: 'disk full',
    })
  })

  it('reports and rejects a shutdown flush that exceeds its timeout', async () => {
    vi.useFakeTimers()
    const reportError = vi.fn()
    const writeMarkdown = vi.fn(() => new Promise<StickyNoteDocument>(() => undefined))
    const coordinator = new StickyNoteSaveCoordinator({
      store: { writeMarkdown },
      flushTimeoutMs: 100,
      reportError,
    })
    coordinator.stage(NOTE_A, 'write never finishes')

    const flushing = coordinator.flushAll()
    let outcome: unknown = 'pending'
    void flushing.then(
      () => { outcome = 'resolved' },
      (error: unknown) => { outcome = error },
    )
    await vi.advanceTimersByTimeAsync(100)

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain('100ms')
    expect(reportError).toHaveBeenCalledTimes(1)
  })
})
