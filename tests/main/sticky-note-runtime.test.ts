import { expect, it, vi } from 'vitest'
import { StickyNoteRuntime } from '../../src/main/sticky-notes/sticky-note-runtime'
import type { StickyNoteDocument, StickyNoteRecord } from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'

function note(): StickyNoteDocument {
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
    },
    markdown: '正文',
  }
}

it('composes storage, saving and windows behind one event-emitting service', async () => {
  const store = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => note()),
    create: vi.fn(async () => note()),
    rename: vi.fn(async () => note()),
    archive: vi.fn(async () => note()),
    restore: vi.fn(async () => note()),
    delete: vi.fn(async () => undefined),
    updateRecord: vi.fn(async (_id: string, update: (record: StickyNoteRecord) => StickyNoteRecord) =>
      update(note().record)),
  }
  const save = {
    stage: vi.fn(),
    flush: vi.fn(async () => ({ status: 'idle' as const })),
    subscribe: vi.fn(() => () => undefined),
  }
  const windows = {
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    reclaim: vi.fn(async () => undefined),
    applyStyle: vi.fn(),
    setPinned: vi.fn(async () => undefined),
    resizeToContent: vi.fn(async () => undefined),
  }
  const runtime = new StickyNoteRuntime({
    store,
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: save,
    windows,
  })
  const events: unknown[] = []
  runtime.subscribe((event) => events.push(event))

  await runtime.create({ name: '测试' })
  runtime.stageSave(NOTE_ID, '修改')
  await runtime.open(NOTE_ID)
  await runtime.open(NOTE_ID, 'needle', 'window:317:0')

  expect(store.create).toHaveBeenCalled()
  expect(save.stage).toHaveBeenCalledWith(NOTE_ID, '修改')
  expect(windows.open.mock.calls).toEqual([
    [NOTE_ID],
    [NOTE_ID, { findQuery: 'needle', foregroundSourceId: 'window:317:0' }],
  ])
  expect(events).toContainEqual({ type: 'index-changed', noteId: NOTE_ID })
})

it('closes the note window before archiving and publishes the index change', async () => {
  const callOrder: string[] = []
  const archived = note()
  archived.record.status = 'archived'
  archived.record.archivedAt = '2026-07-31T04:00:00.000Z'
  archived.record.released = false
  archived.record.pinned = false
  const store = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => note()),
    create: vi.fn(async () => note()),
    rename: vi.fn(async () => note()),
    archive: vi.fn(async () => { callOrder.push('archive'); return archived }),
    restore: vi.fn(async () => note()),
    delete: vi.fn(async () => undefined),
    updateRecord: vi.fn(async (_id: string, update: (record: StickyNoteRecord) => StickyNoteRecord) => update(note().record)),
  }
  const runtime = new StickyNoteRuntime({
    store,
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: {
      stage: vi.fn(),
      flush: vi.fn(async () => ({ status: 'idle' as const })),
      subscribe: vi.fn(() => () => undefined),
    },
    windows: {
      open: vi.fn(async () => undefined),
      close: vi.fn(async () => { callOrder.push('close') }),
      reclaim: vi.fn(async () => undefined),
      applyStyle: vi.fn(),
      setPinned: vi.fn(async () => undefined),
      resizeToContent: vi.fn(async () => undefined),
    },
  })
  const events: unknown[] = []
  runtime.subscribe((event) => events.push(event))

  await expect(runtime.archive(NOTE_ID)).resolves.toBe(archived)

  expect(callOrder).toEqual(['close', 'archive'])
  expect(archived.record).toMatchObject({ released: false, pinned: false, status: 'archived' })
  expect(events).toContainEqual({ type: 'index-changed', noteId: NOTE_ID })
})

it('forwards atomic background applies and broadcasts only after they commit', async () => {
  const updated = note().record
  const applyBackground = vi.fn(async () => updated)
  const runtime = new StickyNoteRuntime({
    store: {
      list: vi.fn(async () => []), get: vi.fn(async () => note()), create: vi.fn(async () => note()),
      rename: vi.fn(async () => note()), archive: vi.fn(async () => note()), restore: vi.fn(async () => note()),
      delete: vi.fn(async () => undefined), updateRecord: vi.fn(async (_id, update) => update(note().record)),
      applyBackground,
    },
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: { stage: vi.fn(), flush: vi.fn(async () => ({ status: 'idle' as const })), subscribe: vi.fn(() => () => undefined) },
    windows: { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined), reclaim: vi.fn(async () => undefined), applyStyle: vi.fn(), setPinned: vi.fn(async () => undefined), resizeToContent: vi.fn(async () => undefined) },
  })
  const events: unknown[] = []
  runtime.subscribe((event) => events.push(event))

  await expect((runtime as unknown as {
    applyBackground(noteId: string, settings: typeof DEFAULT_BACKGROUND_SETTINGS, imageUpdate: { kind: 'remove' }): Promise<StickyNoteRecord>
  }).applyBackground(NOTE_ID, DEFAULT_BACKGROUND_SETTINGS, { kind: 'remove' })).resolves.toBe(updated)

  expect(applyBackground).toHaveBeenCalledWith(NOTE_ID, DEFAULT_BACKGROUND_SETTINGS, { kind: 'remove' }, undefined)
  expect(events).toContainEqual({ type: 'index-changed', noteId: NOTE_ID })
})


it('does not emit a stale background index event after its owner invalidates a pending apply', async () => {
  let finish!: (value: StickyNoteRecord) => void
  const pending = new Promise<StickyNoteRecord>((resolve) => { finish = resolve })
  const runtime = new StickyNoteRuntime({
    store: { applyBackground: async () => pending } as never,
    importer: {} as never,
    saveCoordinator: { subscribe: () => () => undefined } as never,
    windows: {} as never,
  })
  const events: unknown[] = []
  runtime.subscribe((event) => events.push(event))
  let active = true
  const applying = runtime.applyBackground(NOTE_ID, DEFAULT_BACKGROUND_SETTINGS, { kind: 'keep' }, () => {
    if (!active) throw new Error('stale session')
  })
  const rejected = expect(applying).rejects.toThrow('stale session')
  active = false
  finish(note().record)
  await rejected
  expect(events).toEqual([])
})

it('broadcasts a three-line summary after a successful save', async () => {
  let saved: ((noteId: string, state: import('../../src/shared/sticky-notes').StickyNoteSaveState) => void) | undefined
  const source = note()
  source.markdown = '# 第一行\n第二行\n第三行\n第四行'
  const runtime = new StickyNoteRuntime({
    store: {
      list: vi.fn(async () => []), get: vi.fn(async () => source), create: vi.fn(async () => source),
      rename: vi.fn(async () => source), archive: vi.fn(async () => source), restore: vi.fn(async () => source),
      delete: vi.fn(async () => undefined), updateRecord: vi.fn(async (_id, update) => update(source.record)),
    },
    importer: { importFile: vi.fn(async () => ({ note: source, warnings: [] })) },
    saveCoordinator: {
      stage: vi.fn(), flush: vi.fn(async () => ({ status: 'idle' as const })),
      subscribe: vi.fn((listener) => { saved = listener; return () => undefined }),
    },
    windows: {
      open: vi.fn(async () => undefined), close: vi.fn(async () => undefined), reclaim: vi.fn(async () => undefined),
      applyStyle: vi.fn(),
      setPinned: vi.fn(async () => undefined), resizeToContent: vi.fn(async () => undefined),
    },
  })
  const events: unknown[] = []
  runtime.subscribe((event) => events.push(event))

  saved?.(NOTE_ID, { status: 'saved', revision: 1, savedAt: '2026-08-02T03:00:02.000Z' })
  await new Promise((resolve) => setTimeout(resolve, 0))

  expect(events).toContainEqual(expect.objectContaining({
    type: 'note-summary-changed', noteId: NOTE_ID, revision: 1,
    summary: expect.objectContaining({ excerpt: '第一行 第二行 第三行 第四行' }),
  }))
})


function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

it('reserves the save-summary revision before asynchronous summary loading', async () => {
  const delayed = deferred<StickyNoteDocument>()
  let saved: ((noteId: string, state: import('../../src/shared/sticky-notes').StickyNoteSaveState) => void) | undefined
  const runtime = new StickyNoteRuntime({
    store: {
      list: vi.fn(async () => []), get: vi.fn(() => delayed.promise), create: vi.fn(async () => note()),
      rename: vi.fn(async () => note()), archive: vi.fn(async () => note()), restore: vi.fn(async () => note()),
      delete: vi.fn(async () => undefined), updateRecord: vi.fn(async (_id, update) => update(note().record)),
    },
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: { stage: vi.fn(), flush: vi.fn(async () => ({ status: 'idle' as const })), subscribe: vi.fn((listener) => { saved = listener; return () => undefined }) },
    windows: { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined), reclaim: vi.fn(async () => undefined), applyStyle: vi.fn(), setPinned: vi.fn(async () => undefined), resizeToContent: vi.fn(async () => undefined) },
  })
  const events: import('../../src/shared/sticky-notes').StickyNoteEvent[] = []
  runtime.subscribe((event) => events.push(event))

  saved?.(NOTE_ID, { status: 'saved', revision: 1, savedAt: '2026-08-02T04:00:00.000Z' })
  await runtime.setStyle(NOTE_ID, { mode: 'preset', colorPresetId: 'blue', texturePresetId: 'plain' })
  delayed.resolve(note())
  await Promise.resolve()
  await Promise.resolve()

  expect(events.filter((event) => 'revision' in event).map((event) => event.revision)).toEqual([2, 1])
})

it('persists, applies, then broadcasts a material style', async () => {
  const callOrder: string[] = []
  const materialStyle = {
    mode: 'material' as const,
    materialPresetId: 'flowing-glass' as const,
  }
  const runtime = new StickyNoteRuntime({
    store: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => note()),
      create: vi.fn(async () => note()),
      rename: vi.fn(async () => note()),
      archive: vi.fn(async () => note()),
      restore: vi.fn(async () => note()),
      delete: vi.fn(async () => undefined),
      updateRecord: vi.fn(async (_id, update) => {
        callOrder.push('store')
        return update(note().record)
      }),
    },
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: {
      stage: vi.fn(),
      flush: vi.fn(async () => ({ status: 'idle' as const })),
      subscribe: vi.fn(() => () => undefined),
    },
    windows: {
      open: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      reclaim: vi.fn(async () => undefined),
      applyStyle: vi.fn(() => { callOrder.push('window') }),
      setPinned: vi.fn(async () => undefined),
      resizeToContent: vi.fn(async () => undefined),
    },
  })
  runtime.subscribe((event) => {
    if (event.type === 'index-changed') callOrder.push('index-event')
    if (event.type === 'note-style-changed') callOrder.push('style-event')
  })

  await runtime.setStyle(NOTE_ID, materialStyle)

  expect(callOrder).toEqual(['store', 'window', 'index-event', 'style-event'])
})

it('broadcasts a validated font-size change after the record write succeeds', async () => {
  const runtime = new StickyNoteRuntime({
    store: {
      list: vi.fn(async () => []), get: vi.fn(async () => note()), create: vi.fn(async () => note()),
      rename: vi.fn(async () => note()), archive: vi.fn(async () => note()), restore: vi.fn(async () => note()),
      delete: vi.fn(async () => undefined), updateRecord: vi.fn(async (_id, update) => update(note().record)),
    },
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: { stage: vi.fn(), flush: vi.fn(async () => ({ status: 'idle' as const })), subscribe: vi.fn(() => () => undefined) },
    windows: { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined), reclaim: vi.fn(async () => undefined), applyStyle: vi.fn(), setPinned: vi.fn(async () => undefined), resizeToContent: vi.fn(async () => undefined) },
  })
  const events: unknown[] = []
  runtime.subscribe((event) => events.push(event))

  await (runtime as unknown as { setFontSize(noteId: string, fontSizePx: number): Promise<void> }).setFontSize(NOTE_ID, 16)

  expect(events).toContainEqual({ type: 'note-font-size-changed', noteId: NOTE_ID, revision: 1, fontSizePx: 16 })
})

it('persists a standard line-spacing mode and broadcasts the change', async () => {
  const updateRecord = vi.fn(async (_id: string, update: (record: StickyNoteRecord) => StickyNoteRecord) => update(note().record))
  const runtime = new StickyNoteRuntime({
    store: {
      list: vi.fn(async () => []), get: vi.fn(async () => note()), create: vi.fn(async () => note()),
      rename: vi.fn(async () => note()), archive: vi.fn(async () => note()), restore: vi.fn(async () => note()),
      delete: vi.fn(async () => undefined), updateRecord,
    },
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: { stage: vi.fn(), flush: vi.fn(async () => ({ status: 'idle' as const })), subscribe: vi.fn(() => () => undefined) },
    windows: { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined), reclaim: vi.fn(async () => undefined), applyStyle: vi.fn(), setPinned: vi.fn(async () => undefined), resizeToContent: vi.fn(async () => undefined) },
  })
  const events: unknown[] = []
  runtime.subscribe((event) => events.push(event))

  await (runtime as unknown as {
    setLineSpacingMode(noteId: string, lineSpacingMode: 'compact' | 'standard'): Promise<void>
  }).setLineSpacingMode(NOTE_ID, 'standard')

  expect(updateRecord).toHaveBeenCalledWith(NOTE_ID, expect.any(Function))
  expect(updateRecord.mock.calls[0]?.[1](note().record)).toMatchObject({ lineSpacingMode: 'standard' })
  expect(events).toContainEqual({
    type: 'note-line-spacing-changed', noteId: NOTE_ID, revision: 1, lineSpacingMode: 'standard',
  })
})

it('leaves display-state broadcasting to the window-manager callback chain', async () => {
  const runtime = new StickyNoteRuntime({
    store: {
      list: vi.fn(async () => []), get: vi.fn(async () => note()), create: vi.fn(async () => note()),
      rename: vi.fn(async () => note()), archive: vi.fn(async () => note()), restore: vi.fn(async () => note()),
      delete: vi.fn(async () => undefined), updateRecord: vi.fn(async (_id, update) => update(note().record)),
    },
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: { stage: vi.fn(), flush: vi.fn(async () => ({ status: 'idle' as const })), subscribe: vi.fn(() => () => undefined) },
    windows: { open: vi.fn(async () => undefined), close: vi.fn(async () => undefined), reclaim: vi.fn(async () => undefined), applyStyle: vi.fn(), setPinned: vi.fn(async () => undefined), resizeToContent: vi.fn(async () => undefined) },
  })
  const events: import('../../src/shared/sticky-notes').StickyNoteEvent[] = []
  runtime.subscribe((event) => events.push(event))

  await runtime.archive(NOTE_ID)

  expect(events.filter((event) => event.type === 'note-display-state-changed')).toEqual([])
})


const ARCHIVED_A = '00000000-0000-4000-8000-00000000000a'
const ARCHIVED_B = '00000000-0000-4000-8000-00000000000b'

function archivedDeleteRuntime(options: {
  deleteArchived: (noteIds: readonly string[]) => Promise<void>
  refresh: (noteId: string) => Promise<void>
  reportError?: (error: unknown) => void
}) {
  const close = vi.fn(async () => undefined)
  const runtime = new StickyNoteRuntime({
    store: {
      list: vi.fn(async () => []), get: vi.fn(async () => note()), create: vi.fn(async () => note()),
      rename: vi.fn(async () => note()), archive: vi.fn(async () => note()), restore: vi.fn(async () => note()),
      delete: vi.fn(async () => undefined), deleteArchived: options.deleteArchived,
      updateRecord: vi.fn(async (_id, update) => update(note().record)),
    },
    importer: { importFile: vi.fn(async () => ({ note: note(), warnings: [] })) },
    saveCoordinator: {
      stage: vi.fn(), flush: vi.fn(async () => ({ status: 'idle' as const })),
      subscribe: vi.fn(() => () => undefined),
    },
    windows: {
      open: vi.fn(async () => undefined), close, reclaim: vi.fn(async () => undefined),
      applyStyle: vi.fn(),
      setPinned: vi.fn(async () => undefined), resizeToContent: vi.fn(async () => undefined),
    },
    searchIndex: { search: vi.fn(async () => []), refresh: options.refresh },
    reportError: options.reportError,
  })
  const events: unknown[] = []
  runtime.subscribe((event) => events.push(event))
  return { runtime, close, events }
}

it('deduplicates archived batch deletion before store and search work', async () => {
  const deleteArchived = vi.fn(async () => undefined)
  const refresh = vi.fn(async () => undefined)
  const { runtime, close, events } = archivedDeleteRuntime({ deleteArchived, refresh })

  await runtime.deleteArchived([ARCHIVED_A, ARCHIVED_A, ARCHIVED_B])

  expect(deleteArchived).toHaveBeenCalledTimes(1)
  expect(deleteArchived).toHaveBeenCalledWith([ARCHIVED_A, ARCHIVED_B])
  expect(refresh.mock.calls).toEqual([[ARCHIVED_A], [ARCHIVED_B]])
  expect(close).not.toHaveBeenCalled()
  expect(events).toEqual([{ type: 'index-changed', noteId: null }])
})

it('reports rejected archived-delete search refreshes without failing the committed deletion', async () => {
  const refreshFailure = new Error('refresh failed')
  const reportError = vi.fn()
  const { runtime, events } = archivedDeleteRuntime({
    deleteArchived: vi.fn(async () => undefined),
    refresh: vi.fn(async (noteId) => {
      if (noteId === ARCHIVED_B) throw refreshFailure
    }),
    reportError,
  })

  await expect(runtime.deleteArchived([ARCHIVED_A, ARCHIVED_B])).resolves.toBeUndefined()

  expect(reportError).toHaveBeenCalledTimes(1)
  expect(reportError).toHaveBeenCalledWith(refreshFailure)
  expect(events).toEqual([{ type: 'index-changed', noteId: null }])
})

it('contains a throwing archived-delete error reporter after commit', async () => {
  const firstRefreshFailure = new Error('first refresh failed')
  const secondRefreshFailure = new Error('second refresh failed')
  const reportError = vi.fn(() => {
    throw new Error('reporting failed')
  })
  const { runtime, events } = archivedDeleteRuntime({
    deleteArchived: vi.fn(async () => undefined),
    refresh: vi.fn(async (noteId) => {
      throw noteId === ARCHIVED_A ? firstRefreshFailure : secondRefreshFailure
    }),
    reportError,
  })

  await expect(runtime.deleteArchived([ARCHIVED_A, ARCHIVED_B])).resolves.toBeUndefined()

  expect(reportError.mock.calls).toEqual([[firstRefreshFailure], [secondRefreshFailure]])
  expect(events).toEqual([{ type: 'index-changed', noteId: null }])
})

it('emits no archived-delete side effects when the store commit fails', async () => {
  const storeFailure = new Error('commit failed')
  const refresh = vi.fn(async () => undefined)
  const { runtime, events } = archivedDeleteRuntime({
    deleteArchived: vi.fn(async () => {
      throw storeFailure
    }),
    refresh,
  })

  await expect(runtime.deleteArchived([ARCHIVED_A])).rejects.toBe(storeFailure)

  expect(refresh).not.toHaveBeenCalled()
  expect(events).toEqual([])
})
