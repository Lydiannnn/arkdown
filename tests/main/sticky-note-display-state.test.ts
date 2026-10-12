import { expect, it, vi } from 'vitest'
import { StickyNoteRuntime } from '../../src/main/sticky-notes/sticky-note-runtime'
import type { StickyNoteDocument, StickyNoteRecord } from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'

function note(): StickyNoteDocument {
  const timestamp = '2026-08-02T03:00:00.000Z'
  return {
    record: {
      id: NOTE_ID, name: '展示状态', status: 'active',
      markdownRelativePath: `active/${NOTE_ID}/展示状态.md`, resourcesRelativePath: `active/${NOTE_ID}/resources`,
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: timestamp, updatedAt: timestamp, archivedAt: null,
      released: false, pinned: false, windowBounds: null, lastOpenedAt: null, fontSizePx: 13, lineSpacingMode: 'compact',
    }, markdown: '正文',
  }
}

it('marks a left-click open as released before creating the desktop window', async () => {
  const updateRecord = vi.fn(async (_id: string, update: (record: StickyNoteRecord) => StickyNoteRecord) => update(note().record))
  const windows = {
    open: vi.fn(async () => undefined), close: vi.fn(async () => undefined), reclaim: vi.fn(async () => undefined),
    applyStyle: vi.fn(), setPinned: vi.fn(async () => undefined), resizeToContent: vi.fn(async () => undefined),
  }
  const runtime = new StickyNoteRuntime({
    store: {
      list: vi.fn(async () => []), get: vi.fn(async () => note()), create: vi.fn(async () => note()),
      rename: vi.fn(async () => note()), archive: vi.fn(async () => note()), restore: vi.fn(async () => note()),
      delete: vi.fn(async () => undefined), updateRecord,
    },
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: { stage: vi.fn(), flush: vi.fn(async () => ({ status: 'idle' as const })), subscribe: vi.fn(() => () => undefined) },
    windows,
  })

  await runtime.open(NOTE_ID)

  expect(updateRecord).toHaveBeenCalledWith(NOTE_ID, expect.any(Function))
  expect(updateRecord.mock.invocationCallOrder[0]).toBeLessThan(windows.open.mock.invocationCallOrder[0]!)
  expect(updateRecord.mock.calls[0]?.[1](note().record)).toMatchObject({ released: true, pinned: false })
})
