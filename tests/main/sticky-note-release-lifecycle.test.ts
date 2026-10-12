import { expect, it, vi } from 'vitest'
import { StickyNoteRuntime } from '../../src/main/sticky-notes/sticky-note-runtime'
import type { StickyNoteDocument, StickyNoteRecord } from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'

function note(overrides: Partial<StickyNoteRecord> = {}): StickyNoteDocument {
  const timestamp = '2026-07-31T03:00:00.000Z'
  return {
    record: {
      id: NOTE_ID,
      name: '测试',
      status: 'active',
      markdownRelativePath: `active/${NOTE_ID}/测试.md`,
      resourcesRelativePath: `active/${NOTE_ID}/resources`,
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      released: false,
      pinned: false,
      windowBounds: null,
      lastOpenedAt: null,
      fontSizePx: 13,
      lineSpacingMode: 'compact',
      ...overrides,
    },
    markdown: '正文',
  }
}

it('releases with one-time autosizing and clears display state on close', async () => {
  let record = note().record
  const store = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => ({ ...note(), record })),
    create: vi.fn(async () => note()),
    rename: vi.fn(async () => note()),
    archive: vi.fn(async () => note()),
    restore: vi.fn(async () => note()),
    delete: vi.fn(async () => undefined),
    updateRecord: vi.fn(async (_id: string, update: (value: StickyNoteRecord) => StickyNoteRecord) => {
      record = update(record)
      return record
    }),
  }
  const windows = {
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => { record = { ...record, released: false, pinned: false } }),
    reclaim: vi.fn(async () => {
      record = { ...record, released: false, pinned: false }
    }),
    applyStyle: vi.fn(),
    setPinned: vi.fn(async (_id: string, pinned: boolean) => {
      record = { ...record, released: pinned || record.released, pinned }
    }),
    resizeToContent: vi.fn(async () => undefined),
  }
  const runtime = new StickyNoteRuntime({
    store,
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: {
      stage: vi.fn(),
      flush: vi.fn(async () => ({ status: 'idle' as const })),
      subscribe: vi.fn(() => () => undefined),
    },
    windows,
  })

  await runtime.release(NOTE_ID)
  expect(record.released).toBe(true)
  expect(windows.open).toHaveBeenCalledWith(NOTE_ID, { autoSize: true })

  await runtime.close(NOTE_ID)
  expect(record).toMatchObject({ released: false, pinned: false })

  await runtime.reclaim(NOTE_ID)
  expect(record).toMatchObject({ released: false, pinned: false })
})

it('forwards bounded content measurements and pin changes to the window manager', async () => {
  const windows = {
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    reclaim: vi.fn(async () => undefined),
    applyStyle: vi.fn(),
    setPinned: vi.fn(async () => undefined),
    resizeToContent: vi.fn(async () => undefined),
  }
  const runtime = new StickyNoteRuntime({
    store: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => note({ released: true })),
      create: vi.fn(async () => note()),
      rename: vi.fn(async () => note()),
      archive: vi.fn(async () => note()),
      restore: vi.fn(async () => note()),
      delete: vi.fn(async () => undefined),
      updateRecord: vi.fn(async (_id, update) => update(note({ released: true }).record)),
    },
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: {
      stage: vi.fn(),
      flush: vi.fn(async () => ({ status: 'idle' as const })),
      subscribe: vi.fn(() => () => undefined),
    },
    windows,
  })

  await runtime.resizeToContent(NOTE_ID, { scrollWidth: 450, scrollHeight: 700 })
  await runtime.setPinned(NOTE_ID, true)

  expect(windows.resizeToContent).toHaveBeenCalledWith(
    NOTE_ID,
    { scrollWidth: 450, scrollHeight: 700 },
  )
  expect(windows.setPinned).toHaveBeenCalledWith(NOTE_ID, true)
})
