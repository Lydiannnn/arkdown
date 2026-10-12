import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createDocumentWindowOpener,
  loadDocumentWindowIntentAfterReady,
  openOrdinaryDocumentWithError,
  showStartupDocumentOpenError,
  type DocumentIntentWindow,
} from '../../src/main/document-window-opener'
import { DocumentService } from '../../src/main/documents/document-service'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { RecentDocumentStore } from '../../src/main/recent-documents/recent-document-store'
import { openRecentDocumentSafely } from '../../src/main/recent-documents/recent-document-actions'
import {
  chooseStartupWindowIntent,
  createStartupDocumentIntentPresenter,
  startupDocumentIntent,
} from '../../src/main/startup-document-intent'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import {
  WINDOW_CHANNELS,
  type DocumentSnapshot,
  type ImportedDocx,
} from '../../src/shared/contracts'
import { appError, PUBLIC_ERROR_MESSAGES } from '../../src/shared/public-errors'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })))
})

class FakeWebContents extends EventEmitter {
  readonly send = vi.fn()
}

class FakeWindow extends EventEmitter implements DocumentIntentWindow {
  readonly webContents = new FakeWebContents()
  destroyed = false
  readonly show = vi.fn()
  readonly focus = vi.fn()
  readonly isDestroyed = vi.fn(() => this.destroyed)

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }
}

async function createMarkdownDocument(): Promise<{ root: string, document: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-document-window-'))
  temporaryRoots.push(root)
  const document = path.join(root, 'note.md')
  await writeFile(document, '# Loaded after ready\n', 'utf8')
  return { root, document }
}

it('focuses a live initial main window without creating a new window or reloading dirty content', async () => {
  const { document } = await createMarkdownDocument()
  const existing = new FakeWindow()
  const createWindow = vi.fn(() => ({ window: new FakeWindow(), loaded: Promise.resolve() }))
  const open = createDocumentWindowOpener({ createWindow, getOpenWindows: () => [{ window: existing, absolutePath: document }] })
  await open(document)
  expect(existing.focus).toHaveBeenCalledOnce()
  expect(existing.webContents.send).not.toHaveBeenCalled()
  expect(createWindow).not.toHaveBeenCalled()
})

it('sends a location to an existing live window without reloading its dirty document', async () => {
  const { document } = await createMarkdownDocument()
  const existing = new FakeWindow()
  const createWindow = vi.fn(() => ({ window: new FakeWindow(), loaded: Promise.resolve() }))
  const open = createDocumentWindowOpener({ createWindow, getOpenWindows: () => [{ window: existing, absolutePath: document }] })
  await open(document, { anchor: 'section', line: 8 })
  expect(existing.webContents.send).toHaveBeenCalledExactlyOnceWith(WINDOW_CHANNELS.documentLocation, { absolutePath: document, anchor: 'section', line: 8 })
  expect(existing.focus).toHaveBeenCalledOnce()
  expect(createWindow).not.toHaveBeenCalled()
})

it('sends a new-window location only after its document intent has loaded', async () => {
  const { document } = await createMarkdownDocument()
  const window = new FakeWindow()
  const load = deferred<void>()
  const created = deferred<void>()
  const open = createDocumentWindowOpener({ createWindow: () => { created.resolve(); return { window, loaded: load.promise } } })
  const opening = open(document, { line: 8 })
  await created.promise
  expect(window.webContents.send).not.toHaveBeenCalled()
  load.resolve()
  await opening
  expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(WINDOW_CHANNELS.documentLocation, { absolutePath: document, line: 8 })
})

it('does not send a late location to a window that now owns another document', async () => {
  const { document } = await createMarkdownDocument()
  const window = new FakeWindow()
  const load = deferred<void>()
  const created = deferred<void>()
  const live: Array<{ window: FakeWindow; absolutePath: string }> = []
  const open = createDocumentWindowOpener({
    getOpenWindows: () => live,
    createWindow: () => { live.push({ window, absolutePath: document }); created.resolve(); return { window, loaded: load.promise } },
  })
  const opening = open(document, { line: 8 })
  await created.promise
  live[0]!.absolutePath = path.join(path.dirname(document), 'other.md')
  load.resolve()
  await opening
  expect(window.webContents.send).not.toHaveBeenCalled()
})

it.each(['DOCUMENT_BINARY', 'DOCUMENT_ENCODING_UNSUPPORTED', 'DOCUMENT_TEXT_TOO_LARGE'] as const)('presents explicit source input errors for %s', async code => {
  const window = new FakeWindow()
  const showError = vi.fn(async () => undefined)
  await showStartupDocumentOpenError(window, Object.assign(new Error('internal detail'), { code }), { showError, reportDialogError: vi.fn() })
  expect(showError).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES[code])
})

it('invalidates an opener cache after its window switches files and finds the new live path', async () => {
  const { root, document } = await createMarkdownDocument()
  const second = path.join(root, 'next.ts')
  await writeFile(second, 'const next = true')
  const live: Array<{ window: FakeWindow; absolutePath: string }> = []
  const createWindow = vi.fn((absolutePath: string) => {
    const window = new FakeWindow()
    live.push({ window, absolutePath })
    return { window, loaded: Promise.resolve() }
  })
  const open = createDocumentWindowOpener({ createWindow, getOpenWindows: () => live })
  await open(document)
  live[0]!.absolutePath = second
  await open(second)
  expect(createWindow).toHaveBeenCalledTimes(1)
  await open(document)
  expect(createWindow).toHaveBeenCalledTimes(2)
  expect(live[0]!.window.focus).toHaveBeenCalledTimes(2)
  expect(live[1]!.window.focus).toHaveBeenCalledOnce()
})

it('does not focus a former imported-document window after it has no owned document', async () => {
  const { root } = await createMarkdownDocument()
  const imported = path.join(root, 'original.docx')
  await writeFile(imported, 'fixture')
  const previous = new FakeWindow()
  const createWindow = vi.fn(() => ({ window: new FakeWindow(), loaded: Promise.resolve() }))
  const open = createDocumentWindowOpener({
    createWindow,
    getOpenWindows: () => [{ window: previous, absolutePath: null }],
  })
  await open(imported)
  expect(previous.focus).not.toHaveBeenCalled()
  expect(createWindow).toHaveBeenCalledOnce()
})

it.each(['data.json', 'code.cjs', 'source.ts', 'icon.svg', 'Dockerfile'])('opens %s through explicit window intent as exact editable source', async name => {
  const { root } = await createMarkdownDocument()
  const target = path.join(root, name)
  await writeFile(target, 'one\r\n\ttwo\n')
  const window = new FakeWindow()
  const open = createDocumentWindowOpener({ createWindow: absolutePath => {
    const loaded = realMarkdownLoad(window, absolutePath)
    queueMicrotask(() => window.webContents.emit('did-finish-load'))
    return { window, loaded }
  } })
  await open(target)
  expect(window.webContents.send).toHaveBeenCalledWith(WINDOW_CHANNELS.openIntent, expect.objectContaining({ document: expect.objectContaining({ relativePath: name, markdown: 'one\r\n\ttwo\n' }) }))
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function realMarkdownLoad(window: FakeWindow, absolutePath: string): Promise<void> {
  const workspace = new WorkspaceService()
  const documents = new DocumentService(workspace)
  const operations = createIpcOperations({
    chooseDirectory: async () => null,
    workspace,
    documents,
    getLastWorkspace: () => null,
    setLastWorkspace: async () => undefined,
    reportError: vi.fn(),
  })
  return loadDocumentWindowIntentAfterReady({
    window,
    absolutePath,
    workspace,
    documents,
    seedDocumentOwnership: operations.seedStartupDocumentOwnership,
  })
}

function startupDocumentOperations(workspace: WorkspaceService, documents: DocumentService) {
  const drafts = {
    read: vi.fn(async () => null),
    write: vi.fn(async (input: Record<string, unknown>) => ({
      ...input,
      updatedAt: '2026-08-21T00:00:00.000Z',
      ignoredAt: null,
    })),
  }
  const operations = createIpcOperations({
    chooseDirectory: async () => null,
    workspace,
    documents,
    drafts,
    getLastWorkspace: () => null,
    setLastWorkspace: async () => undefined,
    reportError: vi.fn(),
  } as never)
  return { drafts, operations }
}

const webContentsLoadEvents = [
  'did-finish-load',
  'did-fail-load',
  'render-process-gone',
] as const

function expectLoadListenersCleaned(
  window: FakeWindow,
  expectedWindowClosedListeners = 0,
): void {
  expect(window.listenerCount('closed')).toBe(expectedWindowClosedListeners)
  for (const event of webContentsLoadEvents) {
    expect(window.webContents.listenerCount(event)).toBe(0)
  }
}

it('does not show a startup-intent error after its owner window is destroyed', async () => {
  const owner = new FakeWindow()
  owner.destroy()
  const showError = vi.fn(async () => undefined)
  const reportDialogError = vi.fn()

  await showStartupDocumentOpenError(owner, new Error('load failed'), {
    showError,
    reportDialogError,
  })

  expect(showError).not.toHaveBeenCalled()
  expect(reportDialogError).not.toHaveBeenCalled()
})

it('contains a rejected startup-intent error dialog promise', async () => {
  const owner = new FakeWindow()
  const dialogError = new Error('dialog unavailable')
  const showError = vi.fn(async () => { throw dialogError })
  const reportDialogError = vi.fn()

  await expect(showStartupDocumentOpenError(owner, new Error('load failed'), {
    showError,
    reportDialogError,
  })).resolves.toBeUndefined()

  expect(showError).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.OPERATION_FAILED)
  expect(reportDialogError).toHaveBeenCalledWith(dialogError)
})

it.each([
  ['a stale recent document', (missingDocument: string) => chooseStartupWindowIntent({
    explicitDocument: null,
    recoveredDraftCount: 0,
    recentDocuments: [missingDocument],
  })],
  ['an explicit argv document', (missingDocument: string) => chooseStartupWindowIntent({
    explicitDocument: startupDocumentIntent([
      'C:\\Apps\\Arkdown\\Arkdown.exe',
      missingDocument,
    ], true),
    recoveredDraftCount: 0,
    recentDocuments: [],
  })],
])('reports %s failure before revealing the loaded blank startup shell', async (_label, selectIntent) => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-startup-fallback-'))
  temporaryRoots.push(root)
  const missingDocument = path.join(root, 'missing.md')
  const intent = selectIntent(missingDocument)
  expect(intent).toEqual({ kind: 'document', absolutePath: missingDocument })
  if (intent.kind !== 'document') throw new Error('expected a startup document intent')

  const window = new FakeWindow()
  const workspace = new WorkspaceService()
  const documents = new DocumentService(workspace)
  const seedDocumentOwnership = vi.fn(async () => undefined)
  const reportFinished = deferred<void>()
  const events: string[] = []
  window.show.mockImplementation(() => { events.push('show') })
  window.focus.mockImplementation(() => { events.push('focus') })
  const showError = vi.fn(async () => {
    events.push('report:start')
    await reportFinished.promise
    events.push('report:done')
  })
  const presenter = createStartupDocumentIntentPresenter(window)
  const presenting = presenter.present(loadDocumentWindowIntentAfterReady({
    window,
    absolutePath: intent.absolutePath,
    workspace,
    documents,
    seedDocumentOwnership,
  }), (error) => showStartupDocumentOpenError(window, error, {
    showError,
    reportDialogError: vi.fn(),
  }))

  window.webContents.emit('did-finish-load')
  await vi.waitFor(() => expect(showError).toHaveBeenCalledOnce())
  expect(window.webContents.send).not.toHaveBeenCalled()
  expect(seedDocumentOwnership).not.toHaveBeenCalled()
  expect(window.show).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()

  reportFinished.resolve()
  await presenting

  expect(showError).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.OPERATION_FAILED)
  expect(events).toEqual(['report:start', 'report:done', 'show', 'focus'])
  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
})

it('does not reveal a failed startup shell that closes while its error is being reported', async () => {
  const window = new FakeWindow()
  const reportStarted = deferred<void>()
  const reportFinished = deferred<void>()
  const presenter = createStartupDocumentIntentPresenter(window)
  const presenting = presenter.present(Promise.reject(new Error('load failed')), async () => {
    reportStarted.resolve()
    await reportFinished.promise
  })

  await reportStarted.promise
  window.destroy()
  reportFinished.resolve()
  await presenting

  expect(window.show).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()
})

it('does not let an older failed startup generation promote after a newer load succeeds', async () => {
  const window = new FakeWindow()
  const reportStarted = deferred<void>()
  const reportFinished = deferred<void>()
  const presenter = createStartupDocumentIntentPresenter(window)
  const olderPresentation = presenter.present(Promise.reject(new Error('older load failed')), async () => {
    reportStarted.resolve()
    await reportFinished.promise
  })
  await reportStarted.promise

  await presenter.present(Promise.resolve(), async () => undefined)
  reportFinished.resolve()
  await olderPresentation

  expect(window.show).toHaveBeenCalledOnce()
  expect(window.focus).toHaveBeenCalledOnce()
})

async function rejectionAfter(
  promise: Promise<void>,
  trigger: () => void,
): Promise<unknown> {
  let outcome: unknown = null
  void promise.then(
    () => { outcome = 'resolved' },
    (error: unknown) => { outcome = error },
  )
  trigger()
  await vi.waitFor(() => expect(outcome).not.toBeNull())
  return outcome
}

it('resolves a new-window open only after did-finish-load completes a real document read', async () => {
  const { document } = await createMarkdownDocument()
  const createdWindows: FakeWindow[] = []
  const openDocumentInNewWindow = createDocumentWindowOpener({
    createWindow: (absolutePath) => {
      const window = new FakeWindow()
      createdWindows.push(window)
      return { window, loaded: realMarkdownLoad(window, absolutePath) }
    },
  })

  let settled = false
  const opening = openDocumentInNewWindow(document).then(() => { settled = true })
  await vi.waitFor(() => expect(createdWindows).toHaveLength(1))
  expect(settled).toBe(false)
  const createdWindow = createdWindows[0]!
  createdWindow.webContents.emit('did-finish-load')
  await opening

  expect(createdWindow.webContents.send).toHaveBeenCalledWith(
    WINDOW_CHANNELS.openIntent,
    expect.objectContaining({
      document: expect.objectContaining({ markdown: '# Loaded after ready\n' }),
    }),
  )
  expect(createdWindow.destroyed).toBe(false)
  expect(createdWindow.show).toHaveBeenCalledOnce()
  expect(createdWindow.focus).toHaveBeenCalledOnce()
  expectLoadListenersCleaned(createdWindow, 1)
})

it('seeds startup ownership before publishing the snapshot so its first save and draft succeed', async () => {
  const { root, document } = await createMarkdownDocument()
  const window = new FakeWindow()
  const workspace = new WorkspaceService()
  const documents = new DocumentService(workspace)
  const { drafts, operations } = startupDocumentOperations(workspace, documents)
  const events: string[] = []
  window.webContents.send.mockImplementation(() => { events.push('intent') })
  const loaded = loadDocumentWindowIntentAfterReady({
    window,
    absolutePath: document,
    workspace,
    documents,
    seedDocumentOwnership: async (snapshot) => {
      events.push('seed:start')
      await operations.seedStartupDocumentOwnership(snapshot)
      events.push('seed:done')
    },
  })

  window.webContents.emit('did-finish-load')
  await loaded

  expect(events).toEqual(['seed:start', 'seed:done', 'intent'])
  const intent = window.webContents.send.mock.calls.find(
    ([channel]) => channel === WINDOW_CHANNELS.openIntent,
  )?.[1] as { document: DocumentSnapshot }
  await expect(
    operations.seedStartupDocumentOwnership(intent.document),
  ).rejects.toThrow()
  const saved = await operations.saveDocument({
    relativePath: 'note.md',
    markdown: '# Saved from startup intent\n',
    expectedRevision: intent.document.revision,
    encoding: intent.document.encoding,
    newline: intent.document.newline,
  })
  expect(saved).toMatchObject({ ok: true })
  if (!saved.ok) throw new Error('startup save did not complete')
  await expect(documents.read('note.md')).resolves.toMatchObject({
    markdown: '# Saved from startup intent\n',
    revision: saved.value.revision,
  })

  await expect(operations.saveDraft({
    draftId: '123e4567-e89b-42d3-a456-426614174000',
    markdown: '# Saved from startup intent\n',
    expectedOriginalRevision: saved.value.revision,
    encoding: intent.document.encoding,
    newline: intent.document.newline,
  })).resolves.toMatchObject({ ok: true })
  expect(drafts.write).toHaveBeenCalledWith(expect.objectContaining({
    originalAbsolutePath: document,
    workspaceAbsolutePath: root,
    originalRevision: saved.value.revision,
  }))
})

it('destroys a startup window without publishing an intent when its ownership seed is no longer pristine', async () => {
  const { root, document } = await createMarkdownDocument()
  const otherDocument = path.join(root, 'other.md')
  await writeFile(otherDocument, '# Already owned\n', 'utf8')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const documents = new DocumentService(workspace)
  const { operations } = startupDocumentOperations(workspace, documents)
  await operations.readDocument({ relativePath: 'other.md' })
  const createdWindows: FakeWindow[] = []
  const openDocumentInNewWindow = createDocumentWindowOpener({
    createWindow: (absolutePath) => {
      const window = new FakeWindow()
      createdWindows.push(window)
      return {
        window,
        loaded: loadDocumentWindowIntentAfterReady({
          window,
          absolutePath,
          workspace,
          documents,
          seedDocumentOwnership: operations.seedStartupDocumentOwnership,
        }),
      }
    },
  })

  const opening = openDocumentInNewWindow(document)
  await vi.waitFor(() => expect(createdWindows).toHaveLength(1))
  const window = createdWindows[0]!
  window.webContents.emit('did-finish-load')
  await expect(opening).rejects.toThrow()

  expect(window.webContents.send).not.toHaveBeenCalled()
  expect(window.show).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()
  expect(window.destroyed).toBe(true)
  const note = await documents.read('note.md')
  const save = vi.spyOn(documents, 'save')
  await expect(operations.saveDocument({
    relativePath: 'note.md',
    markdown: '# Must not save\n',
    expectedRevision: note.revision,
    encoding: note.encoding,
    newline: note.newline,
  })).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(save).not.toHaveBeenCalled()
})

it('rejects and removes every load listener when the window closes before ready', async () => {
  const { document } = await createMarkdownDocument()
  const window = new FakeWindow()
  const loaded = realMarkdownLoad(window, document)

  const outcome = await rejectionAfter(loaded, () => window.destroy())

  expect(outcome).toBeInstanceOf(Error)
  expect(window.webContents.send).not.toHaveBeenCalled()
  expectLoadListenersCleaned(window)
})

it.each([
  ['main-frame load failure', (window: FakeWindow) => {
    window.webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'file:///note.md', true)
  }],
  ['render process loss', (window: FakeWindow) => {
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
  }],
])('rejects once and cleans counterpart listeners after %s', async (_label, fail) => {
  const { document } = await createMarkdownDocument()
  const window = new FakeWindow()
  const loaded = realMarkdownLoad(window, document)

  const outcome = await rejectionAfter(loaded, () => {
    fail(window)
    window.webContents.emit('did-finish-load')
    window.destroy()
  })

  expect(outcome).toBeInstanceOf(Error)
  expect(window.webContents.send).not.toHaveBeenCalled()
  expectLoadListenersCleaned(window)
})

it('rejects immediately without listeners when the window is already destroyed', async () => {
  const { document } = await createMarkdownDocument()
  const window = new FakeWindow()
  window.destroyed = true

  await expect(realMarkdownLoad(window, document)).rejects.toThrow()
  expectLoadListenersCleaned(window)
})

it('removes a recent file that disappears before the real did-finish-load read', async () => {
  const { root, document } = await createMarkdownDocument()
  const store = new RecentDocumentStore(root)
  await store.record(document)
  const createdWindows: FakeWindow[] = []
  const openDocumentInNewWindow = createDocumentWindowOpener({
    createWindow: (absolutePath) => {
      const window = new FakeWindow()
      createdWindows.push(window)
      const loaded = realMarkdownLoad(window, absolutePath)
      void rm(absolutePath).then(() => window.webContents.emit('did-finish-load'))
      return { window, loaded }
    },
  })
  const refreshMenus = vi.fn()
  const showFileNotFound = vi.fn(async () => undefined)

  await openRecentDocumentSafely(document, {
    openDocumentInNewWindow,
    remove: (absolutePath) => store.remove(absolutePath),
    refreshMenus,
    showFileNotFound,
  })

  expect(createdWindows).toHaveLength(1)
  expect(createdWindows[0]!.destroyed).toBe(true)
  expect(store.list()).toEqual([])
  expect(refreshMenus).toHaveBeenCalledOnce()
  expect(showFileNotFound).toHaveBeenCalledOnce()
  expect(showFileNotFound).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.FILE_NOT_FOUND)
})

it('shows one ordinary error for two callers sharing the same failed open attempt', async () => {
  const { document } = await createMarkdownDocument()
  const createdWindows: FakeWindow[] = []
  const openDocumentInNewWindow = createDocumentWindowOpener({
    createWindow: (absolutePath) => {
      const window = new FakeWindow()
      createdWindows.push(window)
      return { window, loaded: realMarkdownLoad(window, absolutePath) }
    },
  })
  const showError = vi.fn(async () => undefined)

  const firstOpen = openOrdinaryDocumentWithError(document, {
    openDocumentInNewWindow,
    showError,
  })
  await vi.waitFor(() => expect(createdWindows).toHaveLength(1))
  const window = createdWindows[0]!
  window.isDestroyed.mockClear()
  const secondOpen = openOrdinaryDocumentWithError(document, {
    openDocumentInNewWindow,
    showError,
  })
  await vi.waitFor(() => expect(window.isDestroyed).toHaveBeenCalled())
  expect(window.show).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()

  await rm(document)
  window.webContents.emit('did-finish-load')
  await Promise.all([firstOpen, secondOpen])

  expect(window.destroyed).toBe(true)
  expect(window.show).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()
  expect(showError).toHaveBeenCalledOnce()
  expect(showError).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.OPERATION_FAILED)
})

it('removes and reports one stale recent entry for two callers sharing a failed open attempt', async () => {
  const { root, document } = await createMarkdownDocument()
  const store = new RecentDocumentStore(root)
  await store.record(document)
  const createdWindows: FakeWindow[] = []
  const openDocumentInNewWindow = createDocumentWindowOpener({
    createWindow: (absolutePath) => {
      const window = new FakeWindow()
      createdWindows.push(window)
      return { window, loaded: realMarkdownLoad(window, absolutePath) }
    },
  })
  const refreshMenus = vi.fn()
  const showFileNotFound = vi.fn(async () => undefined)
  const removeRecent = vi.fn((absolutePath: string) => store.remove(absolutePath))
  const actions = {
    openDocumentInNewWindow,
    remove: removeRecent,
    refreshMenus,
    showFileNotFound,
  }

  const firstOpen = openRecentDocumentSafely(document, actions)
  await vi.waitFor(() => expect(createdWindows).toHaveLength(1))
  const window = createdWindows[0]!
  window.isDestroyed.mockClear()
  const secondOpen = openRecentDocumentSafely(document, actions)
  await vi.waitFor(() => expect(window.isDestroyed).toHaveBeenCalled())
  expect(window.show).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()

  await rm(document)
  window.webContents.emit('did-finish-load')
  await Promise.all([firstOpen, secondOpen])

  expect(window.destroyed).toBe(true)
  expect(window.show).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()
  expect(store.list()).toEqual([])
  expect(removeRecent).toHaveBeenCalledOnce()
  expect(refreshMenus).toHaveBeenCalledOnce()
  expect(showFileNotFound).toHaveBeenCalledOnce()
  expect(showFileNotFound).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.FILE_NOT_FOUND)
})

it('lets a later recent caller own a shared failure and cleans ownership for a retry', async () => {
  const { root, document } = await createMarkdownDocument()
  const store = new RecentDocumentStore(root)
  await store.record(document)
  const createdWindows: FakeWindow[] = []
  const openDocumentInNewWindow = createDocumentWindowOpener({
    createWindow: (absolutePath) => {
      const window = new FakeWindow()
      createdWindows.push(window)
      return { window, loaded: realMarkdownLoad(window, absolutePath) }
    },
  })
  const showOrdinaryError = vi.fn(async () => undefined)
  const ordinaryOpen = openOrdinaryDocumentWithError(document, {
    openDocumentInNewWindow,
    showError: showOrdinaryError,
  })
  await vi.waitFor(() => expect(createdWindows).toHaveLength(1))
  const window = createdWindows[0]!
  const refreshMenus = vi.fn()
  const showFileNotFound = vi.fn(async () => undefined)
  const removeRecent = vi.fn((absolutePath: string) => store.remove(absolutePath))
  window.isDestroyed.mockClear()
  const recentOpen = openRecentDocumentSafely(document, {
    openDocumentInNewWindow,
    remove: removeRecent,
    refreshMenus,
    showFileNotFound,
  })
  await vi.waitFor(() => expect(window.isDestroyed).toHaveBeenCalled())
  expect(window.show).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()

  await rm(document)
  window.webContents.emit('did-finish-load')

  await Promise.all([ordinaryOpen, recentOpen])
  expect(window.destroyed).toBe(true)
  expect(window.show).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()
  expect(store.list()).toEqual([])
  expect(removeRecent).toHaveBeenCalledOnce()
  expect(showOrdinaryError).not.toHaveBeenCalled()
  expect(refreshMenus).toHaveBeenCalledOnce()
  expect(showFileNotFound).toHaveBeenCalledOnce()
  expect(showFileNotFound).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.FILE_NOT_FOUND)

  await writeFile(document, '# Retry succeeds\n', 'utf8')
  const retry = openOrdinaryDocumentWithError(document, {
    openDocumentInNewWindow,
    showError: showOrdinaryError,
  })
  await vi.waitFor(() => expect(createdWindows).toHaveLength(2))
  createdWindows[1]!.webContents.emit('did-finish-load')
  await retry

  expect(createdWindows[1]!.destroyed).toBe(false)
  expect(showOrdinaryError).not.toHaveBeenCalled()
})

it('shows one ordinary File Open error after a post-create read failure', async () => {
  const { document } = await createMarkdownDocument()
  const createdWindows: FakeWindow[] = []
  const openDocumentInNewWindow = createDocumentWindowOpener({
    createWindow: (absolutePath) => {
      const window = new FakeWindow()
      createdWindows.push(window)
      return { window, loaded: realMarkdownLoad(window, absolutePath) }
    },
  })
  const showError = vi.fn(async () => undefined)

  const opening = openOrdinaryDocumentWithError(document, {
    openDocumentInNewWindow,
    showError,
  })
  await vi.waitFor(() => expect(createdWindows).toHaveLength(1))
  await rm(document)
  createdWindows[0]!.webContents.emit('did-finish-load')
  await opening

  expect(createdWindows[0]!.destroyed).toBe(true)
  expect(showError).toHaveBeenCalledOnce()
  expect(showError).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.OPERATION_FAILED)
})

it('keeps ordinary error ownership when validation fails before a window exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-document-window-missing-'))
  temporaryRoots.push(root)
  const missing = path.join(root, 'missing.md')
  const createWindow = vi.fn(() => {
    throw new Error('must not create a window')
  })
  const openDocumentInNewWindow = createDocumentWindowOpener({ createWindow })
  const showError = vi.fn(async () => undefined)

  await openOrdinaryDocumentWithError(missing, {
    openDocumentInNewWindow,
    showError,
  })

  expect(createWindow).not.toHaveBeenCalled()
  expect(showError).toHaveBeenCalledOnce()
  expect(showError).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.OPERATION_FAILED)
})

it('keeps recent stale ownership when window creation reports the file disappeared', async () => {
  const { root, document } = await createMarkdownDocument()
  const store = new RecentDocumentStore(root)
  await store.record(document)
  const missingError = new Error('gone') as NodeJS.ErrnoException
  missingError.code = 'ENOENT'
  const openDocumentInNewWindow = createDocumentWindowOpener({
    createWindow: () => { throw missingError },
  })
  const refreshMenus = vi.fn()
  const showFileNotFound = vi.fn(async () => undefined)

  await openRecentDocumentSafely(document, {
    openDocumentInNewWindow,
    remove: (absolutePath) => store.remove(absolutePath),
    refreshMenus,
    showFileNotFound,
  })

  expect(store.list()).toEqual([])
  expect(refreshMenus).toHaveBeenCalledOnce()
  expect(showFileNotFound).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.FILE_NOT_FOUND)
})

it('keeps a production DOCX opener pending until import succeeds and the intent is sent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-document-window-docx-'))
  temporaryRoots.push(root)
  const document = path.join(root, 'report.docx')
  await writeFile(document, 'docx fixture', 'utf8')
  const importStarted = deferred<void>()
  const finishImport = deferred<ImportedDocx>()
  const createdWindows: FakeWindow[] = []
  const openDocumentInNewWindow = createDocumentWindowOpener({
    createWindow: (absolutePath) => {
      const window = new FakeWindow()
      createdWindows.push(window)
      const workspace = new WorkspaceService()
      return {
        window,
        loaded: loadDocumentWindowIntentAfterReady({
          window,
          absolutePath,
          workspace,
          documents: new DocumentService(workspace),
          seedDocumentOwnership: async () => undefined,
          docx: {
            import: async () => {
              importStarted.resolve()
              return await finishImport.promise
            },
          },
        }),
      }
    },
  })
  let settled = false
  const opening = openDocumentInNewWindow(document).then(() => { settled = true })
  await vi.waitFor(() => expect(createdWindows).toHaveLength(1))
  const window = createdWindows[0]!

  window.webContents.emit('did-finish-load')
  await importStarted.promise
  expect(settled).toBe(false)
  expect(window.webContents.send).not.toHaveBeenCalled()
  finishImport.resolve({
    sourceAbsolutePath: document,
    sourceFileName: 'report.docx',
    markdown: '# Imported',
  })
  await opening

  expect(window.webContents.send).toHaveBeenCalledWith(WINDOW_CHANNELS.importDocx, {
    workspace: { name: path.basename(root), absolutePath: root },
    imported: {
      sourceAbsolutePath: document,
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    },
  })
  expect(window.destroyed).toBe(false)
  expectLoadListenersCleaned(window, 1)
})

it('shows a real DOCX conversion failure once and destroys its empty ordinary-open window', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-document-window-docx-'))
  temporaryRoots.push(root)
  const document = path.join(root, 'broken.docx')
  await writeFile(document, 'broken docx fixture', 'utf8')
  const createdWindows: FakeWindow[] = []
  const openDocumentInNewWindow = createDocumentWindowOpener({
    createWindow: (absolutePath) => {
      const window = new FakeWindow()
      createdWindows.push(window)
      const workspace = new WorkspaceService()
      return {
        window,
        loaded: loadDocumentWindowIntentAfterReady({
          window,
          absolutePath,
          workspace,
          documents: new DocumentService(workspace),
          seedDocumentOwnership: async () => undefined,
          docx: { import: async () => { throw appError('DOCX_CONVERSION_FAILED') } },
        }),
      }
    },
  })
  const showError = vi.fn(async () => undefined)
  const opening = openOrdinaryDocumentWithError(document, {
    openDocumentInNewWindow,
    showError,
  })
  await vi.waitFor(() => expect(createdWindows).toHaveLength(1))
  const window = createdWindows[0]!

  window.webContents.emit('did-finish-load')

  await opening
  expect(window.destroyed).toBe(true)
  expect(window.webContents.send).not.toHaveBeenCalled()
  expect(showError).toHaveBeenCalledOnce()
  expect(showError).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.DOCX_CONVERSION_FAILED)
  expectLoadListenersCleaned(window)
})
