import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  createAiRendererPortBridge,
  createIpcOperations,
} from '../../src/main/ipc/register-ipc'
import { PublicError } from '../../src/shared/public-errors'
import { OpenDocumentRegistry } from '../../src/main/documents/open-document-registry'
import { RegistryWorkspaceAiEditorBoundary } from '../../src/main/documents/workspace-ai-editor-boundary'
import type { CanonicalFileIdentity } from '../../src/main/documents/document-identity'

const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440003'
const CONVERSATION_ID = '550e8400-e29b-41d4-a716-446655440001'
const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440002'
const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440004'
const AUTHORITY: { workspaceId: string; workspaceGeneration: string } = Object.freeze({
  workspaceId: 'workspace.1', workspaceGeneration: 'generation.1',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function startInput() {
  return {
    requestId: REQUEST_ID,
    conversationId: CONVERSATION_ID,
    workspaceKey: AUTHORITY.workspaceId,
    acknowledgedTranscriptRevision: 0,
    messages: [{ id: MESSAGE_ID, role: 'user' as const, content: 'Summarize it' }] as const,
    capabilities: { currentDocument: true, workspace: false },
    writePolicy: 'ask-every-time' as const,
  }
}

function aiHarness() {
  const aiConversations = {
    start: vi.fn(async () => ({ requestId: REQUEST_ID, modelId: 'deepseek-chat', transcriptRevision: 1 })),
    cancel: vi.fn(async () => undefined),
    submitAuthorizationResult: vi.fn(async () => undefined),
    setCapabilities: vi.fn(() => undefined),
    clearConversation: vi.fn(async () => undefined),
    notifyCurrentDocumentChanged: vi.fn(async () => undefined),
  }
  const desktopAi = {
    ownerId: 17,
    getWorkspaceAuthority: vi.fn(async () => AUTHORITY),
  }
  const openExternal = vi.fn(async () => undefined)
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(async () => null),
    workspace: {} as never,
    documents: {} as never,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    aiConversations,
    desktopAi,
    openExternal,
  } as never)
  return { operations, aiConversations, desktopAi, openExternal }
}

type LinkEntryKind = 'directory' | 'file' | 'symlink'

function linkMetadata(kind: LinkEntryKind, identity: number) {
  return {
    dev: 1,
    ino: identity,
    size: kind === 'file' ? 128 : 0,
    mtimeMs: 1_700_000_000_000,
    ctimeMs: 1_700_000_000_000,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isSymbolicLink: () => kind === 'symlink',
  }
}

function aiLinkHarness(options: {
  readonly symlinkPath?: string
  readonly reparsePath?: string
  readonly missingPath?: string
  readonly mutatePath?: string
  readonly canonicalPath?: string
  readonly authoritySequence?: readonly { workspaceId: string; workspaceGeneration: string }[]
  readonly activationRoots?: readonly string[]
  readonly firstLstatBarrier?: Promise<void>
  readonly onLstatCall?: (count: number) => void
} = {}) {
  const root = 'C:\\Workspace'
  const normalized = (value: string) => path.win32.normalize(value).toLocaleLowerCase('en-US')
  const reads = new Map<string, number>()
  const lstat = vi.fn(async (target: string) => {
    options.onLstatCall?.(lstat.mock.calls.length)
    if (lstat.mock.calls.length === 1 && options.firstLstatBarrier) {
      await options.firstLstatBarrier
    }
    const key = normalized(target)
    if (options.missingPath && key === normalized(options.missingPath)) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    if (options.symlinkPath && key === normalized(options.symlinkPath)) {
      return linkMetadata('symlink', 70)
    }
    const count = (reads.get(key) ?? 0) + 1
    reads.set(key, count)
    const changed = options.mutatePath && key === normalized(options.mutatePath) && count > 1
    const extension = path.win32.extname(target)
    return extension
      ? linkMetadata('file', changed ? 999 : 80)
      : linkMetadata('directory', changed ? 999 : key.length + 10)
  })
  const queryWindowsReparsePoint = vi.fn(async (target: string) => (
    options.reparsePath ? normalized(target) === normalized(options.reparsePath) : false
  ))
  const realpath = vi.fn(async (target: string) => (
    options.canonicalPath && path.win32.extname(target)
      ? options.canonicalPath
      : path.win32.normalize(target)
  ))
  const authoritySequence = [...(options.authoritySequence ?? [AUTHORITY])]
  const activationRoots = [...(options.activationRoots ?? [root])]
  const desktopAi = {
    ownerId: 17,
    getWorkspaceAuthority: vi.fn(async () => authoritySequence.shift() ?? AUTHORITY),
  }
  const workspace = {
    getValidatedActivationSnapshot: vi.fn(async () => {
      const activationRoot = activationRoots.shift() ?? root
      return Object.freeze({
        root: activationRoot, epoch: activationRoot === root ? 4 : 5,
        rootVolumeSerial: 'volume.1', rootFileId: 'directory.1',
      })
    }),
  }
  const openExternal = vi.fn(async () => undefined)
  const openDocumentWindow = vi.fn(async () => {
    throw new Error('AI message links must never open a local document')
  })
  const showItemInFolder = vi.fn()
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(async () => null),
    workspace,
    documents: {} as never,
    getLastWorkspace: () => root,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    desktopAi,
    openExternal,
    openDocumentWindow,
    showItemInFolder,
    aiMessageLinkIo: { lstat, realpath, queryWindowsReparsePoint },
  } as never)
  return {
    root, operations, desktopAi, workspace, openExternal, openDocumentWindow,
    showItemInFolder, lstat, realpath, queryWindowsReparsePoint,
  }
}

it('starts one strict incremental turn and returns the authoritative transcript revision', async () => {
  const { operations, aiConversations } = aiHarness()

  await expect(operations.startAiConversation(startInput())).resolves.toEqual({
    ok: true,
    value: { requestId: REQUEST_ID, modelId: 'deepseek-chat', transcriptRevision: 1 },
  })
  expect(aiConversations.start).toHaveBeenCalledWith(startInput())

  for (const malicious of [
    { ...startInput(), extra: true },
    Object.create(startInput()),
    new Proxy(startInput(), {}),
  ]) {
    await expect(operations.startAiConversation(malicious)).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
  }
  expect(aiConversations.start).toHaveBeenCalledTimes(1)
})

it('rejects hostile nested start records in main without observing proxy traps or getters', async () => {
  const { operations, aiConversations } = aiHarness()
  const base = startInput()
  const hostile = <T extends object>(target: T) => {
    let observations = 0
    return {
      value: new Proxy(target, {
        getPrototypeOf(value) { observations += 1; return Reflect.getPrototypeOf(value) },
        ownKeys(value) { observations += 1; return Reflect.ownKeys(value) },
        getOwnPropertyDescriptor(value, key) {
          observations += 1
          return Reflect.getOwnPropertyDescriptor(value, key)
        },
        get(value, key, receiver) { observations += 1; return Reflect.get(value, key, receiver) },
      }),
      observations: () => observations,
    }
  }
  const top = hostile(base)
  const messages = hostile(base.messages)
  const message = hostile(base.messages[0])
  const capabilities = hostile(base.capabilities)
  for (const [input, observed] of [
    [top.value, top.observations],
    [{ ...base, messages: messages.value }, messages.observations],
    [{ ...base, messages: [message.value] }, message.observations],
    [{ ...base, capabilities: capabilities.value }, capabilities.observations],
  ] as const) {
    await expect(operations.startAiConversation(input)).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
    expect(observed()).toBe(0)
  }
  let getterReads = 0
  const accessorMessage = Object.defineProperty({ id: MESSAGE_ID, role: 'user' }, 'content', {
    enumerable: true,
    get() { getterReads += 1; return 'do not read' },
  })
  await expect(operations.startAiConversation({ ...base, messages: [accessorMessage] } as never))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(getterReads).toBe(0)
  expect(aiConversations.start).not.toHaveBeenCalled()
})

it('binds cancel, capabilities, authorization, clear, and document changes to main authority', async () => {
  const { operations, aiConversations } = aiHarness()
  await operations.startAiConversation(startInput())

  await expect(operations.getAiWorkspaceState()).resolves.toEqual({ ok: true, value: AUTHORITY })
  await expect(operations.setAiConversationCapabilities({
    conversationId: CONVERSATION_ID,
    workspaceId: AUTHORITY.workspaceId,
    workspaceGeneration: AUTHORITY.workspaceGeneration,
    capabilities: { currentDocument: false, workspace: true },
  })).resolves.toEqual({ ok: true, value: null })
  expect(aiConversations.setCapabilities).toHaveBeenCalledWith({
    ownerId: 17,
    conversationId: CONVERSATION_ID,
    workspaceId: AUTHORITY.workspaceId,
    workspaceGeneration: AUTHORITY.workspaceGeneration,
    capabilities: { currentDocument: false, workspace: true },
  })

  const authorization = { requestId: REQUEST_ID, operationId: OPERATION_ID, allowed: true }
  await expect(operations.submitAiAuthorizationResult(authorization)).resolves.toEqual({ ok: true, value: null })
  await expect(operations.submitAiAuthorizationResult(authorization)).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_INPUT' },
  })
  expect(aiConversations.submitAuthorizationResult).toHaveBeenCalledTimes(1)

  await expect(operations.notifyAiCurrentDocumentChanged(AUTHORITY)).resolves.toEqual({ ok: true, value: null })
  expect(aiConversations.notifyCurrentDocumentChanged).toHaveBeenCalledOnce()
  await expect(operations.clearAiConversation({
    conversationId: CONVERSATION_ID,
    workspaceId: AUTHORITY.workspaceId,
    workspaceGeneration: AUTHORITY.workspaceGeneration,
  })).resolves.toEqual({ ok: true, value: null })
  expect(aiConversations.clearConversation).toHaveBeenCalledWith(AUTHORITY.workspaceId, CONVERSATION_ID)

  await expect(operations.cancelAiConversation({ requestId: REQUEST_ID })).resolves.toEqual({ ok: true, value: null })
  await expect(operations.cancelAiConversation({ requestId: '550e8400-e29b-41d4-a716-446655440099' }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
})

it('rejects stale workspace authority before changing conversation state', async () => {
  const { operations, aiConversations, desktopAi } = aiHarness()
  await operations.startAiConversation(startInput())
  desktopAi.getWorkspaceAuthority.mockResolvedValueOnce({
    workspaceId: AUTHORITY.workspaceId,
    workspaceGeneration: 'generation.2',
  })

  await expect(operations.setAiConversationCapabilities({
    conversationId: CONVERSATION_ID,
    workspaceId: AUTHORITY.workspaceId,
    workspaceGeneration: AUTHORITY.workspaceGeneration,
    capabilities: { currentDocument: false, workspace: false },
  })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(aiConversations.setCapabilities).not.toHaveBeenCalled()
})

it('opens only credential-free http(s) AI message links and returns the canonical audit URL', async () => {
  const { operations, openExternal } = aiHarness()
  await expect(operations.openAiMessageLink({ target: 'https://example.com/docs?q=1' }))
    .resolves.toEqual({ ok: true, value: 'https://example.com/docs?q=1' })
  expect(openExternal).toHaveBeenCalledWith('https://example.com/docs?q=1')
  for (const target of [
    'javascript:alert(1)',
    'https://user:secret@example.com/private',
  ]) {
    await expect(operations.openAiMessageLink({ target })).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
  }
  await expect(operations.openAiMessageLink({ target: 'https://example.com', extra: true }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(openExternal).toHaveBeenCalledOnce()
})

it('only reveals local AI message targets without opening or executing them', async () => {
  const insideFile = aiLinkHarness()
  await expect(insideFile.operations.openAiMessageLink({ target: 'notes\\report.pdf' }))
    .resolves.toEqual({ ok: true, value: 'C:\\Workspace\\notes\\report.pdf' })
  expect(insideFile.showItemInFolder).toHaveBeenCalledWith('C:\\Workspace\\notes\\report.pdf')
  expect(insideFile.openDocumentWindow).not.toHaveBeenCalled()

  const outsideExecutable = aiLinkHarness()
  await expect(outsideExecutable.operations.openAiMessageLink({ target: 'C:\\Outside\\malware.exe' }))
    .resolves.toEqual({ ok: true, value: 'C:\\Outside\\malware.exe' })
  expect(outsideExecutable.showItemInFolder).toHaveBeenCalledWith('C:\\Outside\\malware.exe')
  expect(outsideExecutable.openDocumentWindow).not.toHaveBeenCalled()
  expect(outsideExecutable.openExternal).not.toHaveBeenCalled()

  const insideExecutable = aiLinkHarness()
  await expect(insideExecutable.operations.openAiMessageLink({
    target: 'C:\\Workspace\\malware.exe',
  })).resolves.toEqual({ ok: true, value: 'C:\\Workspace\\malware.exe' })
  expect(insideExecutable.showItemInFolder).toHaveBeenCalledWith('C:\\Workspace\\malware.exe')
  expect(insideExecutable.openDocumentWindow).not.toHaveBeenCalled()

  for (const target of ['Folder', 'C:\\Outside\\Folder']) {
    const directory = aiLinkHarness()
    await expect(directory.operations.openAiMessageLink({ target })).resolves.toMatchObject({ ok: true })
    expect(directory.showItemInFolder).toHaveBeenCalledOnce()
    expect(directory.openDocumentWindow).not.toHaveBeenCalled()
  }
})

it('serializes local AI message inspection with the authority operation queue', async () => {
  const barrier = deferred<void>()
  const secondInspection = deferred<void>()
  const harness = aiLinkHarness({
    firstLstatBarrier: barrier.promise,
    onLstatCall(count) { if (count === 2) secondInspection.resolve() },
  })
  const first = harness.operations.openAiMessageLink({ target: 'notes\\first.pdf' })
  await vi.waitFor(() => expect(harness.lstat).toHaveBeenCalledTimes(1))

  const second = harness.operations.openAiMessageLink({ target: 'notes\\second.pdf' })
  const ranConcurrently = await Promise.race([
    secondInspection.promise.then(() => true),
    (async () => {
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
      return false
    })(),
  ])
  expect(ranConcurrently).toBe(false)

  barrier.resolve()
  await expect(Promise.all([first, second])).resolves.toEqual([
    { ok: true, value: 'C:\\Workspace\\notes\\first.pdf' },
    { ok: true, value: 'C:\\Workspace\\notes\\second.pdf' },
  ])
  expect(harness.openDocumentWindow).toHaveBeenCalledTimes(0)
  expect(harness.showItemInFolder).toHaveBeenCalledTimes(2)
})

it('rejects file schemes while canonically auditing a bare absolute path before revealing it', async () => {
  const harness = aiLinkHarness()
  await expect(harness.operations.openAiMessageLink({
    target: 'file:///C:/Workspace/team%20notes.pdf',
  })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(harness.showItemInFolder).not.toHaveBeenCalled()
  expect(harness.openDocumentWindow).not.toHaveBeenCalled()

  const canonical = aiLinkHarness({ canonicalPath: 'C:\\Workspace\\Notes\\Report.pdf' })
  await expect(canonical.operations.openAiMessageLink({ target: 'C:\\Workspace\\notes\\report.pdf' }))
    .resolves.toEqual({ ok: true, value: 'C:\\Workspace\\Notes\\Report.pdf' })
  expect(canonical.showItemInFolder).toHaveBeenCalledWith('C:\\Workspace\\Notes\\Report.pdf')
  expect(canonical.openDocumentWindow).not.toHaveBeenCalled()
})

it('rejects symbolic links and Windows junctions in every local path component', async () => {
  for (const harness of [
    aiLinkHarness({ symlinkPath: 'C:\\Workspace\\linked' }),
    aiLinkHarness({ reparsePath: 'C:\\Workspace\\linked' }),
  ]) {
    await expect(harness.operations.openAiMessageLink({ target: 'linked\\report.pdf' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(harness.openDocumentWindow).not.toHaveBeenCalled()
    expect(harness.showItemInFolder).not.toHaveBeenCalled()
  }
})

it('fails closed for missing, changed, stale-authority, and unsafe local targets', async () => {
  const missing = aiLinkHarness({ missingPath: 'C:\\Workspace\\missing.pdf' })
  await expect(missing.operations.openAiMessageLink({ target: 'missing.pdf' }))
    .resolves.toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } })

  const changed = aiLinkHarness({ mutatePath: 'C:\\Workspace\\changed.pdf' })
  await expect(changed.operations.openAiMessageLink({ target: 'changed.pdf' }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

  const parentChanged = aiLinkHarness({ mutatePath: 'C:\\Workspace\\notes' })
  await expect(parentChanged.operations.openAiMessageLink({ target: 'notes\\report.pdf' }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(parentChanged.showItemInFolder).toHaveBeenCalledTimes(0)
  expect(parentChanged.openDocumentWindow).toHaveBeenCalledTimes(0)

  const stale = aiLinkHarness({ authoritySequence: [
    AUTHORITY,
    { workspaceId: AUTHORITY.workspaceId, workspaceGeneration: 'generation.2' },
  ] })
  await expect(stale.operations.openAiMessageLink({ target: 'notes\\report.pdf' }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(stale.showItemInFolder).toHaveBeenCalledTimes(0)
  expect(stale.openDocumentWindow).not.toHaveBeenCalled()

  const rootRace = aiLinkHarness({ activationRoots: ['C:\\Workspace', 'C:\\Replacement'] })
  await expect(rootRace.operations.openAiMessageLink({ target: 'notes\\report.pdf' }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(rootRace.openDocumentWindow).not.toHaveBeenCalled()

  for (const target of [
    '\\\\server\\share\\report.pdf', 'file://server/share/report.pdf',
    '\\\\?\\C:\\Workspace\\report.pdf', '\\\\.\\C:\\Workspace\\report.pdf',
    '\\??\\C:\\Workspace\\report.pdf', 'C:\\Workspace\\report.pdf:payload.exe',
    'notes\\CON.txt', 'notes\\report.pdf.', 'notes\\bad\0name.pdf',
    'notes\\CLOCK$.txt', 'notes\\NUL .md', 'notes\\CLOCK$ .pdf',
  ]) {
    const harness = aiLinkHarness()
    await expect(harness.operations.openAiMessageLink({ target })).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
    expect(harness.lstat).not.toHaveBeenCalled()
  }
})

function portBridgeHarness(timeoutMs = 15_000) {
  let currentPort: {
    openSnapshot(request: unknown, signal: AbortSignal): Promise<unknown>
    readPage(request: unknown, signal: AbortSignal): Promise<unknown>
    release(request: unknown): void | Promise<void>
  } | undefined
  const send = vi.fn()
  const desktopAi = {
    ownerId: 17,
    getWorkspaceAuthority: vi.fn(async () => AUTHORITY),
    registerCurrentDocumentPort: vi.fn(async (port) => {
      currentPort = port
      return { portGeneration: 3, unregister: vi.fn(async () => undefined) }
    }),
  }
  const window = {
      webContents: {
        id: 17,
        mainFrame: {},
        send,
        isDestroyed: () => false,
      },
      isDestroyed: () => false,
    }
  const bridge = createAiRendererPortBridge({
    window,
    desktopAi,
    timeoutMs,
  } as never)
  return { bridge, desktopAi, send, window, getCurrentPort: () => currentPort! }
}

it('preserves the same current and open handles across close quiescence and waits accepted transport replies', async () => {
  const { bridge, desktopAi, send, getCurrentPort } = portBridgeHarness()
  await bridge.registerCurrentDocumentPort()
  const current = await desktopAi.registerCurrentDocumentPort.mock.results[0]!.value
  const registry = new OpenDocumentRegistry()
  const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
  const target = { windowId: 17, workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration, fileIdentity: '1.a' as CanonicalFileIdentity }
  const { documentHandle } = await bridge.registerOpenDocument(registry, target)
  const lookup = await boundary.lookup(target)
  if (lookup.status !== 'open') throw new Error('expected open editor')
  const pending = boundary.captureReadSnapshot({ target, ...lookup }, new AbortController().signal)
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
  const envelope = send.mock.calls[0]![1]
  let settled = false
  const drain = bridge.quiesceForClose().then(() => { settled = true })
  await expect(bridge.registerCurrentDocumentPort()).rejects.toBeInstanceOf(Error)
  await expect(bridge.registerOpenDocument(registry, { ...target, fileIdentity: '2.a' as CanonicalFileIdentity })).rejects.toBeInstanceOf(Error)
  await expect(getCurrentPort().openSnapshot({}, new AbortController().signal)).rejects.toMatchObject({ name: 'InvalidStateError' })
  expect(settled).toBe(false)
  await bridge.submitOpenDocumentResponse({ transportRequestId: envelope.transportRequestId,
    documentHandle, method: 'captureReadSnapshot', result: { status: 'unavailable' } })
  await expect(pending).resolves.toEqual({ status: 'unavailable' })
  await drain
  expect(current.unregister).not.toHaveBeenCalled()
  expect(await boundary.lookup(target)).toEqual(lookup)
  await bridge.resumeAfterClose()
  const next = boundary.captureReadSnapshot({ target, ...lookup }, new AbortController().signal)
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
  const resumedEnvelope = send.mock.calls[1]![1]
  expect(resumedEnvelope.documentHandle).toBe(documentHandle)
  await bridge.submitOpenDocumentResponse({ transportRequestId: resumedEnvelope.transportRequestId,
    documentHandle, method: 'captureReadSnapshot', result: { status: 'unavailable' } })
  await next
  const snapshot = getCurrentPort().openSnapshot({}, new AbortController().signal)
  const currentEnvelope = send.mock.calls.at(-1)![1]
  await bridge.submitCurrentDocumentResponse({ transportRequestId: currentEnvelope.transportRequestId,
    method: 'openSnapshot', result: { status: 'unavailable' } })
  await snapshot
  expect(desktopAi.registerCurrentDocumentPort).toHaveBeenCalledOnce()
  await bridge.dispose()
  expect(current.unregister).toHaveBeenCalledOnce()
  expect(await boundary.lookup(target)).toEqual({ status: 'closed' })
})

it.each(['frame', 'destroyed', 'workspace', 'destructive-pause'] as const)('fails closed when %s changes during close quiescence', async change => {
  const { bridge, desktopAi, window, getCurrentPort } = portBridgeHarness()
  await bridge.registerCurrentDocumentPort()
  await bridge.quiesceForClose()
  if (change === 'frame') window.webContents.mainFrame = {}
  if (change === 'destroyed') window.isDestroyed = () => true
  if (change === 'workspace') desktopAi.getWorkspaceAuthority.mockResolvedValue({ ...AUTHORITY, workspaceGeneration: 'generation.changed' })
  if (change === 'destructive-pause') await bridge.pauseAndDrain()
  await expect(bridge.resumeAfterClose()).rejects.toBeInstanceOf(Error)
  await expect(getCurrentPort().openSnapshot({}, new AbortController().signal)).rejects.toMatchObject({ name: 'InvalidStateError' })
  await bridge.dispose()
})

it('rechecks original workspace authority after asynchronous owner restoration before reopening transport', async () => {
  const { bridge, desktopAi, getCurrentPort } = portBridgeHarness()
  await bridge.registerCurrentDocumentPort()
  await bridge.quiesceForClose()
  const owner = vi.fn(async () => {
    await expect(getCurrentPort().openSnapshot({}, new AbortController().signal)).rejects.toMatchObject({ name: 'InvalidStateError' })
    desktopAi.getWorkspaceAuthority.mockResolvedValue({ ...AUTHORITY, workspaceGeneration: 'generation.changed' })
  })
  await expect(bridge.resumeAfterClose(owner)).rejects.toBeInstanceOf(Error)
  expect(owner).toHaveBeenCalledOnce()
  await expect(getCurrentPort().openSnapshot({}, new AbortController().signal)).rejects.toMatchObject({ name: 'InvalidStateError' })
  await bridge.dispose()
})

it('revokes a registering port before close quiescence settles and rejects generic resume bypass', async () => {
  const { bridge, desktopAi } = portBridgeHarness()
  const result = deferred<Awaited<ReturnType<typeof desktopAi.registerCurrentDocumentPort>>>()
  const unregister = vi.fn(async () => undefined)
  desktopAi.registerCurrentDocumentPort.mockImplementationOnce(async () => await result.promise)
  const registration = bridge.registerCurrentDocumentPort()
  const rejected = expect(registration).rejects.toBeInstanceOf(Error)
  let settled = false
  const drain = bridge.quiesceForClose().then(() => { settled = true })
  bridge.resume()
  await expect(bridge.registerCurrentDocumentPort()).rejects.toBeInstanceOf(Error)
  expect(settled).toBe(false)
  result.resolve({ portGeneration: 3, unregister })
  await rejected
  await drain
  expect(unregister).toHaveBeenCalledOnce()
  await bridge.resumeAfterClose()
  await expect(bridge.registerCurrentDocumentPort()).resolves.toEqual({ portGeneration: 3 })
  await bridge.dispose()
})

it('does not restore an unacknowledged registering port when its revocation fails', async () => {
  const { bridge, desktopAi } = portBridgeHarness()
  const result = deferred<Awaited<ReturnType<typeof desktopAi.registerCurrentDocumentPort>>>()
  desktopAi.registerCurrentDocumentPort.mockImplementationOnce(async () => await result.promise)
  const registration = bridge.registerCurrentDocumentPort().catch(error => error)
  const quiescence = bridge.quiesceForClose().catch(error => error)
  result.resolve({ portGeneration: 3, unregister: vi.fn(async () => { throw new Error('synthetic revoke failure') }) })
  expect(await registration).toBeInstanceOf(Error)
  expect(await quiescence).toBeInstanceOf(Error)
  await expect(bridge.resumeAfterClose()).rejects.toBeInstanceOf(Error)
  await expect(bridge.dispose()).rejects.toBeInstanceOf(Error)
})

it('settles a late open registration before recovery without publishing its abandoned handle', async () => {
  const { bridge } = portBridgeHarness()
  const registry = new OpenDocumentRegistry()
  const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
  const target = { windowId: 17, workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration, fileIdentity: '1.a' as CanonicalFileIdentity }
  const pending = deferred<void>()
  const register = registry.register.bind(registry)
  const registering = vi.spyOn(registry, 'register').mockImplementationOnce(async (...args) => {
    await pending.promise
    return register(...args)
  })
  const attempt = bridge.registerOpenDocument(registry, target).catch(error => error)
  await vi.waitFor(() => expect(registering).toHaveBeenCalledOnce())
  let settled = false
  const quiescence = bridge.quiesceForClose().then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  pending.resolve()
  expect(await attempt).toBeInstanceOf(Error)
  await quiescence
  expect(await boundary.lookup(target)).toEqual({ status: 'closed' })
  await bridge.resumeAfterClose()
  await bridge.registerOpenDocument(registry, target)
  expect(await boundary.lookup(target)).toMatchObject({ status: 'open' })
  await bridge.dispose()
})

it('attempts every open registration revocation even when current-port disposal fails', async () => {
  const { bridge, desktopAi } = portBridgeHarness()
  const failure = new Error('synthetic current revoke failure')
  desktopAi.registerCurrentDocumentPort.mockResolvedValueOnce({ portGeneration: 3,
    unregister: vi.fn(async () => { throw failure }) })
  await bridge.registerCurrentDocumentPort()
  const registry = new OpenDocumentRegistry()
  const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
  const target = { windowId: 17, workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration, fileIdentity: '1.a' as CanonicalFileIdentity }
  await bridge.registerOpenDocument(registry, target)
  const disposal = bridge.dispose()
  expect(bridge.dispose()).toBe(disposal)
  await expect(disposal).rejects.toBe(failure)
  await expect(bridge.dispose()).rejects.toBe(failure)
  expect(await boundary.lookup(target)).toEqual({ status: 'closed' })
})

it('revokes a replacement current-document registration when the previous port cannot unregister', async () => {
  const previousUnregister = vi.fn(async () => { throw new Error('renderer teardown failed') })
  const replacementUnregister = vi.fn(async () => undefined)
  let registrationCount = 0
  const bridge = createAiRendererPortBridge({
    window: {
      webContents: { id: 17, mainFrame: {}, send: vi.fn(), isDestroyed: () => false },
      isDestroyed: () => false,
    },
    desktopAi: {
      ownerId: 17,
      getWorkspaceAuthority: vi.fn(async () => AUTHORITY),
      registerCurrentDocumentPort: vi.fn(async () => {
        registrationCount += 1
        return registrationCount === 1
          ? { portGeneration: 1, unregister: previousUnregister }
          : { portGeneration: 2, unregister: replacementUnregister }
      }),
    },
  } as never)

  await expect(bridge.registerCurrentDocumentPort()).resolves.toEqual({ portGeneration: 1 })
  await expect(bridge.registerCurrentDocumentPort()).rejects.toBeInstanceOf(PublicError)
  expect(previousUnregister).toHaveBeenCalledOnce()
  expect(replacementUnregister).toHaveBeenCalledOnce()
})

it('routes current-document capture through a main-issued correlation and freezes the reply', async () => {
  const { bridge, send, getCurrentPort } = portBridgeHarness()
  await expect(bridge.registerCurrentDocumentPort()).resolves.toEqual({ portGeneration: 3 })
  const port = getCurrentPort()
  const request = Object.freeze({
    ownerId: 17,
    requestId: REQUEST_ID,
    conversationId: CONVERSATION_ID,
    workspaceId: AUTHORITY.workspaceId,
    workspaceGeneration: AUTHORITY.workspaceGeneration,
    toolCallId: 'call_1',
    brokerRequestId: 'broker.1',
    cursor: 0,
    maxChars: 48_000,
  })
  const pending = port.openSnapshot(request, new AbortController().signal)
  const envelope = send.mock.calls[0]![1] as {
    transportRequestId: string
    method: string
    payload: typeof request
  }
  expect(envelope).toMatchObject({ method: 'openSnapshot', payload: request })
  expect(envelope.transportRequestId).toMatch(/^[0-9a-f-]{36}$/u)

  await expect(bridge.submitCurrentDocumentResponse({
    transportRequestId: envelope.transportRequestId,
    method: 'openSnapshot',
    result: {
      status: 'captured', snapshotId: 'snapshot.1', displayName: 'note.md',
      sourceFormat: 'md', dirty: true, content: '# dirty', nextCursor: null,
      hasMore: false, totalChars: 7,
    },
  })).resolves.toBeUndefined()
  const result = await pending
  expect(result).toEqual({ status: 'captured', ...request, snapshotId: 'snapshot.1', displayName: 'note.md', sourceFormat: 'md', dirty: true, content: '# dirty', nextCursor: null, hasMore: false, totalChars: 7 })
  expect(Object.isFrozen(result)).toBe(true)

  await expect(bridge.submitCurrentDocumentResponse({
    transportRequestId: envelope.transportRequestId,
    method: 'openSnapshot',
    result: { status: 'unavailable' },
  })).rejects.toBeInstanceOf(PublicError)
})

it('rejects current-document waits on abort, timeout, and late responses', async () => {
  vi.useFakeTimers()
  try {
    const { bridge, send, getCurrentPort } = portBridgeHarness(25)
    await bridge.registerCurrentDocumentPort()
    const port = getCurrentPort()
    const request = Object.freeze({
      ownerId: 17, requestId: REQUEST_ID, conversationId: CONVERSATION_ID,
      workspaceId: AUTHORITY.workspaceId, workspaceGeneration: AUTHORITY.workspaceGeneration,
      toolCallId: 'call_1', brokerRequestId: 'broker.1', cursor: 0, maxChars: 48_000,
    })
    const controller = new AbortController()
    const aborted = port.openSnapshot(request, controller.signal)
    const abortedId = (send.mock.calls.at(-1)![1] as { transportRequestId: string }).transportRequestId
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    await expect(bridge.submitCurrentDocumentResponse({
      transportRequestId: abortedId, method: 'openSnapshot', result: { status: 'unavailable' },
    })).rejects.toBeInstanceOf(PublicError)

    const timedOut = port.openSnapshot(request, new AbortController().signal)
    const timedOutExpectation = expect(timedOut).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(25)
    await timedOutExpectation
    expect(bridge.pendingCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('bounds renderer-port backpressure and drains every pending request on dispose', async () => {
  const { bridge, getCurrentPort } = portBridgeHarness()
  await bridge.registerCurrentDocumentPort()
  const port = getCurrentPort()
  const request = Object.freeze({
    ownerId: 17, requestId: REQUEST_ID, conversationId: CONVERSATION_ID,
    workspaceId: AUTHORITY.workspaceId, workspaceGeneration: AUTHORITY.workspaceGeneration,
    toolCallId: 'call_1', brokerRequestId: 'broker.1', cursor: 0, maxChars: 48_000,
  })
  const pending = Array.from({ length: 32 }, () => (
    port.openSnapshot(request, new AbortController().signal)
  ))
  await expect(port.openSnapshot(request, new AbortController().signal))
    .rejects.toMatchObject({ name: 'InvalidStateError' })
  expect(bridge.pendingCount()).toBe(32)
  await bridge.dispose()
  const results = await Promise.allSettled(pending)
  expect(results.every((result) => result.status === 'rejected')).toBe(true)
  expect(bridge.pendingCount()).toBe(0)
})

it('accepts new current and open-document registrations after a completed pause/resume cycle', async () => {
  const { bridge } = portBridgeHarness()
  await bridge.registerCurrentDocumentPort()
  await expect(bridge.pauseAndDrain()).resolves.toBeUndefined()
  bridge.resume()
  await expect(bridge.registerCurrentDocumentPort()).resolves.toEqual({ portGeneration: 3 })

  const target = {
    windowId: 17, workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration, fileIdentity: '1.a' as CanonicalFileIdentity,
  }
  const reservation = {
    target, registrationToken: 'registration-1', registrationRevision: 1,
  }
  const registry = {
    reserve: vi.fn(async () => reservation),
    register: vi.fn(async () => ({
      ...reservation, bindingToken: 'binding-1', bindingRevision: 1,
    })),
    cancelReservation: vi.fn(async () => undefined),
    unregister: vi.fn(async () => undefined),
  }
  await expect(bridge.registerOpenDocument(registry as never, target)).resolves.toMatchObject({
    documentHandle: expect.stringMatching(/^[0-9a-f-]{36}$/u),
  })
})

it('atomically caps completed plus preparing open-document registrations at 32', async () => {
  const authorities = Array.from({ length: 33 }, () => deferred<typeof AUTHORITY | null>())
  let authorityIndex = 0
  const getWorkspaceAuthority = vi.fn(async () => await authorities[authorityIndex++]!.promise)
  const bridge = createAiRendererPortBridge({
    window: {
      webContents: { id: 17, mainFrame: {}, send: vi.fn(), isDestroyed: () => false },
      isDestroyed: () => false,
    },
    desktopAi: {
      ownerId: 17, getWorkspaceAuthority,
      registerCurrentDocumentPort: vi.fn(),
    },
  } as never)
  const registry = new OpenDocumentRegistry()
  const registrations = Array.from({ length: 32 }, (_, index) => bridge.registerOpenDocument(
    registry,
    {
      windowId: 17, workspaceId: AUTHORITY.workspaceId,
      generation: AUTHORITY.workspaceGeneration,
      fileIdentity: `${(index + 1).toString(16)}.a` as CanonicalFileIdentity,
    },
  ))
  await vi.waitFor(() => expect(getWorkspaceAuthority).toHaveBeenCalledTimes(32))
  const overflow = bridge.registerOpenDocument(registry, {
    windowId: 17, workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration,
    fileIdentity: '21.a' as CanonicalFileIdentity,
  })
  await expect(overflow).rejects.toBeInstanceOf(PublicError)
  expect(getWorkspaceAuthority).toHaveBeenCalledTimes(32)

  const failedSlot = expect(registrations[0]).rejects.toBeInstanceOf(PublicError)
  authorities[0]!.resolve(null)
  await failedSlot
  const replacement = bridge.registerOpenDocument(registry, {
    windowId: 17, workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration,
    fileIdentity: '21.a' as CanonicalFileIdentity,
  })
  await vi.waitFor(() => expect(getWorkspaceAuthority).toHaveBeenCalledTimes(33))
  for (let index = 1; index < authorities.length; index += 1) {
    authorities[index]!.resolve(AUTHORITY)
  }
  const settled = await Promise.all([...registrations.slice(1), replacement])
  expect(new Set(settled.map(({ documentHandle }) => documentHandle))).toHaveLength(32)
})

it('revokes current and open-document registrations that arrive after bridge disposal', async () => {
  const currentDeferred = deferred<{
    portGeneration: number
    unregister(): Promise<void>
  }>()
  const currentUnregister = vi.fn(async () => undefined)
  const send = vi.fn()
  const desktopAi = {
    ownerId: 17,
    getWorkspaceAuthority: vi.fn(async () => AUTHORITY),
    registerCurrentDocumentPort: vi.fn(async () => await currentDeferred.promise),
  }
  const bridge = createAiRendererPortBridge({
    window: {
      webContents: { id: 17, mainFrame: {}, send, isDestroyed: () => false },
      isDestroyed: () => false,
    },
    desktopAi,
  } as never)
  const registeringCurrent = bridge.registerCurrentDocumentPort()
  const disposingCurrent = bridge.dispose()
  currentDeferred.resolve({ portGeneration: 1, unregister: currentUnregister })
  await disposingCurrent
  await expect(registeringCurrent).rejects.toBeInstanceOf(PublicError)
  expect(currentUnregister).toHaveBeenCalledOnce()

  const registerDeferred = deferred<{
    target: typeof target
    registrationToken: string
    registrationRevision: number
    bindingToken: string
    bindingRevision: number
  }>()
  const openUnregister = vi.fn(async () => undefined)
  const target = {
    windowId: 17, workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration, fileIdentity: '1.a' as CanonicalFileIdentity,
  }
  const openBridge = createAiRendererPortBridge({
    window: {
      webContents: { id: 17, mainFrame: {}, send, isDestroyed: () => false },
      isDestroyed: () => false,
    },
    desktopAi: {
      ...desktopAi,
      registerCurrentDocumentPort: vi.fn(),
    },
  } as never)
  const reservation = {
    target, registrationToken: 'registration-1', registrationRevision: 1,
  }
  const registry = {
    reserve: vi.fn(async () => reservation),
    register: vi.fn(async () => await registerDeferred.promise),
    cancelReservation: vi.fn(async () => undefined),
    unregister: openUnregister,
  }
  const registeringOpen = openBridge.registerOpenDocument(registry as never, target)
  await vi.waitFor(() => expect(registry.register).toHaveBeenCalled())
  const disposingOpen = openBridge.dispose()
  registerDeferred.resolve({
    ...reservation, bindingToken: 'binding-2', bindingRevision: 2,
  })
  await disposingOpen
  await expect(registeringOpen).rejects.toBeInstanceOf(PublicError)
  expect(openUnregister).toHaveBeenCalledOnce()
})

it('registers an opaque open-editor handle and routes capture without renderer-supplied authority', async () => {
  const { bridge, send } = portBridgeHarness()
  const registry = new OpenDocumentRegistry()
  const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
  const target = {
    windowId: 17,
    workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration,
    fileIdentity: '1.a' as CanonicalFileIdentity,
  }
  const registered = await bridge.registerOpenDocument(registry, target)
  expect(registered.documentHandle).toMatch(/^[0-9a-f-]{36}$/u)
  const lookup = await boundary.lookup(target)
  if (lookup.status !== 'open') throw new Error('expected open editor')
  const pending = boundary.captureReadSnapshot({ target, ...lookup }, new AbortController().signal)
  const contentHash = createHash('sha256').update('# dirty').digest('hex')
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  const envelope = send.mock.calls.at(-1)![1] as {
    transportRequestId: string
    documentHandle: string
    method: string
    payload: Record<string, unknown>
  }
  expect(envelope).toMatchObject({
    documentHandle: registered.documentHandle,
    method: 'captureReadSnapshot',
  })
  await expect(bridge.submitOpenDocumentResponse({
    transportRequestId: envelope.transportRequestId,
    documentHandle: '550e8400-e29b-41d4-a716-446655440099',
    method: 'captureReadSnapshot',
    result: { status: 'unavailable' },
  })).rejects.toBeInstanceOf(PublicError)
  expect(bridge.pendingCount()).toBe(1)
  await bridge.submitOpenDocumentResponse({
    transportRequestId: envelope.transportRequestId,
    documentHandle: registered.documentHandle,
    method: 'captureReadSnapshot',
    result: {
      status: 'captured', editorRevision: 4, contentHash,
      markdown: '# dirty', dirty: true,
    },
  })
  await expect(pending).resolves.toEqual({
    status: 'captured',
    registrationToken: lookup.registrationToken,
    registrationRevision: lookup.registrationRevision,
    bindingToken: lookup.bindingToken,
    bindingRevision: lookup.bindingRevision,
    editorRevision: 4,
    contentHash,
    markdown: '# dirty',
    dirty: true,
  })
  await expect(bridge.submitOpenDocumentResponse({
    transportRequestId: envelope.transportRequestId,
    documentHandle: registered.documentHandle,
    method: 'captureReadSnapshot',
    result: { status: 'unavailable' },
  })).rejects.toBeInstanceOf(PublicError)
  await bridge.unregisterOpenDocument(registered.documentHandle)
  await expect(boundary.lookup(target)).resolves.toEqual({ status: 'closed' })
  await expect(bridge.unregisterOpenDocument(registered.documentHandle)).rejects.toBeInstanceOf(PublicError)
})

it('keeps one renderer port bound while atomically transferring and compensating workspace authority', async () => {
  const { bridge } = portBridgeHarness()
  const registry = new OpenDocumentRegistry()
  const source = {
    windowId: 17,
    workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration,
    fileIdentity: '1.a' as CanonicalFileIdentity,
  }
  const successorAuthority = {
    windowId: 17,
    workspaceId: 'workspace.2',
    generation: 'generation.2',
  }
  const guardedDestination = {
    ...successorAuthority,
    fileIdentity: '2.b' as CanonicalFileIdentity,
  }
  const successor = {
    ...successorAuthority,
    fileIdentity: '3.c' as CanonicalFileIdentity,
  }
  const registered = await bridge.registerOpenDocument(registry, source)

  const transfer = await bridge.beginOpenDocumentTransfer(
    registry,
    source,
    successorAuthority,
  )
  if (!transfer) throw new Error('expected tracked transfer')
  expect(registry.lookupLeased(source)).toEqual({ status: 'transition' })
  await transfer.guardDestination(guardedDestination.fileIdentity)
  expect(registry.lookupLeased(guardedDestination)).toEqual({ status: 'transition' })
  await transfer.handoffDestination(successor.fileIdentity)
  expect(registry.lookupLeased(guardedDestination)).toEqual({ status: 'closed' })
  expect(registry.lookupLeased(successor)).toEqual({ status: 'transition' })
  await transfer.commit(successor.fileIdentity)
  expect(registry.lookupLeased(source)).toEqual({ status: 'closed' })
  expect(registry.lookupLeased(guardedDestination)).toEqual({ status: 'closed' })
  expect(registry.lookupLeased(successor)).toMatchObject({ status: 'open' })

  await transfer.rollback()
  expect(registry.lookupLeased(successor)).toEqual({ status: 'closed' })
  expect(registry.lookupLeased(source)).toMatchObject({ status: 'open' })
  await expect(bridge.unregisterOpenDocument(registered.documentHandle)).resolves.toBeUndefined()
})

it('compensates a failed in-place Save As to the newly restored source identity', async () => {
  const { bridge } = portBridgeHarness()
  const registry = new OpenDocumentRegistry()
  const source = {
    windowId: 17,
    workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration,
    fileIdentity: '1.a' as CanonicalFileIdentity,
  }
  const restored = { ...source, fileIdentity: '3.c' as CanonicalFileIdentity }
  await bridge.registerOpenDocument(registry, source)
  const transfer = await bridge.beginOpenDocumentTransfer(registry, source, source)
  if (!transfer) throw new Error('expected tracked transfer')

  await transfer.rollback(restored.fileIdentity)

  expect(registry.lookupLeased(source)).toEqual({ status: 'closed' })
  expect(registry.lookupLeased(restored)).toMatchObject({ status: 'open' })
})

it('publishes an in-place rollback identity before a second window can reserve it', async () => {
  const { bridge } = portBridgeHarness()
  const registry = new OpenDocumentRegistry()
  const source = {
    windowId: 17,
    workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration,
    fileIdentity: '1.a' as CanonicalFileIdentity,
  }
  const saved = { ...source, fileIdentity: '2.b' as CanonicalFileIdentity }
  const restored = { ...source, fileIdentity: '3.c' as CanonicalFileIdentity }
  await bridge.registerOpenDocument(registry, source)
  const transfer = await bridge.beginOpenDocumentTransfer(registry, source, source)
  if (!transfer) throw new Error('expected tracked transfer')
  await transfer.guardDestination(source.fileIdentity)
  await transfer.handoffDestination(saved.fileIdentity)
  await transfer.commit(saved.fileIdentity)

  const rollback = transfer.rollback(restored.fileIdentity)
  const competingReservation = registry.reserve({ ...restored, windowId: 23 })

  await expect(rollback).resolves.toBeUndefined()
  await expect(competingReservation).rejects.toThrow()
  expect(registry.lookupLeased(restored)).toMatchObject({ status: 'open' })
})

it('routes open-editor plan, apply, and recovery query with only main-issued binding authority', async () => {
  const { bridge, send } = portBridgeHarness()
  const registry = new OpenDocumentRegistry()
  const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
  const target = {
    windowId: 17,
    workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration,
    fileIdentity: '1.a' as CanonicalFileIdentity,
  }
  const registered = await bridge.registerOpenDocument(registry, target)
  const lookup = await boundary.lookup(target)
  if (lookup.status !== 'open') throw new Error('expected open editor')
  const currentHash = createHash('sha256').update('# dirty').digest('hex')
  const replacementMarkdown = '# replacement'
  const replacementHash = createHash('sha256').update(replacementMarkdown).digest('hex')

  const planning = boundary.planReplacement({
    target, ...lookup, operationId: 'operation-1', expectedEditorRevision: 4,
    expectedContentHash: currentHash, replacementMarkdown,
  }, new AbortController().signal)
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  const planEnvelope = send.mock.calls.at(-1)![1] as {
    transportRequestId: string; documentHandle: string; method: string; payload: Record<string, unknown>
  }
  expect(planEnvelope).toEqual({
    transportRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    documentHandle: registered.documentHandle,
    method: 'planReplacement',
    payload: {
      registrationToken: lookup.registrationToken,
      registrationRevision: lookup.registrationRevision,
      bindingToken: lookup.bindingToken,
      bindingRevision: lookup.bindingRevision,
      operationId: 'operation-1', expectedEditorRevision: 4,
      expectedContentHash: currentHash, replacementMarkdown,
    },
  })
  await bridge.submitOpenDocumentResponse({
    transportRequestId: planEnvelope.transportRequestId,
    documentHandle: registered.documentHandle,
    method: 'planReplacement',
    result: { status: 'planned', editorRevision: 4, contentHash: currentHash },
  })
  const plan = await planning
  expect(plan).toEqual({
    ...lookup, status: 'planned', operationId: 'operation-1',
    editorRevision: 4, contentHash: currentHash,
  })
  if (plan.status !== 'planned') throw new Error('expected editor plan')

  const applying = boundary.applyTransaction({ target, plan, replacementMarkdown })
  await vi.waitFor(() => expect(send.mock.calls.at(-1)![1]).toMatchObject({ method: 'applyTransaction' }))
  const applyEnvelope = send.mock.calls.at(-1)![1] as {
    transportRequestId: string; documentHandle: string; method: string; payload: Record<string, unknown>
  }
  await bridge.submitOpenDocumentResponse({
    transportRequestId: applyEnvelope.transportRequestId,
    documentHandle: registered.documentHandle,
    method: 'applyTransaction',
    result: { status: 'applied', editorRevision: 5, contentHash: replacementHash, dirty: true },
  })
  await expect(applying).resolves.toEqual({
    ...lookup, status: 'applied', operationId: 'operation-1',
    editorRevision: 5, contentHash: replacementHash, dirty: true,
  })

  const querying = boundary.queryOutcome({ target, plan, replacementMarkdown })
  await vi.waitFor(() => expect(send.mock.calls.at(-1)![1]).toMatchObject({ method: 'queryOutcome' }))
  const queryEnvelope = send.mock.calls.at(-1)![1] as {
    transportRequestId: string; documentHandle: string; method: string; payload: Record<string, unknown>
  }
  expect(queryEnvelope.payload).toMatchObject({ replacementContentHash: replacementHash })
  await bridge.submitOpenDocumentResponse({
    transportRequestId: queryEnvelope.transportRequestId,
    documentHandle: registered.documentHandle,
    method: 'queryOutcome',
    result: { status: 'applied', editorRevision: 5, contentHash: replacementHash, dirty: true },
  })
  await expect(querying).resolves.toEqual({
    ...lookup, status: 'applied', operationId: 'operation-1',
    editorRevision: 5, contentHash: replacementHash, dirty: true,
  })
})

it('bounds open-editor plan/apply/query waits and rejects late or unregistered replies', async () => {
  vi.useFakeTimers()
  try {
    const { bridge, send } = portBridgeHarness(25)
    const registry = new OpenDocumentRegistry()
    const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
    const target = {
      windowId: 17, workspaceId: AUTHORITY.workspaceId,
      generation: AUTHORITY.workspaceGeneration, fileIdentity: '1.a' as CanonicalFileIdentity,
    }
    const registered = await bridge.registerOpenDocument(registry, target)
    const lookup = await boundary.lookup(target)
    if (lookup.status !== 'open') throw new Error('expected open editor')
    const currentHash = createHash('sha256').update('# dirty').digest('hex')
    const replacementMarkdown = '# replacement'
    const planning = boundary.planReplacement({
      target, ...lookup, operationId: 'operation-1', expectedEditorRevision: 4,
      expectedContentHash: currentHash, replacementMarkdown,
    }, new AbortController().signal)
    await vi.waitFor(() => expect(send.mock.calls.at(-1)![1]).toMatchObject({ method: 'planReplacement' }))
    const planEnvelope = send.mock.calls.at(-1)![1] as { transportRequestId: string }
    await vi.advanceTimersByTimeAsync(25)
    await expect(planning).resolves.toEqual({ status: 'unavailable' })
    await expect(bridge.submitOpenDocumentResponse({
      transportRequestId: planEnvelope.transportRequestId,
      documentHandle: registered.documentHandle,
      method: 'planReplacement',
      result: { status: 'unavailable' },
    })).rejects.toBeInstanceOf(PublicError)

    const plan = Object.freeze({
      ...lookup, status: 'planned' as const, operationId: 'operation-1',
      editorRevision: 4, contentHash: currentHash,
    })
    const applying = boundary.applyTransaction({ target, plan, replacementMarkdown })
    await vi.waitFor(() => expect(send.mock.calls.at(-1)![1]).toMatchObject({ method: 'applyTransaction' }))
    const applyEnvelope = send.mock.calls.at(-1)![1] as { transportRequestId: string }
    const unregistering = bridge.unregisterOpenDocument(registered.documentHandle)
    await expect(applying).resolves.toEqual({ status: 'unknown' })
    await expect(unregistering).resolves.toBeUndefined()
    await expect(bridge.submitOpenDocumentResponse({
      transportRequestId: applyEnvelope.transportRequestId,
      documentHandle: registered.documentHandle,
      method: 'applyTransaction',
      result: { status: 'unknown' },
    })).rejects.toBeInstanceOf(PublicError)

    const recoveryRegistration = await bridge.registerOpenDocument(registry, target)
    const recoveryLookup = await boundary.lookup(target)
    if (recoveryLookup.status !== 'open') throw new Error('expected recovery editor')
    const recoveryPlan = Object.freeze({
      ...recoveryLookup, status: 'planned' as const, operationId: 'operation-2',
      editorRevision: 4, contentHash: currentHash,
    })
    const querying = boundary.queryOutcome({ target, plan: recoveryPlan, replacementMarkdown })
    await vi.waitFor(() => expect(send.mock.calls.at(-1)![1]).toMatchObject({ method: 'queryOutcome' }))
    const queryEnvelope = send.mock.calls.at(-1)![1] as { transportRequestId: string }
    await vi.advanceTimersByTimeAsync(25)
    await expect(querying).resolves.toEqual({ status: 'unavailable' })
    await expect(bridge.submitOpenDocumentResponse({
      transportRequestId: queryEnvelope.transportRequestId,
      documentHandle: recoveryRegistration.documentHandle,
      method: 'queryOutcome',
      result: { status: 'unknown' },
    })).rejects.toBeInstanceOf(PublicError)
  } finally {
    vi.useRealTimers()
  }
})

it('derives open-editor registration authority and file identity entirely in main', async () => {
  const document = Object.freeze({
    relativePath: 'note.md', markdown: '# disk', revision: 'revision.1',
    encoding: 'utf8' as const, newline: 'lf' as const, mtimeMs: 1,
  })
  const registry = new OpenDocumentRegistry()
  const registerOpenDocument = vi.fn(async () => ({
    documentHandle: '550e8400-e29b-41d4-a716-446655440008',
  }))
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(async () => null),
    workspace: {
      resolveExistingDocument: vi.fn(async () => 'C:\\workspace\\note.md'),
    },
    documents: {
      read: vi.fn(async () => document),
      readForMain: vi.fn(async () => ({ document, identity: '1.a' as CanonicalFileIdentity })),
    },
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    desktopAi: { ownerId: 17, getWorkspaceAuthority: vi.fn(async () => AUTHORITY) },
    aiRendererPorts: { registerOpenDocument },
    openDocumentRegistry: registry,
  } as never)
  await expect(operations.readDocument({ relativePath: 'note.md' })).resolves.toEqual({ ok: true, value: document })
  await expect(operations.registerAiOpenDocumentPort()).resolves.toEqual({
    ok: true, value: { documentHandle: '550e8400-e29b-41d4-a716-446655440008' },
  })
  expect(registerOpenDocument).toHaveBeenCalledWith(registry, {
    windowId: 17,
    workspaceId: AUTHORITY.workspaceId,
    generation: AUTHORITY.workspaceGeneration,
    fileIdentity: '1.a',
  })
})

it.each([{}, { expectedDocumentId: CONVERSATION_ID }, { expectedDocumentId: null }, { continuationOfSegmentId: CONVERSATION_ID }, { expectedDocumentId: null, continuationOfSegmentId: CONVERSATION_ID }])('preserves optional start identities through the strict start boundary: %j', async (identity) => {
  const { operations, aiConversations } = aiHarness()
  const input = { ...startInput(), ...identity }
  await expect(operations.startAiConversation(input)).resolves.toMatchObject({ ok: true, value: { transcriptRevision: 1 } })
  expect(aiConversations.start).toHaveBeenCalledWith(input)
})

it('rejects malformed optional document identities and accessor or extra fields before starting', async () => {
  const { operations, aiConversations } = aiHarness()
  const getter = vi.fn(() => CONVERSATION_ID)
  for (const input of [
    { ...startInput(), continuationOfSegmentId: 'not-a-uuid' },
    { ...startInput(), continuationOfSegmentId: null },
    { ...startInput(), continuationOfSegmentId: undefined },
    Object.defineProperty(startInput(), 'continuationOfSegmentId', { enumerable: true, get: getter }),
    { ...startInput(), expectedDocumentId: 'not-a-uuid' },
    { ...startInput(), expectedDocumentId: undefined },
    { ...startInput(), expectedDocumentId: null, extra: true },
    Object.defineProperty(startInput(), 'expectedDocumentId', { enumerable: true, get: getter }),
  ]) {
    await expect(operations.startAiConversation(input as never)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(getter).not.toHaveBeenCalled()
  expect(aiConversations.start).not.toHaveBeenCalled()
})
