import { expect, it, vi } from 'vitest'
import { StickyNoteRuntime } from '../../src/main/sticky-notes/sticky-note-runtime'
import type { StickyNoteDocument, StickyNoteRecord } from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const FIRST = '00000000-0000-4000-8000-00000000000a'
const SECOND = '00000000-0000-4000-8000-00000000000b'

function document(): StickyNoteDocument {
  const timestamp = '2026-08-07T00:00:00.000Z'
  return {
    record: {
      id: FIRST, name: '便签', status: 'active',
      markdownRelativePath: `active/${FIRST}/便签.md`,
      resourcesRelativePath: `active/${FIRST}/resources`,
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: timestamp, updatedAt: timestamp, archivedAt: null,
      released: false, pinned: false, windowBounds: null, lastOpenedAt: null,
      fontSizePx: 14, lineSpacingMode: 'compact',
    },
    markdown: '',
  }
}

it('deduplicates and commits archived batch restore before one index event', async () => {
  const restoreArchived = vi.fn(async () => undefined)
  const refresh = vi.fn(async () => undefined)
  const source = document()
  const runtime = new StickyNoteRuntime({
    store: {
      list: vi.fn(async () => []), get: vi.fn(async () => source), create: vi.fn(async () => source),
      rename: vi.fn(async () => source), archive: vi.fn(async () => source), restore: vi.fn(async () => source),
      restoreArchived, delete: vi.fn(async () => undefined),
      updateRecord: vi.fn(async (_id: string, update: (record: StickyNoteRecord) => StickyNoteRecord) => update(source.record)),
    },
    importer: { importFile: vi.fn(async () => ({ note: source, warnings: [] })) },
    saveCoordinator: {
      stage: vi.fn(), flush: vi.fn(async () => ({ status: 'idle' as const })),
      subscribe: vi.fn(() => () => undefined),
    },
    windows: {
      open: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
      reclaim: vi.fn(async () => undefined), applyStyle: vi.fn(), setPinned: vi.fn(async () => undefined),
      resizeToContent: vi.fn(async () => undefined),
    },
    searchIndex: { search: vi.fn(async () => []), refresh },
  })
  const events: unknown[] = []
  runtime.subscribe((event) => events.push(event))

  await runtime.restoreArchived([FIRST, FIRST, SECOND])

  expect(restoreArchived).toHaveBeenCalledWith([FIRST, SECOND])
  expect(refresh.mock.calls).toEqual([[FIRST], [SECOND]])
  expect(events).toEqual([{ type: 'index-changed', noteId: null }])
})
