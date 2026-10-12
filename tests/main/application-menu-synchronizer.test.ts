import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApplicationMenuSynchronizer } from '../../src/main/application-menu-synchronizer'
import { executeApplicationMenuModelItem } from '../../src/main/application-menu'
import { WindowStateCoordinator } from '../../src/main/window-state'
import { RecentDocumentStore } from '../../src/main/recent-documents/recent-document-store'
import { recentDocumentMenuItemId } from '../../src/main/recent-documents/recent-document-menu-id'
import { APPLICATION_MENU_CHANGED_CHANNEL } from '../../src/shared/contracts'
import type {
  ApplicationMenuSection,
  ApplicationMenuWindowState,
} from '../../src/shared/application-menu-model'

function windowState(
  overrides: Partial<ApplicationMenuWindowState> = {},
): ApplicationMenuWindowState {
  return {
    hasPrintableDocument: false,
    spellCheckEnabled: false,
    showEditIndicators: true,
    editorZoomPercent: 100,
    fullscreen: false,
    ...overrides,
  }
}

class FakeWebContents extends EventEmitter {
  destroyed = false
  readonly send = vi.fn()

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

class FakeBrowserWindow extends EventEmitter {
  destroyed = false
  fullscreen = false
  maximized = false

  constructor(readonly webContents: FakeWebContents) {
    super()
  }

  isDestroyed(): boolean { return this.destroyed }
  isFullScreen(): boolean { return this.fullscreen }
  isMaximized(): boolean { return this.maximized }
  close(): void {}
  maximize(): void {}
  minimize(): void {}
  setFullScreen(): void {}
  unmaximize(): void {}
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })))
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function item(
  model: readonly ApplicationMenuSection[],
  id: string,
): Record<string, unknown> | null {
  const visit = (items: readonly unknown[]): Record<string, unknown> | null => {
    for (const candidate of items) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const record = candidate as Record<string, unknown>
      if (record.id === id) return record
      if (Array.isArray(record.items)) {
        const nested = visit(record.items)
        if (nested) return nested
      }
    }
    return null
  }
  return visit(model.flatMap((section) => section.items))
}

function recentItemForPath(
  model: readonly ApplicationMenuSection[],
  absolutePath: string,
): Record<string, unknown> | null {
  const visit = (items: readonly unknown[]): Record<string, unknown> | null => {
    for (const candidate of items) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const record = candidate as Record<string, unknown>
      if (record.kind === 'recent-document' && record.absolutePath === absolutePath) return record
      if (Array.isArray(record.items)) {
        const nested = visit(record.items)
        if (nested) return nested
      }
    }
    return null
  }
  return visit(model.flatMap((section) => section.items))
}

function lastEmittedModel(contents: FakeWebContents): readonly ApplicationMenuSection[] {
  let call: unknown[] | undefined
  for (const candidate of contents.send.mock.calls) {
    if (candidate[0] === APPLICATION_MENU_CHANGED_CHANNEL) call = candidate
  }
  if (!call) throw new Error('No menu model emitted')
  return call[1] as readonly ApplicationMenuSection[]
}

describe('ApplicationMenuSynchronizer', () => {
  it('keeps state isolated per live sender while sharing recent documents', () => {
    let recentDocuments: readonly string[] = ['C:\\Docs\\one.md']
    let focusedId = 1
    const installNativeModel = vi.fn()
    const synchronizer = new ApplicationMenuSynchronizer({
      getRecentDocuments: () => recentDocuments,
      getFocusedWebContentsId: () => focusedId,
      installNativeModel,
    })
    const first = new FakeWebContents(1)
    const second = new FakeWebContents(2)
    synchronizer.register(first)
    synchronizer.register(second)

    expect(synchronizer.updateWindowState(1, windowState({
      fullscreen: true,
      editorZoomPercent: 70,
    }))).toBe(true)
    expect(synchronizer.updateWindowState(2, windowState({
      spellCheckEnabled: true,
      editorZoomPercent: 200,
    }))).toBe(true)

    expect(item(lastEmittedModel(first), 'view.fullscreen')).toMatchObject({ label: '退出全屏' })
    expect(item(lastEmittedModel(first), 'edit.spell-check')).toMatchObject({ checked: false })
    expect(item(lastEmittedModel(second), 'view.fullscreen')).toMatchObject({ label: '全屏' })
    expect(item(lastEmittedModel(second), 'edit.spell-check')).toMatchObject({ checked: true })
    expect(item(lastEmittedModel(first), 'view.editor-zoom-out')).toMatchObject({ disabled: true })
    expect(item(lastEmittedModel(first), 'view.editor-zoom-in')).toMatchObject({ disabled: false })
    expect(item(lastEmittedModel(second), 'view.editor-zoom-in')).toMatchObject({ disabled: true })
    expect(item(lastEmittedModel(second), 'view.editor-zoom-out')).toMatchObject({ disabled: false })
    expect(item(lastEmittedModel(first), 'theme.minimal')).toEqual({
      kind: 'radio',
      id: 'theme.minimal',
      label: '浅色模式',
      checked: false,
      command: 'select-editor-theme-minimal',
    })
    expect(item(lastEmittedModel(first), 'theme.github')).toBeNull()
    expect(recentItemForPath(lastEmittedModel(first), 'C:\\Docs\\one.md')).toMatchObject({
      absolutePath: 'C:\\Docs\\one.md',
    })
    expect(installNativeModel).toHaveBeenLastCalledWith(lastEmittedModel(first))

    focusedId = 2
    recentDocuments = ['C:\\Docs\\two.md', 'C:\\Docs\\one.md']
    synchronizer.refresh()
    expect(recentItemForPath(lastEmittedModel(second), 'C:\\Docs\\two.md')).toMatchObject({
      absolutePath: 'C:\\Docs\\two.md',
    })
    expect(installNativeModel).toHaveBeenLastCalledWith(lastEmittedModel(second))
  })

  it('patches native fullscreen events into only the matching window model', () => {
    let focusedId = 1
    const installNativeModel = vi.fn()
    const synchronizer = new ApplicationMenuSynchronizer({
      getRecentDocuments: () => [],
      getFocusedWebContentsId: () => focusedId,
      installNativeModel,
    })
    const first = new FakeWebContents(1)
    const second = new FakeWebContents(2)
    const firstWindow = new FakeBrowserWindow(first)
    const secondWindow = new FakeBrowserWindow(second)
    synchronizer.register(first)
    synchronizer.register(second)
    synchronizer.updateWindowState(1, windowState({ spellCheckEnabled: true }))
    synchronizer.updateWindowState(2, windowState({ editorZoomPercent: 120 }))
    new WindowStateCoordinator(firstWindow, (state) => {
      synchronizer.updateWindowFullscreen(first.id, state.fullscreen)
    })
    new WindowStateCoordinator(secondWindow, (state) => {
      synchronizer.updateWindowFullscreen(second.id, state.fullscreen)
    })

    firstWindow.fullscreen = true
    firstWindow.emit('enter-full-screen')
    expect(item(lastEmittedModel(first), 'view.fullscreen')).toMatchObject({
      label: '退出全屏',
      checked: true,
    })
    expect(item(lastEmittedModel(first), 'edit.spell-check')).toMatchObject({ checked: true })
    expect(item(lastEmittedModel(second), 'view.fullscreen')).toMatchObject({
      label: '全屏',
      checked: false,
    })
    expect(item(lastEmittedModel(second), 'view.editor-zoom-reset')).toMatchObject({ disabled: false })
    expect(installNativeModel).toHaveBeenLastCalledWith(lastEmittedModel(first))

    first.send.mockClear()
    installNativeModel.mockClear()
    focusedId = 2
    firstWindow.emit('enter-full-screen')
    expect(first.send).not.toHaveBeenCalled()
    expect(installNativeModel).not.toHaveBeenCalled()

    secondWindow.fullscreen = true
    secondWindow.emit('enter-full-screen')
    expect(item(lastEmittedModel(second), 'view.fullscreen')).toMatchObject({
      label: '退出全屏',
      checked: true,
    })
    expect(installNativeModel).toHaveBeenLastCalledWith(lastEmittedModel(second))

    installNativeModel.mockClear()
    firstWindow.fullscreen = false
    firstWindow.emit('leave-full-screen')
    expect(item(lastEmittedModel(first), 'view.fullscreen')).toMatchObject({
      label: '全屏',
      checked: false,
    })
    expect(item(lastEmittedModel(second), 'view.fullscreen')).toMatchObject({
      label: '退出全屏',
      checked: true,
    })
    expect(installNativeModel).toHaveBeenCalledOnce()
    expect(installNativeModel).toHaveBeenCalledWith(lastEmittedModel(second))
  })

  it('removes destroyed senders and never emits or installs their stale state', () => {
    let focusedId: number | null = 7
    const installNativeModel = vi.fn()
    const synchronizer = new ApplicationMenuSynchronizer({
      getRecentDocuments: () => [],
      getFocusedWebContentsId: () => focusedId,
      installNativeModel,
    })
    const contents = new FakeWebContents(7)
    synchronizer.register(contents)
    synchronizer.updateWindowState(7, windowState({ fullscreen: true }))
    contents.send.mockClear()
    installNativeModel.mockClear()

    contents.destroyed = true
    contents.emit('destroyed')
    focusedId = 7
    expect(synchronizer.updateWindowState(7, windowState())).toBe(false)
    synchronizer.refresh()

    expect(contents.send).not.toHaveBeenCalled()
    expect(installNativeModel).not.toHaveBeenCalled()
    expect(synchronizer.modelForWindow(7)).toBeNull()
  })

  it('keeps a clicked custom row bound to the last emitted model during an atomic record', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-menu-snapshot-'))
    temporaryRoots.push(root)
    const oldDocument = path.join(root, 'old.md')
    const newDocument = path.join(root, 'new.md')
    await Promise.all([
      writeFile(oldDocument, '# Old\n', 'utf8'),
      writeFile(newDocument, '# New\n', 'utf8'),
    ])
    const secondWriteStarted = deferred<void>()
    const releaseSecondWrite = deferred<void>()
    let writeCount = 0
    const store = new RecentDocumentStore(root, {
      writeTextFileAtomic: vi.fn(async () => {
        writeCount += 1
        if (writeCount !== 2) return
        secondWriteStarted.resolve()
        await releaseSecondWrite.promise
      }),
    })
    await store.record(oldDocument)
    const synchronizer = new ApplicationMenuSynchronizer({
      getRecentDocuments: () => store.list(),
      getFocusedWebContentsId: () => 1,
      installNativeModel: vi.fn(),
    })
    const contents = new FakeWebContents(1)
    synchronizer.register(contents)
    synchronizer.updateWindowState(1, windowState())
    const oldVisibleId = String(
      recentItemForPath(lastEmittedModel(contents), path.normalize(oldDocument))?.id,
    )

    const pendingRecord = store.record(newDocument)
    await secondWriteStarted.promise
    expect(store.list()[0]).toBe(path.normalize(newDocument))
    expect(synchronizer.itemForWindow(1, oldVisibleId)).toMatchObject({
      absolutePath: path.normalize(oldDocument),
    })

    releaseSecondWrite.resolve()
    await pendingRecord
    synchronizer.refresh()
    expect(synchronizer.itemForWindow(1, oldVisibleId)).toMatchObject({
      absolutePath: path.normalize(oldDocument),
    })
    expect(recentItemForPath(lastEmittedModel(contents), path.normalize(newDocument))).toMatchObject({
      absolutePath: path.normalize(newDocument),
    })
  })

  it('keeps old visible recent IDs path-stable after a newer reordered model is sent', () => {
    const oldDocument = 'C:\\Docs\\old.md'
    const newDocument = 'C:\\Docs\\new.md'
    let recentDocuments: readonly string[] = [oldDocument]
    const installNativeModel = vi.fn()
    const synchronizer = new ApplicationMenuSynchronizer({
      getRecentDocuments: () => recentDocuments,
      getFocusedWebContentsId: () => 1,
      installNativeModel,
    })
    const contents = new FakeWebContents(1)
    synchronizer.register(contents)
    synchronizer.updateWindowState(1, windowState())
    const oldVisibleModel = lastEmittedModel(contents)
    const oldVisibleItem = recentItemForPath(oldVisibleModel, oldDocument)
    const oldVisibleId = oldVisibleItem?.id

    recentDocuments = [newDocument, oldDocument]
    synchronizer.refresh()
    const newModel = lastEmittedModel(contents)
    const reorderedOldItem = recentItemForPath(newModel, oldDocument)
    const newItem = recentItemForPath(newModel, newDocument)

    expect(oldVisibleId).toBeTypeOf('string')
    expect(reorderedOldItem?.id).toBe(oldVisibleId)
    expect(newItem?.id).not.toBe(oldVisibleId)
    expect(String(oldVisibleId)).not.toContain('old.md')
    expect(String(oldVisibleId)).not.toContain('C:\\Docs')
    expect(recentDocumentMenuItemId(oldDocument.toUpperCase())).toBe(oldVisibleId)
    const itemFromOldVisibleModel = synchronizer.itemForWindow(1, String(oldVisibleId))
    expect(itemFromOldVisibleModel).toMatchObject({
      absolutePath: oldDocument,
    })
    const owner = { webContents: {} } as Electron.BrowserWindow
    const openRecentDocument = vi.fn()
    expect(executeApplicationMenuModelItem(owner, itemFromOldVisibleModel!, vi.fn(), {
      createNewWindow: vi.fn(),
      openDocument: vi.fn(),
      closeWindow: vi.fn(),
      openGuide: vi.fn(),
      openAbout: vi.fn(),
      openBackgroundSettings: vi.fn(),
      openRecentDocument,
    })).toBe(true)
    expect(openRecentDocument).toHaveBeenCalledWith(owner, oldDocument)
    expect(installNativeModel).toHaveBeenLastCalledWith(newModel)
  })

  it('keeps the last emitted snapshot when a live sender rejects the next send', () => {
    let recentDocuments: readonly string[] = ['C:\\Docs\\visible.md']
    const synchronizer = new ApplicationMenuSynchronizer({
      getRecentDocuments: () => recentDocuments,
      getFocusedWebContentsId: () => 1,
      installNativeModel: vi.fn(),
    })
    const contents = new FakeWebContents(1)
    synchronizer.register(contents)
    synchronizer.updateWindowState(1, windowState())
    const visibleId = String(
      recentItemForPath(lastEmittedModel(contents), 'C:\\Docs\\visible.md')?.id,
    )
    recentDocuments = ['C:\\Docs\\unseen.md']
    contents.send.mockImplementationOnce(() => { throw new Error('send failed') })

    expect(() => synchronizer.refresh()).not.toThrow()
    expect(synchronizer.itemForWindow(1, visibleId)).toMatchObject({
      absolutePath: 'C:\\Docs\\visible.md',
    })
  })

  it('removes contents that die during a failed send without exposing the unseen model', () => {
    let recentDocuments: readonly string[] = ['C:\\Docs\\visible.md']
    const synchronizer = new ApplicationMenuSynchronizer({
      getRecentDocuments: () => recentDocuments,
      getFocusedWebContentsId: () => 1,
      installNativeModel: vi.fn(),
    })
    const contents = new FakeWebContents(1)
    synchronizer.register(contents)
    synchronizer.updateWindowState(1, windowState())
    const visibleId = String(
      recentItemForPath(lastEmittedModel(contents), 'C:\\Docs\\visible.md')?.id,
    )
    recentDocuments = ['C:\\Docs\\unseen.md']
    contents.send.mockImplementationOnce(() => {
      contents.destroyed = true
      throw new Error('contents destroyed')
    })

    expect(() => synchronizer.refresh()).not.toThrow()
    expect(synchronizer.itemForWindow(1, visibleId)).toBeNull()
  })
})
