import { describe, expect, it, vi } from 'vitest'
import { normalizeStickyNoteWindowBounds, StickyNoteWindowManager } from '../../src/main/sticky-notes/sticky-note-window-manager'
import type {
  StickyNoteDocument,
  StickyNoteRecord,
  StickyNoteSaveState,
  StickyNoteWindowBounds,
} from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'
import { BackgroundSettingsWindowRegistry } from '../../src/main/backgrounds/background-settings-window-registry'
import { BackgroundWorkflow } from '../../src/main/backgrounds/background-workflow'
import type { BackgroundIpcService } from '../../src/main/ipc/register-ipc'
import { restoreStickyNoteWindowBounds } from '../../src/main/sticky-notes/sticky-note-window-bounds'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'

function document(bounds: StickyNoteWindowBounds | null = null): StickyNoteDocument {
  const timestamp = '2026-07-31T03:00:00.000Z'
  return {
    record: {
      id: NOTE_ID,
      name: '测试便签',
      status: 'active',
      markdownRelativePath: `active/${NOTE_ID}/测试便签.md`,
      resourcesRelativePath: `active/${NOTE_ID}/resources`,
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      released: false,
      pinned: false,
      windowBounds: bounds,
      lastOpenedAt: null,
      fontSizePx: 13,
      lineSpacingMode: 'compact',
    },
    markdown: '正文',
  }
}

function fakeWindow(bounds = { x: 10, y: 20, width: 320, height: 320 }) {
  type WindowEvent = { preventDefault(): void } | undefined
  type Listener = { run: (event?: WindowEvent) => void; once: boolean }
  const listeners = new Map<string, Listener[]>()
  const callLog: string[] = []
  let destroyed = false
  const emit = (event: string, value?: WindowEvent) => {
    const current = listeners.get(event) ?? []
    listeners.set(event, current.filter(({ once }) => !once))
    for (const listener of current) listener.run(value)
  }
  return {
    callLog,
    show: vi.fn(() => { callLog.push('show') }),
    hide: vi.fn(),
    focus: vi.fn(() => { callLog.push('focus') }),
    moveTop: vi.fn(() => { callLog.push('moveTop') }),
    moveAbove: vi.fn((sourceMediaId: string) => { callLog.push('moveAbove:' + sourceMediaId) }),
    destroy: vi.fn(() => { destroyed = true; emit('closed') }),
    isDestroyed: vi.fn(() => destroyed),
    setBackgroundMaterial: vi.fn((material: string) => {
      callLog.push(`setBackgroundMaterial:${material}`)
    }),
    setBackgroundColor: vi.fn((color: string) => {
      callLog.push(`setBackgroundColor:${color}`)
    }),
    setAlwaysOnTop: vi.fn((pinned: boolean, level?: string) => {
      callLog.push(`setAlwaysOnTop:${pinned}:${level ?? 'default'}`)
    }),
    isAlwaysOnTop: vi.fn(() => false),
    sendFindRequest: vi.fn(),
    getBounds: vi.fn(() => bounds),
    setBounds: vi.fn((nextBounds: StickyNoteWindowBounds) => { bounds = nextBounds }),
    on: vi.fn((event: string, run: (event?: WindowEvent) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), { run, once: false }])
    }),
    once: vi.fn((event: string, run: (event?: WindowEvent) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), { run, once: true }])
    }),
    emit,
    setDestroyed(value = true) { destroyed = value },
  }
}

describe('StickyNoteWindowManager', () => {
  it('preserves a corrected reopen while still saving a later user move and resize', async () => {
    const original = { x: 160, y: 180, width: 428, height: 301 }
    const resized = { x: 210, y: 230, width: 560, height: 450 }
    let persisted = document(original)
    const windows: ReturnType<typeof fakeWindow>[] = []
    const manager = new StickyNoteWindowManager({
      store: {
        get: async () => structuredClone(persisted),
        updateRecord: async (_noteId, update) => {
          persisted = { ...persisted, record: update(structuredClone(persisted.record)) }
          return structuredClone(persisted.record)
        },
      },
      saveCoordinator: { flush: async () => ({ status: 'idle' }) },
      createWindow: ({ bounds }) => {
        const target = bounds ?? original
        const window = fakeWindow({ ...target, width: target.width + 3, height: target.height + 1 })
        restoreStickyNoteWindowBounds(window, bounds)
        windows.push(window)
        return window
      },
      normalizeBounds: bounds => bounds,
    })

    await manager.open(NOTE_ID)
    await manager.closeAll({ flush: false, preserveSessionState: true })
    expect(persisted.record.windowBounds).toEqual(original)

    await manager.open(NOTE_ID)
    windows[1]!.setBounds(resized)
    await manager.close(NOTE_ID)
    expect(persisted.record.windowBounds).toEqual(resized)

    await manager.open(NOTE_ID)
    expect(windows[2]!.getBounds()).toEqual(resized)
    expect(persisted.markdown).toBe('正文')
  })

  it('keeps the owner background usable after a failed save and closes it only after a successful retry', async () => {
    const owner = fakeWindow()
    const settingsWindow = { ...fakeWindow(), close: vi.fn() }
    let scoped!: BackgroundIpcService
    const persisted = { settings: DEFAULT_BACKGROUND_SETTINGS, imageUrl: null }
    const registry = new BackgroundSettingsWindowRegistry({
      workflow: new BackgroundWorkflow({
        backend: { get: async () => persisted, previewSource: async () => 'asset:image', apply: async () => persisted },
        chooseSource: async () => null, broadcast: vi.fn(),
      }),
      createWindow: () => settingsWindow,
      register: (_window, service) => { scoped = service; return { dispose: vi.fn() } },
    })
    const flush = vi.fn<() => Promise<StickyNoteSaveState>>()
      .mockResolvedValueOnce({ status: 'error', revision: 1, message: '磁盘已满' })
      .mockResolvedValueOnce({ status: 'saved', revision: 2, savedAt: 'now' })
    const manager = new StickyNoteWindowManager({
      store: { get: async () => document(), updateRecord: async (_id, update) => update(document().record) },
      saveCoordinator: { flush }, createWindow: () => owner, normalizeBounds: (bounds) => bounds,
    })
    await manager.open(NOTE_ID)
    const target = { kind: 'sticky-note' as const, noteId: NOTE_ID }
    await registry.serviceForOwner(owner, vi.fn()).open(target)
    await expect(manager.close(NOTE_ID)).rejects.toThrow('磁盘已满')
    await scoped.preview(target, DEFAULT_BACKGROUND_SETTINGS)
    expect(settingsWindow.close).not.toHaveBeenCalled()
    await manager.close(NOTE_ID)
    expect(settingsWindow.close).toHaveBeenCalledOnce()
    await expect(scoped.preview(target, DEFAULT_BACKGROUND_SETTINGS)).rejects.toThrow('unavailable')
  })

  it('creates one window per note and focuses an existing instance', async () => {
    const created = fakeWindow()
    const createWindow = vi.fn(() => created)
    const flush = vi.fn(async () => ({ status: 'idle' as const }))
    const store = {
      get: vi.fn(async () => document()),
      updateRecord: vi.fn(async (_id, update) => update(document().record)),
    }
    const manager = new StickyNoteWindowManager({
      store,
      saveCoordinator: { flush },
      createWindow,
      normalizeBounds: (bounds) => bounds,
    })

    await manager.open(NOTE_ID)
    await manager.open(NOTE_ID)

    expect(createWindow).toHaveBeenCalledTimes(1)
    expect(created.show).toHaveBeenCalledTimes(1)
    expect(created.focus).toHaveBeenCalledTimes(1)
    expect(created.destroy).not.toHaveBeenCalled()
    expect(created.hide).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(manager.openNoteIds()).toEqual([NOTE_ID])
  })

  it('restores the last moved and resized bounds after closing and reopening without losing the name or body', async () => {
    let persisted = document({ x: 10, y: 20, width: 320, height: 320 })
    persisted.record.name = '下周采购清单'
    persisted.markdown = '# 采购\n\n- 牛奶\n- 面包'
    const store = {
      get: async (_noteId: string) => structuredClone(persisted),
      updateRecord: async (_noteId: string, update: (record: StickyNoteRecord) => StickyNoteRecord) => {
        persisted = { ...persisted, record: update(structuredClone(persisted.record)) }
        return structuredClone(persisted.record)
      },
    }
    const windows: ReturnType<typeof fakeWindow>[] = []
    const manager = new StickyNoteWindowManager({
      store,
      saveCoordinator: { flush: async () => ({ status: 'saved', revision: 1, savedAt: 'now' }) },
      createWindow: ({ bounds }) => {
        const window = fakeWindow(bounds ?? undefined)
        windows.push(window)
        return window
      },
      normalizeBounds: bounds => normalizeStickyNoteWindowBounds(bounds, [
        { x: 0, y: 0, width: 1920, height: 1080 },
      ]),
    })

    await manager.open(NOTE_ID)
    const first = windows[0]!
    first.setBounds({ x: 640, y: 410, width: 470, height: 360 })
    await manager.close(NOTE_ID)

    expect(first.isDestroyed()).toBe(true)
    expect(manager.openNoteIds()).toEqual([])
    expect((await store.get(NOTE_ID)).record.windowBounds).toEqual({
      x: 640, y: 410, width: 470, height: 360,
    })

    await manager.open(NOTE_ID)

    expect(windows).toHaveLength(2)
    expect(windows[1]!.getBounds()).toEqual({ x: 640, y: 410, width: 470, height: 360 })
    expect(manager.openNoteIds()).toEqual([NOTE_ID])
    expect(await store.get(NOTE_ID)).toMatchObject({
      record: { id: NOTE_ID, name: '下周采购清单', status: 'active' },
      markdown: '# 采购\n\n- 牛奶\n- 面包',
    })
  })

  it('uses normalized persisted bounds and removes destroyed windows from the registry', async () => {
    const persisted = { x: -5000, y: -5000, width: 480, height: 560 }
    const normalized = { x: 50, y: 60, width: 480, height: 560 }
    const created = fakeWindow(normalized)
    const createWindow = vi.fn(() => created)
    const persistedDocument = document(persisted)
    persistedDocument.record.pinned = true
    const manager = new StickyNoteWindowManager({
      store: {
        get: vi.fn(async () => persistedDocument),
        updateRecord: vi.fn(async (_id, update) => update(persistedDocument.record)),
      },
      saveCoordinator: { flush: vi.fn(async () => ({ status: 'idle' as const })) },
      createWindow,
      normalizeBounds: () => normalized,
    })

    await manager.open(NOTE_ID)
    expect(createWindow).toHaveBeenCalledWith(expect.objectContaining({
      noteId: NOTE_ID,
      bounds: normalized,
      pinned: true,
      style: persistedDocument.record.style,
    }))
    created.emit('closed')
    expect(manager.openNoteIds()).toEqual([])
  })

  it('flushes and persists bounds before closing without changing note content', async () => {
    const created = fakeWindow({ x: 100, y: 120, width: 400, height: 420 })
    const updateRecord = vi.fn(async (_id, update) => update(document().record))
    const flush = vi.fn(async () => ({ status: 'saved' as const, revision: 1, savedAt: 'now' }))
    const store = { get: vi.fn(async () => document()), updateRecord }
    const manager = new StickyNoteWindowManager({
      store,
      saveCoordinator: { flush },
      createWindow: () => created,
      normalizeBounds: (bounds) => bounds,
    })

    await manager.open(NOTE_ID)
    await manager.close(NOTE_ID)

    expect(flush).toHaveBeenCalledWith(NOTE_ID)
    expect(updateRecord).toHaveBeenCalledWith(NOTE_ID, expect.any(Function))
    const updated = updateRecord.mock.calls[0][1](document().record)
    expect(updated.windowBounds).toEqual({ x: 100, y: 120, width: 400, height: 420 })
    expect(store.get).toHaveBeenCalledTimes(1)
    expect(created.destroy).toHaveBeenCalled()
  })

  it('rejects archived notes and keeps a window open when flushing fails', async () => {
    const archived = document()
    archived.record.status = 'archived'
    archived.record.archivedAt = archived.record.updatedAt
    const created = fakeWindow()
    const manager = new StickyNoteWindowManager({
      store: {
        get: vi.fn()
          .mockResolvedValueOnce(archived)
          .mockResolvedValueOnce(document()),
        updateRecord: vi.fn(),
      },
      saveCoordinator: {
        flush: vi.fn(async () => ({ status: 'error' as const, revision: 1, message: '磁盘已满' })),
      },
      createWindow: () => created,
      normalizeBounds: (bounds) => bounds,
    })

    await expect(manager.open(NOTE_ID)).rejects.toThrow('归档便签不能打开编辑窗口')
    await manager.open(NOTE_ID)
    await expect(manager.close(NOTE_ID)).rejects.toThrow('磁盘已满')
    expect(created.destroy).not.toHaveBeenCalled()
  })
  it('shows and hides every live sticky-note window without closing it', async () => {
    const created = fakeWindow()
    const manager = new StickyNoteWindowManager({
      store: {
        get: vi.fn(async () => document()),
        updateRecord: vi.fn(async (_id, update) => update(document().record)),
      },
      saveCoordinator: { flush: vi.fn(async () => ({ status: 'idle' as const })) },
      createWindow: () => created,
      normalizeBounds: (bounds) => bounds,
    })

    await manager.open(NOTE_ID)
    manager.hideAll()
    manager.showAll()

    expect(created.hide).toHaveBeenCalledTimes(1)
    expect(created.show).toHaveBeenCalledTimes(1)
    expect(created.destroy).not.toHaveBeenCalled()
  })

  it('forwards find queries to new and existing note windows', async () => {
    const created = fakeWindow()
    const manager = new StickyNoteWindowManager({
      store: {
        get: vi.fn(async () => document()),
        updateRecord: vi.fn(async (_id, update) => update(document().record)),
      },
      saveCoordinator: { flush: vi.fn(async () => ({ status: 'idle' as const })) },
      createWindow: () => created,
      normalizeBounds: (bounds) => bounds,
    })

    await manager.open(NOTE_ID, { findQuery: '第一处' })
    await manager.open(NOTE_ID, { findQuery: '下一次' })

    expect(created.sendFindRequest.mock.calls).toEqual([['第一处'], ['下一次']])
  })

  it('updates an open note material without recreating its window', async () => {
    const created = fakeWindow()
    const createWindow = vi.fn(() => created)
    const manager = new StickyNoteWindowManager({
      store: {
        get: vi.fn(async () => document()),
        updateRecord: vi.fn(async (_id, update) => update(document().record)),
      },
      saveCoordinator: { flush: vi.fn(async () => ({ status: 'idle' as const })) },
      createWindow,
      normalizeBounds: (bounds) => bounds,
    })

    await manager.open(NOTE_ID)
    manager.applyStyle(NOTE_ID, {
      mode: 'material',
      materialPresetId: 'flowing-glass',
    })

    expect(created.setBackgroundMaterial).toHaveBeenLastCalledWith('acrylic')
    expect(created.setBackgroundColor).not.toHaveBeenCalled()
    expect(created.callLog.slice(-1)).toEqual(['setBackgroundMaterial:acrylic'])
    expect(createWindow).toHaveBeenCalledTimes(1)
  })

  it('routes live style changes through the owned native surface when available', async () => {
    const created = Object.assign(fakeWindow(), { setStickyNoteSurface: vi.fn() })
    const manager = new StickyNoteWindowManager({
      store: {
        get: vi.fn(async () => document()),
        updateRecord: vi.fn(async (_id, update) => update(document().record)),
      },
      saveCoordinator: { flush: vi.fn(async () => ({ status: 'idle' as const })) },
      createWindow: () => created,
      normalizeBounds: (bounds) => bounds,
    })
    await manager.open(NOTE_ID)
    const style = { mode: 'material' as const, materialPresetId: 'clear-glass' as const }
    manager.applyStyle(NOTE_ID, style)
    expect(created.setStickyNoteSurface).toHaveBeenCalledExactlyOnceWith(style)
    expect(created.setBackgroundMaterial).not.toHaveBeenCalled()
    created.setDestroyed()
    manager.applyStyle(NOTE_ID, style)
    expect(created.setStickyNoteSurface).toHaveBeenCalledTimes(1)
  })

  it('ignores style updates after the mapped window is destroyed', async () => {
    const created = fakeWindow()
    const manager = new StickyNoteWindowManager({
      store: {
        get: vi.fn(async () => document()),
        updateRecord: vi.fn(async (_id, update) => update(document().record)),
      },
      saveCoordinator: { flush: vi.fn(async () => ({ status: 'idle' as const })) },
      createWindow: () => created,
      normalizeBounds: (bounds) => bounds,
    })

    await manager.open(NOTE_ID)
    created.setDestroyed()
    manager.applyStyle(NOTE_ID, {
      mode: 'material',
      materialPresetId: 'mica-light',
    })

    expect(created.setBackgroundMaterial).not.toHaveBeenCalled()
    expect(created.setBackgroundColor).not.toHaveBeenCalled()
  })

  it('preserves the captured open set while destroying windows for app shutdown', async () => {
    const created = fakeWindow()
    const onWindowState = vi.fn()
    const manager = new StickyNoteWindowManager({
      store: {
        get: vi.fn(async () => document()),
        updateRecord: vi.fn(async (_id, update) => update(document().record)),
      },
      saveCoordinator: { flush: vi.fn(async () => ({ status: 'idle' as const })) },
      createWindow: () => created,
      normalizeBounds: (bounds) => bounds,
      onWindowState,
    })

    await manager.open(NOTE_ID)
    await manager.closeAll({ flush: false, preserveSessionState: true })

    expect(onWindowState.mock.calls).toEqual([[NOTE_ID, true, false]])
  })

})


it('applies autosizing only once after release and pins immediately', async () => {
  const created = fakeWindow({ x: 10, y: 20, width: 320, height: 320 })
  const updateRecord = vi.fn(async (_id, update) => update(document().record))
  const manager = new StickyNoteWindowManager({
    store: { get: vi.fn(async () => document()), updateRecord },
    saveCoordinator: { flush: vi.fn(async () => ({ status: 'idle' as const })) },
    createWindow: () => created,
    normalizeBounds: (bounds) => bounds,
    sizeForContent: () => ({ width: 520, height: 680 }),
  })

  await manager.open(NOTE_ID, { autoSize: true })
  await manager.resizeToContent(NOTE_ID, { scrollWidth: 480, scrollHeight: 590 })
  await manager.resizeToContent(NOTE_ID, { scrollWidth: 900, scrollHeight: 900 })

  expect(created.setBounds).toHaveBeenCalledTimes(1)
  expect(created.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 520, height: 680 })

  await manager.setPinned(NOTE_ID, true)
  expect(created.setAlwaysOnTop).toHaveBeenLastCalledWith(true, 'pop-up-menu')
  const pinned = updateRecord.mock.calls.at(-1)?.[1](document().record)
  expect(pinned).toMatchObject({ released: true, pinned: true })

  await manager.setPinned(NOTE_ID, false)
  expect(created.setAlwaysOnTop).toHaveBeenLastCalledWith(false)
})


it('intercepts native close before flushing and leaves the window alive when saving fails', async () => {
  const created = fakeWindow()
  const flush = vi.fn(async () => ({ status: 'error' as const, revision: 1, message: '磁盘已满' }))
  const manager = new StickyNoteWindowManager({
    store: {
      get: vi.fn(async () => document()),
      updateRecord: vi.fn(async (_id, update) => update(document().record)),
    },
    saveCoordinator: { flush },
    createWindow: () => created,
    normalizeBounds: (bounds) => bounds,
  })
  await manager.open(NOTE_ID)

  const preventDefault = vi.fn()
  const closeListener = created.on.mock.calls.find(([event]) => event === 'close')?.[1]
  ;(closeListener as unknown as ((event: { preventDefault(): void }) => void) | undefined)?.({ preventDefault })
  await Promise.resolve()
  await Promise.resolve()

  expect(preventDefault).toHaveBeenCalledTimes(1)
  expect(flush).toHaveBeenCalledWith(NOTE_ID)
  expect(created.destroy).not.toHaveBeenCalled()
})


describe('sticky-note foreground promotion', () => {
  function setup(stored = document()) {
    const created = fakeWindow()
    const store = {
      get: vi.fn(async () => stored),
      updateRecord: vi.fn(async (_id, update) => update(stored.record)),
    }
    const flush = vi.fn<() => Promise<StickyNoteSaveState>>(
      async () => ({ status: 'idle' as const }),
    )
    const manager = new StickyNoteWindowManager({
      store,
      saveCoordinator: { flush },
      createWindow: () => created,
      normalizeBounds: (bounds) => bounds,
    })
    return { created, store, flush, manager }
  }

  it('temporarily pins a user-opened unpinned window, moves it to the top, then restores normal z-order', async () => {
    vi.useFakeTimers()
    try {
      const { created, manager } = setup()

      await manager.open(NOTE_ID, { foregroundSourceId: 'window:317:0' })
      created.emit('ready-to-show')

      expect(created.callLog).toEqual([
        'setAlwaysOnTop:true:pop-up-menu',
        'show',
        'moveAbove:window:317:0',
        'focus',
        'moveTop',
      ])

      await vi.runAllTimersAsync()

      expect(created.callLog).toEqual([
        'setAlwaysOnTop:true:pop-up-menu',
        'show',
        'moveAbove:window:317:0',
        'focus',
        'moveTop',
        'setAlwaysOnTop:false:default',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not undo a persistent pin set while temporary foreground promotion is pending', async () => {
    vi.useFakeTimers()
    try {
      const { created, manager } = setup()
      await manager.open(NOTE_ID, { foregroundSourceId: 'window:317:0' })
      created.emit('ready-to-show')
      created.callLog.length = 0

      await manager.setPinned(NOTE_ID, true)
      await vi.runAllTimersAsync()

      expect(created.callLog).toEqual([
        'setAlwaysOnTop:true:pop-up-menu',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('temporarily raises an existing unpinned window when no source window is available', async () => {
    const { created, manager } = setup()
    await manager.open(NOTE_ID)
    created.emit('ready-to-show')
    created.callLog.length = 0

    await manager.open(NOTE_ID)

    expect(created.callLog).toEqual([
      'setAlwaysOnTop:true:pop-up-menu', 'show', 'focus', 'moveTop',
    ])
  })

  it('raises an existing unpinned window directly above its initiating window', async () => {
    const { created, manager } = setup()
    await manager.open(NOTE_ID)
    created.emit('ready-to-show')
    created.callLog.length = 0
    created.moveTop.mockClear()

    await manager.open(NOTE_ID, { foregroundSourceId: 'window:317:0' })

    expect(created.callLog).toEqual([
      'setAlwaysOnTop:true:pop-up-menu', 'show',
      'moveAbove:window:317:0', 'focus', 'moveTop',
    ])
  })

  it('raises a new unpinned window above its initiating window when ready', async () => {
    const { created, manager } = setup()

    await manager.open(NOTE_ID, { foregroundSourceId: 'window:317:0' })
    expect(created.callLog).toEqual([])
    created.emit('ready-to-show')

    expect(created.callLog).toEqual([
      'setAlwaysOnTop:true:pop-up-menu', 'show',
      'moveAbove:window:317:0', 'focus', 'moveTop',
    ])
  })

  it('falls back to moveTop when the initiating window is no longer available', async () => {
    const { created, manager } = setup()
    created.moveAbove.mockImplementationOnce(() => {
      throw new Error('source window is unavailable')
    })

    await manager.open(NOTE_ID, { foregroundSourceId: 'window:317:0' })
    created.emit('ready-to-show')

    expect(created.callLog).toEqual([
      'setAlwaysOnTop:true:pop-up-menu', 'show', 'focus', 'moveTop',
    ])
  })

  it('uses the persisted pin value when raising an existing window', async () => {
    const stored = document()
    const { created, store, manager } = setup(stored)
    await manager.open(NOTE_ID)
    created.emit('ready-to-show')
    created.callLog.length = 0
    stored.record.pinned = true

    await manager.open(NOTE_ID)

    expect(store.get).toHaveBeenCalledTimes(2)
    expect(created.isAlwaysOnTop).not.toHaveBeenCalled()
    expect(created.callLog).toEqual([
      'setAlwaysOnTop:true:pop-up-menu', 'show', 'focus', 'moveTop',
    ])
  })

  it('promotes a new pinned window once at ready-to-show without stealing restore focus', async () => {
    const stored = document()
    stored.record.pinned = true
    const { created, manager } = setup(stored)

    await manager.open(NOTE_ID, { focus: false })

    expect(created.callLog).toEqual([])
    expect(created.once).toHaveBeenCalledTimes(1)
    expect(created.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function))
    created.emit('ready-to-show')
    created.emit('ready-to-show')
    expect(created.callLog).toEqual(['setAlwaysOnTop:true:pop-up-menu', 'show', 'moveTop'])
  })

  it('does not promote a window destroyed before ready-to-show', async () => {
    const { created, manager } = setup()
    await manager.open(NOTE_ID)
    created.setDestroyed()
    created.emit('ready-to-show')
    expect(created.callLog).toEqual([])
  })

  it('suppresses promotion during close and permits promotion and close retry after flush failure', async () => {
    let resolveFlush:
      | ((value: { status: 'error'; revision: number; message: string }) => void)
      | undefined
    const pending = new Promise<{ status: 'error'; revision: number; message: string }>(
      (resolve) => { resolveFlush = resolve },
    )
    const { created, flush, manager } = setup()
    flush.mockImplementationOnce(() => pending)
      .mockResolvedValueOnce({ status: 'saved', revision: 2, savedAt: 'now' })
    await manager.open(NOTE_ID)
    created.emit('ready-to-show')
    created.callLog.length = 0

    const closing = manager.close(NOTE_ID)
    const reopening = manager.open(NOTE_ID)
    expect(created.callLog).toEqual([])

    resolveFlush?.({ status: 'error', revision: 1, message: '磁盘已满' })
    await expect(closing).rejects.toThrow('磁盘已满')
    await reopening
    expect(created.callLog).toEqual([
      'setAlwaysOnTop:true:pop-up-menu', 'show', 'focus', 'moveTop',
    ])
    await manager.close(NOTE_ID)
    expect(created.destroy).toHaveBeenCalledTimes(1)
  })

  it('reopens with released display state after an in-flight close flush succeeds', async () => {
    let record = document().record
    record = { ...record, released: true }
    let resolveFlush:
      | ((value: { status: 'saved'; revision: number; savedAt: string }) => void)
      | undefined
    const pending = new Promise<{ status: 'saved'; revision: number; savedAt: string }>(
      (resolve) => { resolveFlush = resolve },
    )
    const first = fakeWindow()
    const reopened = fakeWindow()
    const createWindow = vi.fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce(() => {
        queueMicrotask(() => reopened.emit('ready-to-show'))
        return reopened
      })
    const store = {
      get: vi.fn(async () => ({ ...document(), record })),
      updateRecord: vi.fn(async (_id, update) => {
        record = update(record)
        return record
      }),
    }
    const onWindowState = vi.fn()
    const manager = new StickyNoteWindowManager({
      store,
      saveCoordinator: { flush: vi.fn(() => pending) },
      createWindow,
      normalizeBounds: (bounds) => bounds,
      onWindowState,
    })
    await manager.open(NOTE_ID)
    first.emit('ready-to-show')

    const closing = manager.close(NOTE_ID)
    await store.updateRecord(NOTE_ID, (current: StickyNoteRecord) => ({ ...current, released: true }))
    const openings = [manager.open(NOTE_ID), manager.open(NOTE_ID)]

    resolveFlush?.({ status: 'saved', revision: 1, savedAt: 'now' })
    await closing
    await Promise.all(openings)

    expect(first.destroy).toHaveBeenCalledTimes(1)
    expect(createWindow).toHaveBeenCalledTimes(2)
    expect(reopened.show).toHaveBeenCalled()
    expect(manager.openNoteIds()).toEqual([NOTE_ID])
    expect(onWindowState.mock.calls).toEqual([
      [NOTE_ID, true, false],
      [NOTE_ID, false, false],
      [NOTE_ID, true, false],
    ])
    expect(record).toMatchObject({ released: true, pinned: false })
  })


  it('coalesces repeated close calls and native close events into one active attempt', async () => {
    let resolveFlush:
      | ((value: { status: 'error'; revision: number; message: string }) => void)
      | undefined
    const pending = new Promise<{ status: 'error'; revision: number; message: string }>(
      (resolve) => { resolveFlush = resolve },
    )
    const { created, flush, manager } = setup()
    flush.mockImplementationOnce(() => pending)
      .mockResolvedValue({ status: 'saved', revision: 2, savedAt: 'now' })
    await manager.open(NOTE_ID)
    created.emit('ready-to-show')
    created.callLog.length = 0

    const firstClose = manager.close(NOTE_ID)
    const repeatedClose = manager.close(NOTE_ID)
    const preventDefault = vi.fn()
    const nativeClose = created.on.mock.calls.find(([event]) => event === 'close')?.[1]
    nativeClose?.({ preventDefault })

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)

    const reopening = manager.open(NOTE_ID)
    expect(created.callLog).toEqual([])

    resolveFlush?.({ status: 'error', revision: 1, message: '磁盘已满' })
    await expect(firstClose).rejects.toThrow('磁盘已满')
    await expect(repeatedClose).rejects.toThrow('磁盘已满')

    await reopening
    expect(created.callLog).toEqual([
      'setAlwaysOnTop:true:pop-up-menu', 'show', 'focus', 'moveTop',
    ])

    await manager.close(NOTE_ID)
    expect(flush).toHaveBeenCalledTimes(2)
    expect(created.destroy).toHaveBeenCalledTimes(1)
  })
})
