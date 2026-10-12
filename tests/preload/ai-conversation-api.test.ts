import { beforeEach, expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import type { AiRendererPortTransport } from '../../src/preload/arkdown-api'
import {
  AI_CONVERSATION_EVENT_CHANNEL,
  IPC_CHANNELS,
  type ArkdownApi,
} from '../../src/shared/contracts'
import type { AiConversationEvent } from '../../src/shared/ai-conversation'

const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440003'
const CONVERSATION_ID = '550e8400-e29b-41d4-a716-446655440001'
const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440002'
const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440004'
const AUTHORITY = { workspaceId: 'workspace.1', workspaceGeneration: 'generation.1' }

it.each(['network', 'service-unavailable', 'cli-authentication', 'cli-unavailable', 'protocol-malformed'] as const)(
  'preserves finite AI start %s detail and replaces all untrusted error prose', async reason => {
    const detail = { version: 1 as const, reason, stage: 'connect' as const, source: 'local' as const }
    const api = createAiApi(async () => ({ ok: false, error: {
      code: 'MODEL_INCOMPATIBLE_RESPONSE', message: 'SECRET C:/private/provider-body', detail,
    } }))
    const response = await api.startAiConversation(startInput())
    expect(response).toEqual({ ok: false, error: { code: 'MODEL_INCOMPATIBLE_RESPONSE',
      message: '大模型服务返回的响应格式不兼容', detail } })
    expect(JSON.stringify(response)).not.toContain('SECRET')
  },
)

it('rejects extra AI start error fields and malformed detail without exposing provider data', async () => {
  for (const error of [
    { code: 'MODEL_TIMEOUT', message: 'SECRET', detail: { version: 1, reason: 'timeout', stage: 'receive', source: 'local', path: 'SECRET' } },
    { code: 'MODEL_TIMEOUT', message: 'SECRET', detail: null },
    { code: 'MODEL_TIMEOUT', message: 'SECRET', providerBody: 'SECRET' },
  ]) {
    const response = await createAiApi(async () => ({ ok: false, error })).startAiConversation(startInput())
    expect(response).toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })
    expect(JSON.stringify(response)).not.toContain('SECRET')
  }
})

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
    electronMocks.listeners.set(channel, listener)
  }),
  removeListener: vi.fn(),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    send: electronMocks.send,
  },
  webUtils: { getPathForFile: vi.fn(() => '') },
}))

beforeEach(() => {
  electronMocks.exposeInMainWorld.mockClear()
  electronMocks.invoke.mockReset()
  electronMocks.on.mockClear()
  electronMocks.removeListener.mockClear()
  electronMocks.send.mockClear()
  electronMocks.listeners.clear()
})

function startInput() {
  return {
    requestId: REQUEST_ID,
    conversationId: CONVERSATION_ID,
    workspaceKey: AUTHORITY.workspaceId,
    acknowledgedTranscriptRevision: 0,
    messages: [{ id: MESSAGE_ID, role: 'user' as const, content: 'Summarize it' }] as [{
      id: string; role: 'user'; content: string
    }],
    capabilities: { currentDocument: true, workspace: false },
    writePolicy: 'ask-every-time' as const,
  }
}

function createAiApi(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  aiEventTransport?: { subscribe(listener: (payload: unknown) => void): () => void },
  aiRendererPortTransport?: AiRendererPortTransport,
) {
  return createArkdownApi(
    invoke,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    aiEventTransport,
    aiRendererPortTransport,
  )
}

it('exposes strict authoritative AI state and conversation commands without the legacy document result API', async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === IPC_CHANNELS.getAiWorkspaceState) return { ok: true, value: AUTHORITY }
    if (channel === IPC_CHANNELS.startAiConversation) {
      return { ok: true, value: { requestId: REQUEST_ID, modelId: 'deepseek-chat', transcriptRevision: 1 } }
    }
    if (channel === IPC_CHANNELS.openAiMessageLink) {
      return { ok: true, value: 'https://example.com/docs' }
    }
    return { ok: true, value: null }
  })
  const api = createAiApi(invoke)

  expect('submitAiDocumentResult' in api).toBe(false)
  expect('submitAiWorkspaceToolResult' in api).toBe(false)
  await expect(api.getAiWorkspaceState()).resolves.toEqual({ ok: true, value: AUTHORITY })
  await expect(api.startAiConversation(startInput())).resolves.toEqual({
    ok: true,
    value: { requestId: REQUEST_ID, modelId: 'deepseek-chat', transcriptRevision: 1 },
  })
  await expect(api.cancelAiConversation({ requestId: REQUEST_ID })).resolves.toEqual({ ok: true, value: null })
  await expect(api.setAiConversationCapabilities({
    ...AUTHORITY,
    conversationId: CONVERSATION_ID,
    capabilities: { currentDocument: false, workspace: true },
  })).resolves.toEqual({ ok: true, value: null })
  await expect(api.submitAiAuthorizationResult({
    requestId: REQUEST_ID, operationId: OPERATION_ID, allowed: false,
  })).resolves.toEqual({ ok: true, value: null })
  await expect(api.clearAiConversation({ ...AUTHORITY, conversationId: CONVERSATION_ID }))
    .resolves.toEqual({ ok: true, value: null })
  await expect(api.notifyAiCurrentDocumentChanged(AUTHORITY)).resolves.toEqual({ ok: true, value: null })
  await expect(api.openAiMessageLink('https://example.com/docs')).resolves.toEqual({
    ok: true, value: 'https://example.com/docs',
  })

  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.getAiWorkspaceState],
    [IPC_CHANNELS.startAiConversation, startInput()],
    [IPC_CHANNELS.cancelAiConversation, { requestId: REQUEST_ID }],
    [IPC_CHANNELS.setAiConversationCapabilities, {
      ...AUTHORITY, conversationId: CONVERSATION_ID,
      capabilities: { currentDocument: false, workspace: true },
    }],
    [IPC_CHANNELS.submitAiAuthorizationResult, {
      requestId: REQUEST_ID, operationId: OPERATION_ID, allowed: false,
    }],
    [IPC_CHANNELS.clearAiConversation, { ...AUTHORITY, conversationId: CONVERSATION_ID }],
    [IPC_CHANNELS.notifyAiCurrentDocumentChanged, AUTHORITY],
    [IPC_CHANNELS.openAiMessageLink, { target: 'https://example.com/docs' }],
  ])
})

it('rejects extra keys, accessors, uninspectable records, stale start replies, and malformed workspace state locally', async () => {
  const invoke = vi.fn(async () => ({ ok: true, value: null }))
  const api = createAiApi(invoke)
  const accessor = Object.defineProperty({}, 'requestId', { enumerable: true, get: () => REQUEST_ID })

  await expect(api.cancelAiConversation({ requestId: REQUEST_ID, extra: true } as never))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(api.cancelAiConversation(accessor as never))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  const uninspectable = Proxy.revocable(AUTHORITY, {})
  uninspectable.revoke()
  await expect(api.notifyAiCurrentDocumentChanged(uninspectable.proxy as never))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(invoke).not.toHaveBeenCalled()
  await expect(api.openAiMessageLink('javascript:alert(1)')).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_INPUT' },
  })

  const stale = createAiApi(vi.fn(async () => ({
    ok: true,
    value: { requestId: '550e8400-e29b-41d4-a716-446655440099', modelId: 'deepseek-chat', transcriptRevision: 1 },
  })))
  await expect(stale.startAiConversation(startInput())).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_RESPONSE' },
  })

  const malformedState = createAiApi(vi.fn(async () => ({
    ok: true, value: { ...AUTHORITY, apiKey: 'leak' },
  })))
  await expect(malformedState.getAiWorkspaceState()).resolves.toMatchObject({
    ok: false, error: { code: 'INVALID_RESPONSE' },
  })
})

it('normalizes local AI message links and accepts only a strict canonical audit target reply', async () => {
  const invoke = vi.fn(async (_channel: string, input: unknown) => ({
    ok: true,
    value: (input as { target: string }).target.startsWith('notes')
      ? 'C:\\Workspace\\notes\\report.pdf'
      : 'C:\\Workspace\\team notes.pdf',
  }))
  const api = createAiApi(invoke)

  await expect(api.openAiMessageLink('notes/report.pdf')).resolves.toEqual({
    ok: true, value: 'C:\\Workspace\\notes\\report.pdf',
  })
  await expect(api.openAiMessageLink('C:\\Workspace\\team notes.pdf')).resolves.toEqual({
    ok: true, value: 'C:\\Workspace\\team notes.pdf',
  })
  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.openAiMessageLink, { target: 'notes\\report.pdf' }],
    [IPC_CHANNELS.openAiMessageLink, { target: 'C:\\Workspace\\team notes.pdf' }],
  ])

  invoke.mockClear()
  for (const target of [
    'notes/CLOCK$.txt',
    'notes/NUL .md',
    'file:///C:/Workspace/team%20notes.pdf',
    'file:///C:/Workspace/CLOCK$%20.pdf',
  ]) {
    await expect(api.openAiMessageLink(target)).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
  }
  expect(invoke).not.toHaveBeenCalled()

  for (const value of [42, { path: 'C:\\Workspace\\secret.pdf' }, '\\\\server\\share\\secret.pdf']) {
    const malformed = createAiApi(vi.fn(async () => ({ ok: true, value })))
    await expect(malformed.openAiMessageLink('notes/report.pdf')).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_RESPONSE' },
    })
  }
})

it('rejects own accessors at every nested start boundary without invoking their getters', async () => {
  const invoke = vi.fn(async () => ({ ok: true, value: null }))
  const api = createAiApi(invoke)
  const base = startInput()
  // Electron 43 contextBridge rejects Proxy arguments before invoking preload.
  // Renderer getters run during bridge copying; preload receives data properties.
  // Direct parser tests therefore verify local own-accessor rejection, while main
  // retains its native zero-trap Proxy rejection regression.
  let getterReads = 0
  const accessor = <T extends object>(target: T, key: PropertyKey, result: unknown): T => (
    Object.defineProperty(target, key, {
      enumerable: true, configurable: true,
      get() { getterReads += 1; return result },
    })
  )
  for (const input of [
    accessor({ ...base }, 'requestId', REQUEST_ID),
    { ...base, messages: accessor([...base.messages], '0', base.messages[0]) },
    { ...base, messages: [accessor({ ...base.messages[0] }, 'content', 'do not read')] },
    { ...base, capabilities: accessor({ ...base.capabilities }, 'currentDocument', false) },
  ]) {
    await expect(api.startAiConversation(input as never)).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
    expect(getterReads).toBe(0)
  }
  expect(invoke).not.toHaveBeenCalled()
})

it('attaches one current-document port, rolls it back on registration failure, and detaches on unregister', async () => {
  const detach = vi.fn()
  const rollback = vi.fn()
  const commit = vi.fn()
  const transport = {
    attachCurrentDocumentPort: vi.fn(() => ({ commit, rollback, detach })),
    attachOpenDocumentPort: vi.fn(() => ({ bind: vi.fn(), detach: vi.fn() })),
  }
  const port = {
    openSnapshot: vi.fn(async () => ({ status: 'unavailable' as const })),
    readPage: vi.fn(async () => ({ status: 'unavailable' as const })),
    release: vi.fn(),
  }
  const failed = createAiApi(
    vi.fn(async () => ({ ok: false, error: { code: 'OPERATION_FAILED', message: '操作未能完成' } })),
    undefined,
    transport,
  )
  await expect(failed.registerAiCurrentDocumentPort(port)).resolves.toMatchObject({ ok: false })
  expect(rollback).toHaveBeenCalledOnce()
  expect(detach).not.toHaveBeenCalled()

  rollback.mockClear()
  const invoke = vi.fn(async (channel: string) => channel === IPC_CHANNELS.registerAiCurrentDocumentPort
    ? { ok: true, value: { portGeneration: 2 } }
    : { ok: true, value: null })
  const api = createAiApi(invoke, undefined, transport)
  await expect(api.registerAiCurrentDocumentPort(port)).resolves.toEqual({
    ok: true, value: { portGeneration: 2 },
  })
  expect(commit).toHaveBeenCalledOnce()
  expect(detach).not.toHaveBeenCalled()
  await expect(api.unregisterAiCurrentDocumentPort()).resolves.toEqual({ ok: true, value: null })
  expect(detach).toHaveBeenCalledOnce()
})

it('rejects overlapping current-document port transitions until main resolves the active transition', async () => {
  let resolveRegistration: ((value: unknown) => void) | undefined
  const registration = new Promise<unknown>((resolve) => { resolveRegistration = resolve })
  const invoke = vi.fn(async (channel: string) => {
    if (channel === IPC_CHANNELS.registerAiCurrentDocumentPort) return registration
    return { ok: true, value: null }
  })
  const detach = vi.fn()
  const rollback = vi.fn()
  const commit = vi.fn()
  const transport = {
    attachCurrentDocumentPort: vi.fn(() => ({ commit, rollback, detach })),
    attachOpenDocumentPort: vi.fn(() => ({ bind: vi.fn(), detach: vi.fn() })),
  }
  const port = {
    openSnapshot: vi.fn(async () => ({ status: 'unavailable' as const })),
    readPage: vi.fn(async () => ({ status: 'unavailable' as const })),
    release: vi.fn(),
  }
  const api = createAiApi(invoke, undefined, transport)

  const first = api.registerAiCurrentDocumentPort(port)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.registerAiCurrentDocumentPort))
  await expect(api.registerAiCurrentDocumentPort(port)).resolves.toMatchObject({
    ok: false, error: { code: 'OPERATION_FAILED' },
  })
  await expect(api.unregisterAiCurrentDocumentPort()).resolves.toMatchObject({
    ok: false, error: { code: 'OPERATION_FAILED' },
  })
  expect(transport.attachCurrentDocumentPort).toHaveBeenCalledOnce()
  expect(invoke).not.toHaveBeenCalledWith(IPC_CHANNELS.unregisterAiCurrentDocumentPort)

  resolveRegistration?.({ ok: true, value: { portGeneration: 1 } })
  await expect(first).resolves.toEqual({ ok: true, value: { portGeneration: 1 } })
  await expect(api.unregisterAiCurrentDocumentPort()).resolves.toEqual({ ok: true, value: null })
  expect(commit).toHaveBeenCalledOnce()
  expect(detach).toHaveBeenCalledOnce()
})

it('parses the authoritative event union and honors transport unsubscription', () => {
  let emit: ((payload: unknown) => void) | undefined
  const detach = vi.fn()
  const api = createAiApi(vi.fn(), {
    subscribe(listener) {
      emit = listener
      return detach
    },
  })
  const listener = vi.fn()
  const unsubscribe = api.onAiConversationEvent(listener)
  const event: AiConversationEvent = {
    requestId: REQUEST_ID,
    type: 'usage',
    usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: null, estimated: false },
  }
  emit?.(event)
  emit?.({ ...event, usage: { ...event.usage, totalTokens: 99 } })
  expect(listener).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledWith(event)
  unsubscribe()
  expect(detach).toHaveBeenCalledOnce()
})

it('keeps a real buffered AI request active until its actual terminal event', async () => {
  vi.resetModules()
  await import('../../src/preload/index')
  const api = electronMocks.exposeInMainWorld.mock.calls[0]![1] as ArkdownApi
  const listener = vi.fn()
  const unsubscribe = api.onAiConversationEvent(listener)
  const emit = electronMocks.listeners.get(AI_CONVERSATION_EVENT_CHANNEL)
  const events: AiConversationEvent[] = [
    { requestId: REQUEST_ID, type: 'started', transcriptRevision: 0 },
    { requestId: REQUEST_ID, type: 'user-message-accepted', messageId: MESSAGE_ID, transcriptRevision: 1 },
    { requestId: REQUEST_ID, type: 'message-start', messageId: OPERATION_ID, previousTranscriptRevision: 1 },
    { requestId: REQUEST_ID, type: 'delta', messageId: OPERATION_ID, delta: 'hello' },
    {
      requestId: REQUEST_ID, type: 'authorization-requested', toolCallId: 'call_1',
      toolName: 'edit_workspace_document', operationId: OPERATION_ID,
      scope: 'action', paths: ['note.md'],
    },
    {
      requestId: REQUEST_ID, type: 'usage',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: null, estimated: false },
    },
    { requestId: REQUEST_ID, type: 'message-completed', messageId: OPERATION_ID, transcriptRevision: 2 },
    { requestId: REQUEST_ID, type: 'completed' },
  ]
  for (const event of events) emit?.({}, event)
  expect(listener.mock.calls.map(([event]) => event)).toEqual(events)
  unsubscribe()
  emit?.({}, { requestId: REQUEST_ID, type: 'failed', code: 'OPERATION_FAILED', message: 'late' })
  expect(listener).toHaveBeenCalledTimes(events.length)
})

it('dispatches main-issued current-document requests without letting renderer callbacks report authority', async () => {
  vi.resetModules()
  electronMocks.invoke.mockImplementation(async (channel: string) => {
    if (channel === IPC_CHANNELS.registerAiCurrentDocumentPort) {
      return { ok: true, value: { portGeneration: 1 } }
    }
    return { ok: true, value: null }
  })
  await import('../../src/preload/index')
  const api = electronMocks.exposeInMainWorld.mock.calls[0]![1] as ArkdownApi
  const openSnapshot = vi.fn(async (_input: unknown) => ({
    status: 'captured' as const,
    snapshotId: 'snapshot.1',
    displayName: 'note.md',
    sourceFormat: 'md',
    dirty: true,
    content: '# dirty',
    nextCursor: null,
    hasMore: false,
    totalChars: 7,
  }))
  await api.registerAiCurrentDocumentPort({
    openSnapshot,
    readPage: vi.fn(async () => ({ status: 'unavailable' as const })),
    release: vi.fn(),
  })
  const requestListener = electronMocks.listeners.get(IPC_CHANNELS.aiRendererPortRequest)
  expect(requestListener).toEqual(expect.any(Function))
  const payload = {
    ownerId: 17,
    requestId: REQUEST_ID,
    conversationId: CONVERSATION_ID,
    workspaceId: AUTHORITY.workspaceId,
    workspaceGeneration: AUTHORITY.workspaceGeneration,
    toolCallId: 'call_1',
    brokerRequestId: 'broker.1',
    expectedDocumentId: CONVERSATION_ID,
    cursor: 0,
    maxChars: 48_000,
  }
  requestListener?.({}, {
    transportRequestId: OPERATION_ID,
    method: 'openSnapshot',
    payload,
  })
  await vi.waitFor(() => expect(openSnapshot).toHaveBeenCalledWith(Object.freeze({
    cursor: 0, maxChars: 48_000, expectedDocumentId: CONVERSATION_ID,
  })))
  await vi.waitFor(() => expect(electronMocks.invoke).toHaveBeenCalledWith(
    IPC_CHANNELS.submitAiCurrentDocumentPortResponse,
    {
      transportRequestId: OPERATION_ID,
      method: 'openSnapshot',
      result: {
        status: 'captured', snapshotId: 'snapshot.1', displayName: 'note.md',
        sourceFormat: 'md', dirty: true, content: '# dirty', nextCursor: null,
        hasMore: false, totalChars: 7,
      },
    },
  ))
  expect(openSnapshot.mock.calls[0]![0]).not.toHaveProperty('ownerId')
  expect(openSnapshot.mock.calls[0]![0]).not.toHaveProperty('workspaceId')

  requestListener?.({}, { transportRequestId: OPERATION_ID, method: 'openSnapshot', payload: { ...payload, path: 'C:\\secret' } })
  expect(openSnapshot).toHaveBeenCalledOnce()
})

it('restores the previous current-document port when a replacement registration fails', async () => {
  vi.resetModules()
  let registrations = 0
  electronMocks.invoke.mockImplementation(async (channel: string) => {
    if (channel === IPC_CHANNELS.registerAiCurrentDocumentPort) {
      registrations += 1
      return registrations === 1
        ? { ok: true, value: { portGeneration: 1 } }
        : { ok: false, error: { code: 'OPERATION_FAILED', message: '操作未能完成' } }
    }
    return { ok: true, value: null }
  })
  await import('../../src/preload/index')
  const api = electronMocks.exposeInMainWorld.mock.calls[0]![1] as ArkdownApi
  const oldOpen = vi.fn(async () => ({ status: 'unavailable' as const }))
  const newOpen = vi.fn(async () => ({ status: 'unavailable' as const }))
  const port = (openSnapshot: typeof oldOpen) => ({
    openSnapshot,
    readPage: vi.fn(async () => ({ status: 'unavailable' as const })),
    release: vi.fn(),
  })
  await expect(api.registerAiCurrentDocumentPort(port(oldOpen))).resolves.toMatchObject({ ok: true })
  await expect(api.registerAiCurrentDocumentPort(port(newOpen))).resolves.toMatchObject({ ok: false })
  const listener = electronMocks.listeners.get(IPC_CHANNELS.aiRendererPortRequest)
  listener?.({}, {
    transportRequestId: '550e8400-e29b-41d4-a716-446655440009',
    method: 'openSnapshot',
    payload: {
      ownerId: 17, requestId: REQUEST_ID, conversationId: CONVERSATION_ID,
      workspaceId: AUTHORITY.workspaceId, workspaceGeneration: AUTHORITY.workspaceGeneration,
      toolCallId: 'call_1', brokerRequestId: 'broker.1', cursor: 0, maxChars: 48_000,
    },
  })
  await vi.waitFor(() => expect(oldOpen).toHaveBeenCalledOnce())
  expect(newOpen).not.toHaveBeenCalled()
})

it('binds an open-editor port to a main-issued handle and strips registry authority from callbacks', async () => {
  vi.resetModules()
  const documentHandle = '550e8400-e29b-41d4-a716-446655440008'
  electronMocks.invoke.mockImplementation(async (channel: string) => {
    if (channel === IPC_CHANNELS.registerAiOpenDocumentPort) {
      return { ok: true, value: { documentHandle } }
    }
    return { ok: true, value: null }
  })
  await import('../../src/preload/index')
  const api = electronMocks.exposeInMainWorld.mock.calls[0]![1] as ArkdownApi
  const captureReadSnapshot = vi.fn(async (_input: unknown) => ({
    status: 'captured' as const,
    editorRevision: 4,
    contentHash: 'a'.repeat(64),
    markdown: '# dirty',
    dirty: true,
  }))
  const planReplacement = vi.fn(async (_input: unknown) => ({
    status: 'planned' as const, editorRevision: 4, contentHash: 'a'.repeat(64),
  }))
  const applyTransaction = vi.fn(async (_input: unknown) => ({
    status: 'applied' as const, editorRevision: 5, contentHash: 'b'.repeat(64), dirty: true,
  }))
  const queryOutcome = vi.fn(async (_input: unknown) => ({ status: 'not-applied' as const }))
  await expect(api.registerAiOpenDocumentPort({
    captureReadSnapshot,
    planReplacement,
    applyTransaction,
    queryOutcome,
  })).resolves.toEqual({ ok: true, value: { documentHandle } })

  const listener = electronMocks.listeners.get(IPC_CHANNELS.aiRendererPortRequest)
  listener?.({}, {
    transportRequestId: OPERATION_ID,
    documentHandle,
    method: 'captureReadSnapshot',
    payload: {
      registrationToken: 'registration-1', registrationRevision: 1,
      bindingToken: 'binding-2', bindingRevision: 2,
    },
  })
  await vi.waitFor(() => expect(captureReadSnapshot).toHaveBeenCalledWith(Object.freeze({})))
  await vi.waitFor(() => expect(electronMocks.invoke).toHaveBeenCalledWith(
    IPC_CHANNELS.submitAiOpenDocumentPortResponse,
    {
      transportRequestId: OPERATION_ID,
      documentHandle,
      method: 'captureReadSnapshot',
      result: {
        status: 'captured', editorRevision: 4, contentHash: 'a'.repeat(64),
        markdown: '# dirty', dirty: true,
      },
    },
  ))
  expect(captureReadSnapshot.mock.calls[0]![0]).not.toHaveProperty('bindingToken')
  listener?.({}, {
    transportRequestId: OPERATION_ID,
    documentHandle,
    method: 'captureReadSnapshot',
    payload: {
      registrationToken: 'registration-1', registrationRevision: 1,
      bindingToken: 'binding-2', bindingRevision: 2,
    },
  })
  listener?.({}, {
    transportRequestId: '550e8400-e29b-41d4-a716-446655440009',
    documentHandle,
    method: 'captureReadSnapshot',
    payload: {
      registrationToken: 'registration-1', registrationRevision: 1,
      bindingToken: 'binding-2', bindingRevision: 2, path: 'C:\\secret',
    },
  })
  expect(captureReadSnapshot).toHaveBeenCalledOnce()

  const binding = {
    registrationToken: 'registration-1', registrationRevision: 1,
    bindingToken: 'binding-2', bindingRevision: 2,
  }
  const editInput = {
    operationId: 'operation-1', expectedEditorRevision: 4,
    expectedContentHash: 'a'.repeat(64), replacementMarkdown: '# replacement',
  }
  listener?.({}, {
    transportRequestId: '550e8400-e29b-41d4-a716-446655440010',
    documentHandle,
    method: 'planReplacement',
    payload: { ...binding, ...editInput },
  })
  await vi.waitFor(() => expect(planReplacement).toHaveBeenCalledWith(Object.freeze(editInput)))
  await vi.waitFor(() => expect(electronMocks.invoke).toHaveBeenCalledWith(
    IPC_CHANNELS.submitAiOpenDocumentPortResponse,
    {
      transportRequestId: '550e8400-e29b-41d4-a716-446655440010', documentHandle,
      method: 'planReplacement',
      result: { status: 'planned', editorRevision: 4, contentHash: 'a'.repeat(64) },
    },
  ))
  expect(planReplacement.mock.calls[0]![0]).not.toHaveProperty('bindingToken')

  listener?.({}, {
    transportRequestId: '550e8400-e29b-41d4-a716-446655440011',
    documentHandle,
    method: 'applyTransaction',
    payload: { ...binding, ...editInput },
  })
  await vi.waitFor(() => expect(applyTransaction).toHaveBeenCalledWith(Object.freeze(editInput)))
  await vi.waitFor(() => expect(electronMocks.invoke).toHaveBeenCalledWith(
    IPC_CHANNELS.submitAiOpenDocumentPortResponse,
    {
      transportRequestId: '550e8400-e29b-41d4-a716-446655440011', documentHandle,
      method: 'applyTransaction',
      result: { status: 'applied', editorRevision: 5, contentHash: 'b'.repeat(64), dirty: true },
    },
  ))

  const queryInput = {
    operationId: 'operation-1', expectedEditorRevision: 4,
    expectedContentHash: 'a'.repeat(64), replacementContentHash: 'b'.repeat(64),
  }
  listener?.({}, {
    transportRequestId: '550e8400-e29b-41d4-a716-446655440012',
    documentHandle,
    method: 'queryOutcome',
    payload: { ...binding, ...queryInput },
  })
  await vi.waitFor(() => expect(queryOutcome).toHaveBeenCalledWith(Object.freeze(queryInput)))
  await vi.waitFor(() => expect(electronMocks.invoke).toHaveBeenCalledWith(
    IPC_CHANNELS.submitAiOpenDocumentPortResponse,
    {
      transportRequestId: '550e8400-e29b-41d4-a716-446655440012', documentHandle,
      method: 'queryOutcome', result: { status: 'not-applied' },
    },
  ))
  await expect(api.unregisterAiOpenDocumentPort(documentHandle)).resolves.toEqual({ ok: true, value: null })
})

it('bounds open-editor callback waits, ignores late completion, and fails closed after unregister', async () => {
  vi.useFakeTimers()
  try {
    vi.resetModules()
    const documentHandle = '550e8400-e29b-41d4-a716-446655440008'
    electronMocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.registerAiOpenDocumentPort) {
        return { ok: true, value: { documentHandle } }
      }
      return { ok: true, value: null }
    })
    let resolvePlan: ((value: {
      status: 'planned'; editorRevision: number; contentHash: string
    }) => void) | undefined
    const planResponse = new Promise<{
      status: 'planned'; editorRevision: number; contentHash: string
    }>((resolve) => { resolvePlan = resolve })
    const planReplacement = vi.fn(() => planResponse)
    const queryOutcome = vi.fn(async () => ({ status: 'not-applied' as const }))
    await import('../../src/preload/index')
    const api = electronMocks.exposeInMainWorld.mock.calls[0]![1] as ArkdownApi
    await api.registerAiOpenDocumentPort({
      captureReadSnapshot: vi.fn(async () => ({ status: 'unavailable' as const })),
      planReplacement,
      applyTransaction: vi.fn(async () => ({ status: 'unknown' as const })),
      queryOutcome,
    })
    const listener = electronMocks.listeners.get(IPC_CHANNELS.aiRendererPortRequest)
    const binding = {
      registrationToken: 'registration-1', registrationRevision: 1,
      bindingToken: 'binding-2', bindingRevision: 2,
    }
    const editInput = {
      operationId: 'operation-1', expectedEditorRevision: 4,
      expectedContentHash: 'a'.repeat(64), replacementMarkdown: '# replacement',
    }
    const timedOutId = '550e8400-e29b-41d4-a716-446655440010'
    listener?.({}, {
      transportRequestId: timedOutId, documentHandle, method: 'planReplacement',
      payload: { ...binding, ...editInput },
    })
    await vi.waitFor(() => expect(planReplacement).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.waitFor(() => expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.submitAiOpenDocumentPortResponse,
      { transportRequestId: timedOutId, documentHandle, method: 'planReplacement', result: { status: 'unavailable' } },
    ))
    resolvePlan?.({ status: 'planned', editorRevision: 4, contentHash: 'a'.repeat(64) })
    await Promise.resolve()
    expect(electronMocks.invoke.mock.calls.filter(([, input]) => (
      (input as { transportRequestId?: string })?.transportRequestId === timedOutId
    ))).toHaveLength(1)

    await api.unregisterAiOpenDocumentPort(documentHandle)
    const afterUnregisterId = '550e8400-e29b-41d4-a716-446655440011'
    listener?.({}, {
      transportRequestId: afterUnregisterId, documentHandle, method: 'queryOutcome',
      payload: {
        ...binding, operationId: 'operation-1', expectedEditorRevision: 4,
        expectedContentHash: 'a'.repeat(64), replacementContentHash: 'b'.repeat(64),
      },
    })
    await vi.waitFor(() => expect(electronMocks.invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.submitAiOpenDocumentPortResponse,
      { transportRequestId: afterUnregisterId, documentHandle, method: 'queryOutcome', result: { status: 'unknown' } },
    ))
    expect(queryOutcome).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it.each([{}, { expectedDocumentId: CONVERSATION_ID }, { expectedDocumentId: null }, { continuationOfSegmentId: CONVERSATION_ID }, { expectedDocumentId: null, continuationOfSegmentId: CONVERSATION_ID }])('preserves optional start identities through the strict start boundary: %j', async (identity) => {
  const invoke = vi.fn(async () => ({ ok: true, value: { requestId: REQUEST_ID, modelId: 'deepseek-chat', transcriptRevision: 1 } }))
  const api = createAiApi(invoke)
  const input = { ...startInput(), ...identity }
  await expect(api.startAiConversation(input)).resolves.toMatchObject({ ok: true, value: { transcriptRevision: 1 } })
  expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.startAiConversation, input)
})

it('rejects malformed optional document identities and accessor or extra fields before starting', async () => {
  const invoke = vi.fn()
  const api = createAiApi(invoke)
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
    await expect(api.startAiConversation(input as never)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(getter).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
})
