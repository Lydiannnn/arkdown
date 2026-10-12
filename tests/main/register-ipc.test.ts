import { modelObservation } from '../helpers/model-observation'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  createChooseDirectory,
  createAiRendererPortBridge,
  createIpcOperations,
  registerIpc,
  registerIpcHandlers,
  registerPrintWindowIpc,
} from '../../src/main/ipc/register-ipc'
import {
  DOCUMENT_CONVERSION_IPC_CHANNELS,
  IPC_CHANNELS,
  SCREENSHOT_OCR_MODEL_CHANNELS,
} from '../../src/shared/contracts'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { TranslationSessionService } from '../../src/main/models/translation-session-service'
import { OpenDocumentRegistry } from '../../src/main/documents/open-document-registry'
import { RegistryWorkspaceAiEditorBoundary } from '../../src/main/documents/workspace-ai-editor-boundary'
import type { CanonicalFileIdentity } from '../../src/main/documents/document-identity'

const revision = 'a'.repeat(64)

it('owns and validates the one-way workspace introduction request without exposing settings writes', async () => {
  const ipcMain = createRegistrar(), dependencies = createDependencies()
  const claim = vi.fn(async () => ({ showIntroduction: true }))
  const window = { webContents: { mainFrame: {} } }
  const registration = registerIpc({ ...dependencies, ipcMain, window, claimWorkspaceIntroduction: claim,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }), controlWindow: vi.fn(), getWindowState: vi.fn() } as never)
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const invoke = (input: unknown, source = event) => ipcMain.handlers.get(IPC_CHANNELS.claimWorkspaceIntroduction)!(source, input)
  expect(await invoke({ legacySeen: false })).toEqual({ ok: true, value: { showIntroduction: true } })
  expect(claim).toHaveBeenCalledExactlyOnceWith(false)
  for (const bad of [{ legacySeen: 'true' }, {}, { legacySeen: false, path: 'C:/other' }]) expect(await invoke(bad)).toMatchObject({ ok: false })
  expect(await invoke({ legacySeen: true }, { ...event, senderFrame: {} })).toMatchObject({ ok: false })
  expect(claim).toHaveBeenCalledTimes(1)
  claim.mockRejectedValueOnce(new Error('private disk failure'))
  const failure = await invoke({ legacySeen: false })
  expect(failure).toMatchObject({ ok: false })
  expect(JSON.stringify(failure)).not.toContain('private disk failure')
  await registration.dispose()
})

it.each(['current', 'open'] as const)('accepts only correlated terminal %s replies while close admission is paused', async kind => {
  const dependencies = createDependencies(), ipcMain = createRegistrar()
  const webContents = { id: 96, mainFrame: {}, send: vi.fn(), isDestroyed: () => false }
  let bridge!: ReturnType<typeof createAiRendererPortBridge>
  let current!: { openSnapshot(request: unknown, signal: AbortSignal): Promise<unknown> }
  const authority = { workspaceId: 'workspace.1', workspaceGeneration: 'generation.1' }
  const registration = registerIpc({ ...dependencies, ipcMain,
    window: { webContents, isDestroyed: () => false },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }), controlWindow: vi.fn(), getWindowState: vi.fn(),
    aiRendererPortBridgeFactory: (options: Parameters<typeof createAiRendererPortBridge>[0]) => (bridge = createAiRendererPortBridge(options)),
    desktopAi: { ownerId: 96, getWorkspaceAuthority: async () => authority,
      registerCurrentDocumentPort: async (port: typeof current) => { current = port; return { portGeneration: 1, unregister: async () => undefined } } },
  } as never)
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  const invoke = (channel: string, input?: unknown) => ipcMain.handlers.get(channel)!(event, input)
  await invoke(IPC_CHANNELS.registerAiCurrentDocumentPort)
  let pending: Promise<unknown>
  const replacementMarkdown = '# confirmed close write'
  const replacementHash = createHash('sha256').update(replacementMarkdown).digest('hex')
  if (kind === 'current') pending = current.openSnapshot({}, new AbortController().signal)
  else {
    const registry = new OpenDocumentRegistry(), boundary = new RegistryWorkspaceAiEditorBoundary(registry)
    const target = { windowId: 96, workspaceId: authority.workspaceId, generation: authority.workspaceGeneration,
      fileIdentity: '1.a' as CanonicalFileIdentity }
    await bridge.registerOpenDocument(registry, target)
    const lookup = await boundary.lookup(target)
    if (lookup.status !== 'open') throw new Error('expected open editor')
    pending = boundary.applyTransaction({ target, replacementMarkdown, plan: {
      ...lookup, status: 'planned', operationId: 'operation-close-1', editorRevision: 4, contentHash: revision,
    } })
  }
  await vi.waitFor(() => expect(webContents.send).toHaveBeenCalledOnce())
  const envelope = webContents.send.mock.calls[0]![1]
  let settled = false
  const drain = registration.quiesceForClose().then(() => { settled = true })
  const channel = kind === 'current' ? IPC_CHANNELS.submitAiCurrentDocumentPortResponse : IPC_CHANNELS.submitAiOpenDocumentPortResponse
  const reply = { transportRequestId: envelope.transportRequestId, method: envelope.method,
    ...(kind === 'open' ? { documentHandle: envelope.documentHandle } : {}), result: kind === 'open'
      ? { status: 'applied', editorRevision: 5, contentHash: replacementHash, dirty: true }
      : { status: 'unavailable' } }
  expect(await invoke(IPC_CHANNELS.readDocument, { relativePath: 'note.md' })).toMatchObject({ ok: false })
  expect(await invoke(IPC_CHANNELS.registerAiCurrentDocumentPort)).toMatchObject({ ok: false })
  expect(await invoke(channel, { ...reply, transportRequestId: '550e8400-e29b-41d4-a716-446655440099' })).toMatchObject({ ok: false })
  expect(await ipcMain.handlers.get(channel)!({ sender: webContents, senderFrame: {} }, reply)).toMatchObject({ ok: false })
  expect(settled).toBe(false)
  expect(await invoke(channel, reply)).toMatchObject({ ok: true })
  expect(await pending).toMatchObject(kind === 'open'
    ? { status: 'applied', operationId: 'operation-close-1', editorRevision: 5, contentHash: replacementHash, dirty: true }
    : { status: 'unavailable' })
  await drain
  expect(await invoke(channel, reply)).toMatchObject({ ok: false })
  await registration.resumeAfterClose()
  await registration.dispose()
})

it.each(['frame', 'destroyed', 'destructive-pause'] as const)('keeps ordinary admission closed after %s while owner restoration awaits without AI ports', async change => {
  const dependencies = createDependencies(), ipcMain = createRegistrar()
  const webContents = { mainFrame: {}, isDestroyed: () => false }
  const window = { webContents, isDestroyed: () => false }
  const registration = registerIpc({ ...dependencies, ipcMain, window,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }), controlWindow: vi.fn(), getWindowState: vi.fn() } as never)
  await registration.quiesceForClose()
  let finish!: () => void
  const owner = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const result = registration.resumeAfterClose(owner).catch(error => error)
  await vi.waitFor(() => expect(owner).toHaveBeenCalledOnce())
  if (change === 'frame') webContents.mainFrame = {}
  if (change === 'destroyed') window.isDestroyed = () => true
  if (change === 'destructive-pause') await registration.pauseAndDrain()
  finish()
  expect(await result).toBeInstanceOf(Error)
  expect(await ipcMain.handlers.get(IPC_CHANNELS.readDocument)!({ sender: webContents, senderFrame: webContents.mainFrame },
    { relativePath: 'note.md' })).toMatchObject({ ok: false })
  await registration.dispose()
})

it('keeps entered writes and their renderer registration alive until standalone disposal drains', async () => {
  const dependencies = createDependencies(), ipcMain = createRegistrar()
  const webContents = { id: 93, mainFrame: {}, send: vi.fn(), isDestroyed: () => false }
  let finishSave!: () => void
  dependencies.documents.save.mockImplementationOnce(() => new Promise(resolve => {
    finishSave = () => resolve({ revision, mtimeMs: 2 })
  }))
  const unregister = vi.fn(async () => undefined), releaseOwner = vi.fn()
  const registration = registerIpc({ ...dependencies, ipcMain,
    window: { webContents, isDestroyed: () => false },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    drafts: { releaseOwner }, controlWindow: vi.fn(), getWindowState: vi.fn(),
    desktopAi: { ownerId: 93,
      getWorkspaceAuthority: async () => ({ workspaceId: 'workspace.1', workspaceGeneration: 'generation.1' }),
      registerCurrentDocumentPort: async () => ({ portGeneration: 1, unregister }) },
  } as never)
  const invoke = (channel: string, input?: unknown) => ipcMain.handlers.get(channel)!({ sender: webContents, senderFrame: webContents.mainFrame }, input)
  await invoke(IPC_CHANNELS.readDocument, { relativePath: 'note.md' })
  await invoke(IPC_CHANNELS.registerAiCurrentDocumentPort)
  const save = invoke(IPC_CHANNELS.saveDocument, { relativePath: 'note.md', markdown: '# saved',
    expectedRevision: revision, encoding: 'utf8', newline: 'lf' })
  await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'))
  const disposal = registration.dispose()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(unregister).not.toHaveBeenCalled()
  expect(releaseOwner).not.toHaveBeenCalled()
  expect(ipcMain.handlers.size).toBeGreaterThan(0)
  finishSave()
  expect(await save).toMatchObject({ ok: true })
  await disposal
  expect(unregister).toHaveBeenCalledOnce()
  expect(releaseOwner).toHaveBeenCalledOnce()
  expect(ipcMain.handlers.size).toBe(0)
})

it('restores close ports before AI and ordinary admission and stays closed after an owner restoration failure', async () => {
  const dependencies = createDependencies(), ipcMain = createRegistrar()
  const webContents = { id: 94, mainFrame: {}, send: vi.fn(), isDestroyed: () => false }
  const unregister = vi.fn(async () => undefined)
  let port!: { openSnapshot(request: unknown, signal: AbortSignal): Promise<unknown> }
  const registration = registerIpc({ ...dependencies, ipcMain,
    window: { webContents, isDestroyed: () => false },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }), controlWindow: vi.fn(), getWindowState: vi.fn(),
    desktopAi: { ownerId: 94,
      getWorkspaceAuthority: async () => ({ workspaceId: 'workspace.1', workspaceGeneration: 'generation.1' }),
      registerCurrentDocumentPort: async (value: typeof port) => { port = value; return { portGeneration: 1, unregister } } },
  } as never)
  const invoke = (channel: string, input?: unknown) => ipcMain.handlers.get(channel)!({ sender: webContents, senderFrame: webContents.mainFrame }, input)
  await invoke(IPC_CHANNELS.registerAiCurrentDocumentPort)
  await registration.quiesceForClose()
  await expect(registration.resumeAfterClose(async () => {
    expect(await invoke(IPC_CHANNELS.readDocument, { relativePath: 'note.md' })).toMatchObject({ ok: false })
    throw new Error('synthetic AI restoration failure')
  })).rejects.toThrow('synthetic AI restoration failure')
  expect(unregister).not.toHaveBeenCalled()
  await expect(port.openSnapshot({}, new AbortController().signal)).rejects.toMatchObject({ name: 'InvalidStateError' })
  expect(await invoke(IPC_CHANNELS.readDocument, { relativePath: 'note.md' })).toMatchObject({ ok: false })
  await registration.resumeAfterClose(async () => {
    expect(await invoke(IPC_CHANNELS.readDocument, { relativePath: 'note.md' })).toMatchObject({ ok: false })
  })
  expect(await invoke(IPC_CHANNELS.readDocument, { relativePath: 'note.md' })).toMatchObject({ ok: true })
  const snapshot = port.openSnapshot({}, new AbortController().signal)
  const envelope = webContents.send.mock.calls.at(-1)![1]
  expect(await invoke(IPC_CHANNELS.submitAiCurrentDocumentPortResponse, { transportRequestId: envelope.transportRequestId,
    method: 'openSnapshot', result: { status: 'unavailable' } })).toMatchObject({ ok: true })
  await snapshot
  expect(unregister).not.toHaveBeenCalled()
  await registration.dispose()
})

it.each(['pause', 'dispose'] as const)('waits the entered ordinary drain before rejecting failed login cancellation during close %s', async phase => {
  const dependencies = createDependencies(), ipcMain = createRegistrar()
  const webContents = { id: 91, mainFrame: {}, send: vi.fn(), isDestroyed: () => false }
  let finishRead!: (value: Awaited<ReturnType<typeof dependencies.documents.read>>) => void
  const document = await dependencies.documents.read()
  dependencies.documents.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
  const cancel = vi.fn<() => Promise<void>>(async () => { throw new Error('synthetic cancellation failure') })
  const registration = registerIpc({ ...dependencies, ipcMain, window: { webContents, isDestroyed: () => false },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }), cancelCodexCliLogin: cancel,
    controlWindow: vi.fn(), getWindowState: vi.fn() } as never)
  const handler = ipcMain.handlers.get(IPC_CHANNELS.readDocument)!
  const entered = handler({ sender: webContents, senderFrame: webContents.mainFrame }, { relativePath: 'note.md' })
  await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'))
  let settled = false
  const drain = Promise.resolve(phase === 'pause' ? registration.pauseAndDrain() : registration.dispose())
    .then(() => { settled = true; return null }, error => { settled = true; return error })
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(settled).toBe(false)
  finishRead(document)
  await entered
  expect(await drain).toBeInstanceOf(Error)
  if (phase === 'pause') { cancel.mockResolvedValueOnce(undefined); await registration.dispose() }
})

it('settles every disposal cleanup, releases draft ownership, and rejects instead of swallowing failures', async () => {
  const dependencies = createDependencies(), ipcMain = createRegistrar()
  const webContents = { id: 92, mainFrame: {}, send: vi.fn(), isDestroyed: () => false }
  const draftId = '123e4567-e89b-42d3-a456-426614174000'
  let finishRelease!: () => void
  const release = new Promise<void>(resolve => { finishRelease = resolve })
  const releaseSavedClipboardHistory = vi.fn(async () => { await release; throw new Error('synthetic clipboard failure') })
  const releaseOwner = vi.fn(), cancel = vi.fn(async () => { throw new Error('synthetic login failure') })
  const registration = registerIpc({ ...dependencies, ipcMain, window: { webContents, isDestroyed: () => false },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }), cancelCodexCliLogin: cancel,
    drafts: { read: async () => null, write: async () => ({ draftId }), retainClipboardHistoryAfterSave: async () => true,
      releaseSavedClipboardHistory, releaseOwner }, assets: undefined,
    controlWindow: vi.fn(), getWindowState: vi.fn() } as never)
  const invoke = (channel: string, input: unknown) => ipcMain.handlers.get(channel)!({ sender: webContents, senderFrame: webContents.mainFrame }, input)
  await invoke(IPC_CHANNELS.readDocument, { relativePath: 'note.md' })
  await invoke(IPC_CHANNELS.saveDraft, { draftId, markdown: '# image', expectedOriginalRevision: revision, encoding: 'utf8', newline: 'lf' })
  await invoke(IPC_CHANNELS.saveDocument, { relativePath: 'note.md', markdown: '# image', expectedRevision: revision, encoding: 'utf8', newline: 'lf' })
  let settled = false
  const disposal = registration.dispose()
  expect(registration.dispose()).toBe(disposal)
  const outcome = Promise.resolve(disposal).then(() => { settled = true; return null }, error => { settled = true; return error })
  await vi.waitFor(() => expect(releaseSavedClipboardHistory).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  expect(releaseOwner).not.toHaveBeenCalled()
  finishRelease()
  expect(await outcome).toBeInstanceOf(Error)
  expect(releaseOwner).toHaveBeenCalledOnce()
  expect(ipcMain.handlers.size).toBe(0)
  expect(registration.dispose()).toBe(disposal)
})

it.each(['preparing', 'browser'] as const)('cancels an owner login before draining IPC during %s, without cancelling another owner', async phase => {
  const ipcMain = createRegistrar()
  const build = (id: number) => {
    const webContents = { id, mainFrame: {}, send: vi.fn(), isDestroyed: () => false }
    let finishLogin!: () => void
    const start = vi.fn(() => new Promise<{ status: 'cancelled' }>(resolve => { finishLogin = () => resolve({ status: 'cancelled' }) }))
    const cancel = vi.fn(async () => { finishLogin?.() })
    const ensure = vi.fn(async (signal?: AbortSignal) => {
      if (phase === 'preparing' && id === 31) return new Promise<boolean>(resolve => signal!.addEventListener('abort', () => resolve(false), { once: true }))
      return true
    })
    const registration = registerIpc({ ...createDependencies(), ipcMain,
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      window: { webContents, isDestroyed: () => false },
      ensureCodexCli: ensure, startCodexCliLogin: start, cancelCodexCliLogin: cancel,
      controlWindow: vi.fn(), getWindowState: vi.fn(),
    } as never)
    const invoke = () => ipcMain.handlers.get(IPC_CHANNELS.startCodexCliLogin)!({ sender: webContents, senderFrame: webContents.mainFrame }, { observed: modelObservation(DEFAULT_LARGE_MODEL_SETTINGS) })
    return { registration, invoke, start, cancel, ensure }
  }
  const owner = build(31), other = build(32)
  const first = owner.invoke(), second = other.invoke()
  await vi.waitFor(() => expect(other.start).toHaveBeenCalledOnce())
  const drain = owner.registration.pauseAndDrain()
  expect(await first).toEqual({ ok: true, value: { status: 'cancelled' } })
  await drain
  expect(owner.cancel).toHaveBeenCalledOnce()
  expect(other.cancel).not.toHaveBeenCalled()
  expect(await owner.invoke()).toMatchObject({ ok: false })
  await other.registration.cancelCodexCliLoginAttempt()
  expect(await second).toEqual({ ok: true, value: { status: 'cancelled' } })
  await Promise.all([owner.registration.dispose(), other.registration.dispose()])
})

it('permits a fresh login after main-only renderer invalidation cancels the old attempt', async () => {
  const ipcMain = createRegistrar(), webContents = { id: 35, mainFrame: {}, send: vi.fn(), isDestroyed: () => false }
  let finish!: () => void
  const start = vi.fn(() => new Promise<{ status: 'cancelled' }>(resolve => { finish = () => resolve({ status: 'cancelled' }) }))
  const cancel = vi.fn(async () => { finish?.() })
  const registration = registerIpc({ ...createDependencies(), ipcMain,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }), window: { webContents, isDestroyed: () => false },
    ensureCodexCli: async () => true, startCodexCliLogin: start, cancelCodexCliLogin: cancel,
    controlWindow: vi.fn(), getWindowState: vi.fn(),
  } as never)
  const invoke = () => ipcMain.handlers.get(IPC_CHANNELS.startCodexCliLogin)!({ sender: webContents, senderFrame: webContents.mainFrame }, { observed: modelObservation(DEFAULT_LARGE_MODEL_SETTINGS) })
  const first = invoke()
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
  await registration.cancelCodexCliLoginAttempt()
  await first
  const reopened = invoke()
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2))
  await registration.cancelCodexCliLoginAttempt()
  expect(await reopened).toEqual({ ok: true, value: { status: 'cancelled' } })
  await registration.dispose()
})

it('binds both default-app operations to the registered owner main frame and rejects extra arguments', async () => {
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { id: 71, mainFrame }
  const getStatus = vi.fn(async () => ({ markdown: false, text: true }))
  const openSettings = vi.fn(async () => {})
  const operations = createIpcOperations({ ...createDependencies(), defaultApplications: { getStatus, openSettings } } as never)
  const registration = registerIpcHandlers({ ipcMain, window: { webContents }, operations })
  for (const channel of [IPC_CHANNELS.getDefaultApplicationsStatus, IPC_CHANNELS.openDefaultApplicationsSettings, IPC_CHANNELS.setDefaultApplicationsEnabled]) {
    const handler = ipcMain.handlers.get(channel)!
    for (const event of [{ sender: { id: 71 }, senderFrame: mainFrame }, { sender: webContents, senderFrame: {} }]) {
      await expect(handler(event)).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
    }
    await expect(handler({ sender: webContents, senderFrame: mainFrame }, undefined, { uri: 'ms-settings:other' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(getStatus).not.toHaveBeenCalled()
  expect(openSettings).not.toHaveBeenCalled()
  await expect(ipcMain.handlers.get(IPC_CHANNELS.getDefaultApplicationsStatus)!({ sender: webContents, senderFrame: mainFrame }))
    .resolves.toEqual({ ok: true, value: { markdown: false, text: true } })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.openDefaultApplicationsSettings)!({ sender: webContents, senderFrame: mainFrame }))
    .resolves.toEqual({ ok: true, value: null })
  registration.dispose()
  expect(ipcMain.handlers.has(IPC_CHANNELS.openDefaultApplicationsSettings)).toBe(false)
})

it('requires an owned draft and rejects foreign identities and destination keys for clipboard images', async () => {
  const draftId = '123e4567-e89b-42d3-a456-426614174000'
  const stageClipboardImage = vi.fn(async () => ({ markdown: '![](managed.png)' }))
  const operations = createIpcOperations({ ...createDependencies(),
    assets: { stageClipboardImage }, drafts: { read: async () => null, write: async () => ({ draftId }) },
  } as never)
  await expect(operations.pasteClipboardImage({ draftId })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(operations.saveDraft({ draftId, markdown: '', expectedOriginalRevision: null, encoding: 'utf8', newline: 'lf' })).resolves.toMatchObject({ ok: true })
  await expect(operations.pasteClipboardImage({ draftId })).resolves.toEqual({ ok: true, value: '![](managed.png)' })
  for (const value of [{ draftId, destination: 'C:/escape.png' }, { draftId, bytes: [1, 2] }, { noteId: draftId }, { draftId: '123e4567-e89b-42d3-a456-426614174001' }, Object.create({ draftId })]) {
    await expect(operations.pasteClipboardImage(value)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(stageClipboardImage).toHaveBeenCalledTimes(1)
})

it('awaits retained clipboard release on document registration disposal, including repeated disposal', async () => {
  const dependencies = createDependencies()
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { id: 17, mainFrame, send: vi.fn(), isDestroyed: () => false }
  const draftId = '123e4567-e89b-42d3-a456-426614174000'
  let finishRelease!: () => void
  const release = new Promise<void>((resolve) => { finishRelease = resolve })
  const releaseSavedClipboardHistory = vi.fn(() => release)
  const registration = registerIpc({
    ...dependencies,
    ipcMain,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    window: { webContents, isDestroyed: () => false, isMaximized: () => false, isFullScreen: () => false },
    drafts: { read: async () => null, write: async () => ({ draftId }), retainClipboardHistoryAfterSave: async () => true, releaseSavedClipboardHistory },
    assets: undefined,
    controlWindow: () => ({ maximized: false, fullscreen: false, revision: 1 }),
    getWindowState: () => ({ maximized: false, fullscreen: false, revision: 1 }),
  } as never)
  const invoke = (channel: string, input: unknown) => ipcMain.handlers.get(channel)!({ sender: webContents, senderFrame: mainFrame }, input)
  await invoke(IPC_CHANNELS.readDocument, { relativePath: 'note.md' })
  await invoke(IPC_CHANNELS.saveDraft, { draftId, markdown: '# image', expectedOriginalRevision: revision, encoding: 'utf8', newline: 'lf' })
  expect(await invoke(IPC_CHANNELS.saveDocument, { relativePath: 'note.md', markdown: '# image', expectedRevision: revision, encoding: 'utf8', newline: 'lf' })).toMatchObject({ ok: true, value: { clipboardAssetsRetained: true } })
  let disposed = false
  const completion = registration.dispose()
  expect(completion).toBeInstanceOf(Promise)
  expect(registration.dispose()).toBe(completion)
  void Promise.resolve(completion).then(() => { disposed = true })
  await vi.waitFor(() => expect(releaseSavedClipboardHistory).toHaveBeenCalledWith(draftId))
  expect(disposed).toBe(false)
  expect(ipcMain.handlers.size).toBe(0)
  finishRelease()
  await completion
  expect(disposed).toBe(true)
})

function createDependencies() {
  const summary = { name: 'notes', absolutePath: 'C:\\canonical\\notes' }
  const commit = vi.fn(() => summary)
  const workspace = {
    listDirectory: vi.fn().mockResolvedValue([]),
    validateRoot: vi.fn().mockResolvedValue({ summary, commit }),
    setRoot: vi.fn().mockResolvedValue(summary),
    restoreCanonicalRoot: vi.fn().mockResolvedValue(summary),
    getRoot: vi.fn(() => 'C:\\canonical\\notes'),
    resolveExistingDocument: vi.fn(async (relativePath: string) => `C:\\canonical\\notes\\${relativePath}`),
  }
  const documents = {
    read: vi.fn().mockResolvedValue({
      relativePath: 'note.md',
      markdown: '# note',
      revision,
      encoding: 'utf8',
      newline: 'lf',
      mtimeMs: 1,
    }),
    save: vi.fn().mockResolvedValue({ revision, mtimeMs: 2 }),
  }
  const chooseDirectory = vi.fn().mockResolvedValue('C:\\picked\\notes')
  const getLastWorkspace = vi.fn<() => string | null>().mockReturnValue('C:\\saved\\notes')
  const setLastWorkspace = vi.fn().mockResolvedValue(undefined)
  const reportError = vi.fn()
  const assets = { allowWorkspaceRoot: vi.fn() }
  return {
    workspace, documents, chooseDirectory, getLastWorkspace, setLastWorkspace,
    reportError, assets, activationCommit: commit,
  }
}

it('rejects an untyped list path before calling the workspace', async () => {
  const workspace = { listDirectory: vi.fn(), setRoot: vi.fn(), getRoot: vi.fn() }
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(),
    workspace: workspace as never,
    documents: {} as never,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
  })

  await expect(operations.listDirectory({ relativePath: 42 })).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(workspace.listDirectory).not.toHaveBeenCalled()
})

it('returns exact bounded clipboard MIME representations without inferring HTML', async () => {
  const readClipboardFormats = vi.fn(() => ({
    plainText: '# Plain',
    markdown: '# Markdown',
    html: null,
  }))
  const operations = createIpcOperations({
    ...createDependencies(),
    readClipboardFormats,
  } as never)

  await expect(operations.readClipboardFormats()).resolves.toEqual({
    ok: true,
    value: { plainText: '# Plain', markdown: '# Markdown', html: null },
  })
  expect(readClipboardFormats).toHaveBeenCalledOnce()
})

it('fails closed when a clipboard representation exceeds the public bound', async () => {
  const operations = createIpcOperations({
    ...createDependencies(),
    readClipboardFormats: () => ({
      plainText: 'x'.repeat((2 * 1024 * 1024) + 1),
      markdown: null,
      html: null,
    }),
  } as never)

  await expect(operations.readClipboardFormats()).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
})

it('validates and delegates current-window control actions', async () => {
  const controlWindow = vi.fn((action: 'minimize' | 'toggle-maximize' | 'close') => ({
    maximized: action === 'toggle-maximize',
    fullscreen: action === 'toggle-maximize',
    revision: 8,
  }))
  const getWindowState = vi.fn(() => ({ maximized: false, fullscreen: true, revision: 7 }))
  const operations = createIpcOperations({
    ...createDependencies(),
    controlWindow,
    getWindowState,
  } as never)

  await expect(operations.controlWindow({ action: 'toggle-maximize' })).resolves.toEqual({
    ok: true,
    value: { maximized: true, fullscreen: true, revision: 8 },
  })
  await expect(operations.getWindowState()).resolves.toEqual({
    ok: true,
    value: { maximized: false, fullscreen: true, revision: 7 },
  })
  await expect(operations.controlWindow({ action: 'move-offscreen' })).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(controlWindow).toHaveBeenCalledTimes(1)
})

it('calls every service operation with validated inputs', async () => {
  const dependencies = createDependencies()
  const operations = createIpcOperations(dependencies as never)
  const saveInput = {
    relativePath: 'note.md', markdown: '# changed', expectedRevision: revision,
    encoding: 'utf8' as const, newline: 'lf' as const,
  }

  await expect(operations.chooseWorkspace()).resolves.toEqual({
    ok: true, value: { name: 'notes', absolutePath: 'C:\\canonical\\notes' },
  })
  expect(dependencies.workspace.validateRoot).toHaveBeenCalledWith('C:\\picked\\notes')
  expect(dependencies.setLastWorkspace).toHaveBeenCalledWith('C:\\canonical\\notes')
  expect(dependencies.activationCommit).toHaveBeenCalledTimes(1)
  expect(dependencies.assets.allowWorkspaceRoot).toHaveBeenCalledTimes(1)
  await expect(operations.restoreWorkspace()).resolves.toEqual({
    ok: true, value: { name: 'notes', absolutePath: 'C:\\canonical\\notes' },
  })
  expect(dependencies.workspace.restoreCanonicalRoot).toHaveBeenLastCalledWith('C:\\saved\\notes')
  expect(dependencies.assets.allowWorkspaceRoot).toHaveBeenCalledTimes(2)
  expect(dependencies.workspace.setRoot).not.toHaveBeenCalled()
  await expect(operations.listDirectory({ relativePath: 'folder' })).resolves.toEqual({ ok: true, value: [] })
  expect(dependencies.workspace.listDirectory).toHaveBeenCalledWith('folder')
  await expect(operations.readDocument({ relativePath: 'note.md' })).resolves.toMatchObject({
    ok: true, value: { relativePath: 'note.md' },
  })
  expect(dependencies.documents.read).toHaveBeenCalledWith('note.md')
  await expect(operations.saveDocument(saveInput)).resolves.toEqual({ ok: true, value: { revision, mtimeMs: 2 } })
  expect(dependencies.documents.save).toHaveBeenCalledWith(saveInput)
})

it('keeps DOCX export targets scoped to one validated document session', async () => {
  const dependencies = createDependencies()
  const exportDocx = vi.fn(async () => undefined)
  const canReuseTarget = vi.fn(async () => true)
  const chooseDocxExportPath = vi.fn()
    .mockResolvedValueOnce('C:\\exports\\report.docx')
    .mockResolvedValueOnce('C:\\exports\\report-new.docx')
  const operations = createIpcOperations({
    ...dependencies,
    docx: { exportDocx, canReuseTarget },
    chooseDocxExportPath,
  } as never) as ReturnType<typeof createIpcOperations> & Record<string, (...args: never[]) => unknown>
  const input = {
    documentSessionId: '123e4567-e89b-42d3-a456-426614174000',
    markdown: '# Report',
    mode: 'choose',
    suggestedBaseName: 'report',
  }

  expect(typeof operations.exportDocx).toBe('function')
  expect('confirmDocxExport' in operations).toBe(false)
  expect('confirmClose' in operations).toBe(false)
  await expect(operations.exportDocx(input as never)).resolves.toEqual({
    ok: true,
    value: { fileName: 'report.docx', reusedTarget: false },
  })
  expect(chooseDocxExportPath).toHaveBeenCalledWith('report')
  expect(exportDocx).toHaveBeenLastCalledWith('# Report', 'C:\\exports\\report.docx')

  await expect(operations.exportDocx({ ...input, mode: 'reuse' } as never)).resolves.toEqual({
    ok: true,
    value: { fileName: 'report.docx', reusedTarget: true },
  })
  expect(chooseDocxExportPath).toHaveBeenCalledTimes(1)

  canReuseTarget.mockResolvedValueOnce(false)
  await expect(operations.exportDocx({ ...input, mode: 'reuse' } as never)).resolves.toEqual({
    ok: true,
    value: { fileName: 'report-new.docx', reusedTarget: false },
  })
  expect(chooseDocxExportPath).toHaveBeenCalledTimes(2)

  await expect(operations.exportDocx({ ...input, extra: true } as never)).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(exportDocx).toHaveBeenCalledTimes(3)
})

it('reopens Save As when a remembered DOCX target becomes unavailable during replacement', async () => {
  const dependencies = createDependencies()
  const targetFailure = Object.assign(new Error('private target failed'), { code: 'EACCES' })
  const exportDocx = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(targetFailure)
    .mockResolvedValueOnce(undefined)
  const chooseDocxExportPath = vi.fn()
    .mockResolvedValueOnce('C:\\exports\\report.docx')
    .mockResolvedValueOnce('C:\\exports\\report-recovered.docx')
  const operations = createIpcOperations({
    ...dependencies,
    docx: { exportDocx, canReuseTarget: vi.fn(async () => true) },
    chooseDocxExportPath,
  } as never) as ReturnType<typeof createIpcOperations> & Record<string, (...args: never[]) => unknown>
  const input = {
    documentSessionId: '123e4567-e89b-42d3-a456-426614174001',
    markdown: '# Report',
    suggestedBaseName: 'report',
  }

  await expect(operations.exportDocx({ ...input, mode: 'choose' } as never)).resolves.toMatchObject({
    ok: true,
  })
  await expect(operations.exportDocx({ ...input, mode: 'reuse' } as never)).resolves.toEqual({
    ok: true,
    value: { fileName: 'report-recovered.docx', reusedTarget: false },
  })
  expect(chooseDocxExportPath).toHaveBeenCalledTimes(2)
  expect(exportDocx).toHaveBeenLastCalledWith(
    '# Report',
    'C:\\exports\\report-recovered.docx',
  )
})

it('exports XLSX only to a main-selected target with exact bounded input', async () => {
  const dependencies = createDependencies()
  const exportXlsx = vi.fn(async () => undefined)
  const chooseXlsxExportPath = vi.fn(async () => 'C:\\exports\\report.xlsx')
  const operations = createIpcOperations({
    ...dependencies,
    xlsx: { export: exportXlsx },
    chooseXlsxExportPath,
  } as never) as ReturnType<typeof createIpcOperations> & Record<string, (...args: never[]) => unknown>
  const input = { markdown: '# Report', suggestedBaseName: 'report' }

  expect(typeof operations.exportXlsx).toBe('function')
  await expect(operations.exportXlsx(input as never)).resolves.toEqual({
    ok: true,
    value: { fileName: 'report.xlsx' },
  })
  expect(chooseXlsxExportPath).toHaveBeenCalledWith('report')
  expect(exportXlsx).toHaveBeenCalledWith('# Report', 'C:\\exports\\report.xlsx')
  await expect(operations.exportXlsx({ ...input, extra: true } as never)).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(exportXlsx).toHaveBeenCalledOnce()
})

it('opens only a known top-level application menu at validated coordinates', async () => {
  const dependencies = createDependencies()
  const openApplicationMenu = vi.fn()
  const operations = createIpcOperations({
    ...dependencies,
    openApplicationMenu,
  } as never)

  await expect(operations.openApplicationMenu({
    section: 'file',
    x: 120,
    y: 52,
  })).resolves.toEqual({ ok: true, value: null })
  expect(openApplicationMenu).toHaveBeenCalledWith('file', 120, 52)

  await expect(operations.openApplicationMenu({
    section: 'tools',
    x: 120,
    y: 52,
  })).resolves.toMatchObject({ ok: true })
  expect(openApplicationMenu).toHaveBeenLastCalledWith('tools', 120, 52)

  for (const input of [
    { section: 'unknown', x: 120, y: 52 },
    { section: 'file', x: -1, y: 52 },
    { section: 'file', x: 120.5, y: 52 },
    { section: 'file', x: 120, y: Number.POSITIVE_INFINITY },
    { section: 'file', x: 120, y: 52, extra: true },
  ]) {
    await expect(operations.openApplicationMenu(input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }
  expect(openApplicationMenu).toHaveBeenCalledTimes(2)
})

it('treats canceled and empty directory selections as cancellation', async () => {
  for (const selection of [null, '']) {
    const dependencies = createDependencies()
    dependencies.chooseDirectory.mockResolvedValue(selection)
    const operations = createIpcOperations(dependencies as never)
    await expect(operations.chooseWorkspace()).resolves.toEqual({ ok: true, value: null })
    expect(dependencies.workspace.setRoot).not.toHaveBeenCalled()
    expect(dependencies.setLastWorkspace).not.toHaveBeenCalled()
  }
})

it('returns null when there is no workspace to restore', async () => {
  const dependencies = createDependencies()
  dependencies.getLastWorkspace.mockReturnValue(null)
  const operations = createIpcOperations(dependencies as never)
  await expect(operations.restoreWorkspace()).resolves.toEqual({ ok: true, value: null })
  expect(dependencies.workspace.setRoot).not.toHaveBeenCalled()
})

it('rejects payloads for parameterless operations before side effects', async () => {
  const dependencies = createDependencies()
  const operations = createIpcOperations(dependencies as never)
  await expect(operations.chooseWorkspace({ extra: true })).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_INPUT' },
  })
  await expect(operations.restoreWorkspace('unexpected')).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_INPUT' },
  })
  expect(dependencies.chooseDirectory).not.toHaveBeenCalled()
  expect(dependencies.getLastWorkspace).not.toHaveBeenCalled()
  expect(dependencies.workspace.setRoot).not.toHaveBeenCalled()
})

it('rejects strict path objects and overlong paths before service calls', async () => {
  const dependencies = createDependencies()
  const operations = createIpcOperations(dependencies as never)
  for (const input of [
    { relativePath: 'folder', extra: true },
    { relativePath: 'a'.repeat(32768) },
    { relativePath: null },
  ]) {
    await expect(operations.listDirectory(input)).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
  }
  await expect(operations.readDocument({ relativePath: 'note.md', extra: true })).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_INPUT' },
  })
  expect(dependencies.workspace.listDirectory).not.toHaveBeenCalled()
  expect(dependencies.documents.read).not.toHaveBeenCalled()
})

it('rejects malformed save revisions, enums, and extra keys before saving', async () => {
  const dependencies = createDependencies()
  const operations = createIpcOperations(dependencies as never)
  const valid = {
    relativePath: 'note.md', markdown: '# changed', expectedRevision: revision,
    encoding: 'utf8', newline: 'lf',
  }
  for (const input of [
    { ...valid, expectedRevision: 'A'.repeat(64) },
    { ...valid, expectedRevision: 'a'.repeat(63) },
    { ...valid, encoding: 'utf16' },
    { ...valid, newline: 'native' },
    { ...valid, extra: true },
  ]) {
    await expect(operations.saveDocument(input)).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
  }
  expect(dependencies.documents.save).not.toHaveBeenCalled()
})

it('does not report workspace selection success when settings persistence fails', async () => {
  const dependencies = createDependencies()
  dependencies.setLastWorkspace.mockRejectedValue(new Error('C:\\private\\settings.json is locked'))
  const operations = createIpcOperations(dependencies as never)
  await expect(operations.chooseWorkspace()).resolves.toEqual({
    ok: false, error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
  })
})

it('fails selection without persistence when directory identity is unavailable', async () => {
  const dependencies = createDependencies()
  dependencies.workspace.validateRoot.mockRejectedValue(
    new Error('Workspace directory identity is unavailable at C:\\private\\notes'),
  )
  const operations = createIpcOperations(dependencies as never)

  const result = await operations.chooseWorkspace()

  expect(result).toEqual({
    ok: false,
    error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
  })
  expect(dependencies.setLastWorkspace).not.toHaveBeenCalled()
  expect(dependencies.reportError).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toContain('C:\\private')
})

it('preserves document conflicts and sanitizes unknown errors', async () => {
  const conflictDependencies = createDependencies()
  conflictDependencies.documents.save.mockRejectedValue(
    Object.assign(new Error('文件已被其他程序修改'), { code: 'DOCUMENT_CONFLICT' }),
  )
  const conflictOperations = createIpcOperations(conflictDependencies as never)
  const input = {
    relativePath: 'note.md', markdown: '# changed', expectedRevision: revision,
    encoding: 'utf8', newline: 'lf',
  }
  await conflictOperations.seedStartupDocumentOwnership({
    relativePath: 'note.md',
    markdown: '# note',
    revision,
    encoding: 'utf8',
    newline: 'lf',
    mtimeMs: 1,
  })
  await expect(conflictOperations.saveDocument(input)).resolves.toEqual({
    ok: false, error: { code: 'DOCUMENT_CONFLICT', message: '文件已被其他程序修改' },
  })
  const unknownDependencies = createDependencies()
  unknownDependencies.documents.read.mockRejectedValue(
    new Error('EACCES at C:\\Users\\private\\secret.md\nstack detail'),
  )
  const unknownOperations = createIpcOperations(unknownDependencies as never)
  const result = await unknownOperations.readDocument({ relativePath: 'note.md' })
  expect(result).toEqual({
    ok: false, error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
  })
  expect(JSON.stringify(result)).not.toContain('C:\\Users\\private')
  expect(JSON.stringify(result)).not.toContain('stack detail')
})


function createRegistrar() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`)
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  }
}

it('registers the complete fixed channel allowlist and disposes it safely', async () => {
  expect(Object.values(IPC_CHANNELS)).toEqual([
    'app-update:get-state', 'app-update:about', 'app-update:open-website', 'app-update:exit', 'app-update:protect', 'app-update:action',
    'workspace:choose',
    'workspace:claim-introduction',
    'workspace:restore',
    'workspace:list',
    'workspace:start-file-drag',
    'workspace:inspect-dropped',
    'workspace:open-dropped',
    'workspace:prepare-dropped',
    'workspace:settle-dropped',
    'document:create',
    'document:read',
    'document:peek',
    'document:save',
    'document:save-as:begin',
    'document:save-as:commit',
    'document:save-as:abort',
    'draft:retry-finalization',
    'draft:save',
    'draft:list-recoverable',
    'draft:read',
    'draft:claim-recovered',
    'draft:clean',
    'draft:release-recovery',
    'draft:ignore',
    'draft:discard',
    'document:reveal',
    'document:trash',
    'docx:import',
    'docx:export',
    'xlsx:export',
    'clipboard:read-formats',
    'clipboard:paste-image',
    'asset:import',
    'asset:open',
    'window:open-document',
    'document-view:navigate',
    'document-view:refresh',
    'document-view:inspect',
    'document-view:open',
    'document-view:reveal-local-link',
    'window:control',
    'window:get-state',
    'document-conversion:get-component-state',
    'document-conversion:install-component',
    'document-conversion:cancel-component-install',
    'document-conversion:remove-component',
    'document-conversion:convert-workspace-document',
    'document-conversion:cancel-workspace-document',
    'settings:get-search',
    'settings:get-preference-snapshot',
    'settings:patch-preferences',
    'settings:get-shortcuts',
    'settings:update-shortcuts',
    'settings:shortcut-recording',
    'settings:set-search',
    'settings:get-editor-appearance',
    'settings:set-editor-appearance',
    'settings:compare-and-set-editor-appearance',
    'settings:get-layout',
    'settings:compare-and-set-layout',
    'settings:get-sticky-notes',
    'settings:set-sticky-notes',
    'settings:get-desktop-lifecycle',
    'settings:get-default-applications-status',
    'settings:open-default-applications',
    'settings:set-default-applications-enabled',
    'settings:get-shell-integration',
    'settings:update-shell-integration',
    'settings:set-desktop-lifecycle',
    'arknote-settings:get',
    'arknote-settings:set',
    'arknote-settings:preview-wallpaper-appearances',
    'settings:get-system-fonts',
    'arknote-settings:preview-theme',
    'models:get-settings',
    'models:get-settings-snapshot',
    'models:get-capability-rules',
    'models:set-capability-rules',
    'models:connect',
    'models:list',
    'models:test',
    'models:delete',
    'models:set-ai-conversation',
    'models:codex-cli-test',
    'models:codex-cli-login-start',
    'models:codex-cli-login-cancel',
    'models:codex-cli-remove',
    'models:set-selection-translation',
    'models:set-screenshot-translation',
    'models:set-floating-translation',
    'ai-conversation:start',
    'ai-conversation:cancel',
    'ai-conversation:get-workspace-state',
    'ai-conversation:set-capabilities',
    'ai-conversation:authorization-result',
    'ai-conversation:clear',
    'ai-conversation:current-document-changed',
    'ai-conversation:current-document-port-register',
    'ai-conversation:current-document-port-unregister',
    'ai-conversation:current-document-port-response',
    'ai-conversation:open-document-port-register',
    'ai-conversation:open-document-port-unregister',
    'ai-conversation:open-document-port-response',
    'ai-conversation:open-message-link',
    'ai-conversation:renderer-port-request',
    'screenshot-translation:begin',
    'screenshot-translation:capture-pointer',
    'screenshot-translation:capture-ready',
    'screenshot-translation:capture-commit',
    'screenshot-translation:capture-cancel',
    'screenshot-translation:ocr-submit',
    'screenshot-translation:ocr-settled',
    'screenshot-translation:start',
    'screenshot-translation:cancel',
    'screenshot-translation:minimize',
    'screenshot-translation:close',
    'screenshot-translation:open-settings',
    'models:accept-privacy-notice',
    'translation:start',
    'translation:cancel',
    'search:selection',
    'external:open-link',
    'image:reveal',
    'image:copy',
    'image:save-copy',
    'image:copy-to',
    'mermaid-image:copy',
    'mermaid-viewer:open',
    'mermaid-viewer:get',
    'mermaid-image:save',
    'workspace:create-folder',
    'workspace:rename-entry',
    'workspace:duplicate-document',
    'workspace:trash-entry',
    'workspace:reveal-entry',
    'workspace:open-window',
    'workspace:entry-properties',
    'workspace:root-properties',
    'workspace:get-color-marks',
    'workspace:set-color-mark',
    'workspace:move-color-mark',
    'workspace:delete-color-marks',
    'menu:open-section',
    'menu:execute-item',
    'recent-documents:record',
    'menu:update-window-state',
    'print:document',
    'print:take-document',
    'print:ready',
    'arknote:connect',
    'sticky-note:list',
    'sticky-note:reorder',
    'sticky-note:search',
    'sticky-note:read',
    'sticky-note:create',
    'sticky-note:rename',
    'sticky-note:archive',
    'sticky-note:restore',
    'sticky-note:restore-archived-batch',
    'sticky-note:delete',
    'sticky-note:delete-archived-batch',
    'sticky-note:import',
    'sticky-note:import-selection',
    'sticky-note:stage-save',
    'sticky-note:flush-save',
    'sticky-note:open-window',
    'sticky-note:close-window',
    'sticky-note:release',
    'sticky-note:reclaim',
    'sticky-note:set-pinned',
    'sticky-note:set-style',
    'sticky-note:set-font-size',
    'sticky-note:set-line-spacing-mode',
    'sticky-note:choose-image',
    'sticky-note:copy-image',
    'sticky-note:resize-to-content',
    'background:open-settings',
    'background:get-presentation',
    'background:choose-image',
    'background:remove-image',
    'background:preview',
    'background:apply',
    'background:cancel-settings',
  ])
  const ipcMain = createRegistrar()
  const webContents = { id: 7, mainFrame: {} }
  const firstOperations = {
    chooseWorkspace: vi.fn(), restoreWorkspace: vi.fn(), listDirectory: vi.fn(),
    openDroppedPath: vi.fn(), createDocument: vi.fn(), readDocument: vi.fn(), saveDocument: vi.fn(),
    revealDocument: vi.fn(), trashDocument: vi.fn(),
  }
  const firstRegistration = registerIpcHandlers({
    ipcMain, window: { webContents }, operations: firstOperations,
  })
  expect([...ipcMain.handlers.keys()].sort()).toEqual([
    ...Object.values(IPC_CHANNELS).filter((channel) => (
      channel !== IPC_CHANNELS.beginScreenshotTranslation
      && channel !== IPC_CHANNELS.aiRendererPortRequest
      && !(DOCUMENT_CONVERSION_IPC_CHANNELS as readonly string[]).includes(channel)
    )),
    ...Object.values(SCREENSHOT_OCR_MODEL_CHANNELS),
  ].sort())
  expect(ipcMain.handlers.has('document:save-as')).toBe(false)

  const secondOperations = {
    chooseWorkspace: vi.fn(), restoreWorkspace: vi.fn(), listDirectory: vi.fn(),
    openDroppedPath: vi.fn(), createDocument: vi.fn(), readDocument: vi.fn(), saveDocument: vi.fn(),
    revealDocument: vi.fn(), trashDocument: vi.fn(),
  }
  const secondRegistration = registerIpcHandlers({
    ipcMain, window: { webContents }, operations: secondOperations,
  })
  const registeredChannelCount = Object.values(IPC_CHANNELS).length
    - 2
    - DOCUMENT_CONVERSION_IPC_CHANNELS.length
    + Object.values(SCREENSHOT_OCR_MODEL_CHANNELS).length
  expect(ipcMain.handlers).toHaveLength(registeredChannelCount)
  expect(ipcMain.handle).toHaveBeenCalledTimes(registeredChannelCount)
  const chooseHandler = ipcMain.handlers.get(IPC_CHANNELS.chooseWorkspace)!
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  await chooseHandler(event)
  expect(firstOperations.chooseWorkspace).not.toHaveBeenCalled()
  expect(secondOperations.chooseWorkspace).toHaveBeenCalledTimes(1)
  firstRegistration.dispose()
  expect(ipcMain.handlers).toHaveLength(registeredChannelCount)
  secondRegistration.dispose()
  expect(ipcMain.handlers).toHaveLength(0)
})

it('allows only the current window main frame to invoke operations', async () => {
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { id: 7, mainFrame }
  const operations = {
    chooseWorkspace: vi.fn().mockResolvedValue({ ok: true, value: null }),
    restoreWorkspace: vi.fn(), listDirectory: vi.fn(), openDroppedPath: vi.fn(), createDocument: vi.fn(),
    readDocument: vi.fn(), saveDocument: vi.fn(), revealDocument: vi.fn(), trashDocument: vi.fn(),
  }
  registerIpcHandlers({ ipcMain, window: { webContents }, operations })
  const handler = ipcMain.handlers.get(IPC_CHANNELS.chooseWorkspace)!

  await expect(handler({ sender: webContents, senderFrame: mainFrame })).resolves.toEqual({
    ok: true, value: null,
  })
  await expect(handler({ sender: { id: 7 }, senderFrame: mainFrame })).resolves.toMatchObject({
    ok: false, error: { code: 'UNTRUSTED_SENDER' },
  })
  await expect(handler({ sender: webContents, senderFrame: {} })).resolves.toMatchObject({
    ok: false, error: { code: 'UNTRUSTED_SENDER' },
  })
  expect(operations.chooseWorkspace).toHaveBeenCalledTimes(1)
})

it('keeps the AI message-link capability bound to the owner window main frame', async () => {
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { id: 17, mainFrame }
  const openAiMessageLink = vi.fn().mockResolvedValue({
    ok: true, value: 'C:\\Workspace\\notes\\report.pdf',
  })
  registerIpcHandlers({
    ipcMain,
    window: { webContents },
    operations: { openAiMessageLink },
  })
  const handler = ipcMain.handlers.get(IPC_CHANNELS.openAiMessageLink)!

  await expect(handler(
    { sender: webContents, senderFrame: mainFrame },
    { target: 'notes\\report.pdf' },
  )).resolves.toEqual({ ok: true, value: 'C:\\Workspace\\notes\\report.pdf' })
  await expect(handler(
    { sender: { id: 17 }, senderFrame: mainFrame },
    { target: 'notes\\report.pdf' },
  )).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  await expect(handler(
    { sender: webContents, senderFrame: {} },
    { target: 'notes\\report.pdf' },
  )).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  expect(openAiMessageLink).toHaveBeenCalledTimes(1)
})

it('limits a print surface to sender-owned one-use payload and ready operations', async () => {
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { id: 12, mainFrame }
  const token = '00000000-0000-4000-8000-000000000001'
  const payload = {
    markdown: '# Print',
    documentName: 'print.md',
    documentAbsolutePath: 'C:\\Notes\\print.md',
    appearance: { ...DEFAULT_EDITOR_APPEARANCE },
    surfaceDeadlineEpochMs: 1_788_048_030_000,
  }
  const takePrintDocument = vi.fn(() => payload)
  const readyPrintDocument = vi.fn()
  registerPrintWindowIpc({
    ipcMain,
    window: { webContents },
    takePrintDocument,
    readyPrintDocument,
  })
  const event = { sender: webContents, senderFrame: mainFrame }

  await expect(ipcMain.handlers.get(IPC_CHANNELS.takePrintDocument)!(event, { token }))
    .resolves.toEqual({ ok: true, value: payload })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.readyPrintDocument)!(event, { token }))
    .resolves.toEqual({ ok: true, value: null })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.printDocument)!(event, payload))
    .resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.takePrintDocument)!({
    sender: { id: webContents.id },
    senderFrame: mainFrame,
  }, { token })).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  expect(takePrintDocument).toHaveBeenCalledOnce()
  expect(readyPrintDocument).toHaveBeenCalledOnce()
})

it('starts a real translation IPC request when the retired privacy flag remains false', async () => {
  const secretGet = vi.fn(async () => 'api-key')
  const streamChat = vi.fn(async () => ({
    toolCalls: [], reasoningContent: '', providerReplay: null, usage: null,
  }))
  const translations = new TranslationSessionService({
    settings: {
      get: () => ({
        lastWorkspace: null,
        models: {
          version: 3,
          codexCli: null,
          connections: [{
            id: '550e8400-e29b-41d4-a716-446655440000',
            name: 'IPC model',
            provider: 'deepseek',
            accessType: 'standard-api',
            protocol: 'openai',
            baseUrl: 'https://api.example.com/v1',
            modelId: 'chat-model',
            apiKeyHint: '••••test',
            status: 'connected',
            lastTestedAt: '2026-07-30T00:00:00.000Z',
          }],
          selectionTranslation: {
            connectionId: '550e8400-e29b-41d4-a716-446655440000',
            reasoningEffort: 'off',
            targetLanguage: 'en',
            privacyNoticeAccepted: false,
          },
          screenshotTranslation: {
            connectionId: '550e8400-e29b-41d4-a716-446655440000',
            reasoningEffort: 'off',
            targetLanguage: 'en',
          },
        },
      }),
      update: vi.fn(),
    } as never,
    secrets: { get: secretGet } as never,
    client: { streamChat, testConnection: vi.fn() },
    events: { emit: vi.fn() },
  })
  const dependencies = createDependencies()
  const operations = createIpcOperations({
    ...dependencies,
    translations,
  } as never)
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { mainFrame }
  registerIpcHandlers({ ipcMain, window: { webContents }, operations })
  const handler = ipcMain.handlers.get(IPC_CHANNELS.startTranslation)!

  await expect(handler(
    { sender: webContents, senderFrame: mainFrame },
    {
      documentKey: 'note.md',
      content: { markdown: 'private selection', plainText: 'private selection' },
      mode: 'visual',
    },
  )).resolves.toMatchObject({
    ok: true,
    value: { modelId: 'chat-model', targetLanguage: 'en' },
  })
  expect(secretGet).toHaveBeenCalledOnce()
  expect(streamChat).toHaveBeenCalledOnce()
})

it('converts thrown handler operations and extra invoke arguments into ApiResult failures', async () => {
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { mainFrame }
  const operations = {
    chooseWorkspace: vi.fn().mockRejectedValue(new Error('C:\\private\\failure.txt')),
    restoreWorkspace: vi.fn(), listDirectory: vi.fn(), openDroppedPath: vi.fn(), createDocument: vi.fn(),
    readDocument: vi.fn(), saveDocument: vi.fn(), revealDocument: vi.fn(), trashDocument: vi.fn(),
  }
  registerIpcHandlers({ ipcMain, window: { webContents }, operations })
  const handler = ipcMain.handlers.get(IPC_CHANNELS.chooseWorkspace)!
  await expect(handler({ sender: webContents, senderFrame: mainFrame })).resolves.toEqual({
    ok: false, error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
  })
  operations.chooseWorkspace.mockClear()
  await expect(handler({ sender: webContents, senderFrame: mainFrame }, undefined, 'extra')).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_INPUT' },
  })
  expect(operations.chooseWorkspace).not.toHaveBeenCalled()
})

it('opens the folder chooser at the last folder selected through that chooser', async () => {
  const showOpenDialog = vi.fn().mockResolvedValue({ canceled: true, filePaths: [] })
  const window = {}
  const chooseDirectory = createChooseDirectory(
    showOpenDialog,
    window,
    () => 'C:\\previous\\notes',
  )

  await chooseDirectory()

  expect(showOpenDialog).toHaveBeenCalledWith(window, {
    properties: ['openDirectory'],
    defaultPath: 'C:\\previous\\notes',
  })
})


it('maps canceled or empty dialog results to no directory', async () => {
  for (const result of [
    { canceled: true, filePaths: ['C:\\ignored'] },
    { canceled: false, filePaths: [] },
  ]) {
    const showOpenDialog = vi.fn().mockResolvedValue(result)
    const window = {}
    const chooseDirectory = createChooseDirectory(showOpenDialog, window)
    await expect(chooseDirectory()).resolves.toBeNull()
    expect(showOpenDialog).toHaveBeenCalledWith(window, { properties: ['openDirectory'] })
  }
})


it('removes partially installed handlers when registration fails', () => {
  const ipcMain = createRegistrar()
  ipcMain.handle.mockImplementation((channel, handler) => {
    if (channel === IPC_CHANNELS.readDocument) throw new Error('registration failed')
    ipcMain.handlers.set(channel, handler)
  })
  const webContents = { mainFrame: {} }
  const operations = {
    chooseWorkspace: vi.fn(), restoreWorkspace: vi.fn(), listDirectory: vi.fn(),
    openDroppedPath: vi.fn(), createDocument: vi.fn(), readDocument: vi.fn(), saveDocument: vi.fn(),
    revealDocument: vi.fn(), trashDocument: vi.fn(),
  }

  expect(() => registerIpcHandlers({ ipcMain, window: { webContents }, operations })).toThrow(
    'registration failed',
  )
  expect(ipcMain.handlers).toHaveLength(0)
})


it('keeps the no-workspace state when chosen workspace persistence fails', async () => {
  const chosen = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-chosen-'))
  try {
    const workspace = new WorkspaceService()
    const operations = createIpcOperations({
      chooseDirectory: vi.fn().mockResolvedValue(chosen),
      workspace,
      documents: {} as never,
      getLastWorkspace: () => null,
      setLastWorkspace: vi.fn().mockRejectedValue(new Error('settings failed')),
      reportError: vi.fn(),
    })

    await expect(operations.chooseWorkspace()).resolves.toMatchObject({
      ok: false, error: { code: 'OPERATION_FAILED' },
    })
    expect(() => workspace.getRoot()).toThrow('No workspace is open')
  } finally {
    await rm(chosen, { recursive: true, force: true })
  }
})

it('keeps the old workspace when chosen workspace persistence fails', async () => {
  const oldRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-old-'))
  const chosen = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-chosen-'))
  try {
    const workspace = new WorkspaceService()
    await workspace.setRoot(oldRoot)
    const previousRoot = workspace.getRoot()
    const operations = createIpcOperations({
      chooseDirectory: vi.fn().mockResolvedValue(chosen),
      workspace,
      documents: {} as never,
      getLastWorkspace: () => null,
      setLastWorkspace: vi.fn().mockRejectedValue(new Error('settings failed')),
      reportError: vi.fn(),
    })

    await operations.chooseWorkspace()
    expect(workspace.getRoot()).toBe(previousRoot)
  } finally {
    await Promise.all([
      rm(oldRoot, { recursive: true, force: true }),
      rm(chosen, { recursive: true, force: true }),
    ])
  }
})

it('persists the canonical workspace before committing it in memory', async () => {
  const chosen = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-success-'))
  try {
    const canonical = await realpath(chosen)
    const workspace = new WorkspaceService()
    const setLastWorkspace = vi.fn(async (savedRoot: string | null) => {
      expect(savedRoot).toBe(canonical)
      expect(() => workspace.getRoot()).toThrow('No workspace is open')
    })
    const operations = createIpcOperations({
      chooseDirectory: vi.fn().mockResolvedValue(chosen),
      workspace,
      documents: {} as never,
      getLastWorkspace: () => null,
      setLastWorkspace,
      reportError: vi.fn(),
    })

    await expect(operations.chooseWorkspace()).resolves.toMatchObject({
      ok: true, value: { absolutePath: canonical },
    })
    expect(workspace.getRoot()).toBe(canonical)
  } finally {
    await rm(chosen, { recursive: true, force: true })
  }
})


it('does not remove a foreign handler when initial registration encounters a duplicate', () => {
  const ipcMain = createRegistrar()
  const foreignHandler = vi.fn()
  ipcMain.handlers.set(IPC_CHANNELS.readDocument, foreignHandler)
  const webContents = { mainFrame: {} }
  const operations = {
    chooseWorkspace: vi.fn(), restoreWorkspace: vi.fn(), listDirectory: vi.fn(),
    openDroppedPath: vi.fn(), createDocument: vi.fn(), readDocument: vi.fn(), saveDocument: vi.fn(),
    revealDocument: vi.fn(), trashDocument: vi.fn(),
  }

  expect(() => registerIpcHandlers({ ipcMain, window: { webContents }, operations })).toThrow(
    `duplicate handler: ${IPC_CHANNELS.readDocument}`,
  )
  expect(ipcMain.handlers).toEqual(new Map([[IPC_CHANNELS.readDocument, foreignHandler]]))
  expect(ipcMain.removeHandler).not.toHaveBeenCalledWith(IPC_CHANNELS.readDocument)
})

it('pauses new requests and drains operations that already entered the handler', async () => {
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { mainFrame }
  let finishOperation: ((value: { ok: true; value: null }) => void) | undefined
  const operationResult = new Promise<{ ok: true; value: null }>((resolve) => {
    finishOperation = resolve
  })
  const operations = {
    chooseWorkspace: vi.fn().mockReturnValue(operationResult),
    restoreWorkspace: vi.fn(), listDirectory: vi.fn(), openDroppedPath: vi.fn(), createDocument: vi.fn(),
    readDocument: vi.fn(), saveDocument: vi.fn(), revealDocument: vi.fn(), trashDocument: vi.fn(),
  }
  const registration = registerIpcHandlers({ ipcMain, window: { webContents }, operations })
  const handler = ipcMain.handlers.get(IPC_CHANNELS.chooseWorkspace)!
  const event = { sender: webContents, senderFrame: mainFrame }

  const entered = handler(event)
  let drained = false
  const drain = registration.pauseAndDrain().then(() => {
    drained = true
  })
  await expect(handler(event)).resolves.toEqual({
    ok: false,
    error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
  })
  expect(operations.chooseWorkspace).toHaveBeenCalledTimes(1)
  expect(drained).toBe(false)

  finishOperation?.({ ok: true, value: null })
  await expect(entered).resolves.toEqual({ ok: true, value: null })
  await drain
  expect(drained).toBe(true)

  registration.resume()
  operations.chooseWorkspace.mockResolvedValue({ ok: true, value: null })
  await expect(handler(event)).resolves.toEqual({ ok: true, value: null })
  expect(operations.chooseWorkspace).toHaveBeenCalledTimes(2)
})


it('registerIpc adapts the dialog and services to the owned handlers', async () => {
  const dependencies = createDependencies()
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { mainFrame }
  const showOpenDialog = vi.fn().mockResolvedValue({
    canceled: false,
    filePaths: ['C:\\picked\\notes'],
  })
  const window = {
    webContents,
    isMaximized: () => { throw new Error('direct maximized read') },
    isFullScreen: () => { throw new Error('direct fullscreen read') },
  }
  const getWindowState = vi.fn(() => ({
    maximized: false,
    fullscreen: true,
    revision: 2,
  }))
  const controlWindow = vi.fn(() => ({
    maximized: false,
    fullscreen: true,
    revision: 2,
  }))
  const registration = registerIpc({
    ipcMain,
    showOpenDialog,
    window,
    workspace: dependencies.workspace as never,
    documents: dependencies.documents as never,
    getLastWorkspace: dependencies.getLastWorkspace,
    setLastWorkspace: dependencies.setLastWorkspace,
    reportError: vi.fn(),
    controlWindow,
    getWindowState,
  })

  const handler = ipcMain.handlers.get(IPC_CHANNELS.chooseWorkspace)!
  await expect(handler({ sender: webContents, senderFrame: mainFrame })).resolves.toEqual({
    ok: true,
    value: { name: 'notes', absolutePath: 'C:\\canonical\\notes' },
  })
  expect(showOpenDialog).toHaveBeenCalledWith(
    window,
    { properties: ['openDirectory'] },
  )
  expect(dependencies.workspace.validateRoot).toHaveBeenCalledWith('C:\\picked\\notes')
  expect(dependencies.setLastWorkspace).toHaveBeenCalledWith('C:\\canonical\\notes')
  const stateHandler = ipcMain.handlers.get(IPC_CHANNELS.getWindowState)!
  await expect(stateHandler({ sender: webContents, senderFrame: mainFrame })).resolves.toEqual({
    ok: true,
    value: { maximized: false, fullscreen: true, revision: 2 },
  })
  expect(getWindowState).toHaveBeenCalledOnce()

  await registration.dispose()
  expect(ipcMain.handlers).toHaveLength(0)
})

it('resumes composite AI renderer IPC and reports asynchronous teardown failures on disposal', async () => {
  const dependencies = createDependencies()
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = {
    id: 17, mainFrame, send: vi.fn(), isDestroyed: () => false,
  }
  const teardownError = new Error('AI renderer teardown failed')
  const reportError = vi.fn()
  let portGeneration = 0
  const registration = registerIpc({
    ipcMain,
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    window: {
      webContents,
      isDestroyed: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
    },
    workspace: dependencies.workspace as never,
    documents: dependencies.documents as never,
    getLastWorkspace: dependencies.getLastWorkspace,
    setLastWorkspace: dependencies.setLastWorkspace,
    reportError,
    controlWindow: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 1 })),
    getWindowState: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 1 })),
    desktopAi: {
      ownerId: 17,
      getWorkspaceAuthority: vi.fn(async () => ({
        workspaceId: 'workspace.1', workspaceGeneration: 'generation.1',
      })),
      registerCurrentDocumentPort: vi.fn(async () => {
        portGeneration += 1
        return {
          portGeneration,
          unregister: portGeneration === 1
            ? vi.fn(async () => undefined)
            : vi.fn(async () => { throw teardownError }),
        }
      }),
      registerTransportLifecycle: vi.fn(() => () => undefined),
    },
  })
  const handler = ipcMain.handlers.get(IPC_CHANNELS.registerAiCurrentDocumentPort)!
  await expect(handler({ sender: webContents, senderFrame: mainFrame })).resolves.toEqual({
    ok: true, value: { portGeneration: 1 },
  })
  await expect(registration.pauseAndDrain()).resolves.toBeUndefined()
  registration.resume()
  await expect(handler({ sender: webContents, senderFrame: mainFrame })).resolves.toEqual({
    ok: true, value: { portGeneration: 2 },
  })

  await expect(registration.dispose()).rejects.toThrow('IPC disposal cleanup failed')
  expect(reportError).toHaveBeenCalledWith(teardownError)
  expect(ipcMain.handlers).toHaveLength(0)
})

it('rolls back an attached AI renderer lifecycle when handler installation fails', async () => {
  const dependencies = createDependencies()
  const ipcMain = createRegistrar()
  const foreignHandler = vi.fn()
  ipcMain.handlers.set(IPC_CHANNELS.readDocument, foreignHandler)
  const detach = vi.fn()
  const disposalError = new Error('AI bridge rollback failed')
  const disposeBridge = vi.fn(async () => { throw disposalError })
  const reportError = vi.fn()
  const mainFrame = {}
  const webContents = { id: 17, mainFrame, send: vi.fn(), isDestroyed: () => false }

  expect(() => registerIpc({
    ipcMain,
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    window: {
      webContents, isDestroyed: () => false,
      isMaximized: () => false, isFullScreen: () => false,
    },
    workspace: dependencies.workspace as never,
    documents: dependencies.documents as never,
    getLastWorkspace: dependencies.getLastWorkspace,
    setLastWorkspace: dependencies.setLastWorkspace,
    reportError,
    controlWindow: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 1 })),
    getWindowState: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 1 })),
    desktopAi: {
      ownerId: 17,
      getWorkspaceAuthority: vi.fn(async () => ({
        workspaceId: 'workspace.1', workspaceGeneration: 'generation.1',
      })),
      registerCurrentDocumentPort: vi.fn(),
      registerTransportLifecycle: vi.fn(() => detach),
    },
    aiRendererPortBridgeFactory: vi.fn(() => ({ dispose: disposeBridge }) as never),
  })).toThrow(`duplicate handler: ${IPC_CHANNELS.readDocument}`)
  expect(detach).toHaveBeenCalledOnce()
  expect(disposeBridge).toHaveBeenCalledOnce()
  expect(ipcMain.handlers).toEqual(new Map([[IPC_CHANNELS.readDocument, foreignHandler]]))
  await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(disposalError))
})

it('disposes a newly created AI bridge when lifecycle attachment throws before handler install', async () => {
  const dependencies = createDependencies()
  const ipcMain = createRegistrar()
  const attachError = new Error('AI lifecycle attach failed')
  const disposeBridge = vi.fn(async () => undefined)
  const registerTransportLifecycle = vi.fn(() => { throw attachError })
  const webContents = { id: 17, mainFrame: {}, send: vi.fn(), isDestroyed: () => false }

  expect(() => registerIpc({
    ipcMain,
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    window: {
      webContents, isDestroyed: () => false,
      isMaximized: () => false, isFullScreen: () => false,
    },
    workspace: dependencies.workspace as never,
    documents: dependencies.documents as never,
    getLastWorkspace: dependencies.getLastWorkspace,
    setLastWorkspace: dependencies.setLastWorkspace,
    reportError: vi.fn(),
    controlWindow: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 1 })),
    getWindowState: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 1 })),
    desktopAi: {
      ownerId: 17,
      getWorkspaceAuthority: vi.fn(async () => ({
        workspaceId: 'workspace.1', workspaceGeneration: 'generation.1',
      })),
      registerCurrentDocumentPort: vi.fn(),
      registerTransportLifecycle,
    },
    aiRendererPortBridgeFactory: vi.fn(() => ({ dispose: disposeBridge }) as never),
  })).toThrow(attachError)
  expect(registerTransportLifecycle).toHaveBeenCalledOnce()
  expect(disposeBridge).toHaveBeenCalledOnce()
  expect(ipcMain.handlers).toHaveLength(0)
})

it('does not attach a lifecycle or install handlers when AI bridge creation fails', () => {
  const dependencies = createDependencies()
  const ipcMain = createRegistrar()
  const creationError = new Error('AI bridge creation failed')
  const registerTransportLifecycle = vi.fn()
  const webContents = { id: 17, mainFrame: {}, send: vi.fn(), isDestroyed: () => false }

  expect(() => registerIpc({
    ipcMain,
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    window: {
      webContents, isDestroyed: () => false,
      isMaximized: () => false, isFullScreen: () => false,
    },
    workspace: dependencies.workspace as never,
    documents: dependencies.documents as never,
    getLastWorkspace: dependencies.getLastWorkspace,
    setLastWorkspace: dependencies.setLastWorkspace,
    reportError: vi.fn(),
    controlWindow: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 1 })),
    getWindowState: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 1 })),
    desktopAi: {
      ownerId: 17,
      getWorkspaceAuthority: vi.fn(async () => ({
        workspaceId: 'workspace.1', workspaceGeneration: 'generation.1',
      })),
      registerCurrentDocumentPort: vi.fn(),
      registerTransportLifecycle,
    },
    aiRendererPortBridgeFactory: vi.fn(() => { throw creationError }),
  })).toThrow(creationError)
  expect(registerTransportLifecycle).not.toHaveBeenCalled()
  expect(ipcMain.handlers).toHaveLength(0)
})

it('removes handlers and disposes the AI bridge even when its lifecycle detacher throws', async () => {
  const dependencies = createDependencies()
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { id: 17, mainFrame, send: vi.fn(), isDestroyed: () => false }
  const detachError = new Error('AI lifecycle detach failed')
  const unregister = vi.fn(async () => undefined)
  const reportError = vi.fn()
  const registration = registerIpc({
    ipcMain,
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    window: {
      webContents, isDestroyed: () => false,
      isMaximized: () => false, isFullScreen: () => false,
    },
    workspace: dependencies.workspace as never,
    documents: dependencies.documents as never,
    getLastWorkspace: dependencies.getLastWorkspace,
    setLastWorkspace: dependencies.setLastWorkspace,
    reportError,
    controlWindow: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 1 })),
    getWindowState: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 1 })),
    desktopAi: {
      ownerId: 17,
      getWorkspaceAuthority: vi.fn(async () => ({
        workspaceId: 'workspace.1', workspaceGeneration: 'generation.1',
      })),
      registerCurrentDocumentPort: vi.fn(async () => ({ portGeneration: 1, unregister })),
      registerTransportLifecycle: vi.fn(() => () => { throw detachError }),
    },
  })
  const handler = ipcMain.handlers.get(IPC_CHANNELS.registerAiCurrentDocumentPort)!
  await expect(handler({ sender: webContents, senderFrame: mainFrame })).resolves.toMatchObject({ ok: true })

  await expect(registration.dispose()).rejects.toThrow('IPC disposal cleanup failed')
  await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce())
  expect(reportError).toHaveBeenCalledWith(detachError)
  expect(ipcMain.handlers).toHaveLength(0)
})


it('rolls settings back and preserves no-root when a chosen directory is recreated before commit', async () => {
  const chosen = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-recreate-'))
  const canonical = await realpath(chosen)
  let releasePersistence: (() => void) | undefined
  const persistence = new Promise<void>((resolve) => {
    releasePersistence = resolve
  })
  const setLastWorkspace = vi.fn()
    .mockImplementationOnce(() => persistence)
    .mockResolvedValueOnce(undefined)
  const reportError = vi.fn()
  try {
    const workspace = new WorkspaceService()
    const operations = createIpcOperations({
      chooseDirectory: vi.fn().mockResolvedValue(chosen),
      workspace,
      documents: {} as never,
      getLastWorkspace: () => null,
      setLastWorkspace,
      reportError,
    })

    const result = operations.chooseWorkspace()
    await vi.waitFor(() => expect(setLastWorkspace).toHaveBeenCalledWith(canonical))
    await rm(chosen, { recursive: true, force: true })
    await mkdir(chosen)
    releasePersistence?.()

    await expect(result).resolves.toMatchObject({
      ok: false, error: { code: 'OPERATION_FAILED' },
    })
    expect(setLastWorkspace.mock.calls).toEqual([[canonical], [null]])
    expect(reportError).not.toHaveBeenCalled()
    expect(() => workspace.getRoot()).toThrow('No workspace is open')
  } finally {
    await rm(chosen, { recursive: true, force: true })
  }
})

it('rolls settings back and preserves the old root when chosen path becomes a junction', async () => {
  const oldRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-old-root-'))
  const chosen = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-junction-source-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-junction-target-'))
  const moved = `${chosen}-moved`
  const canonicalOld = await realpath(oldRoot)
  let releasePersistence: (() => void) | undefined
  const persistence = new Promise<void>((resolve) => {
    releasePersistence = resolve
  })
  const setLastWorkspace = vi.fn()
    .mockImplementationOnce(() => persistence)
    .mockResolvedValueOnce(undefined)
  try {
    const workspace = new WorkspaceService()
    await workspace.setRoot(oldRoot)
    const operations = createIpcOperations({
      chooseDirectory: vi.fn().mockResolvedValue(chosen),
      workspace,
      documents: {} as never,
      getLastWorkspace: () => canonicalOld,
      setLastWorkspace,
      reportError: vi.fn(),
    })

    const result = operations.chooseWorkspace()
    await vi.waitFor(() => expect(setLastWorkspace).toHaveBeenCalledTimes(1))
    await rename(chosen, moved)
    await symlink(outside, chosen, 'junction')
    releasePersistence?.()

    await expect(result).resolves.toMatchObject({
      ok: false, error: { code: 'OPERATION_FAILED' },
    })
    expect(setLastWorkspace.mock.calls[1]).toEqual([canonicalOld])
    expect(workspace.getRoot()).toBe(canonicalOld)
  } finally {
    await Promise.all([
      rm(chosen, { recursive: true, force: true }),
      rm(moved, { recursive: true, force: true }),
      rm(oldRoot, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ])
  }
})

it('reports failure and preserves root state when both commit and settings rollback fail', async () => {
  const chosen = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-rollback-fail-'))
  const canonical = await realpath(chosen)
  const rollbackError = new Error('rollback failed at C:\\private\\settings.json\nrollback stack')
  const setLastWorkspace = vi.fn()
    .mockImplementationOnce(async () => {
      await rm(chosen, { recursive: true, force: true })
      await mkdir(chosen)
    })
    .mockRejectedValueOnce(rollbackError)
  const reportError = vi.fn()
  try {
    const workspace = new WorkspaceService()
    const operations = createIpcOperations({
      chooseDirectory: vi.fn().mockResolvedValue(chosen),
      workspace,
      documents: {} as never,
      getLastWorkspace: () => null,
      setLastWorkspace,
      reportError,
    })

    const result = await operations.chooseWorkspace()
    expect(result).toEqual({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
    })
    expect(reportError).toHaveBeenCalledTimes(1)
    const reported = reportError.mock.calls[0]?.[0]
    expect(reported).toBeInstanceOf(AggregateError)
    if (!(reported instanceof AggregateError)) throw new Error('Expected AggregateError')
    expect(reported.errors).toHaveLength(2)
    expect(reported.errors[0]).toMatchObject({ message: 'Workspace identity changed' })
    expect(reported.errors[1]).toBe(rollbackError)
    expect(JSON.stringify(result)).not.toContain('C:\\private')
    expect(JSON.stringify(result)).not.toContain('stack')
    expect(setLastWorkspace.mock.calls).toEqual([[canonical], [null]])
    expect(() => workspace.getRoot()).toThrow('No workspace is open')
  } finally {
    await rm(chosen, { recursive: true, force: true })
  }
})


it('rejects replacement while paused with no inflight work and preserves the old registration', async () => {
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { mainFrame }
  const firstOperations = {
    chooseWorkspace: vi.fn().mockResolvedValue({ ok: true, value: null }),
    restoreWorkspace: vi.fn(), listDirectory: vi.fn(), openDroppedPath: vi.fn(), createDocument: vi.fn(),
    readDocument: vi.fn(), saveDocument: vi.fn(), revealDocument: vi.fn(), trashDocument: vi.fn(),
  }
  const secondOperations = {
    chooseWorkspace: vi.fn().mockResolvedValue({ ok: true, value: null }),
    restoreWorkspace: vi.fn(), listDirectory: vi.fn(), openDroppedPath: vi.fn(), createDocument: vi.fn(),
    readDocument: vi.fn(), saveDocument: vi.fn(), revealDocument: vi.fn(), trashDocument: vi.fn(),
  }
  const first = registerIpcHandlers({ ipcMain, window: { webContents }, operations: firstOperations })
  await first.pauseAndDrain()

  expect(() => registerIpcHandlers({
    ipcMain, window: { webContents }, operations: secondOperations,
  })).toThrow('IPC registration is paused')

  first.resume()
  const handler = ipcMain.handlers.get(IPC_CHANNELS.chooseWorkspace)!
  await expect(handler({ sender: webContents, senderFrame: mainFrame })).resolves.toEqual({
    ok: true, value: null,
  })
  expect(firstOperations.chooseWorkspace).toHaveBeenCalledTimes(1)
  expect(secondOperations.chooseWorkspace).not.toHaveBeenCalled()
  await expect(first.pauseAndDrain()).resolves.toBeUndefined()
  first.resume()
})

it('rejects replacement while actively draining without polluting inflight state or waiters', async () => {
  const ipcMain = createRegistrar()
  const mainFrame = {}
  const webContents = { mainFrame }
  let finish: ((result: { ok: true; value: null }) => void) | undefined
  const pending = new Promise<{ ok: true; value: null }>((resolve) => {
    finish = resolve
  })
  const firstOperations = {
    chooseWorkspace: vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ ok: true, value: null }),
    restoreWorkspace: vi.fn(), listDirectory: vi.fn(), openDroppedPath: vi.fn(), createDocument: vi.fn(),
    readDocument: vi.fn(), saveDocument: vi.fn(), revealDocument: vi.fn(), trashDocument: vi.fn(),
  }
  const secondOperations = {
    chooseWorkspace: vi.fn().mockResolvedValue({ ok: true, value: null }),
    restoreWorkspace: vi.fn(), listDirectory: vi.fn(), openDroppedPath: vi.fn(), createDocument: vi.fn(),
    readDocument: vi.fn(), saveDocument: vi.fn(), revealDocument: vi.fn(), trashDocument: vi.fn(),
  }
  const first = registerIpcHandlers({ ipcMain, window: { webContents }, operations: firstOperations })
  const handler = ipcMain.handlers.get(IPC_CHANNELS.chooseWorkspace)!
  const event = { sender: webContents, senderFrame: mainFrame }
  const entered = handler(event)
  const drain = first.pauseAndDrain()

  expect(() => registerIpcHandlers({
    ipcMain, window: { webContents }, operations: secondOperations,
  })).toThrow('IPC registration is paused')
  finish?.({ ok: true, value: null })
  await expect(entered).resolves.toEqual({ ok: true, value: null })
  await expect(drain).resolves.toBeUndefined()

  first.resume()
  await expect(handler(event)).resolves.toEqual({ ok: true, value: null })
  expect(firstOperations.chooseWorkspace).toHaveBeenCalledTimes(2)
  expect(secondOperations.chooseWorkspace).not.toHaveBeenCalled()
  await expect(first.pauseAndDrain()).resolves.toBeUndefined()
  first.resume()
})


it('rolls settings back and preserves no-root when the chosen path is removed before commit', async () => {
  const chosen = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-removed-'))
  const canonical = await realpath(chosen)
  const setLastWorkspace = vi.fn()
    .mockImplementationOnce(async () => rm(chosen, { recursive: true, force: true }))
    .mockResolvedValueOnce(undefined)
  const workspace = new WorkspaceService()
  const operations = createIpcOperations({
    chooseDirectory: vi.fn().mockResolvedValue(chosen),
    workspace,
    documents: {} as never,
    getLastWorkspace: () => null,
    setLastWorkspace,
    reportError: vi.fn(),
  })

  await expect(operations.chooseWorkspace()).resolves.toMatchObject({
    ok: false, error: { code: 'FILE_NOT_FOUND' },
  })
  expect(setLastWorkspace.mock.calls).toEqual([[canonical], [null]])
  expect(() => workspace.getRoot()).toThrow('No workspace is open')
})

it.each(['no-root', 'old-root'] as const)(
  'refuses a rollback-residual canonical path redirected outside with %s',
  async (initialState) => {
    const chosen = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-residual-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-outside-'))
    const oldRoot = initialState === 'old-root'
      ? await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-old-'))
      : null
    const moved = `${chosen}-moved`
    const chosenCanonical = await realpath(chosen)
    const oldCanonical = oldRoot ? await realpath(oldRoot) : null
    let savedWorkspace: string | null = null
    const rollbackError = new Error('rollback failed at C:\\private\\settings.json')
    const setLastWorkspace = vi.fn()
      .mockImplementationOnce(async (root: string | null) => {
        savedWorkspace = root
        await rename(chosen, moved)
        await symlink(outside, chosen, 'junction')
      })
      .mockRejectedValueOnce(rollbackError)
    const reportError = vi.fn()

    try {
      const workspace = new WorkspaceService()
      if (oldRoot) await workspace.setRoot(oldRoot)
      const operations = createIpcOperations({
        chooseDirectory: vi.fn().mockResolvedValue(chosen),
        workspace,
        documents: {} as never,
        getLastWorkspace: () => savedWorkspace,
        setLastWorkspace,
        reportError,
      })

      await expect(operations.chooseWorkspace()).resolves.toEqual({
        ok: false,
        error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
      })
      expect(savedWorkspace).toBe(chosenCanonical)
      expect(reportError).toHaveBeenCalledTimes(1)

      await expect(operations.restoreWorkspace()).resolves.toEqual({
        ok: false,
        error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
      })
      if (oldCanonical) expect(workspace.getRoot()).toBe(oldCanonical)
      else expect(() => workspace.getRoot()).toThrow('No workspace is open')
    } finally {
      await Promise.all([
        rm(chosen, { recursive: true, force: true }),
        rm(moved, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
        ...(oldRoot ? [rm(oldRoot, { recursive: true, force: true })] : []),
      ])
    }
  },
)

it('rejects a redirected residual canonical path on the next startup', async () => {
  const savedRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-restart-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-outside-'))
  const moved = `${savedRoot}-moved`
  const savedCanonical = await realpath(savedRoot)
  try {
    await rename(savedRoot, moved)
    await symlink(outside, savedRoot, 'junction')
    const workspace = new WorkspaceService()
    const operations = createIpcOperations({
      chooseDirectory: vi.fn(),
      workspace,
      documents: {} as never,
      getLastWorkspace: () => savedCanonical,
      setLastWorkspace: vi.fn(),
      reportError: vi.fn(),
    })

    await expect(operations.restoreWorkspace()).resolves.toEqual({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
    })
    expect(() => workspace.getRoot()).toThrow('No workspace is open')
  } finally {
    await Promise.all([
      rm(savedRoot, { recursive: true, force: true }),
      rm(moved, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ])
  }
})

it('still accepts a junction explicitly selected by the user and persists its canonical target', async () => {
  const selected = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-selected-'))
  const target = await mkdtemp(path.join(tmpdir(), 'arkdown-ipc-target-'))
  await rm(selected, { recursive: true, force: true })
  await symlink(target, selected, 'junction')
  const targetCanonical = await realpath(target)
  const setLastWorkspace = vi.fn().mockResolvedValue(undefined)
  try {
    const workspace = new WorkspaceService()
    const operations = createIpcOperations({
      chooseDirectory: vi.fn().mockResolvedValue(selected),
      workspace,
      documents: {} as never,
      getLastWorkspace: () => null,
      setLastWorkspace,
      reportError: vi.fn(),
    })

    await expect(operations.chooseWorkspace()).resolves.toMatchObject({
      ok: true,
      value: { absolutePath: targetCanonical },
    })
    expect(setLastWorkspace).toHaveBeenCalledWith(targetCanonical)
    expect(workspace.getRoot()).toBe(targetCanonical)
  } finally {
    await Promise.all([
      rm(selected, { recursive: true, force: true }),
      rm(target, { recursive: true, force: true }),
    ])
  }
})


it('keeps IPC operations isolated across two live windows', async () => {
  const ipcMain = createRegistrar()
  const firstWebContents = { id: 101, mainFrame: {} }
  const secondWebContents = { id: 202, mainFrame: {} }
  const firstChoose = vi.fn(async () => ({ ok: true as const, value: { name: 'First', absolutePath: 'C:/First' } }))
  const secondChoose = vi.fn(async () => ({ ok: true as const, value: { name: 'Second', absolutePath: 'C:/Second' } }))
  const first = registerIpcHandlers({
    ipcMain,
    window: { webContents: firstWebContents },
    operations: { chooseWorkspace: firstChoose },
  })
  const second = registerIpcHandlers({
    ipcMain,
    window: { webContents: secondWebContents },
    operations: { chooseWorkspace: secondChoose },
  })
  const handler = ipcMain.handlers.get(IPC_CHANNELS.chooseWorkspace)!

  await handler({ sender: firstWebContents, senderFrame: firstWebContents.mainFrame })
  await handler({ sender: secondWebContents, senderFrame: secondWebContents.mainFrame })

  expect(firstChoose).toHaveBeenCalledTimes(1)
  expect(secondChoose).toHaveBeenCalledTimes(1)
  first.dispose()
  await handler({ sender: secondWebContents, senderFrame: secondWebContents.mainFrame })
  expect(secondChoose).toHaveBeenCalledTimes(2)
  expect(ipcMain.handlers).toHaveLength(
    Object.values(IPC_CHANNELS).length
      - 2
      - DOCUMENT_CONVERSION_IPC_CHANNELS.length
      + Object.values(SCREENSHOT_OCR_MODEL_CHANNELS).length,
  )
  second.dispose()
  expect(ipcMain.handlers).toHaveLength(0)
})


it('registers the line-spacing IPC channel for an ordinary Arkdown window', async () => {
  const ipcMain = createRegistrar()
  const webContents = { id: 303, mainFrame: {} }
  const setStickyNoteLineSpacingMode = vi.fn(async () => ({ ok: true as const, value: null }))
  registerIpcHandlers({
    ipcMain,
    window: { webContents },
    operations: { setStickyNoteLineSpacingMode },
  })

  const handler = ipcMain.handlers.get(IPC_CHANNELS.setStickyNoteLineSpacingMode)
  expect(handler).toBeDefined()
  await expect(handler?.(
    { sender: webContents, senderFrame: webContents.mainFrame },
    { noteId: '00000000-0000-4000-8000-000000000001', lineSpacingMode: 'standard' },
  )).resolves.toEqual({ ok: true, value: null })
  expect(setStickyNoteLineSpacingMode).toHaveBeenCalledWith({
    noteId: '00000000-0000-4000-8000-000000000001',
    lineSpacingMode: 'standard',
  })
})
