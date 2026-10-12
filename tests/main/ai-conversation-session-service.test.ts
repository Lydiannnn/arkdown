import { describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { parseAiConversationEvent, parseWorkspaceToolResult } from '../../src/shared/ai-conversation'
import { PUBLIC_ERROR_MESSAGES } from '../../src/shared/public-errors'
import { useAiConversation } from '../../src/renderer/editor/use-ai-conversation'
import { AiConversationSidebar } from '../../src/renderer/editor/AiConversationSidebar'
import type { AppSettings } from '../../src/main/settings/settings-store'
import type {
  AiConversationModelSelectionSnapshot,
  SettingsUpdater,
} from '../../src/main/settings/settings-coordinator'
import type {
  AiConversationEvent, AiCurrentDocumentToolArguments, AiCurrentDocumentToolResult,
  AiFileVersion, AiMutationToolName, AiOperationManifest, StartAiConversationInput,
} from '../../src/shared/ai-conversation'
import type { AiWritePolicy, LargeModelSettings, ModelConnectionSummary } from '../../src/shared/large-model-settings'
import type { ModelChatInput, ModelChatResult, ModelProtocolClient, ModelProviderReplay } from '../../src/main/models/model-protocol-client'
import { createModelProtocolClient } from '../../src/main/models/model-protocol-client'
import {
  AI_WORKSPACE_WRITE_AUTHORIZATION_PROMPT, AiConversationRequestRegistry,
  AiConversationSessionService,
  type AiConversationEventSink, type AiCurrentDocumentSnapshot,
  type WorkspaceAiFileBoundary,
} from '../../src/main/models/ai-conversation-session-service'
import { ModelProtocolError } from '../../src/main/models/model-errors'
import { AiOperationOutcomeUnknownError } from '../../src/main/workspace/ai-operation-journal'
import { WorkspaceAiFileError } from '../../src/main/workspace/workspace-ai-file-service'
import { estimateWireTokens, estimateTextTokens } from '../../src/main/models/ai-context-budget'

const CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440000'
const CONVERSATION_ID = '550e8400-e29b-41d4-a716-446655440001'
const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440002'
const SECOND_MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440003'
const THIRD_MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440006'
const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440004'
const SECOND_REQUEST_ID = '550e8400-e29b-41d4-a716-446655440005'
const THIRD_REQUEST_ID = '550e8400-e29b-41d4-a716-446655440007'
const OPERATION_IDS = [
  '650e8400-e29b-41d4-a716-446655440001', '650e8400-e29b-41d4-a716-446655440002',
  '650e8400-e29b-41d4-a716-446655440003', '650e8400-e29b-41d4-a716-446655440004',
] as const
const VERSION_A: AiFileVersion = { fileId: 'file-a', revision: 'rev-a', size: 4, mtimeMs: 1 }
const VERSION_B: AiFileVersion = { fileId: 'file-b', revision: 'rev-b', size: 4, mtimeMs: 1 }

function result(overrides: Partial<ModelChatResult> = {}): ModelChatResult {
  return { toolCalls: [], reasoningContent: '', providerReplay: null, usage: null, ...overrides }
}

function providerReplay(protocol: 'anthropic' | 'openai-responses'): ModelProviderReplay {
  return protocol === 'anthropic'
    ? { protocol, blocks: [{ type: 'thinking', thinking: 'hidden', signature: 'signed' }] }
    : { protocol, modelId: 'gpt-6-astra', outputItems: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted-private-replay' }] }
}

function connection(overrides: Partial<ModelConnectionSummary> = {}): ModelConnectionSummary {
  return {
    id: CONNECTION_ID, name: 'DeepSeek V4 Pro', provider: 'deepseek', accessType: 'standard-api',
    protocol: 'openai', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-v4-pro',
    apiKeyHint: '••••test', status: 'connected', lastTestedAt: '2026-08-31T00:00:00.000Z',
    capabilityOverride: null, ...overrides,
  }
}

function modelSettings(selected: ModelConnectionSummary | null = connection()): LargeModelSettings {
  return {
    version: 6, codexCli: null, connections: selected ? [selected] : [],
    selectionTranslation: { connectionId: null, thinkingMode: 'default' as const, reasoningEffort: 'default', targetLanguage: 'auto', privacyNoticeAccepted: false },
    screenshotTranslation: { connectionId: null, thinkingMode: 'default' as const, reasoningEffort: 'default', targetLanguage: 'auto' },
    aiConversation: { connectionId: selected?.id ?? null, thinkingMode: 'default' as const, reasoningEffort: 'default', writePolicy: 'ask-every-time' },
  }
}

class MemoryConversationSettings implements SettingsUpdater {
  private revision = 0
  private readonly listeners = new Set<(snapshot: { policy: AiWritePolicy; revision: number }) => void>()
  private modelRevision = 0
  private readonly modelListeners = new Set<(snapshot: AiConversationModelSelectionSnapshot) => void>()
  readonly value: AppSettings

  constructor(models: LargeModelSettings | undefined = modelSettings()) {
    this.value = { lastWorkspace: null, ...(models ? { models } : {}) }
  }

  get() { return this.value }
  async update() {}
  getAiConversationWritePolicySnapshot() {
    return {
      policy: this.value.models?.aiConversation.writePolicy ?? 'ask-every-time',
      revision: this.revision,
    }
  }
  subscribeAiConversationWritePolicy(listener: (snapshot: { policy: AiWritePolicy; revision: number }) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getAiConversationModelSelectionSnapshot(): AiConversationModelSelectionSnapshot {
    return {
      connectionId: this.value.models?.aiConversation.connectionId ?? null,
      thinkingMode: this.value.models?.aiConversation.thinkingMode ?? 'default', reasoningEffort: this.value.models?.aiConversation.reasoningEffort ?? 'default',
      revision: this.modelRevision,
    }
  }
  subscribeAiConversationModelSelection(listener: (snapshot: AiConversationModelSelectionSnapshot) => void) {
    this.modelListeners.add(listener)
    return () => { this.modelListeners.delete(listener) }
  }
  setWritePolicy(policy: AiWritePolicy) {
    if (this.value.models === undefined) throw new Error('models unavailable')
    this.value.models.aiConversation.writePolicy = policy
    this.revision += 1
    const snapshot = this.getAiConversationWritePolicySnapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
  setSelectedModel(modelId: string) {
    if (this.value.models === undefined) throw new Error('models unavailable')
    this.value.models.connections[0]!.modelId = modelId
    this.modelRevision += 1
    const snapshot = this.getAiConversationModelSelectionSnapshot()
    for (const listener of this.modelListeners) listener(snapshot)
  }
}

type StartInputOverrides = Partial<Omit<StartAiConversationInput, 'messages'>> & {
  messages?: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
}

function startInput(overrides: StartInputOverrides = {}): StartAiConversationInput {
  return {
    requestId: REQUEST_ID, conversationId: CONVERSATION_ID, workspaceKey: 'workspace-a',
    acknowledgedTranscriptRevision: 0,
    messages: [{ id: MESSAGE_ID, role: 'user', content: 'Please help.' }],
    capabilities: { currentDocument: false, workspace: false },
    writePolicy: 'ask-every-time', ...overrides,
  } as StartAiConversationInput
}

function latestTranscriptRevision(events: readonly AiConversationEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'message-completed' || event.type === 'started') return event.transcriptRevision
  }
  return 0
}

function continuedInput(
  events: readonly AiConversationEvent[],
  overrides: StartInputOverrides,
): StartAiConversationInput {
  const lastUser = [...(overrides.messages ?? [])].reverse().find((message) => message.role === 'user')
  if (lastUser === undefined) throw new Error('continued input requires a user delta')
  return startInput({
    ...overrides,
    acknowledgedTranscriptRevision: latestTranscriptRevision(events),
    messages: [lastUser],
  })
}

function call(name: string, args: unknown, id = 'call_1') {
  return { id, name, argumentsJson: JSON.stringify(args) }
}

function edit(path = 'notes/a.md', expectedVersion = VERSION_A) {
  return { path, content: 'next', expectedVersion }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

async function waitEvent(events: AiConversationEvent[], type: AiConversationEvent['type'], count = 1) {
  await vi.waitFor(() => expect(events.filter((event) => event.type === type), JSON.stringify(events.map((event) => ({ type: event.type, ...('code' in event ? { code: event.code } : {}) })))).toHaveLength(count))
  return events.filter((event) => event.type === type)[count - 1]!
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not settle')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

class MemoryWorkspaceFiles implements WorkspaceAiFileBoundary {
  readonly requests: string[] = []
  readonly listSignals: Array<AbortSignal | undefined> = []
  readonly readSignals: Array<AbortSignal | undefined> = []
  readonly planSignals: Array<AbortSignal | undefined> = []
  readonly executed: string[] = []
  rootGeneration = '1.generation'
  workspaceId = 'workspace-a'
  activationEpoch = 1
  rootVolumeSerial = 'volume'
  rootFileId = 'root-workspace-a'
  outcome: 'succeeded' | 'unknown' = 'succeeded'
  readContent = 'text'
  successorVersion: AiFileVersion = VERSION_A
  executionGate: Promise<void> | null = null
  planGate: Promise<void> | null = null
  readonly planningStarted: string[] = []
  listGate: Promise<void> | null = null
  readGate: Promise<void> | null = null
  readonly abandoned: string[] = []
  private index = 0
  private readonly plans = new Map<string, AiOperationManifest>()

  async getRootCapability() {
    return {
      windowId: 1,
      workspaceId: this.workspaceId,
      rootGeneration: this.activationEpoch,
      workspaceGeneration: this.rootGeneration,
      rootFinalPath: `C:\\${this.workspaceId}`,
      rootVolumeSerial: this.rootVolumeSerial,
      rootFileId: this.rootFileId,
    }
  }
  async listEntries(input: Parameters<WorkspaceAiFileBoundary['listEntries']>[0], signal?: AbortSignal) {
    this.listSignals.push(signal)
    this.requests.push(`list:${input.path}`)
    if (this.listGate !== null) await this.listGate
    return { kind: 'entries' as const, directoryPath: input.path,
      directoryVersion: { workspaceGeneration: this.rootGeneration, directoryId: 'dir', revision: 'rev' },
      cursor: input.cursor, entries: [{ path: 'notes/a.md', name: 'a.md', kind: 'document' as const }], nextCursor: null }
  }
  async readDocument(input: Parameters<WorkspaceAiFileBoundary['readDocument']>[0], signal?: AbortSignal) {
    this.readSignals.push(signal)
    this.requests.push(`read:${input.path}`)
    if (this.readGate !== null) await this.readGate
    return { kind: 'document' as const, path: input.path, displayName: 'a.md', sourceFormat: 'md',
      cursor: input.cursor, content: this.readContent, nextCursor: null, hasMore: false,
      totalChars: this.readContent.length, version: VERSION_A }
  }
  async planEdit(input: Parameters<WorkspaceAiFileBoundary['planEdit']>[0], key: string, signal?: AbortSignal) {
    return this.plan(key, 'edit_workspace_document', [input.path], [input.expectedVersion], signal)
  }
  async planCreate(input: Parameters<WorkspaceAiFileBoundary['planCreate']>[0], key: string) {
    return this.plan(key, 'create_workspace_document', [input.path], [])
  }
  async planRename(input: Parameters<WorkspaceAiFileBoundary['planRename']>[0], key: string, signal?: AbortSignal) {
    return this.plan(key, 'rename_workspace_document', [input.path, input.newPath], [input.expectedVersion], signal)
  }
  async planDelete(input: Parameters<WorkspaceAiFileBoundary['planDelete']>[0], key: string, signal?: AbortSignal) {
    return this.plan(key, 'delete_workspace_document', [input.path], [input.expectedVersion], signal)
  }
  authorize() {}
  abandon(operation: AiOperationManifest) { this.abandoned.push(operation.operationId) }
  async executeAuthorized(operation: AiOperationManifest) {
    this.executed.push(operation.operationId)
    if (this.executionGate !== null) await this.executionGate
    if (this.outcome === 'unknown') throw new AiOperationOutcomeUnknownError()
    const kind: 'edited' | 'created' | 'renamed' | 'recycled' = operation.toolName === 'edit_workspace_document' ? 'edited'
      : operation.toolName === 'create_workspace_document' ? 'created'
        : operation.toolName === 'rename_workspace_document' ? 'renamed' : 'recycled'
    return {
      result: { kind: 'mutation' as const, operationId: operation.operationId,
        state: 'succeeded' as const, paths: [...operation.relativePaths] },
      localAudit: { kind, absolutePaths: operation.relativePaths.map((item) => `C:\\workspace\\${item.replaceAll('/', '\\')}`) },
      ...(operation.toolName === 'edit_workspace_document'
        ? { successorVersion: { ...this.successorVersion } } : {}),
    }
  }
  private async plan(
    key: string,
    toolName: AiMutationToolName,
    paths: readonly string[],
    versions: readonly AiFileVersion[],
    signal?: AbortSignal,
  ) {
    const prior = this.plans.get(key)
    if (prior) return prior
    this.planSignals.push(signal)
    this.planningStarted.push(`${toolName}:${paths.join('->')}`)
    if (this.planGate !== null) {
      if (signal === undefined) await this.planGate
      else {
        signal.throwIfAborted()
        let onAbort!: () => void
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason instanceof Error
            ? signal.reason : new DOMException('Planning aborted', 'AbortError'))
          signal.addEventListener('abort', onAbort, { once: true })
        })
        void this.planGate.catch(() => undefined)
        try {
          await Promise.race([this.planGate, aborted])
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      }
    }
    signal?.throwIfAborted()
    const index = this.index++
    const operationId = OPERATION_IDS[index] ?? `650e8400-e29b-41d4-a716-${String(index + 1).padStart(12, '0')}`
    const value: AiOperationManifest = { operationId, idempotencyKey: `key-${operationId}`,
      nonce: `nonce-${operationId}`, workspaceGeneration: this.rootGeneration,
      toolName, relativePaths: paths, expectedVersions: versions }
    this.plans.set(key, value)
    this.requests.push(`plan:${toolName}:${paths.join('->')}`)
    return value
  }
}

function snapshot(name: string, text: string, version: AiFileVersion): AiCurrentDocumentSnapshot {
  return { async readPage(input: AiCurrentDocumentToolArguments): Promise<AiCurrentDocumentToolResult> {
    const content = text.slice(input.cursor, input.cursor + input.maxChars)
    const nextCursor = input.cursor + content.length < text.length ? input.cursor + content.length : null
    return { kind: 'document', displayName: name, sourceFormat: 'markdown', dirty: true,
      cursor: input.cursor, content, nextCursor, hasMore: nextCursor !== null, totalChars: text.length, version }
  }, async release() {} }
}

function setup(options: {
  models?: LargeModelSettings
  writePolicy?: AiWritePolicy
  streamChat?: (input: ModelChatInput) => Promise<ModelChatResult>
  files?: MemoryWorkspaceFiles
  openCurrentDocument?: () => Promise<AiCurrentDocumentSnapshot | null>
  getCurrentDocumentWriteAuthority?: () => { path: string; session: number } | null
  ownerId?: number
  requestRegistry?: AiConversationRequestRegistry
  useDefaultRequestRegistry?: boolean
  getCredentialSnapshot?: () => Promise<{ connection: ModelConnectionSummary; apiKey: string | null }>
  onEvent?: (event: AiConversationEvent) => void
} = {}) {
  const events: AiConversationEvent[] = []
  const streamChat = vi.fn<ModelProtocolClient['streamChat']>(options.streamChat ?? (async () => result()))
  const files = options.files ?? new MemoryWorkspaceFiles()
  const openCurrentDocument = vi.fn(options.openCurrentDocument ?? (async () => null))
  const models = options.models ?? modelSettings()
  models.aiConversation.writePolicy = options.writePolicy ?? models.aiConversation.writePolicy
  const settings = new MemoryConversationSettings(models)
  const service = new AiConversationSessionService({
    ownerId: options.ownerId ?? 1,
    requestRegistry: options.useDefaultRequestRegistry
      ? undefined : options.requestRegistry ?? new AiConversationRequestRegistry(),
    settings,
    connections: { getCredentialSnapshot: options.getCredentialSnapshot
      ?? (async () => ({ connection: models.connections[0] ?? connection(), apiKey: 'api-key' })) },
    client: { streamChat, testConnection: async () => undefined },
    events: { emit: (event) => { events.push(event); options.onEvent?.(event) } } satisfies AiConversationEventSink,
    files, currentDocument: { openSnapshot: openCurrentDocument },
    getCurrentDocumentWriteAuthority: options.getCurrentDocumentWriteAuthority,
  })
  return { events, files, models, settings, openCurrentDocument, service, streamChat }
}

describe('normal conversation output and write scope', () => {
  it.each([
    [connection(), 98_304, true],
    [connection({ provider: 'other', modelId: 'unknown', capabilityOverride: null }), 32_768, true],
    [connection({ provider: 'other', modelId: 'unknown', capabilityOverride: { contextWindowTokens: 200_000 } }), 32_768, true],
    [connection({ capabilityOverride: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 } }), 8_192, true],
    [connection({ capabilityOverride: { contextWindowTokens: 32_768, maxOutputTokens: 32_768 } }), 16_384, false],
  ] as const)('sends a model-compatible output allowance without starving input: %o', async (selected, expected, workspace) => {
    const bodies: Record<string, unknown>[] = []
    const client = createModelProtocolClient(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response('data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
    })
    const state = setup({ models: modelSettings(selected), streamChat: input => client.streamChat(input) })
    await state.service.start(startInput({ capabilities: { currentDocument: workspace, workspace } }))
    await waitEvent(state.events, 'completed')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.max_tokens).toBe(expected)
    const messages = bodies[0]!.messages as Array<{ role: string; content: string }>
    expect(messages.find(message => message.role === 'system')?.content).toContain('禁止对用户要求范围以外的内容进行写操作')
    const tools = bodies[0]!.tools as Array<{ function: { name: string; description: string } }>
    for (const name of workspace ? ['edit_workspace_document', 'create_workspace_document', 'rename_workspace_document', 'delete_workspace_document'] : []) {
      expect(tools.find(tool => tool.function.name === name)?.function.description).toContain('禁止对用户要求范围以外的内容进行写操作')
    }
  })

  it('does not plan or execute even complete-looking write arguments from a truncated response', async () => {
    const client = createModelProtocolClient(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: {
      tool_calls: [{ index: 0, id: 'call_write', type: 'function', function: {
        name: 'edit_workspace_document', arguments: JSON.stringify(edit()),
      } }],
    }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
    const state = setup({ writePolicy: 'workspace-grant', streamChat: input => client.streamChat(input) })
    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: true } }))
    await waitEvent(state.events, 'failed')
    expect(state.files.planningStarted).toEqual([])
    expect(state.files.executed).toEqual([])
    expect(state.streamChat).toHaveBeenCalledOnce()
  })
})

describe('main-only close admission ticket', () => {
  it('reserves synchronously, rejects new starts, and canceling the prompt leaves original work alive', async () => {
    const answer = deferred<ModelChatResult>(), reached = deferred<ModelChatInput>()
    const state = setup({ streamChat: async input => { reached.resolve(input); return answer.promise } })
    await state.service.start(startInput())
    const provider = await reached.promise
    const ticket = state.service.beginCloseAdmission()
    expect(ticket.hasRunningWork).toBe(true)
    expect(state.service.beginCloseAdmission()).toBe(ticket)
    expect(provider.signal.aborted).toBe(false)
    await expect(state.service.start(startInput({ requestId: SECOND_REQUEST_ID }))).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await ticket.resume()
    expect(provider.signal.aborted).toBe(false)
    answer.resolve(result())
    await waitEvent(state.events, 'completed')
    const empty = state.service.beginCloseAdmission()
    expect(empty).not.toBe(ticket)
    expect(empty.hasRunningWork).toBe(false)
    await empty.resume()
    await expect(ticket.stopAndDrain()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    state.streamChat.mockResolvedValueOnce(result())
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Keep history' }] }))
    await waitEvent(state.events, 'completed', 2)
    expect(state.streamChat.mock.calls.at(-1)![0].messages.some(message => message.content === 'Please help.')).toBe(true)
    await state.service.dispose()
  })
  it('waits an aborted provider promise before restoring admission and cannot revive the stopped request', async () => {
    const answer = deferred<ModelChatResult>(), reached = deferred<ModelChatInput>()
    const state = setup({ streamChat: async input => { reached.resolve(input); return answer.promise } })
    await state.service.start(startInput())
    const provider = await reached.promise, ticket = state.service.beginCloseAdmission()
    const drain = ticket.stopAndDrain()
    expect(ticket.stopAndDrain()).toBe(drain)
    let drained = false, resumed = false
    void drain.then(() => { drained = true })
    const resuming = ticket.resume().then(() => { resumed = true })
    await Promise.resolve(); await Promise.resolve()
    expect(provider.signal.aborted).toBe(true)
    expect(drained).toBe(false); expect(resumed).toBe(false)
    await expect(state.service.start(startInput({ requestId: SECOND_REQUEST_ID }))).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    answer.resolve(result())
    await drain; await resuming
    expect(drained).toBe(true); expect(resumed).toBe(true)
    const count = state.events.length
    provider.onDelta('LATE'); provider.onReasoning?.(true)
    expect(state.events).toHaveLength(count)
    expect(state.events.some(event => event.type === 'completed')).toBe(false)
    state.streamChat.mockResolvedValueOnce(result())
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'New request' }] }))
    await waitEvent(state.events, 'completed')
    await ticket.stopAndDrain() // settled old ticket is inert
    await state.service.dispose()
  })
  it('waits pending credential preflight and never issues its provider request after stop', async () => {
    const credential = deferred<{ connection: ModelConnectionSummary; apiKey: string | null }>(), reached = deferred<void>()
    const state = setup({ getCredentialSnapshot: async () => { reached.resolve(); return credential.promise } })
    const starting = state.service.start(startInput()), rejected = expect(starting).rejects.toBeDefined()
    await reached.promise
    const ticket = state.service.beginCloseAdmission()
    expect(ticket.hasRunningWork).toBe(true)
    let done = false
    const drain = ticket.stopAndDrain().then(() => { done = true })
    await Promise.resolve(); await Promise.resolve()
    expect(done).toBe(false)
    credential.resolve({ connection: connection(), apiKey: 'synthetic' })
    await rejected; await drain; await ticket.resume()
    expect(state.streamChat).not.toHaveBeenCalled()
    await state.service.dispose()
  })
  it('waits snapshot release and already executing writes without pretending cancellation rolls them back', async () => {
    const execution = deferred<void>(), release = deferred<void>()
    const files = new MemoryWorkspaceFiles(); files.executionGate = execution.promise
    const current = snapshot('current.md', 'content', VERSION_A)
    const released = vi.spyOn(current, 'release').mockImplementation(() => release.promise)
    const state = setup({ files, openCurrentDocument: async () => current })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 1 }),
      call('edit_workspace_document', edit(), 'write_1')] }))
    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: true } }))
    const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await state.service.submitAuthorizationResult({ requestId: REQUEST_ID, operationId: prompt.operationId, allowed: true })
    await vi.waitFor(() => expect(files.executed).toHaveLength(1))
    const ticket = state.service.beginCloseAdmission()
    let done = false
    const drain = ticket.stopAndDrain().then(() => { done = true })
    await vi.waitFor(() => expect(released).toHaveBeenCalledTimes(1))
    expect(done).toBe(false)
    execution.resolve()
    await Promise.resolve(); await Promise.resolve()
    expect(done).toBe(false)
    release.resolve()
    await drain; await ticket.resume()
    expect(files.executed).toHaveLength(1)
    expect(state.events.some(event => event.type === 'audit' && event.action === 'edited')).toBe(true)
    expect(state.streamChat).toHaveBeenCalledTimes(1)
    await state.service.dispose()
  })
  it('leaves an authorization pending until explicit stop and never executes it after denial', async () => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    const ticket = state.service.beginCloseAdmission()
    expect(state.events.some(event => event.type === 'authorization-result')).toBe(false)
    expect(state.files.executed).toEqual([])
    await ticket.stopAndDrain()
    await ticket.resume()
    expect(state.events.some(event => event.type === 'authorization-result' && !event.allowed)).toBe(true)
    await expect(state.service.submitAuthorizationResult({ requestId: REQUEST_ID, operationId: prompt.operationId, allowed: true }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(state.files.executed).toEqual([])
    expect(state.streamChat).toHaveBeenCalledTimes(1)
    await state.service.dispose()
  })
})

describe('real independent tool budget and local finalization', () => {
  const reads = (count: number, offset = 0) => Array.from({ length: count }, (_, index) =>
    call('list_workspace_entries', { path: '', cursor: 0, maxEntries: 1, directoryVersion: null }, `read_${offset + index}`))
  const writes = (count: number, offset = 0) => Array.from({ length: count }, (_, index) =>
    call('edit_workspace_document', edit(`notes/item-${offset + index}.md`), `write_${offset + index}`))
  function approvingState() {
    const state = setup({ writePolicy: 'workspace-grant', onEvent: event => {
      if (event.type === 'authorization-requested') void state.service.submitAuthorizationResult({
        requestId: event.requestId, operationId: event.operationId, allowed: true })
    } })
    return state
  }
  it.each(['completed', 'failed', 'cancel'] as const)('preserves owned finalizer thinking, process, and answer output (%s)', async ending => {
    let now = 100
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const ready = deferred<void>(), finish = deferred<ModelChatResult>()
    const state = setup()
    let finalizer: ModelChatInput | undefined
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: reads(257) })).mockImplementationOnce(async input => {
      finalizer = input
      input.onReasoning?.(true)
      input.onProcess?.({ kind: 'reasoning-summary', itemId: 'provider-private-id', segmentIndex: 0, delta: 'Observed summary', delivery: 'stream' })
      input.onDelta('Final partial answer')
      input.onProcess?.({ kind: 'commentary', itemId: 'provider-private-id', segmentIndex: 1, delta: 'Queued tail', delivery: 'stream' })
      ready.resolve()
      return finish.promise
    })
    try {
      await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
      await ready.promise
      now = 350
      if (ending === 'cancel') { await state.service.cancel(REQUEST_ID); finish.reject(new DOMException('Aborted', 'AbortError')) }
      else if (ending === 'failed') finish.reject(new ModelProtocolError('timeout'))
      else finish.resolve(result())
      await waitEvent(state.events, ending === 'cancel' ? 'stopped' : 'budget-paused')
      const starts = state.events.filter(event => event.type === 'message-start'), messageId = starts.at(-1)!.messageId
      const thinking = state.events.filter((event): event is Extract<AiConversationEvent, { type: 'thinking' }> => event.type === 'thinking' && event.messageId === messageId)
      expect(thinking.map(event => [event.active, event.elapsedMs])).toEqual([[true, 0], [false, 250]])
      const process = state.events.filter((event): event is Extract<AiConversationEvent, { type: 'process-text' }> => event.type === 'process-text' && event.messageId === messageId)
      expect(process.map(event => event.delta).join('')).toBe('Observed summaryQueued tail')
      expect(process.every(event => event.round === 2 && event.itemId !== 'provider-private-id')).toBe(true)
      expect(state.events.filter((event): event is Extract<AiConversationEvent, { type: 'process-stage' }> => event.type === 'process-stage' && event.messageId === messageId).map(event => event.stage))
        .toEqual(['waiting-model', 'thinking', 'answering'])
      expect(state.events.some(event => event.type === 'delta' && event.messageId === messageId && event.delta === 'Final partial answer')).toBe(true)
      const terminalIndex = state.events.findIndex(event => event.type === (ending === 'cancel' ? 'stopped' : 'budget-paused'))
      expect(process.every(event => state.events.indexOf(event) < terminalIndex)).toBe(true)
      expect(state.events.some(event => event.type === 'message-completed' && event.messageId === messageId)).toBe(ending === 'completed')
      const count = state.events.length
      finalizer!.onReasoning?.(true); finalizer!.onDelta('LATE')
      finalizer!.onProcess?.({ kind: 'commentary', itemId: 'late', segmentIndex: 0, delta: 'LATE', delivery: 'complete' })
      expect(state.events).toHaveLength(count)
    } finally { finish.resolve(result()); await state.service.dispose(); clock.mockRestore() }
  })
  it('preserves both invalidated-read and current-document notices in finalizer messages and input estimates', async () => {
    const state = setup({ openCurrentDocument: async () => snapshot('current.md', 'content', VERSION_A) })
    let finalizerInput: ModelChatInput | undefined
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 7 })] }))
      .mockResolvedValueOnce(result({ toolCalls: reads(256) })).mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ toolCalls: reads(257, 100) })).mockImplementationOnce(async input => { finalizerInput = input; return result() })
    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: true }, expectedDocumentId: CONVERSATION_ID }))
    const paused = await waitEvent(state.events, 'budget-paused') as Extract<AiConversationEvent, { type: 'budget-paused' }>
    await state.service.notifyCurrentDocumentChanged()
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue' }], expectedDocumentId: CONVERSATION_ID,
      capabilities: { currentDocument: true, workspace: true }, continuationOfSegmentId: paused.continuationId! }))
    await waitEvent(state.events, 'budget-paused', 2)
    const messages = finalizerInput!.messages
    expect(JSON.stringify(messages)).toContain('ARKDOWN_CONTINUATION_FRESH_READ_REQUIRED_V1')
    expect(messages.some(message => message.content === '当前文档已改变，本次任务如依赖其内容，请重新读取。')).toBe(true)
    const usage = state.events.filter((event): event is Extract<AiConversationEvent, { type: 'usage' }> => event.type === 'usage' && event.requestId === SECOND_REQUEST_ID).at(-1)!
    expect(usage.usage.inputTokens).toBe(estimateWireTokens(messages) + estimateTextTokens('[]') + 64)
    await state.service.dispose()
  })
  it.each([15, 16, 17])('admits a whole %i-write batch or rejects it before planning', async count => {
    const state = approvingState()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: writes(count) })).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true }, writePolicy: 'workspace-grant' }))
    await waitEvent(state.events, count > 16 ? 'budget-paused' : 'completed')
    expect(state.files.executed).toHaveLength(count > 16 ? 0 : count)
    expect(state.files.planningStarted).toHaveLength(count > 16 ? 0 : count)
    if (count > 16) expect(state.events.find(event => event.type === 'budget-paused')).toMatchObject({
      reason: 'write-budget', counts: { readAdmitted: 0, writeAdmitted: 0, rejectedNewCalls: 17 }, outcomes: { notExecuted: 17 } })
    await state.service.dispose()
  })
  it.each(['read-first', 'write-first'])('preserves independent exact limits in %s order', async ordering => {
    const state = approvingState()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: ordering === 'read-first' ? reads(256) : writes(16) }))
      .mockResolvedValueOnce(result({ toolCalls: ordering === 'read-first' ? writes(16) : reads(256) }))
      .mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true }, writePolicy: 'workspace-grant' }))
    expect(await waitEvent(state.events, 'budget-paused')).toMatchObject({ reason: 'budgets-exhausted',
      counts: { readAdmitted: 256, writeAdmitted: 16, rejectedNewCalls: 0 }, outcomes: { readSucceeded: 256, writeSucceeded: 16 } })
    expect(state.files.executed).toHaveLength(16)
    expect(state.files.requests.filter(item => item.startsWith('list:'))).toHaveLength(256)
    expect(state.streamChat).toHaveBeenCalledTimes(3)
    expect(state.streamChat.mock.calls[2]![0].tools).toEqual([])
    await state.service.dispose()
  })
  it('rejects 255+2 reads atomically and excludes cached writes from rejected new calls', async () => {
    const state = approvingState()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [...reads(255), ...writes(15)] }))
      .mockResolvedValueOnce(result({ toolCalls: [...writes(1), ...reads(2, 255), ...writes(2, 15)] }))
      .mockImplementationOnce(async input => {
        const paired = input.messages.filter(message => message.role === 'tool').slice(-5)
        expect(JSON.parse(paired[0]!.content)).toMatchObject({ kind: 'mutation', state: 'succeeded' })
        expect(paired.slice(1).map(message => JSON.parse(message.content).kind)).toEqual(Array(4).fill('not-executed'))
        return result()
      })
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true }, writePolicy: 'workspace-grant' }))
    expect(await waitEvent(state.events, 'budget-paused')).toMatchObject({ reason: 'combined-budget',
      counts: { readAdmitted: 255, writeAdmitted: 15, rejectedNewCalls: 4 }, outcomes: { readSucceeded: 255, writeSucceeded: 15, notExecuted: 4 } })
    expect(state.files.executed).toHaveLength(15)
    expect(state.files.requests.filter(item => item.startsWith('list:'))).toHaveLength(255)
    await state.service.dispose()
  })
  it('validates the invalid final item before treating a large batch as budget exhaustion', async () => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [...reads(257),
      call('read_workspace_document', { path: '../private.md', cursor: 0, maxChars: 10 }, 'invalid')] }))
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    expect(await waitEvent(state.events, 'failed')).toMatchObject({ detail: { reason: 'tool-invalid-arguments' } })
    expect(state.files.requests).toEqual([])
    expect(state.events.some(event => event.type === 'budget-paused' || event.type === 'process-tool')).toBe(false)
    expect(state.streamChat).toHaveBeenCalledTimes(1)
    await state.service.dispose()
  })
  it('sends the soft notice once on crossing 192 and charges repeated reads with new IDs', async () => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: reads(191) }))
      .mockResolvedValueOnce(result({ toolCalls: reads(1, 191) })).mockResolvedValueOnce(result({ toolCalls: reads(1, 192) }))
      .mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')
    expect(state.streamChat.mock.calls.map(([input]) => JSON.stringify(input.messages).includes('ARKDOWN_TOOL_BUDGET_NOTICE_V1')))
      .toEqual([false, false, true, false])
    const notice = state.streamChat.mock.calls[2]![0].messages.find(message => message.content?.startsWith('ARKDOWN_TOOL_BUDGET_NOTICE_V1'))!
    expect(JSON.parse(notice.content!.split('\n')[1]!)).toMatchObject({ remainingReads: 64, remainingWrites: 16 })
    expect(state.files.requests.filter(item => item.startsWith('list:'))).toHaveLength(193)
    await state.service.dispose()
  })
  it('naturally completes on the 80th ordinary round without an extra finalizer', async () => {
    let rounds = 0
    const state = setup({ streamChat: async () => ++rounds < 80 ? result({ toolCalls: reads(1) }) : result() })
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')
    expect(state.streamChat).toHaveBeenCalledTimes(80)
    expect(state.events.some(event => event.type === 'budget-paused')).toBe(false)
    await state.service.dispose()
  })
  it('rejects a forged continuation before any provider call', async () => {
    const state = setup()
    await expect(state.service.start(startInput({ continuationOfSegmentId: SECOND_REQUEST_ID })))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(state.streamChat).not.toHaveBeenCalled()
    await state.service.dispose()
  })
  it('skips an over-capacity finalizer without hidden compaction or another model call', async () => {
    const state = setup({ models: modelSettings(connection({ provider: 'other', baseUrl: 'https://synthetic.invalid/v1', modelId: 'bounded',
      capabilityOverride: { contextWindowTokens: 160000, maxInputTokens: 15000, maxOutputTokens: 1000 } })) })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: Array.from({ length: 257 }, (_, index) =>
      call('read_workspace_document', { path: `${Array(4).fill('x'.repeat(180)).join('/')}/a.md`, cursor: 0, maxChars: 1 }, `read_${index}`)) }))
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    expect(await waitEvent(state.events, 'budget-paused')).toMatchObject({ finalization: { status: 'context-limit' } })
    expect(state.streamChat).toHaveBeenCalledTimes(1)
    expect(state.events.some(event => event.type === 'context-compaction')).toBe(false)
    expect(state.files.requests).toEqual([])
    await state.service.dispose()
  })
  it.each(['cancel', 'permission', 'root'] as const)('rejects continuation ownership lost during directory revalidation: %s', async boundary => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: reads(256) })).mockResolvedValueOnce(result({ toolCalls: reads(1, 256) }))
      .mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const paused = await waitEvent(state.events, 'budget-paused') as Extract<AiConversationEvent, { type: 'budget-paused' }>
    const gate = deferred<void>(), reached = deferred<void>()
    const realList = state.files.listEntries.bind(state.files)
    vi.spyOn(state.files, 'listEntries').mockImplementationOnce(async (input, signal) => {
      reached.resolve(); await gate.promise; return realList(input, signal)
    })
    const pending = state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue' }],
      capabilities: { currentDocument: false, workspace: true }, continuationOfSegmentId: paused.continuationId! }))
    const rejected = expect(pending).rejects.toBeDefined()
    await reached.promise
    if (boundary === 'cancel') await state.service.cancel(SECOND_REQUEST_ID)
    if (boundary === 'permission') state.service.setCapabilities({ ownerId: 1, workspaceId: state.files.workspaceId,
      workspaceGeneration: state.files.rootGeneration, conversationId: CONVERSATION_ID, capabilities: { currentDocument: false, workspace: false } })
    if (boundary === 'root') state.files.rootFileId = 'new-root'
    gate.resolve()
    await rejected
    expect(state.streamChat).toHaveBeenCalledTimes(3)
    expect(state.events.filter(event => event.type === 'started')).toHaveLength(1)
    await state.service.dispose()
  })
  it('retains only 64 deeply immutable metadata diagnostics without private text or paths', async () => {
    const state = setup({ streamChat: async input => { input.onDelta('PRIVATE_PROVIDER_TEXT'); return result() } })
    for (let index = 0; index < 65; index++) {
      const id = `550e8400-e29b-41d4-a716-${String(index + 100).padStart(12, '0')}`
      const input = continuedInput(state.events, { requestId: id, messages: [{ id, role: 'user', content: 'PRIVATE_USER_TEXT' }] })
      await state.service.start(input)
      await waitEvent(state.events, 'completed', index + 1)
    }
    const diagnostics = state.service.getSegmentDiagnostics()
    expect(diagnostics).toHaveLength(64)
    expect(diagnostics.at(-1)).toMatchObject({ version: 1, terminal: 'completed', stage: 'tools', reason: null, code: null,
      counts: { readAdmitted: 0, writeAdmitted: 0, toolRounds: 1 }, revalidationReads: 0, resetReasons: [] })
    expect(diagnostics.every(item => /^[a-f0-9]{64}$/.test(item.modelFingerprint))).toBe(true)
    expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE_|api\.deepseek|notes\/|workspace-a|api-key/)
    const again = state.service.getSegmentDiagnostics()
    expect(again[0]).not.toBe(diagnostics[0])
    expect(again[0]!.counts).not.toBe(diagnostics[0]!.counts)
    for (const item of [diagnostics, diagnostics[0], diagnostics[0]!.counts, diagnostics[0]!.outcomes, diagnostics[0]!.resetReasons]) expect(Object.isFrozen(item)).toBe(true)
    await state.service.dispose()
  })
  it.each(['succeeded', 'unknown'] as const)('continues with a cached %s write receipt without re-execution or new authorization', async outcome => {
    const state = approvingState()
    state.files.outcome = outcome
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: writes(1) }))
      .mockResolvedValueOnce(result({ toolCalls: reads(257) })).mockRejectedValueOnce(new ModelProtocolError('timeout'))
      .mockImplementationOnce(async input => {
        expect(JSON.stringify(input.messages)).toContain('ARKDOWN_LOCAL_BUDGET_CLOSURE_V1')
        return result({ toolCalls: writes(1) })
      }).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true }, writePolicy: 'workspace-grant' }))
    const paused = await waitEvent(state.events, 'budget-paused') as Extract<AiConversationEvent, { type: 'budget-paused' }>
    expect(paused.outcomes).toMatchObject(outcome === 'succeeded' ? { writeSucceeded: 1 } : { writeUnknown: 1 })
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue' }],
      capabilities: { currentDocument: false, workspace: true }, writePolicy: 'workspace-grant', continuationOfSegmentId: paused.continuationId! }))
    await waitEvent(state.events, 'completed')
    expect(state.files.executed).toHaveLength(1)
    expect(state.files.planningStarted).toHaveLength(1)
    expect(state.events.filter(event => event.type === 'authorization-requested')).toHaveLength(0)
    expect(state.events.filter(event => event.requestId === SECOND_REQUEST_ID && event.type === 'process-tool')).toEqual([
      expect.objectContaining({ cached: true, status: outcome })])
    const reply = state.streamChat.mock.calls.at(-1)![0].messages.filter(message => message.role === 'tool').at(-1)!
    expect(JSON.parse(reply.content)).toMatchObject({ kind: 'mutation', state: outcome })
    await state.service.dispose()
  })
  it.each(['revoked', 'changed', 'unavailable', 'no-version'] as const)('treats %s directory observations as historical before continuation', async change => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: reads(256) }))
      .mockResolvedValueOnce(result({ toolCalls: reads(1, 256) })).mockResolvedValueOnce(result())
      .mockImplementationOnce(async input => {
        expect(JSON.stringify(input.messages)).toContain('ARKDOWN_CONTINUATION_FRESH_READ_REQUIRED_V1')
        expect(input.messages.filter(message => message.role === 'tool')).toEqual([])
        return result()
      })
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const paused = await waitEvent(state.events, 'budget-paused') as Extract<AiConversationEvent, { type: 'budget-paused' }>
    const list = vi.spyOn(state.files, 'listEntries')
    if (change === 'unavailable') list.mockRejectedValueOnce(new Error('PRIVATE_PATH'))
    if (change === 'changed' || change === 'no-version') list.mockResolvedValueOnce({
      kind: 'entries', directoryPath: '', cursor: 0, entries: [], nextCursor: null,
      ...(change === 'changed' ? { directoryVersion: { workspaceGeneration: state.files.rootGeneration, directoryId: 'dir', revision: 'new' } } : {}),
    } as Awaited<ReturnType<typeof state.files.listEntries>>)
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue' }],
      capabilities: { currentDocument: false, workspace: change !== 'revoked' }, continuationOfSegmentId: paused.continuationId! }))
    await waitEvent(state.events, 'completed')
    expect(list).toHaveBeenCalledTimes(change === 'revoked' ? 0 : 1)
    expect(state.service.getSegmentDiagnostics().at(-1)).toMatchObject({ revalidationReads: change === 'revoked' ? 0 : 1,
      resetReasons: [change === 'revoked' ? 'permission-or-document-changed' : change === 'unavailable' ? 'read-unavailable' : 'version-changed-or-invalid'] })
    expect(JSON.stringify(state.events)).not.toContain('PRIVATE_PATH')
    await state.service.dispose()
  })
  it('revalidates the current document through one bounded snapshot page and releases both snapshots', async () => {
    const first = snapshot('current.md', 'content', VERSION_A), next = snapshot('current.md', 'content', VERSION_A)
    const firstRelease = vi.spyOn(first, 'release'), nextRelease = vi.spyOn(next, 'release'), nextRead = vi.spyOn(next, 'readPage')
    const state = setup()
    state.openCurrentDocument.mockResolvedValueOnce(first).mockResolvedValueOnce(next)
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 7 })] }))
      .mockResolvedValueOnce(result({ toolCalls: reads(256) })).mockResolvedValueOnce(result()).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: true }, expectedDocumentId: CONVERSATION_ID }))
    const paused = await waitEvent(state.events, 'budget-paused') as Extract<AiConversationEvent, { type: 'budget-paused' }>
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue' }], expectedDocumentId: CONVERSATION_ID,
      capabilities: { currentDocument: true, workspace: true }, continuationOfSegmentId: paused.continuationId! }))
    await waitEvent(state.events, 'completed')
    expect(nextRead).toHaveBeenCalledWith({ cursor: 0, maxChars: 1 }, expect.any(AbortSignal))
    expect(firstRelease).toHaveBeenCalledTimes(1)
    expect(nextRelease).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(state.streamChat.mock.calls.at(-1)![0].messages)).not.toContain('ARKDOWN_CONTINUATION_FRESH_READ_REQUIRED_V1')
    await state.service.dispose()
  })
  it('does not reopen an earlier current document after its epoch changes', async () => {
    const state = setup({ openCurrentDocument: async () => snapshot('current.md', 'content', VERSION_A) })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 7 })] }))
      .mockResolvedValueOnce(result({ toolCalls: reads(256) })).mockResolvedValueOnce(result())
      .mockImplementationOnce(async input => {
        expect(JSON.stringify(input.messages)).toContain('ARKDOWN_CONTINUATION_FRESH_READ_REQUIRED_V1')
        expect(input.messages.filter(message => message.role === 'tool')).toEqual([])
        return result()
      })
    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: true }, expectedDocumentId: CONVERSATION_ID }))
    const paused = await waitEvent(state.events, 'budget-paused') as Extract<AiConversationEvent, { type: 'budget-paused' }>
    await state.service.notifyCurrentDocumentChanged()
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue' }], expectedDocumentId: CONVERSATION_ID,
      capabilities: { currentDocument: true, workspace: true }, continuationOfSegmentId: paused.continuationId! }))
    await waitEvent(state.events, 'completed')
    expect(state.openCurrentDocument).toHaveBeenCalledTimes(1)
    expect(state.service.getSegmentDiagnostics().at(-1)).toMatchObject({ revalidationReads: 0, resetReasons: ['permission-or-document-changed'] })
    await state.service.dispose()
  })
  it.each(['same', 'changed'] as const)('checks the bounded document page version (%s) and retains trusted write facts through reset', async version => {
    const state = approvingState()
    const boundary: WorkspaceAiFileBoundary = state.files
    const fileRead = vi.spyOn(boundary, 'readDocument')
    fileRead.mockResolvedValueOnce({ kind: 'document', path: 'notes/a.md', displayName: 'a.md', sourceFormat: 'md',
      cursor: 0, content: 'private excerpt', nextCursor: null, hasMore: false, totalChars: 15, version: VERSION_A })
      .mockResolvedValueOnce({ kind: 'document', path: 'notes/a.md', displayName: 'a.md', sourceFormat: 'md',
        cursor: 0, content: 'p', nextCursor: 1, hasMore: true, totalChars: 15, version: version === 'same' ? VERSION_A : VERSION_B })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 }), ...writes(1)] }))
      .mockResolvedValueOnce(result({ toolCalls: reads(256) })).mockResolvedValueOnce(result())
      .mockImplementationOnce(async input => {
        expect(JSON.stringify(input.messages).includes('ARKDOWN_CONTINUATION_FRESH_READ_REQUIRED_V1')).toBe(version === 'changed')
        if (version === 'changed') {
          expect(JSON.stringify(input.messages)).not.toContain('private excerpt')
          expect(JSON.stringify(input.messages)).toContain(OPERATION_IDS[0])
        }
        return result({ toolCalls: writes(1) })
      }).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true }, writePolicy: 'workspace-grant' }))
    const paused = await waitEvent(state.events, 'budget-paused') as Extract<AiConversationEvent, { type: 'budget-paused' }>
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue' }],
      capabilities: { currentDocument: false, workspace: true }, writePolicy: 'workspace-grant', continuationOfSegmentId: paused.continuationId! }))
    await waitEvent(state.events, 'completed')
    expect(fileRead).toHaveBeenLastCalledWith({ path: 'notes/a.md', cursor: 0, maxChars: 1 }, expect.any(AbortSignal))
    expect(state.files.executed).toHaveLength(1)
    await state.service.dispose()
  })
  it('allows only the newest competing continuation candidate to consume the receipt', async () => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: reads(256) })).mockResolvedValueOnce(result({ toolCalls: reads(1, 256) }))
      .mockResolvedValueOnce(result()).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const paused = await waitEvent(state.events, 'budget-paused') as Extract<AiConversationEvent, { type: 'budget-paused' }>
    const gate = deferred<void>(), reached = deferred<void>(), realList = state.files.listEntries.bind(state.files)
    vi.spyOn(state.files, 'listEntries').mockImplementationOnce(async (input, signal) => { reached.resolve(); await gate.promise; return realList(input, signal) })
    const input = { messages: [{ id: SECOND_MESSAGE_ID, role: 'user' as const, content: 'Continue' }],
      capabilities: { currentDocument: false, workspace: true }, continuationOfSegmentId: paused.continuationId! }
    const first = state.service.start(continuedInput(state.events, { ...input, requestId: SECOND_REQUEST_ID }))
    const rejected = expect(first).rejects.toBeDefined()
    await reached.promise
    await state.service.start(continuedInput(state.events, { ...input, requestId: THIRD_REQUEST_ID,
      messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'Continue newer' }] }))
    gate.resolve()
    await rejected
    await waitEvent(state.events, 'completed')
    expect(state.streamChat).toHaveBeenCalledTimes(4)
    expect(state.events.filter(event => event.type === 'started').map(event => event.requestId)).toEqual([REQUEST_ID, THIRD_REQUEST_ID])
    await state.service.dispose()
  })
  it('rejects a changed model profile receipt without reading prior targets or consuming the token', async () => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: reads(256) })).mockResolvedValueOnce(result({ toolCalls: reads(1, 256) }))
      .mockResolvedValueOnce(result()).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const paused = await waitEvent(state.events, 'budget-paused') as Extract<AiConversationEvent, { type: 'budget-paused' }>
    const originalModel = state.models.connections[0]!.modelId
    state.settings.setSelectedModel('different-model')
    await expect(state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue' }],
      capabilities: { currentDocument: false, workspace: true }, continuationOfSegmentId: paused.continuationId! })))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(state.files.requests.filter(item => item.startsWith('list:'))).toHaveLength(256)
    state.settings.setSelectedModel(originalModel)
    await state.service.start(continuedInput(state.events, { requestId: THIRD_REQUEST_ID,
      messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'Continue again' }],
      capabilities: { currentDocument: false, workspace: true }, continuationOfSegmentId: paused.continuationId! }))
    await waitEvent(state.events, 'completed')
    expect(state.files.requests.filter(item => item.startsWith('list:'))).toHaveLength(257)
    await state.service.dispose()
  })
  it('stops a canceled finalizer with partial text and retains the paired local closure for a later user request', async () => {
    const started = deferred<void>()
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: reads(257) })).mockImplementationOnce(async input => {
      input.onDelta('Partial summary')
      started.resolve()
      await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
      return result()
    }).mockImplementationOnce(async input => {
      expect(input.messages.filter(message => message.role === 'tool')).toHaveLength(257)
      expect(JSON.stringify(input.messages)).toContain('ARKDOWN_LOCAL_BUDGET_CLOSURE_V1')
      expect(JSON.stringify(input.messages)).not.toContain('Partial summary')
      return result()
    })
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await started.promise
    await state.service.cancel(REQUEST_ID)
    await waitEvent(state.events, 'stopped')
    expect(state.events.some(event => event.type === 'budget-paused' || event.type === 'completed')).toBe(false)
    expect(state.events.some(event => event.type === 'delta' && event.delta === 'Partial summary')).toBe(true)
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue normally' }], capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')
    await state.service.dispose()
  })
  it('issues a single-use main receipt and revalidates one unique directory without spending new tool budget', async () => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: reads(256) }))
      .mockResolvedValueOnce(result({ toolCalls: reads(1, 256) })).mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ toolCalls: reads(256, 100) })).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const paused = await waitEvent(state.events, 'budget-paused') as Extract<AiConversationEvent, { type: 'budget-paused' }>
    expect(paused.continuationId).toEqual(expect.any(String))
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue' }],
      capabilities: { currentDocument: false, workspace: true }, continuationOfSegmentId: paused.continuationId! }))
    await waitEvent(state.events, 'completed')
    expect(state.files.requests.filter(item => item.startsWith('list:'))).toHaveLength(513)
    expect(state.streamChat).toHaveBeenCalledTimes(5)
    await expect(state.service.start(continuedInput(state.events, { requestId: THIRD_REQUEST_ID,
      messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'Replay token' }], continuationOfSegmentId: paused.continuationId! })))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await state.service.dispose()
  })
  it('retains and revalidates all 256 unique document observations before continuing with a fresh budget', async () => {
    const state = setup()
    const readDocument = state.files.readDocument.bind(state.files)
    const boundary: WorkspaceAiFileBoundary = state.files
    vi.spyOn(boundary, 'readDocument').mockImplementation(async (input, signal) => {
      const page = await readDocument(input, signal)
      const content = page.content.slice(0, input.maxChars)
      const nextCursor = content.length < page.totalChars ? content.length : null
      return { ...page, content, nextCursor, hasMore: nextCursor !== null }
    })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: Array.from({ length: 256 }, (_, index) =>
      call('read_workspace_document', { path: `notes/file-${index}.md`, cursor: 0, maxChars: 4 }, `unique_read_${index}`)) }))
      .mockResolvedValueOnce(result({ toolCalls: reads(1) })).mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ toolCalls: reads(1, 1000) })).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const paused = await waitEvent(state.events, 'budget-paused') as Extract<AiConversationEvent, { type: 'budget-paused' }>
    expect(paused).toMatchObject({ counts: { readAdmitted: 256, rejectedNewCalls: 1 }, outcomes: { readSucceeded: 256, notExecuted: 1 } })
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue remaining task' }],
      capabilities: { currentDocument: false, workspace: true }, continuationOfSegmentId: paused.continuationId! }))
    await waitEvent(state.events, 'completed')
    expect(state.files.readSignals).toHaveLength(512)
    expect(JSON.stringify(state.streamChat.mock.calls[3]![0].messages)).not.toContain('ARKDOWN_CONTINUATION_FRESH_READ_REQUIRED_V1')
    expect(state.files.requests.filter(item => item.startsWith('list:'))).toHaveLength(1)
    expect(state.service.getSegmentDiagnostics().at(-1)).toMatchObject({ revalidationReads: 256,
      resetReasons: [], counts: { readAdmitted: 1, writeAdmitted: 0 } })
    await state.service.dispose()
  })
  it.each([8, 9, 64, 65, 191, 192, 255, 256])('admits %i reads in the actual service without consuming writes', async count => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: reads(count) })).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')
    expect(state.files.requests.filter(item => item.startsWith('list:'))).toHaveLength(count)
    expect(state.events.some(event => event.type === 'failed' || event.type === 'budget-paused')).toBe(false)
    expect(JSON.stringify(state.streamChat.mock.calls[1]![0].messages).includes('ARKDOWN_TOOL_BUDGET_NOTICE_V1')).toBe(count >= 192)
    await state.service.dispose()
  })
  it.each(['completed', 'failed', 'tools-returned'] as const)('rejects the whole 257-read batch then makes one bounded %s finalizer', async ending => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: reads(257) })).mockImplementationOnce(async input => {
      expect(input.tools).toEqual([])
      const paired = input.messages.filter(message => message.role === 'tool')
      expect(paired).toHaveLength(257)
      expect(paired.every(message => JSON.parse(message.content).kind === 'not-executed')).toBe(true)
      input.onDelta('Summary received')
      if (ending === 'failed') throw new ModelProtocolError('timeout')
      return result({ toolCalls: ending === 'tools-returned' ? reads(1, 100) : [] })
    })
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const paused = await waitEvent(state.events, 'budget-paused')
    expect(paused).toMatchObject({ reason: 'read-budget', counts: { readAdmitted: 0, writeAdmitted: 0, rejectedNewCalls: 257, toolRounds: 1 },
      outcomes: { notExecuted: 257 }, finalization: { status: ending } })
    expect(state.files.requests).toEqual([])
    expect(state.streamChat).toHaveBeenCalledTimes(2)
    expect(state.events.some(event => event.type === 'failed' || event.type === 'completed')).toBe(false)
    expect(state.events.filter(event => event.type === 'process-tool').every(event => event.status === 'not-executed')).toBe(true)
    await state.service.dispose()
  })
  it('bounds cached-only round trips at 80 plus one finalizer while executing once', async () => {
    let calls = 0
    const state = setup({ streamChat: async input => {
      if (++calls > 82) throw new Error('Synthetic probe stopped an unbounded loop')
      return input.tools?.length ? result({ toolCalls: reads(1) }) : result()
    } })
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    expect(await waitEvent(state.events, 'budget-paused')).toMatchObject({ reason: 'tool-rounds', counts: { readAdmitted: 1, toolRounds: 80 } })
    expect(state.streamChat).toHaveBeenCalledTimes(81)
    expect(state.files.requests.filter(item => item.startsWith('list:'))).toHaveLength(1)
    await state.service.dispose()
  })
})

describe('main-owned readable conversation progress', () => {
  it('preserves a finite semantic failure detail after flushing the readable text', async () => {
    const detail = { version: 1, reason: 'access-denied', stage: 'provider', source: 'http', httpStatus: 403 } as const
    const state = setup({ streamChat: async input => {
      input.onProcess?.({ kind: 'commentary', itemId: 'p', segmentIndex: 0, delta: 'Accepted', delivery: 'stream' })
      throw new ModelProtocolError('incompatible-response', undefined, detail)
    } })
    await state.service.start(startInput())
    expect(await waitEvent(state.events, 'failed')).toMatchObject({ detail, code: 'MODEL_INCOMPATIBLE_RESPONSE' })
    expect(state.events.findIndex(event => event.type === 'process-text')).toBeLessThan(state.events.findIndex(event => event.type === 'failed'))
    await state.service.dispose()
  })
  it('rejects the entire invalid batch before any tool progress or file operation', async () => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [
      call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 }),
      call('read_workspace_document', { path: '../private.md', cursor: 0, maxChars: 100 }, 'call_2'),
    ] }))
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'failed')
    expect(state.events.filter(event => event.type === 'process-tool')).toEqual([])
    expect(state.files.requests).toEqual([])
    await state.service.dispose()
  })
  it.each(['denied', 'read-unavailable', 'read-failed', 'write-denied', 'write-failed'] as const)(
    'reports confirmed %s without inventing successful execution', async boundary => {
      const state = setup()
      if (boundary === 'read-failed') vi.spyOn(state.files, 'readDocument').mockRejectedValueOnce(new Error('PRIVATE_PATH'))
      if (boundary === 'read-unavailable') state.files.readContent = 'x'.repeat(101) // Valid document shape, invalid requested-page echo.
      if (boundary === 'write-failed') vi.spyOn(state.files, 'executeAuthorized').mockRejectedValueOnce(new Error('PRIVATE_KEY'))
      const write = boundary.startsWith('write-')
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [write
        ? call('edit_workspace_document', edit())
        : call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 })] }))
        .mockResolvedValueOnce(result())
      await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: boundary !== 'denied' } }))
      if (write) {
        const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
        await state.service.submitAuthorizationResult({ requestId: REQUEST_ID, operationId: prompt.operationId, allowed: boundary !== 'write-denied' })
      }
      await waitEvent(state.events, 'completed')
      const tools = state.events.filter(event => event.type === 'process-tool')
      expect(tools.map(event => event.status)).toEqual(boundary === 'denied' ? ['denied']
        : boundary === 'read-unavailable' ? ['running', 'unavailable']
          : boundary === 'read-failed' ? ['running', 'failed']
          : boundary === 'write-denied' ? ['awaiting-approval', 'denied'] : ['awaiting-approval', 'running', 'failed'])
      expect(JSON.stringify(tools)).not.toMatch(/PRIVATE_PATH|PRIVATE_KEY/)
      if (boundary === 'denied' || boundary === 'write-denied') expect(state.files.executed).toEqual([])
      expect(state.service.getSegmentDiagnostics().at(-1)).toMatchObject({
        counts: { readAdmitted: write ? 0 : 1, writeAdmitted: write ? 1 : 0 },
        outcomes: { readSucceeded: 0, writeSucceeded: 0,
          readDenied: boundary === 'denied' ? 1 : 0,
          readUnavailable: boundary === 'read-unavailable' ? 1 : 0,
          readFailed: boundary === 'read-failed' ? 1 : 0,
          writeDenied: boundary === 'write-denied' ? 1 : 0,
          writeFailed: boundary === 'write-failed' ? 1 : 0 },
      })
      await state.service.dispose()
    })
  it.each(['planned', 'awaitingApproval', 'authorized', 'executing'] as const)(
    'does not promote journal state %s into a confirmed terminal outcome', async journalState => {
      const state = setup(), boundary: WorkspaceAiFileBoundary = state.files
      const execute = boundary.executeAuthorized.bind(boundary)
      vi.spyOn(boundary, 'executeAuthorized').mockImplementation(async manifest => {
        const completed = await execute(manifest)
        return { ...completed, result: { kind: 'mutation', operationId: completed.result.operationId,
          paths: completed.result.paths, state: journalState } }
      })
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] })).mockResolvedValueOnce(result())
      await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
      const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      await state.service.submitAuthorizationResult({ requestId: REQUEST_ID, operationId: prompt.operationId, allowed: true })
      await waitEvent(state.events, 'completed')
      expect(state.events.filter(event => event.type === 'process-tool').map(event => event.status))
        .toEqual(['awaiting-approval', 'running', 'unavailable'])
      expect(state.events.some(event => event.type === 'audit' && event.action === 'edited')).toBe(false)
      expect(state.streamChat.mock.calls[1]![0].messages.filter(message => message.role === 'tool').at(-1))
        .toMatchObject({ content: JSON.stringify({ kind: 'unavailable' }) })
      await state.service.dispose()
    })
  it.each(['succeeded', 'unknown'] as const)('settles an already executing %s write before stopped without admitting another tool', async outcome => {
    const files = new MemoryWorkspaceFiles(), execution = deferred<void>()
    files.executionGate = execution.promise; files.outcome = outcome
    const state = setup({ files })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [
      call('edit_workspace_document', edit()), call('edit_workspace_document', edit('notes/b.md'), 'call_2'),
    ] }))
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await state.service.submitAuthorizationResult({ requestId: REQUEST_ID, operationId: prompt.operationId, allowed: true })
    await vi.waitFor(() => expect(files.executed).toHaveLength(1))
    const cancellation = state.service.cancel(REQUEST_ID)
    execution.resolve()
    await cancellation
    await waitEvent(state.events, 'stopped')
    const terminal = state.events.findIndex(event => event.type === 'process-tool' && event.status === outcome)
    expect(terminal).toBeGreaterThan(-1)
    expect(terminal).toBeLessThan(state.events.findIndex(event => event.type === 'stopped'))
    expect(state.events.filter(event => event.type === 'process-tool').map(event => event.status)).toEqual(['awaiting-approval', 'running', outcome])
    expect(files.executed).toHaveLength(1)
    await state.service.dispose()
  })
  it('keeps the real final answer and completion when the optional display consumer throws', async () => {
    const state = setup({ onEvent(event) { if (event.type.startsWith('process-')) throw new Error('display only') }, streamChat: async input => {
      input.onProcess?.({ kind: 'commentary', itemId: 'p', segmentIndex: 0, delta: 'Display', delivery: 'stream' })
      input.onDelta('Actual answer')
      return result()
    } })
    await state.service.start(startInput())
    await waitEvent(state.events, 'completed')
    expect(state.events.filter(event => event.type === 'delta').map(event => event.delta).join('')).toBe('Actual answer')
    expect(state.events.filter(event => event.type === 'process-stage')).toHaveLength(1)
    expect(state.events.some(event => event.type === 'failed')).toBe(false)
    await state.service.dispose()
  })
  it('orders model text, stages and real cached reads under opaque round ownership', async () => {
    const state = setup()
    const read = call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 })
    let old: ModelChatInput | undefined
    state.streamChat.mockImplementationOnce(async input => {
      old = input
      input.onReasoning?.(true)
      input.onProcess?.({ kind: 'reasoning-summary', itemId: 'PRIVATE_PROVIDER_ID', segmentIndex: 0, delta: 'Readable ', delivery: 'stream' })
      input.onProcess?.({ kind: 'reasoning-summary', itemId: 'PRIVATE_PROVIDER_ID', segmentIndex: 0, delta: 'summary', delivery: 'stream' })
      input.onDelta('Plan')
      return result({ toolCalls: [read], reasoningContent: 'FULL_REPLAY' })
    }).mockImplementationOnce(async input => {
      old!.onProcess?.({ kind: 'commentary', itemId: 'old', segmentIndex: 0, delta: 'LATE_OLD_ROUND', delivery: 'stream' })
      old!.onReasoning?.(true); old!.onDelta('LATE_OLD_ANSWER')
      input.onProcess?.({ kind: 'commentary', itemId: 'PRIVATE_PROVIDER_ID', segmentIndex: 0, delta: 'Again', delivery: 'complete' })
      return result({ toolCalls: [read] })
    }).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')
    const process = state.events.filter(event => event.type.startsWith('process-'))
    expect(process.length).toBeGreaterThan(0)
    expect(process.every(event => parseAiConversationEvent(event) !== undefined)).toBe(true)
    expect(process.map(event => 'sequence' in event ? event.sequence : 0)).toEqual(process.map((_, index) => index + 1))
    const texts = process.filter(event => event.type === 'process-text')
    expect(texts.map(event => event.delta)).toEqual(['Readable summary', 'Again'])
    expect(texts[0]!.itemId).not.toBe('PRIVATE_PROVIDER_ID')
    expect(texts[0]!.itemId).not.toBe(texts[1]!.itemId)
    expect(texts.map(event => event.round)).toEqual([1, 2])
    expect(JSON.stringify(process)).not.toMatch(/PRIVATE_PROVIDER_ID|FULL_REPLAY|LATE_OLD_ROUND/)
    expect(state.events.filter(event => event.type === 'delta').map(event => event.delta)).toEqual(['Plan'])
    const tools = process.filter(event => event.type === 'process-tool')
    expect(tools.map(event => [event.round, event.status, event.cached])).toEqual([[1, 'running', false], [1, 'succeeded', false], [2, 'succeeded', true]])
    expect(state.files.requests.filter(item => item.startsWith('read:'))).toHaveLength(1)
    const firstCompleted = state.events.findIndex(event => event.type === 'message-completed')
    expect(state.events.findIndex(event => event.type === 'process-tool')).toBeGreaterThan(firstCompleted)
    expect(state.events.findIndex(event => event.type === 'process-text')).toBeLessThan(state.events.findIndex(event => event.type === 'delta'))
    expect(state.streamChat.mock.calls[1]![0].messages).toContainEqual(expect.objectContaining({ role: 'assistant', reasoningContent: 'FULL_REPLAY' }))
    await state.service.dispose()
  })
  it.each(['failed', 'cancel'] as const)('flushes accepted text before %s and rejects late provider callbacks', async ending => {
    const gate = deferred<ModelChatResult>(), ready = deferred<ModelChatInput>()
    const state = setup({ streamChat: async input => {
      input.onProcess?.({ kind: 'reasoning-text', itemId: 'r', segmentIndex: 0, delta: 'retained', delivery: 'stream' })
      ready.resolve(input)
      return gate.promise
    } })
    await state.service.start(startInput())
    const input = await ready.promise
    if (ending === 'cancel') await state.service.cancel(REQUEST_ID)
    else gate.reject(new ModelProtocolError('incompatible-response'))
    await waitEvent(state.events, ending === 'cancel' ? 'stopped' : 'failed')
    const textIndex = state.events.findIndex(event => event.type === 'process-text' && event.delta === 'retained')
    expect(textIndex).toBeGreaterThan(-1)
    expect(textIndex).toBeLessThan(state.events.findIndex(event => event.type === 'stopped' || event.type === 'failed'))
    const count = state.events.length
    input.onProcess?.({ kind: 'commentary', itemId: 'late', segmentIndex: 0, delta: 'late', delivery: 'stream' })
    input.onReasoning?.(true); input.onDelta('late answer')
    gate.resolve(result())
    await Promise.resolve()
    expect(state.events).toHaveLength(count)
    await state.service.dispose()
  })
  it.each(['succeeded', 'unknown'] as const)('shows approval before a journal-admitted write and its confirmed %s result', async outcome => {
    const files = new MemoryWorkspaceFiles(); files.outcome = outcome
    const state = setup({ files, onEvent(event) {
      if (event.type === 'process-tool' && event.status === 'running') expect(files.executed).toContain(event.operationId)
    } })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] })).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    expect(state.events.filter(event => event.type === 'process-tool').map(event => event.status)).toEqual(['awaiting-approval'])
    expect(files.executed).toEqual([])
    await state.service.submitAuthorizationResult({ requestId: REQUEST_ID, operationId: prompt.operationId, allowed: true })
    await waitEvent(state.events, 'completed')
    expect(state.events.filter(event => event.type === 'process-tool').map(event => [event.status, event.operationId]))
      .toEqual([['awaiting-approval', prompt.operationId], ['running', prompt.operationId], [outcome, prompt.operationId]])
    await state.service.dispose()
  })
})

describe('AiConversationSessionService', () => {
  it.each(['other-document', 'closed-document', 'selection-changed', 'document-epoch', 'every-action'] as const)(
    'keeps approval protection for %s despite a current document', async boundary => {
      const files = new MemoryWorkspaceFiles()
      Object.assign(files, { isPlannedEditorEdit: () => boundary !== 'closed-document' })
      const gate = deferred<void>()
      files.planGate = gate.promise
      let authority = { path: 'notes/a.md', session: 1 }
      const state = setup({ files, writePolicy: boundary === 'every-action' ? 'ask-every-time' : 'document-grant',
        getCurrentDocumentWriteAuthority: () => authority })
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document',
        edit(boundary === 'other-document' ? 'notes/b.md' : 'notes/a.md'))] })).mockResolvedValueOnce(result())
      const started = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
      await vi.waitFor(() => expect(files.planningStarted).toHaveLength(1))
      if (boundary === 'selection-changed') authority = { path: 'notes/a.md', session: 2 }
      if (boundary === 'document-epoch') await state.service.notifyCurrentDocumentChanged()
      gate.resolve()
      const approval = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      expect(files.executed).toHaveLength(0)
      await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: approval.operationId, allowed: false })
      await waitEvent(state.events, 'completed')
    },
  )

  it('does not turn implicit current-document permission into a retained grant for another selection', async () => {
    const files = new MemoryWorkspaceFiles()
    Object.assign(files, { isPlannedEditorEdit: () => true })
    let authority = { path: 'notes/a.md', session: 1 }
    const state = setup({ files, writePolicy: 'document-grant', getCurrentDocumentWriteAuthority: () => authority })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
      .mockImplementationOnce(async () => {
        authority = { path: 'notes/b.md', session: 2 }
        return result({ toolCalls: [call('edit_workspace_document', edit(), 'call_2')] })
      }).mockResolvedValueOnce(result())
    const started = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const approval = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    expect(files.executed).toHaveLength(1)
    await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: approval.operationId, allowed: false })
    await waitEvent(state.events, 'completed')
  })

  it.each(['failed', 'unknown'] as const)('does not reopen a workspace read series after a %s mutation', async outcome => {
    const state = setup()
    if (outcome === 'unknown') state.files.outcome = 'unknown'
    else vi.spyOn(state.files, 'executeAuthorized').mockRejectedValueOnce(new Error('write failed'))
    state.streamChat
      .mockResolvedValueOnce(result({ toolCalls: [call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 })] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_2')] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 }, 'call_3')] }))
      .mockResolvedValueOnce(result())
    const started = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const approval = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: approval.operationId, allowed: true })
    await waitEvent(state.events, 'completed')
    expect(state.files.requests.filter(item => item.startsWith('read:'))).toHaveLength(1)
    expect(state.streamChat.mock.calls.at(-1)![0].messages.filter(message => message.role === 'tool').at(-1))
      .toMatchObject({ content: JSON.stringify({ kind: 'unavailable' }) })
  })

  it('keeps unmodified read series closed and rejects old continuation cursors after editing another series', async () => {
    const state = setup()
    state.streamChat
      .mockResolvedValueOnce(result({ toolCalls: [
        call('read_workspace_document', { path: 'notes/b.md', cursor: 0, maxChars: 100 }),
        call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 }, 'call_2'),
      ] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_3')] }))
      .mockResolvedValueOnce(result({ toolCalls: [
        call('read_workspace_document', { path: 'notes/b.md', cursor: 0, maxChars: 100 }, 'call_4'),
        call('read_workspace_document', { path: 'notes/a.md', cursor: 1, maxChars: 100 }, 'call_5'),
      ] })).mockResolvedValueOnce(result())
    const started = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const approval = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: approval.operationId, allowed: true })
    await waitEvent(state.events, 'completed')
    expect(state.files.requests.filter(item => item === 'read:notes/b.md')).toHaveLength(1)
    const finalTools = state.streamChat.mock.calls.at(-1)![0].messages.filter(message => message.role === 'tool').slice(-2)
    expect(finalTools.map(message => message.content)).toEqual([
      JSON.stringify({ kind: 'unavailable' }), JSON.stringify({ kind: 'unavailable' }),
    ])
  })

  it('edits the main-owned current editor under document-grant without an approval request', async () => {
    const files = new MemoryWorkspaceFiles()
    Object.assign(files, { isPlannedEditorEdit: () => true })
    const state = setup({ files, writePolicy: 'document-grant',
      getCurrentDocumentWriteAuthority: () => ({ path: 'notes/a.md', session: 1 }) })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
      .mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    try {
      await vi.waitFor(() => expect(files.executed).toHaveLength(1))
      await waitEvent(state.events, 'completed')
      expect(state.events.some(event => event.type === 'authorization-requested')).toBe(false)
    } finally { await state.service.dispose() }
  })

  it.each([
    ['planning', 'STALE_TARGET'], ['execution', 'STALE_TARGET'],
    ['planning', 'AI_FILE_CHANGED'], ['execution', 'AI_FILE_CHANGED'],
  ] as const)('allows a fresh read after a stale %s version (%s) without reopening unrelated series', async (stage, code) => {
    const files = new MemoryWorkspaceFiles()
    const readDocument = files.readDocument.bind(files)
    files.readDocument = async (input, signal) => {
      const page = await readDocument(input, signal)
      return { ...page, content: page.content.slice(input.cursor, input.cursor + input.maxChars),
        version: files.readContent === 'text' ? VERSION_A : VERSION_B }
    }
    const stale = () => {
      files.readContent = '# User revision'
      throw new WorkspaceAiFileError(code, 'Private exception C:\\private\\secret.md')
    }
    if (stage === 'planning') files.planEdit = async () => stale()
    else files.executeAuthorized = async () => stale()
    const state = setup({ files })
    state.streamChat
      .mockResolvedValueOnce(result({ toolCalls: [
        call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 }),
        call('read_workspace_document', { path: 'notes/b.md', cursor: 0, maxChars: 100 }, 'call_2'),
      ] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_3')] }))
      .mockResolvedValueOnce(result({ toolCalls: [
        call('read_workspace_document', { path: 'notes/a.md', cursor: 1, maxChars: 100 }, 'call_4'),
        call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 }, 'call_5'),
        call('read_workspace_document', { path: 'notes/b.md', cursor: 0, maxChars: 100 }, 'call_6'),
      ] }))
      .mockResolvedValueOnce(result())
    try {
      const started = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
      if (stage === 'execution') {
        const approval = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
        await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: approval.operationId, allowed: true })
      }
      await waitEvent(state.events, 'completed')
      const conflict = JSON.parse(state.streamChat.mock.calls[2]![0].messages.filter(message => message.role === 'tool').at(-1)!.content)
      expect(conflict).toEqual({
        ...(stage === 'planning' ? { kind: 'unavailable' } : {
          kind: 'mutation', operationId: OPERATION_IDS[0], state: 'failed', paths: ['notes/a.md'],
        }),
        reason: 'target-changed',
        guidance: 'The target changed. Read the affected document again from cursor 0 and use the newly returned version before requesting a new write.',
      })
      expect(parseWorkspaceToolResult('edit_workspace_document', conflict)).toEqual(conflict)
      expect(JSON.stringify(state.streamChat.mock.calls[2]![0].messages)).not.toContain('private')
      const tools = state.streamChat.mock.calls.at(-1)![0].messages.filter(message => message.role === 'tool').slice(-3)
      expect(tools.map(message => JSON.parse(message.content))).toEqual([
        { kind: 'unavailable' },
        { kind: 'document', path: 'notes/a.md', displayName: 'a.md', sourceFormat: 'md',
          cursor: 0, content: '# User revision', nextCursor: null, hasMore: false,
          totalChars: 15, version: VERSION_B },
        { kind: 'unavailable' },
      ])
      expect(state.events.filter(event => event.type === 'audit' && event.action === 'edited')).toEqual([])
    } finally { await state.service.dispose() }
  })

  it.each([
    ['spoofed-stale', Object.assign(new Error('private error'), { code: 'STALE_TARGET' }), 'failed'],
    ['invalid-path', new WorkspaceAiFileError('AI_INVALID_PATH', 'private error'), 'failed'],
    ['unknown-commit', new AiOperationOutcomeUnknownError(), 'unknown'],
  ] as const)('does not expose stale retry guidance for %s', async (_kind, error, terminal) => {
    const files = new MemoryWorkspaceFiles()
    files.executeAuthorized = async () => { throw error }
    const state = setup({ files, writePolicy: 'workspace-grant' })
    state.streamChat
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
      .mockResolvedValueOnce(result())
    try {
      await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
      await waitEvent(state.events, 'completed')
      const response = JSON.parse(state.streamChat.mock.calls[1]![0].messages.filter(message => message.role === 'tool').at(-1)!.content)
      expect(response).toEqual({ kind: 'mutation', operationId: OPERATION_IDS[0],
        state: terminal, paths: ['notes/a.md'] })
    } finally { await state.service.dispose() }
  })

  it('releases an obsolete current snapshot after a stale edit and rereads the current revision', async () => {
    const first = snapshot('a.md', 'old remaining content', VERSION_A)
    let current = first
    const files = new MemoryWorkspaceFiles()
    files.planEdit = async () => {
      current = snapshot('a.md', '# User revision', VERSION_B)
      throw new WorkspaceAiFileError('STALE_TARGET', 'The editor changed')
    }
    const state = setup({ files, openCurrentDocument: async () => current,
      getCurrentDocumentWriteAuthority: () => ({ path: 'notes/a.md', session: 1 }) })
    state.streamChat
      .mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 3 })] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_2')] }))
      .mockResolvedValueOnce(result({ toolCalls: [
        call('read_current_document', { cursor: 3, maxChars: 100 }, 'call_3'),
        call('read_current_document', { cursor: 0, maxChars: 100 }, 'call_4'),
      ] }))
      .mockResolvedValueOnce(result())
    try {
      await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: true } }))
      await waitEvent(state.events, 'completed')
      const tools = state.streamChat.mock.calls.at(-1)![0].messages.filter(message => message.role === 'tool').slice(-2)
      expect(tools.map(message => JSON.parse(message.content))).toEqual([
        { kind: 'unavailable' },
        { kind: 'document', displayName: 'a.md', sourceFormat: 'markdown', dirty: true,
          cursor: 0, content: '# User revision', nextCursor: null, hasMore: false,
          totalChars: 15, version: VERSION_B },
      ])
    } finally { await state.service.dispose() }
  })

  it('reopens the affected workspace read series after a verified successful edit', async () => {
    const state = setup()
    state.streamChat
      .mockResolvedValueOnce(result({ toolCalls: [call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 })] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_2')] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 }, 'call_3')] }))
      .mockResolvedValueOnce(result())
    const started = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const approval = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    state.files.readContent = '# New heading'
    await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: approval.operationId, allowed: true })
    await waitEvent(state.events, 'completed')
    expect(state.files.requests.filter(item => item.startsWith('read:'))).toHaveLength(2)
    expect(state.streamChat.mock.calls.at(-1)![0].messages.filter(message => message.role === 'tool').at(-1))
      .toMatchObject({ content: expect.stringContaining('# New heading') })
  })

  it('releases a partially read current snapshot when that main-owned document is edited', async () => {
    const first = snapshot('a.md', 'old remaining content', VERSION_A)
    const release = vi.spyOn(first, 'release')
    let content = first
    const state = setup({ getCurrentDocumentWriteAuthority: () => ({ path: 'notes/a.md', session: 1 }),
      openCurrentDocument: async () => content })
    state.streamChat
      .mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 3 })] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_2')] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 100 }, 'call_3')] }))
      .mockResolvedValueOnce(result())
    const started = await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: true } }))
    const approval = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    content = snapshot('a.md', '# New heading', VERSION_B)
    await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: approval.operationId, allowed: true })
    await waitEvent(state.events, 'completed')
    expect(release).toHaveBeenCalledOnce()
    expect(state.openCurrentDocument).toHaveBeenCalledTimes(2)
    expect(state.streamChat.mock.calls.at(-1)![0].messages.filter(message => message.role === 'tool').at(-1))
      .toMatchObject({ content: expect.stringContaining('# New heading') })
  })

  it('invalidates the submitted A snapshot after switching to B and explicitly approving an edit to A', async () => {
    const first = snapshot('a.md', 'old remaining content', VERSION_A)
    const release = vi.spyOn(first, 'release')
    let releasedBeforeContinuation = false
    let authority = { path: 'notes/a.md', session: 1 }
    const state = setup({ getCurrentDocumentWriteAuthority: () => authority,
      openCurrentDocument: async () => first, writePolicy: 'document-grant' })
    state.streamChat
      .mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 3 })] }))
      .mockImplementationOnce(async () => {
        authority = { path: 'notes/b.md', session: 2 }
        await state.service.notifyCurrentDocumentChanged()
        return result({ toolCalls: [call('edit_workspace_document', edit(), 'call_2')] })
      })
      .mockImplementationOnce(async () => {
        releasedBeforeContinuation = release.mock.calls.length === 1
        return result({ toolCalls: [
          call('read_current_document', { cursor: 3, maxChars: 100 }, 'call_3'),
          call('read_current_document', { cursor: 0, maxChars: 100 }, 'call_4'),
        ] })
      }).mockResolvedValueOnce(result())
    const started = await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: true } }))
    const approval = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    expect(approval.paths).toEqual(['notes/a.md'])
    await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: approval.operationId, allowed: true })
    await waitEvent(state.events, 'completed')
    expect(state.files.executed).toHaveLength(1)
    expect(state.openCurrentDocument).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(state.streamChat.mock.calls.at(-1)![0].messages.filter(message => message.role === 'tool').slice(-2)
      .map(message => message.content)).toEqual([
        JSON.stringify({ kind: 'unavailable' }), JSON.stringify({ kind: 'unavailable' }),
      ])
    expect(releasedBeforeContinuation).toBe(true)
  })

  it.each(['failed', 'unknown', 'other-document'] as const)(
    'preserves the current snapshot when an edit is %s', async boundary => {
      const first = snapshot('a.md', 'old remaining content', VERSION_A)
      const state = setup({ getCurrentDocumentWriteAuthority: () => ({ path: 'notes/a.md', session: 1 }),
        openCurrentDocument: async () => first })
      if (boundary === 'unknown') state.files.outcome = 'unknown'
      if (boundary === 'failed') vi.spyOn(state.files, 'executeAuthorized').mockRejectedValueOnce(new Error('write failed'))
      state.streamChat
        .mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 3 })] }))
        .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document',
          edit(boundary === 'other-document' ? 'notes/b.md' : 'notes/a.md'), 'call_2')] }))
        .mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 3, maxChars: 100 }, 'call_3')] }))
        .mockResolvedValueOnce(result())
      const started = await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: true } }))
      const approval = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: approval.operationId, allowed: true })
      await waitEvent(state.events, 'completed')
      expect(state.openCurrentDocument).toHaveBeenCalledOnce()
      expect(state.streamChat.mock.calls.at(-1)![0].messages.filter(message => message.role === 'tool').at(-1))
        .toMatchObject({ content: expect.stringContaining(' remaining content') })
    },
  )

  it.each(['model', 'effort', 'workspace'] as const)('accepts fresh document intent after %s changes and still executes only a fresh document read', async (change) => {
    const state = setup({ openCurrentDocument: async () => snapshot('note.md', 'fresh contents', VERSION_A) })
    state.streamChat.mockImplementationOnce(async (input) => { input.onDelta('first answer'); return result() })
    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
    await waitEvent(state.events, 'completed')
    if (change === 'model') state.models.connections[0] = connection({ modelId: 'replacement-model' })
    if (change === 'effort') state.models.aiConversation.reasoningEffort = 'high'
    if (change === 'workspace') {
      const ticket = await state.service.prepareWorkspaceSwitch()
      state.files.rootGeneration = '2.generation'
      state.files.activationEpoch = 2
      await state.service.activateWorkspace(ticket, await state.files.getRootCapability())
    }
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 20 })] }))
      .mockResolvedValueOnce(result())
    await state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'read this document' }],
      capabilities: { currentDocument: true, workspace: false } }))
    await waitEvent(state.events, 'completed', 2)
    expect(state.openCurrentDocument).toHaveBeenCalledOnce()
    expect(state.streamChat.mock.calls.at(-1)![0].messages).toContainEqual(expect.objectContaining({
      role: 'tool', name: 'read_current_document', content: expect.stringContaining('fresh contents'),
    }))
  })

  it.each([true, false])('rejects a late start whose credential preflight overlapped an explicit document denial (previous authority %s)', async (previousAuthority) => {
    const credentials = vi.fn(async () => ({ connection: connection(), apiKey: 'key' }))
    const state = setup({ getCredentialSnapshot: credentials })
    await state.service.start(startInput({ capabilities: { currentDocument: previousAuthority, workspace: false } }))
    await waitEvent(state.events, 'completed')
    const gate = deferred<{ connection: ModelConnectionSummary; apiKey: string }>()
    credentials.mockReturnValueOnce(gate.promise)
    const starting = state.service.start(continuedInput(state.events, { requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'stale intent' }],
      capabilities: { currentDocument: true, workspace: false } }))
    await vi.waitFor(() => expect(credentials).toHaveBeenCalledTimes(2))
    state.service.setCapabilities({ ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
      conversationId: CONVERSATION_ID, capabilities: { currentDocument: false, workspace: false } })
    gate.resolve({ connection: connection(), apiKey: 'key' })
    await expect(starting).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(state.streamChat).toHaveBeenCalledOnce()
  })
  it('retains only allowlisted actionable denial guidance in validated tool results', () => {
    expect(parseWorkspaceToolResult('read_current_document', { kind: 'denied', guidance: '请开启“AI 可查看文档”。' }))
      .toEqual({ kind: 'denied', guidance: '请开启“AI 可查看文档”。' })
    expect(parseWorkspaceToolResult('create_workspace_document', { kind: 'denied', guidance: '创建、重命名或删除文档需要选择“每次询问”或“按工作区许可”。' }))
      .toEqual({ kind: 'denied', guidance: '创建、重命名或删除文档需要选择“每次询问”或“按工作区许可”。' })
    expect(parseWorkspaceToolResult('read_workspace_document', { kind: 'denied', guidance: '请开启“AI 可查看工作区”。' }))
      .toEqual({ kind: 'denied', guidance: '请开启“AI 可查看工作区”。' })
    expect(parseWorkspaceToolResult('read_workspace_document', { kind: 'denied', guidance: 'arbitrary provider instruction' })).toBeUndefined()
    expect(parseWorkspaceToolResult('read_workspace_document', { kind: 'denied', guidance: '请开启“AI 可查看工作区”。', absolutePath: 'C:\\private' })).toBeUndefined()
  })

  it('accepts only a user delta at the acknowledged revision and preserves assistant whitespace by message boundary', async () => {
    const state = setup({ streamChat: async (input) => {
      input.onDelta('\n answer \n')
      return result()
    } })
    const first = await state.service.start(startInput())
    expect(first.transcriptRevision).toBe(1)
    const completed = await waitEvent(state.events, 'message-completed') as Extract<AiConversationEvent, { type: 'message-completed' }>
    expect(completed.transcriptRevision).toBe(2)
    expect(state.events).toContainEqual({
      requestId: REQUEST_ID, type: 'message-start', messageId: completed.messageId,
      previousTranscriptRevision: 1,
    })
    expect(state.events).toContainEqual({
      requestId: REQUEST_ID, type: 'delta', messageId: completed.messageId, delta: '\n answer \n',
    })

    await expect(state.service.start(startInput({
      requestId: SECOND_REQUEST_ID,
      acknowledgedTranscriptRevision: 1,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'stale' }],
    }))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await state.service.start(startInput({
      requestId: THIRD_REQUEST_ID,
      acknowledgedTranscriptRevision: 2,
      messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'next' }],
    }))
    await vi.waitFor(() => expect(
      state.events.filter((event) => event.type === 'completed'), JSON.stringify(state.events),
    ).toHaveLength(2))
    expect(state.streamChat.mock.calls[1]![0].messages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: '\n answer \n', reasoningContent: '' },
      { role: 'user', content: 'next' },
    ]))
  })

  it('rejects a stale transcript acknowledgement without canceling the valid active request', async () => {
    const running = deferred<ModelChatResult>()
    const state = setup({ streamChat: () => running.promise })
    await state.service.start(startInput())
    await waitEvent(state.events, 'started')

    await expect(state.service.start(startInput({
      requestId: SECOND_REQUEST_ID,
      acknowledgedTranscriptRevision: 0,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'stale overlap' }],
    }))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(state.streamChat.mock.calls[0]![0].signal.aborted).toBe(false)

    running.resolve(result())
    await waitEvent(state.events, 'completed')
  })

  it('supports 101 incremental turns and more than 48k cumulative visible text without history retransmission', async () => {
    const state = setup({ streamChat: async (input) => { input.onDelta('ok'); return result() } })
    let revision = 0
    for (let index = 0; index < 101; index += 1) {
      const suffix = index.toString(16).padStart(12, '0')
      const started = await state.service.start(startInput({
        requestId: `750e8400-e29b-41d4-a716-${suffix}`,
        acknowledgedTranscriptRevision: revision,
        messages: [{
          id: `850e8400-e29b-41d4-a716-${suffix}`,
          role: 'user', content: `${index}:`.padEnd(500, 'x'),
        }],
      }))
      expect(started.transcriptRevision).toBe(revision + 1)
      await waitEvent(state.events, 'completed', index + 1)
      const message = state.events.filter((event): event is Extract<AiConversationEvent, { type: 'message-completed' }> => (
        event.type === 'message-completed'
      )).at(-1)!
      revision = message.transcriptRevision
    }
    expect(revision).toBe(202)
    expect(state.streamChat).toHaveBeenCalledTimes(101)
  }, 15_000)

  it('keeps natural conversation history when the current document changes', async () => {
    const { service, events, streamChat } = setup()
    streamChat.mockImplementationOnce(async (input) => { input.onDelta('First answer'); return result() })
      .mockImplementationOnce(async (input) => { input.onDelta('Second answer'); return result() })
    await service.start(startInput())
    await waitEvent(events, 'completed')
    await service.notifyCurrentDocumentChanged()
    await service.start(continuedInput(events, { messages: [
      { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
      { id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue.' },
    ], requestId: SECOND_REQUEST_ID }))
    await waitEvent(events, 'completed', 2)
    expect(streamChat.mock.calls[1]![0].messages).toEqual(expect.arrayContaining([
      { role: 'user', content: 'Please help.' },
      { role: 'assistant', content: 'First answer', reasoningContent: '', providerReplay: undefined },
      { role: 'user', content: 'Continue.' },
    ]))
    expect(streamChat.mock.calls[0]![0].tools).toEqual([])
    const secondMessages = streamChat.mock.calls[1]![0].messages
    expect(secondMessages.slice(-2)).toEqual([
      { role: 'system', content: '当前文档已改变，本次任务如依赖其内容，请重新读取。' },
      { role: 'user', content: 'Continue.' },
    ])
    expect(secondMessages.filter((message) => message.content === '当前文档已改变，本次任务如依赖其内容，请重新读取。')).toHaveLength(1)
    await service.start(continuedInput(events, {
      requestId: THIRD_REQUEST_ID, messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'Again.' }],
    }))
    await waitEvent(events, 'completed', 3)
    expect(streamChat.mock.calls[2]![0].messages.filter((message) => message.content === '当前文档已改变，本次任务如依赖其内容，请重新读取。')).toEqual([])
  })

  it('collapses document changes and retains the notice after a failed start', async () => {
    const credentials = vi.fn(async () => ({ connection: connection(), apiKey: 'api-key' }))
    const state = setup({ getCredentialSnapshot: credentials })
    await state.service.start(startInput())
    await waitEvent(state.events, 'completed')
    await state.service.notifyCurrentDocumentChanged()
    await state.service.notifyCurrentDocumentChanged()
    credentials.mockRejectedValueOnce(new Error('unavailable'))
    await expect(state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID, messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Retry me.' }],
    }))).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await state.service.start(continuedInput(state.events, {
      requestId: THIRD_REQUEST_ID, messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Retry me.' }],
    }))
    await waitEvent(state.events, 'completed', 2)
    expect(state.streamChat.mock.calls.at(-1)![0].messages.slice(-2)).toEqual([
      { role: 'system', content: '当前文档已改变，本次任务如依赖其内容，请重新读取。' },
      { role: 'user', content: 'Retry me.' },
    ])
    expect(state.streamChat.mock.calls.at(-1)![0].messages.filter((message) => message.content === '当前文档已改变，本次任务如依赖其内容，请重新读取。')).toHaveLength(1)
    expect(state.openCurrentDocument).not.toHaveBeenCalled()
  })

  it('restores a pending document notice after a committed turn fails at the provider', async () => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new ModelProtocolError('invalid-endpoint'))
    await state.service.start(startInput())
    await waitEvent(state.events, 'completed')
    await state.service.notifyCurrentDocumentChanged()
    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID, messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Use document B.' }],
    }))
    await waitEvent(state.events, 'failed')
    expect(state.streamChat.mock.calls[1]![0].messages.at(-2)).toEqual({ role: 'system', content: '当前文档已改变，本次任务如依赖其内容，请重新读取。' })
    await state.service.start(continuedInput(state.events, {
      requestId: THIRD_REQUEST_ID, messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'Retry document B.' }],
    }))
    await waitEvent(state.events, 'completed', 2)
    const retryMessages = state.streamChat.mock.calls[2]![0].messages
    expect(retryMessages.slice(-2)).toEqual([
      { role: 'system', content: '当前文档已改变，本次任务如依赖其内容，请重新读取。' },
      { role: 'user', content: 'Retry document B.' },
    ])
    expect(retryMessages.filter((message) => message.content === '当前文档已改变，本次任务如依赖其内容，请重新读取。')).toHaveLength(1)
    await state.service.start(continuedInput(state.events, {
      requestId: '550e8400-e29b-41d4-a716-446655440008',
      messages: [{ id: '550e8400-e29b-41d4-a716-446655440009', role: 'user', content: 'Continue.' }],
    }))
    await waitEvent(state.events, 'completed', 3)
    expect(state.streamChat.mock.calls[3]![0].messages.some((message) => message.content === '当前文档已改变，本次任务如依赖其内容，请重新读取。')).toBe(false)
  })

  it('preserves a completed turn while its current-document snapshot cleanup is pending', async () => {
    const releaseEntered = deferred<void>()
    const releaseGate = deferred<void>()
    const opened: AiCurrentDocumentSnapshot = {
      async readPage() {
        return {
          kind: 'document', displayName: 'b.md', sourceFormat: 'markdown', dirty: true,
          cursor: 0, content: '0123456789', nextCursor: 10, hasMore: true,
          totalChars: 20, version: { ...VERSION_B, size: 20 },
        }
      },
      release: vi.fn(async () => {
        releaseEntered.resolve()
        await releaseGate.promise
      }),
    }
    const state = setup({ openCurrentDocument: async () => opened })
    state.streamChat.mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 10 })] }))
      .mockImplementationOnce(async (input) => {
        input.onDelta('Document B answer.')
        return result({ reasoningContent: 'Document B reasoning.' })
      })
    try {
      await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
      await waitEvent(state.events, 'completed')
      await state.service.notifyCurrentDocumentChanged()
      await state.service.start(continuedInput(state.events, {
        requestId: SECOND_REQUEST_ID,
        messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Use document B.' }],
        capabilities: { currentDocument: true, workspace: false },
      }))
      await waitEvent(state.events, 'completed', 2)
      await settlesWithin(releaseEntered.promise)
      expect(state.streamChat.mock.calls[1]![0].messages.slice(-2)).toEqual([
        { role: 'system', content: '当前文档已改变，本次任务如依赖其内容，请重新读取。' },
        { role: 'user', content: 'Use document B.' },
      ])

      await state.service.start(continuedInput(state.events, {
        requestId: THIRD_REQUEST_ID,
        messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'Continue with that answer.' }],
      }))
      await waitEvent(state.events, 'completed', 3)
      const nextMessages = state.streamChat.mock.calls[3]![0].messages
      expect.soft(nextMessages.filter((message) => message.content === '当前文档已改变，本次任务如依赖其内容，请重新读取。')).toEqual([])
      expect.soft(nextMessages).toEqual(expect.arrayContaining([
        { role: 'user', content: 'Use document B.' },
        expect.objectContaining({
          role: 'assistant', content: 'Document B answer.', reasoningContent: 'Document B reasoning.',
        }),
        expect.objectContaining({ role: 'tool', name: 'read_current_document', toolCallId: 'call_1' }),
      ]))
      expect(opened.release).toHaveBeenCalledOnce()
    } finally {
      releaseGate.resolve()
      await state.service.dispose()
    }
  })

  it('includes document changes that arrive while the next turn is still compacting', async () => {
    const summaryGate = deferred<void>()
    const state = setup({ models: modelSettings(connection({ provider: 'other', modelId: 'custom-chat',
      capabilityOverride: { contextWindowTokens: 100_000, maxInputTokens: 100_000, maxOutputTokens: 32_768 },
    })), streamChat: async (input) => {
      if (input.requestedOutputTokens === 16_384) {
        await summaryGate.promise
        input.onDelta(JSON.stringify({ version: 1, userGoals: ['continue'], decisions: [], workspaceFacts: [],
          unresolvedQuestions: [], nextSteps: [], retainedToolFacts: [], completedOperationIds: [] }))
      } else input.onDelta('ok')
      return result()
    } })
    await state.service.start(startInput({ messages: [{ id: MESSAGE_ID, role: 'user', content: 'a'.repeat(25_000) }] }))
    await waitEvent(state.events, 'completed')
    const pending = state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID, messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'b'.repeat(10_000) }],
    }))
    await vi.waitFor(() => expect(state.streamChat.mock.calls.some(([input]) => input.requestedOutputTokens === 16_384)).toBe(true))
    await state.service.notifyCurrentDocumentChanged()
    await state.service.notifyCurrentDocumentChanged()
    summaryGate.resolve()
    await pending
    await waitEvent(state.events, 'completed', 2)
    expect(state.streamChat.mock.calls.at(-1)![0].messages.at(-2)).toEqual({ role: 'system', content: '当前文档已改变，本次任务如依赖其内容，请重新读取。' })
    await state.service.start(continuedInput(state.events, {
      requestId: THIRD_REQUEST_ID, messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'next' }],
    }))
    await waitEvent(state.events, 'completed', 3)
    expect(state.streamChat.mock.calls.at(-1)![0].messages.some((message) => message.content === '当前文档已改变，本次任务如依赖其内容，请重新读取。')).toBe(false)
  })

  it.each([
    ['read_current_document', { cursor: 0, maxChars: 10 }, '请开启“AI 可查看文档”。'],
    ['list_workspace_entries', { path: '', cursor: 0, maxEntries: 10, directoryVersion: null }, '请开启“AI 可查看工作区”。'],
  ] as const)('tells a disabled %s caller the exact capability control to enable', async (name, args, guidance) => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(name, args)] }))
    await state.service.start(startInput())
    await waitEvent(state.events, 'completed')
    const reply = state.streamChat.mock.calls[1]![0].messages.find((message) => message.role === 'tool')!
    expect(JSON.parse(reply.content)).toEqual({ kind: 'denied', guidance })
    expect(state.files.requests).toEqual([])
    expect(state.openCurrentDocument).not.toHaveBeenCalled()
  })

  it.each([
    ['read_current_document', '{"cursor":0,"maxChars":10}', '请开启“AI 可查看文档”。'],
    ['list_workspace_entries', '{"path":"","cursor":0,"maxEntries":10,"directoryVersion":null}', '请开启“AI 可查看工作区”。'],
  ] as const)('returns disabled %s guidance through the real DeepSeek JSON protocol path', async (name, argumentsJson, guidance) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-disabled', object: 'chat.completion', model: 'deepseek-v4-pro',
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{
          id: 'call_disabled', type: 'function', function: { name, arguments: argumentsJson },
        }] }, finish_reason: 'tool_calls' }],
      }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{
        message: { role: 'assistant', content: guidance }, finish_reason: 'stop',
      }] }), { headers: { 'content-type': 'application/json' } }))
    const client = createModelProtocolClient(fetchImpl)
    const state = setup({ streamChat: (input) => client.streamChat(input) })
    await state.service.start(startInput())
    await vi.waitFor(() => expect(state.events.some((event) => event.type === 'completed' || event.type === 'failed')).toBe(true))
    expect(state.events.filter((event) => event.type === 'failed')).toEqual([])
    expect(state.events).toContainEqual(expect.objectContaining({ type: 'delta', delta: guidance }))
    const initialBody = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))
    expect(initialBody).not.toHaveProperty('tools')
    expect(initialBody).not.toHaveProperty('recognizedToolNames')
    const continuationBody = JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body))
    expect(continuationBody.messages).toContainEqual({
      role: 'tool', tool_call_id: 'call_disabled', content: JSON.stringify({ kind: 'denied', guidance }),
    })
    expect(state.files.requests).toEqual([])
    expect(state.openCurrentDocument).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown tool', 'execute_shell', '{}'],
    ['malformed JSON', 'read_current_document', '{'],
    ['non-object JSON', 'read_current_document', '[]'],
    ['invalid cursor', 'read_current_document', '{"cursor":-1,"maxChars":10}'],
    ['extra argument', 'read_current_document', '{"cursor":0,"maxChars":10,"absolutePath":"C:\\\\private"}'],
  ] as const)('still rejects %s through the real protocol with capabilities disabled', async (_label, name, argumentsJson) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{
      message: { role: 'assistant', content: null, tool_calls: [{
        id: 'call_invalid', type: 'function', function: { name, arguments: argumentsJson },
      }] }, finish_reason: 'tool_calls',
    }] }), { headers: { 'content-type': 'application/json' } }))
    const client = createModelProtocolClient(fetchImpl)
    const state = setup({ streamChat: (input) => client.streamChat(input) })
    await state.service.start(startInput())
    const failed = await waitEvent(state.events, 'failed')
    expect(failed).toMatchObject({ code: 'MODEL_INCOMPATIBLE_RESPONSE' })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(state.files.requests).toEqual([])
    expect(state.openCurrentDocument).not.toHaveBeenCalled()
  })

  it('opens the active document on demand and keeps pagination on that snapshot', async () => {
    let active = snapshot('first.md', 'abcdef', VERSION_A)
    const { service, events, openCurrentDocument, streamChat } = setup({ openCurrentDocument: async () => active })
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 3 })] }))
      .mockImplementationOnce(async () => { active = snapshot('second.md', 'uvwxyz', VERSION_B)
        return result({ toolCalls: [call('read_current_document', { cursor: 3, maxChars: 3 }, 'call_2')] }) })
      .mockResolvedValueOnce(result())
    await service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
    await waitEvent(events, 'completed')
    expect(openCurrentDocument).toHaveBeenCalledOnce()
    const pages = streamChat.mock.calls[2]![0].messages.filter((message) => message.role === 'tool')
      .map((message) => JSON.parse(message.content))
    expect(pages).toMatchObject([
      { displayName: 'first.md', cursor: 0, content: 'abc', version: VERSION_A },
      { displayName: 'first.md', cursor: 3, content: 'def', version: VERSION_A },
    ])
  })

  it('rejects a current-document read when the document changed after submission but before the tool call', async () => {
    const state = setup({ openCurrentDocument: async () => snapshot('B.md', 'unrelated B secret', VERSION_B) })
    state.streamChat.mockImplementationOnce(async () => {
      state.service.notifyCurrentDocumentChanged()
      return result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 100 })] })
    }).mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
    await waitEvent(state.events, 'completed')
    const tools = state.streamChat.mock.calls[1]![0].messages.filter((message) => message.role === 'tool')
    expect(tools.map((message) => JSON.parse(message.content))).toEqual([{ kind: 'unavailable' }])
    expect(JSON.stringify(state.streamChat.mock.calls)).not.toContain('unrelated B secret')
    expect(state.openCurrentDocument).not.toHaveBeenCalled()
  })

  it('carries the submitted source identity through the actual snapshot call without adding provider metadata', async () => {
    const sourceId = 'd30496c8-1725-4eab-ab59-b3152de3e938'
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 100 })] }))
      .mockResolvedValueOnce(result())
    await state.service.start(startInput({ expectedDocumentId: sourceId,
      capabilities: { currentDocument: true, workspace: false } }))
    await waitEvent(state.events, 'completed')
    expect(state.openCurrentDocument).toHaveBeenCalledWith(expect.objectContaining({ expectedDocumentId: sourceId }))
    expect(JSON.stringify(state.streamChat.mock.calls)).not.toContain(sourceId)
  })

  it('does not guess a current document for multiple quoted sources', async () => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 100 })] }))
      .mockResolvedValueOnce(result())
    await state.service.start(startInput({ expectedDocumentId: null,
      capabilities: { currentDocument: true, workspace: false } }))
    await waitEvent(state.events, 'completed')
    expect(state.openCurrentDocument).not.toHaveBeenCalled()
    const tools = state.streamChat.mock.calls[1]![0].messages.filter((message) => message.role === 'tool')
    expect(tools.map((message) => JSON.parse(message.content))).toEqual([{ kind: 'unavailable' }])
  })

  it.each([128_000, 256_000])('starts workspace access after a complete document turn with a %i-token profile', async (contextWindowTokens) => {
    const models = modelSettings(connection({
      provider: 'other', modelId: 'gpt-5-arkdown-ai-e2e',
      capabilityOverride: { contextWindowTokens, maxInputTokens: 95_000, maxOutputTokens: 32_768 },
    }))
    models.aiConversation.reasoningEffort = 'high'
    const state = setup({
      models,
      openCurrentDocument: async () => snapshot('b.md', '# B\n\nUNSAVED-B-a41c', VERSION_B),
    })
    state.streamChat
      .mockImplementationOnce(async (input) => {
        input.onDelta('LOOPBACK_CHAT_OK:E2E_SESSION_MARKER_WORKSPACE_A')
        return result({ usage: { inputTokens: 120, outputTokens: 10, totalTokens: 130, cachedInputTokens: 0, estimated: false } })
      })
      .mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 48_000 })] }))
      .mockImplementationOnce(async (input) => {
        input.onDelta('LOOPBACK_READ_OK:UNSAVED-B-a41c')
        return result({ usage: { inputTokens: 23_400, outputTokens: 10, totalTokens: 23_410, cachedInputTokens: 0, estimated: false } })
      })
      .mockResolvedValueOnce(result())

    await state.service.start(startInput())
    await waitEvent(state.events, 'completed')
    state.service.setCapabilities({
      ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
      conversationId: CONVERSATION_ID,
      capabilities: { currentDocument: true, workspace: false },
    })
    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Read the current document.' }],
      capabilities: { currentDocument: true, workspace: false },
    }))
    await waitEvent(state.events, 'completed', 2)
    expect(state.streamChat).toHaveBeenCalledTimes(3)
    state.service.setCapabilities({
      ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
      conversationId: CONVERSATION_ID,
      capabilities: { currentDocument: true, workspace: true },
    })
    state.settings.setWritePolicy('ask-every-time')

    await expect(state.service.start(continuedInput(state.events, {
      requestId: THIRD_REQUEST_ID,
      messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'Read and edit b.md.' }],
      capabilities: { currentDocument: true, workspace: true },
    }))).resolves.toMatchObject({ requestId: THIRD_REQUEST_ID })
    await waitEvent(state.events, 'completed', 3)
    expect(state.streamChat).toHaveBeenCalledTimes(4)
  })

  it('keeps an accepted immutable snapshot across a same-workspace document switch', async () => {
    let released = false
    const release = vi.fn(() => { released = true })
    const opened: AiCurrentDocumentSnapshot = {
      async readPage(input) {
        if (released) throw new Error('released snapshot cannot be read')
        const content = 'abcdef'.slice(input.cursor, input.cursor + input.maxChars)
        const nextCursor = input.cursor + content.length < 6 ? input.cursor + content.length : null
        return {
          kind: 'document', displayName: 'old.md', sourceFormat: 'markdown', dirty: true,
          cursor: input.cursor, content, nextCursor, hasMore: nextCursor !== null,
          totalChars: 6, version: VERSION_A,
        }
      },
      release,
    }
    const state = setup({ openCurrentDocument: async () => opened })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
      'read_current_document', { cursor: 0, maxChars: 3 },
    )] })).mockImplementationOnce(async () => {
      await state.service.notifyCurrentDocumentChanged()
      return result({ toolCalls: [call(
        'read_current_document', { cursor: 3, maxChars: 3 }, 'call_2',
      )] })
    }).mockResolvedValueOnce(result())

    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
    await waitEvent(state.events, 'completed')

    const pages = state.streamChat.mock.calls[2]![0].messages
      .filter((message) => message.role === 'tool')
      .map((message) => JSON.parse(message.content))
    expect(pages).toMatchObject([
      { displayName: 'old.md', cursor: 0, content: 'abc', version: VERSION_A },
      { displayName: 'old.md', cursor: 3, content: 'def', version: VERSION_A },
    ])
    expect(state.openCurrentDocument).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('releases a natural EOF immediately and refuses a switched document in the same request', async () => {
    const first = Object.assign(snapshot('first.md', 'one', VERSION_A), {
      snapshotId: 'main-only-first-snapshot', release: vi.fn(),
    })
    const second = Object.assign(snapshot('second.md', 'two', VERSION_B), {
      snapshotId: 'main-only-second-snapshot', release: vi.fn(),
    })
    let current: AiCurrentDocumentSnapshot = first
    let releasesBeforeSecondTool = -1
    const state = setup({ openCurrentDocument: async () => current })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
      'read_current_document', { cursor: 0, maxChars: 100 },
    )] })).mockImplementationOnce(async () => {
      releasesBeforeSecondTool = first.release.mock.calls.length
      current = second
      await state.service.notifyCurrentDocumentChanged()
      return result({ toolCalls: [call(
        'read_current_document', { cursor: 0, maxChars: 100 }, 'call_2',
      )] })
    }).mockResolvedValueOnce(result())

    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
    await waitEvent(state.events, 'completed')

    expect(releasesBeforeSecondTool).toBe(1)
    expect(state.openCurrentDocument).toHaveBeenCalledOnce()
    expect(first.release).toHaveBeenCalledOnce()
    expect(second.release).not.toHaveBeenCalled()
    const wire = JSON.stringify(state.streamChat.mock.calls[2]![0].messages)
    expect(wire).toContain('first.md')
    expect(wire).not.toContain('second.md')
    expect(wire).toContain('unavailable')
    expect(wire).not.toContain('main-only-first-snapshot')
    expect(wire).not.toContain('main-only-second-snapshot')
  })

  it('does not append an EOF page or continue after its deferred release crosses a capability ABA', async () => {
    const releaseEntered = deferred<void>()
    const releaseGate = deferred<void>()
    const opened = Object.assign(snapshot('active.md', 'text', VERSION_A), {
      release: vi.fn(async () => {
        releaseEntered.resolve(undefined)
        await releaseGate.promise
      }),
    })
    const state = setup({ openCurrentDocument: async () => opened })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
      'read_current_document', { cursor: 0, maxChars: 100 },
    )] })).mockResolvedValue(result())

    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
    await releaseEntered.promise
    state.service.setCapabilities({
      ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
      conversationId: CONVERSATION_ID,
      capabilities: { currentDocument: false, workspace: false },
    })
    state.service.setCapabilities({
      ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
      conversationId: CONVERSATION_ID,
      capabilities: { currentDocument: true, workspace: false },
    })
    releaseGate.resolve(undefined)

    await vi.waitFor(() => expect(state.events.some((event) => (
      event.requestId === REQUEST_ID && (event.type === 'stopped' || event.type === 'completed')
    ))).toBe(true))
    expect(state.events).toContainEqual({ requestId: REQUEST_ID, type: 'stopped' })
    expect(state.streamChat).toHaveBeenCalledOnce()
    expect(opened.release).toHaveBeenCalledOnce()
  })

  it('does not append an EOF page or continue after its deferred release loses request generation', async () => {
    const releaseEntered = deferred<void>()
    const releaseGate = deferred<void>()
    const nextCredential = deferred<{ connection: ModelConnectionSummary; apiKey: string | null }>()
    let credentialCalls = 0
    const opened = Object.assign(snapshot('active.md', 'text', VERSION_A), {
      release: vi.fn(async () => {
        releaseEntered.resolve(undefined)
        await releaseGate.promise
      }),
    })
    const state = setup({
      openCurrentDocument: async () => opened,
      getCredentialSnapshot: async () => {
        credentialCalls += 1
        return credentialCalls === 1
          ? { connection: connection(), apiKey: 'api-key' }
          : await nextCredential.promise
      },
    })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
      'read_current_document', { cursor: 0, maxChars: 100 },
    )] })).mockResolvedValue(result())

    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
    await releaseEntered.promise
    const nextStart = state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue safely.' }],
    }))
    await vi.waitFor(() => expect(credentialCalls).toBe(2))
    releaseGate.resolve(undefined)

    await vi.waitFor(() => expect(state.events.some((event) => (
      event.requestId === REQUEST_ID && (event.type === 'stopped' || event.type === 'completed')
    ))).toBe(true))
    expect(state.events).toContainEqual({ requestId: REQUEST_ID, type: 'stopped' })
    expect(state.streamChat).toHaveBeenCalledOnce()
    nextCredential.resolve({ connection: connection(), apiKey: 'api-key' })
    await nextStart
    await vi.waitFor(() => expect(state.events).toContainEqual({
      requestId: SECOND_REQUEST_ID, type: 'completed',
    }))
  })

  it.each(['read-error', 'invalid-page', 'invalid-echo'] as const)(
    'closes a cursor-zero candidate after %s before orphan continuation and clean retry',
    async (fault) => {
      const failedRead = vi.fn(async (input: AiCurrentDocumentToolArguments): Promise<AiCurrentDocumentToolResult> => {
        if (fault === 'read-error') throw new Error('snapshot read failed')
        if (fault === 'invalid-page') {
          return { kind: 'document', displayName: 'broken.md' } as AiCurrentDocumentToolResult
        }
        return {
          kind: 'document', displayName: 'broken.md', sourceFormat: 'markdown', dirty: false,
          cursor: input.cursor + 1, content: 'x', nextCursor: null, hasMore: false,
          totalChars: 2, version: VERSION_A,
        }
      })
      const failed: AiCurrentDocumentSnapshot = { readPage: failedRead, release: vi.fn() }
      const clean = Object.assign(snapshot('clean.md', 'ok', VERSION_B), { release: vi.fn() })
      let opens = 0
      const state = setup({ openCurrentDocument: async () => (opens++ === 0 ? failed : clean) })
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
        'read_current_document', { cursor: 0, maxChars: 2 },
      )] })).mockResolvedValueOnce(result({ toolCalls: [call(
        'read_current_document', { cursor: 1, maxChars: 1 }, 'call_2',
      )] })).mockResolvedValueOnce(result({ toolCalls: [call(
        'read_current_document', { cursor: 0, maxChars: 2 }, 'call_3',
      )] })).mockResolvedValueOnce(result())

      await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
      await waitEvent(state.events, 'completed')

      const firstTool = state.streamChat.mock.calls[1]![0].messages.filter((message) => message.role === 'tool').at(-1)!
      const orphanTool = state.streamChat.mock.calls[2]![0].messages.filter((message) => message.role === 'tool').at(-1)!
      const cleanTool = state.streamChat.mock.calls[3]![0].messages.filter((message) => message.role === 'tool').at(-1)!
      expect(JSON.parse(firstTool.content)).toEqual({ kind: 'unavailable' })
      expect(JSON.parse(orphanTool.content)).toEqual({ kind: 'unavailable' })
      expect(JSON.parse(cleanTool.content)).toMatchObject({
        kind: 'document', displayName: 'clean.md', cursor: 0, content: 'ok',
      })
      expect(failedRead).toHaveBeenCalledOnce()
      expect(state.openCurrentDocument).toHaveBeenCalledTimes(2)
      expect(failed.release).toHaveBeenCalledOnce()
      expect(clean.release).toHaveBeenCalledOnce()
    },
  )

  it('rejects an orphan current-document continuation without opening a snapshot', async () => {
    const state = setup({ openCurrentDocument: async () => snapshot('active.md', 'text', VERSION_A) })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
      'read_current_document', { cursor: 2, maxChars: 100 },
    )] })).mockResolvedValueOnce(result())

    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
    await waitEvent(state.events, 'completed')

    expect(state.openCurrentDocument).not.toHaveBeenCalled()
    const tool = state.streamChat.mock.calls[1]![0].messages.find((message) => message.role === 'tool')!
    expect(JSON.parse(tool.content)).toEqual({ kind: 'unavailable' })
  })

  it('rejects an unpaired surrogate page and accepts UTF-16 cursor echoes on a clean retry', async () => {
    const malformed: AiCurrentDocumentSnapshot = {
      async readPage(input) {
        return {
          kind: 'document', displayName: 'broken.md', sourceFormat: 'markdown', dirty: false,
          cursor: input.cursor, content: '\uD83D', nextCursor: null, hasMore: false,
          totalChars: 1, version: VERSION_A,
        }
      },
      release: vi.fn(),
    }
    const valid: AiCurrentDocumentSnapshot = {
      async readPage(input) {
        const firstPage = input.cursor === 0
        return {
          kind: 'document', displayName: 'emoji.md', sourceFormat: 'markdown', dirty: false,
          cursor: input.cursor, content: firstPage ? '😀' : 'x',
          nextCursor: firstPage ? 2 : null, hasMore: firstPage,
          totalChars: 3, version: VERSION_B,
        }
      },
      release: vi.fn(),
    }
    let opens = 0
    const state = setup({ openCurrentDocument: async () => (opens++ === 0 ? malformed : valid) })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
      'read_current_document', { cursor: 0, maxChars: 2 },
    )] })).mockResolvedValueOnce(result({ toolCalls: [call(
      'read_current_document', { cursor: 0, maxChars: 2 }, 'call_2',
    )] })).mockResolvedValueOnce(result({ toolCalls: [call(
      'read_current_document', { cursor: 2, maxChars: 1 }, 'call_3',
    )] })).mockResolvedValueOnce(result())

    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
    await waitEvent(state.events, 'completed')

    const firstTool = state.streamChat.mock.calls[1]![0].messages.filter((message) => message.role === 'tool').at(-1)!
    const secondTool = state.streamChat.mock.calls[2]![0].messages.filter((message) => message.role === 'tool').at(-1)!
    const thirdTool = state.streamChat.mock.calls[3]![0].messages.filter((message) => message.role === 'tool').at(-1)!
    expect(JSON.parse(firstTool.content)).toEqual({ kind: 'unavailable' })
    expect(JSON.parse(secondTool.content)).toMatchObject({
      kind: 'document', displayName: 'emoji.md', cursor: 0, content: '😀',
      nextCursor: 2, hasMore: true, totalChars: 3,
    })
    expect(JSON.parse(thirdTool.content)).toMatchObject({
      kind: 'document', displayName: 'emoji.md', cursor: 2, content: 'x',
      nextCursor: null, hasMore: false, totalChars: 3,
    })
    expect(malformed.release).toHaveBeenCalledOnce()
    expect(valid.release).toHaveBeenCalledOnce()
  })

  it('exposes exactly seven tools without eagerly reading either capability', async () => {
    const { service, events, files, openCurrentDocument, streamChat } = setup()
    await service.start(startInput({ capabilities: { currentDocument: true, workspace: true } }))
    await waitEvent(events, 'completed')
    expect(streamChat.mock.calls[0]![0].tools?.map((tool) => tool.name)).toEqual([
      'read_current_document', 'list_workspace_entries', 'read_workspace_document',
      'edit_workspace_document', 'create_workspace_document', 'rename_workspace_document',
      'delete_workspace_document',
    ])
    expect(openCurrentDocument).not.toHaveBeenCalled()
    expect(files.requests).toEqual([])
  })

  it('exposes current-document access for only the command turn', async () => {
    const state = setup()
    await state.service.start(startInput({
      capabilities: { currentDocument: false, workspace: false },
      currentDocumentOnce: true,
    }))
    await waitEvent(state.events, 'completed')
    expect(state.streamChat.mock.calls[0]![0].tools?.map(({ name }) => name))
      .toEqual(['read_current_document'])

    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'ordinary next turn' }],
      capabilities: { currentDocument: false, workspace: false },
    }))
    await waitEvent(state.events, 'completed', 2)
    expect(state.streamChat.mock.calls.at(-1)![0].tools).toEqual([])
  })

  it('reads workspace content only after a tool call and sends only relative paths', async () => {
    const { service, events, files, streamChat } = setup()
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_workspace_document', {
      path: 'notes/a.md', cursor: 0, maxChars: 100,
    })] })).mockResolvedValueOnce(result())
    await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(events, 'completed')
    expect(files.requests).toEqual(['read:notes/a.md'])
    const wire = JSON.stringify(streamChat.mock.calls[1]![0].messages)
    expect(wire).toContain('notes/a.md')
    expect(wire).not.toContain('C:\\\\workspace')
  })

  it.each(['list', 'read'] as const)('strictly allowlists a forged workspace %s result before wire insertion', async (kind) => {
    const files = new MemoryWorkspaceFiles()
    const secret = 'C:\\private\\forged.txt'
    if (kind === 'list') {
      files.listEntries = vi.fn(async () => ({
        kind: 'entries' as const,
        directoryPath: '',
        directoryVersion: { workspaceGeneration: files.rootGeneration, directoryId: 'dir', revision: 'rev' },
        cursor: 0,
        entries: [],
        nextCursor: null,
        absolutePath: secret,
      })) as MemoryWorkspaceFiles['listEntries']
    } else {
      files.readDocument = vi.fn(async () => ({
        kind: 'document' as const,
        path: 'notes/a.md', displayName: 'a.md', sourceFormat: 'md', cursor: 0,
        content: 'safe', nextCursor: null, hasMore: false, totalChars: 4, version: VERSION_A,
        nonce: secret,
      })) as MemoryWorkspaceFiles['readDocument']
    }
    const state = setup({ files })
    const tool = kind === 'list'
      ? call('list_workspace_entries', { path: '', cursor: 0, maxEntries: 100, directoryVersion: null })
      : call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [tool] })).mockResolvedValueOnce(result())

    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')

    const toolResult = state.streamChat.mock.calls[1]![0].messages.find((message) => message.role === 'tool')!
    expect(JSON.parse(toolResult.content)).toEqual({ kind: 'unavailable' })
    expect(JSON.stringify(state.streamChat.mock.calls[1]![0].messages)).not.toContain(secret)
  })

  it.each([
    ['list', 'mismatched'], ['list', 'oversized'],
    ['workspace-read', 'mismatched'], ['workspace-read', 'oversized'],
    ['current-document', 'mismatched'], ['current-document', 'oversized'],
  ] as const)('rejects a %s result with %s request echoes without consuming a clean retry', async (kind, fault) => {
    const files = new MemoryWorkspaceFiles()
    if (kind === 'list') {
      let calls = 0
      files.listEntries = vi.fn(async (input) => {
        calls += 1
        return { kind: 'entries' as const,
          directoryPath: calls === 1 && fault === 'mismatched' ? 'other' : input.path,
          directoryVersion: { workspaceGeneration: files.rootGeneration, directoryId: 'dir', revision: 'rev' },
          cursor: input.cursor,
          entries: calls === 1 && fault === 'oversized'
            ? Array.from({ length: input.maxEntries + 1 }, (_, index) => ({ path: `f${index}.md`, name: `f${index}.md`, kind: 'document' as const }))
            : [{ path: 'ok.md', name: 'ok.md', kind: 'document' as const }],
          nextCursor: null }
      }) as MemoryWorkspaceFiles['listEntries']
    }
    if (kind === 'workspace-read') {
      let calls = 0
      files.readDocument = vi.fn(async (input) => {
        calls += 1
        const content = calls === 1 && fault === 'oversized' ? 'x'.repeat(input.maxChars + 1) : 'ok'
        return { kind: 'document' as const,
          path: calls === 1 && fault === 'mismatched' ? 'other.md' : input.path,
          displayName: 'a.md', sourceFormat: 'md', cursor: input.cursor,
          content, nextCursor: null, hasMore: false, totalChars: content.length, version: VERSION_A }
      }) as MemoryWorkspaceFiles['readDocument']
    }
    let opens = 0
    const openCurrentDocument = async () => {
      opens += 1
      const page = snapshot('a.md', 'ok', VERSION_A)
      if (opens === 1) page.readPage = async (input) => {
        const content = fault === 'oversized' ? 'x'.repeat(input.maxChars + 1) : 'ok'
        return { kind: 'document', displayName: 'a.md', sourceFormat: 'md', dirty: false,
          cursor: fault === 'mismatched' ? input.cursor + 1 : input.cursor,
          content, nextCursor: null, hasMore: false, totalChars: content.length, version: VERSION_A }
      }
      return page
    }
    const state = setup({ files, openCurrentDocument })
    const first = kind === 'list'
      ? call('list_workspace_entries', { path: '', cursor: 0, maxEntries: 1, directoryVersion: null })
      : kind === 'workspace-read'
        ? call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 2 })
        : call('read_current_document', { cursor: 0, maxChars: 2 })
    const second = { ...first, id: 'call_2' }
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [first] }))
      .mockResolvedValueOnce(result({ toolCalls: [second] })).mockResolvedValueOnce(result())

    await state.service.start(startInput({
      capabilities: { currentDocument: kind === 'current-document', workspace: kind !== 'current-document' },
    }))
    await waitEvent(state.events, 'completed')

    const firstResult = state.streamChat.mock.calls[1]![0].messages.filter((message) => message.role === 'tool').at(-1)!
    const secondResult = state.streamChat.mock.calls[2]![0].messages.filter((message) => message.role === 'tool').at(-1)!
    expect(JSON.parse(firstResult.content)).toEqual({ kind: 'unavailable' })
    expect(JSON.parse(secondResult.content).kind).toBe(kind === 'list' ? 'entries' : 'document')
  })

  it('asks for every edit and leaves one authorization result event per decision', async () => {
    const { service, events, streamChat } = setup()
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_1')] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_2')] }))
      .mockResolvedValueOnce(result())
    const started = await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const first = await waitEvent(events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await service.submitAuthorizationResult({ requestId: started.requestId, operationId: first.operationId, allowed: true })
    const second = await waitEvent(events, 'authorization-requested', 2) as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await service.submitAuthorizationResult({ requestId: started.requestId, operationId: second.operationId, allowed: false })
    await waitEvent(events, 'completed')
    expect(events.filter((event) => event.type === 'authorization-result')).toMatchObject([
      { scope: 'action', allowed: true }, { scope: 'action', allowed: false },
    ])
  })

  it('reuses a document grant only for the same file identity', async () => {
    const { service, events, streamChat } = setup({ writePolicy: 'document-grant' })
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit('a.md', VERSION_A), 'call_1')] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit('renamed.md', VERSION_A), 'call_2')] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit('b.md', VERSION_B), 'call_3')] }))
      .mockResolvedValueOnce(result())
    const started = await service.start(startInput({ capabilities: { currentDocument: false, workspace: true }, writePolicy: 'document-grant' }))
    const first = await waitEvent(events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await service.submitAuthorizationResult({ requestId: started.requestId, operationId: first.operationId, allowed: true })
    const second = await waitEvent(events, 'authorization-requested', 2) as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    expect(first.scope).toBe('document')
    expect(second.paths).toEqual(['b.md'])
    await service.submitAuthorizationResult({ requestId: started.requestId, operationId: second.operationId, allowed: false })
    await waitEvent(events, 'completed')
  })

  it('migrates a document grant only to the verified successor identity after edit', async () => {
    const files = new MemoryWorkspaceFiles()
    files.successorVersion = VERSION_B
    const state = setup({ writePolicy: 'document-grant', files })
    state.streamChat
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit('notes/a.md', VERSION_A), 'call_1')] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit('notes/a.md', VERSION_B), 'call_2')] }))
      .mockResolvedValueOnce(result())
    const started = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: prompt.operationId, allowed: true })
    await waitEvent(state.events, 'completed')

    expect(state.events.filter((event) => event.type === 'authorization-requested')).toHaveLength(1)
    expect(files.executed).toHaveLength(2)
  })

  it('directly authorizes the selected workspace policy for all four mutation tools', async () => {
    expect(AI_WORKSPACE_WRITE_AUTHORIZATION_PROMPT).toBe('允许当前会话内AI对工作区文档进行编辑与操作。')
    const { service, events, streamChat } = setup({ writePolicy: 'workspace-grant' })
    const tools = [
      call('edit_workspace_document', edit(), 'call_1'),
      call('create_workspace_document', { path: 'new.md', content: 'new' }, 'call_2'),
      call('rename_workspace_document', { path: 'a.md', newPath: 'b.md', expectedVersion: VERSION_A }, 'call_3'),
      call('delete_workspace_document', { path: 'b.md', expectedVersion: VERSION_A }, 'call_4'),
    ]
    for (const tool of tools) streamChat.mockResolvedValueOnce(result({ toolCalls: [tool] }))
    streamChat.mockResolvedValueOnce(result())
    await service.start(startInput({ capabilities: { currentDocument: false, workspace: true }, writePolicy: 'workspace-grant' }))
    await waitEvent(events, 'completed')
    expect(events.filter((event) => event.type === 'authorization-requested')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'audit' && ['edited', 'created', 'renamed', 'deleted'].includes(event.action))).toHaveLength(4)
  })

  it.each([
    ['document-grant', 'create_workspace_document', { path: 'new.md', content: '' }],
    ['document-grant', 'rename_workspace_document', { path: 'a.md', newPath: 'b.md', expectedVersion: VERSION_A }],
    ['document-grant', 'delete_workspace_document', { path: 'a.md', expectedVersion: VERSION_A }],
  ] as const)('does not plan %s structural writes without a supported structural-write policy', async (policy, tool, args) => {
    const { service, events, files, streamChat } = setup({ writePolicy: policy as AiWritePolicy })
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call(tool, args)] })).mockResolvedValueOnce(result())
    await service.start(startInput({ capabilities: { currentDocument: false, workspace: true }, writePolicy: policy as AiWritePolicy }))
    await waitEvent(events, 'completed')
    expect(files.requests.filter((item) => item.startsWith('plan:'))).toEqual([])
    const reply = streamChat.mock.calls[1]![0].messages.find((message) => message.role === 'tool')!
    expect(JSON.parse(reply.content)).toEqual({ kind: 'denied', guidance: '创建、重命名或删除文档需要选择“每次询问”或“按工作区许可”。' })
  })

  it.each([
    ['edit_workspace_document', edit()],
    ['create_workspace_document', { path: 'new.md', content: 'new' }],
    ['rename_workspace_document', { path: 'a.md', newPath: 'b.md', expectedVersion: VERSION_A }],
    ['delete_workspace_document', { path: 'a.md', expectedVersion: VERSION_A }],
  ] as const)('asks for each %s action and executes only the approved operation', async (tool, args) => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(tool, args)] }))
      .mockResolvedValueOnce(result({ toolCalls: [call(tool, args, 'call_2')] }))
      .mockResolvedValueOnce(result())
    const started = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const first = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    expect(first.scope).toBe('action')
    expect(parseAiConversationEvent(first)).toEqual(first)
    expect(state.files.executed).toEqual([])
    await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: first.operationId, allowed: true })
    const second = await waitEvent(state.events, 'authorization-requested', 2) as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    expect(state.files.executed).toEqual([first.operationId])
    await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: second.operationId, allowed: false })
    await waitEvent(state.events, 'completed')
    expect(state.files.executed).toEqual([first.operationId])
    expect(state.events.filter(event => event.type === 'authorization-result')).toMatchObject([
      { toolName: tool, scope: 'action', allowed: true }, { toolName: tool, scope: 'action', allowed: false },
    ])
    for (const event of state.events.filter(event => event.type === 'authorization-result')) {
      expect(parseAiConversationEvent(event)).toEqual(event)
    }
  })

  it('revokes document grants when switching workspaces but retains workspace conversation memory', async () => {
    const { service, events, files, streamChat } = setup({ writePolicy: 'document-grant' })
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
      .mockResolvedValueOnce(result()).mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_2')] }))
      .mockResolvedValueOnce(result())
    const first = await service.start(startInput({ capabilities: { currentDocument: false, workspace: true }, writePolicy: 'document-grant' }))
    const prompt = await waitEvent(events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await service.submitAuthorizationResult({ requestId: first.requestId, operationId: prompt.operationId, allowed: true })
    await waitEvent(events, 'completed')
    const workspaceARevision = latestTranscriptRevision(events)
    const switchToB = await service.prepareWorkspaceSwitch()
    files.workspaceId = 'workspace-b'
    files.rootGeneration = '2.generation'
    files.activationEpoch = 2
    await service.activateWorkspace(switchToB, await files.getRootCapability())
    await service.start(startInput({ conversationId: '750e8400-e29b-41d4-a716-446655440001', workspaceKey: 'workspace-b',
      requestId: SECOND_REQUEST_ID,
      messages: [{ id: '750e8400-e29b-41d4-a716-446655440002', role: 'user', content: 'B' }] }))
    await waitEvent(events, 'completed', 2)
    const switchToA = await service.prepareWorkspaceSwitch()
    files.workspaceId = 'workspace-a'
    files.rootGeneration = '3.generation'
    files.activationEpoch = 3
    await service.activateWorkspace(switchToA, await files.getRootCapability())
    service.setCapabilities({
      ownerId: 1,
      workspaceId: 'workspace-a',
      workspaceGeneration: '3.generation',
      conversationId: CONVERSATION_ID,
      capabilities: { currentDocument: false, workspace: true },
    })
    const resumed = await service.start(startInput({
      requestId: '850e8400-e29b-41d4-a716-446655440001',
      acknowledgedTranscriptRevision: workspaceARevision,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Back.' }],
      capabilities: { currentDocument: false, workspace: true }, writePolicy: 'document-grant' }))
    const reprompt = await waitEvent(events, 'authorization-requested', 2) as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    expect(streamChat.mock.calls[3]![0].messages).toEqual(expect.arrayContaining([{ role: 'user', content: 'Please help.' }]))
    await service.submitAuthorizationResult({ requestId: resumed.requestId, operationId: reprompt.operationId, allowed: false })
    await waitEvent(events, 'completed', 3)
  })

  it('keeps trusted absolute mutation paths only in local audit events', async () => {
    const { service, events, streamChat } = setup()
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] })).mockResolvedValueOnce(result())
    const started = await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await service.submitAuthorizationResult({ requestId: started.requestId, operationId: prompt.operationId, allowed: true })
    await waitEvent(events, 'completed')
    expect(events).toContainEqual(expect.objectContaining({ type: 'audit', action: 'edited', absolutePaths: ['C:\\workspace\\notes\\a.md'] }))
    const wire = JSON.stringify(streamChat.mock.calls[1]![0].messages)
    expect(wire).not.toContain('C:\\\\workspace')
    expect(wire).not.toContain('nonce-')
  })

  it.each(['operation-id', 'path-value', 'path-order'] as const)(
    'rejects a succeeded mutation with a mismatched %s echo before audit, recovery, or lineage commit',
    async (fault) => {
      const files = new MemoryWorkspaceFiles()
      const executeAuthorized = files.executeAuthorized.bind(files)
      files.executeAuthorized = vi.fn(async (manifest) => {
        const execution = await executeAuthorized(manifest)
        return {
          ...execution,
          result: {
            ...execution.result,
            operationId: fault === 'operation-id'
              ? OPERATION_IDS[3]
              : execution.result.operationId,
            paths: fault === 'path-value'
              ? ['leaked-other.md']
              : fault === 'path-order'
                ? [...execution.result.paths].reverse()
                : [...execution.result.paths],
          },
        }
      }) as MemoryWorkspaceFiles['executeAuthorized']
      const state = setup({ files })
      const tool = fault === 'path-order'
        ? call('rename_workspace_document', {
          path: 'notes/a.md', newPath: 'notes/b.md', expectedVersion: VERSION_A,
        })
        : call('edit_workspace_document', edit())
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [tool] }))
        .mockResolvedValueOnce(result({ toolCalls: [tool] }))
        .mockResolvedValueOnce(result())
        .mockResolvedValueOnce(result())

      const started = await state.service.start(startInput({
        capabilities: { currentDocument: false, workspace: true },
      }))
      const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      await state.service.submitAuthorizationResult({
        requestId: started.requestId, operationId: prompt.operationId, allowed: true,
      })
      await waitEvent(state.events, 'completed')

      expect(files.executed).toEqual([prompt.operationId])
      expect(state.events.filter(event => event.type === 'process-tool').map(event => [event.status, event.cached]))
        .toEqual([['awaiting-approval', false], ['running', false], ['unknown', false], ['unknown', true]])
      expect(state.events.some((event) => event.type === 'audit'
        && ['edited', 'created', 'renamed', 'deleted'].includes(event.action))).toBe(false)
      for (const continuation of state.streamChat.mock.calls.slice(1, 3)) {
        const terminal = continuation[0].messages.filter((message) => message.role === 'tool').at(-1)!
        expect(JSON.parse(terminal.content)).toEqual({ kind: 'unavailable' })
      }

      await state.service.start(continuedInput(state.events, {
        requestId: SECOND_REQUEST_ID,
        messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue safely.' }],
      }))
      await waitEvent(state.events, 'completed', 2)
      const nextWire = state.streamChat.mock.calls[3]![0].messages
      const retained = nextWire.filter((message) => message.role === 'tool').at(-1)!
      expect(JSON.parse(retained.content)).toEqual({ kind: 'unavailable' })
      if (fault === 'operation-id') expect(JSON.stringify(nextWire)).not.toContain(OPERATION_IDS[3])
      if (fault === 'path-value') expect(JSON.stringify(nextWire)).not.toContain('leaked-other.md')
    },
  )

  it('keeps an echo-mismatch barrier across requests until a real reread and fresh authorization', async () => {
    const files = new MemoryWorkspaceFiles()
    const executeAuthorized = files.executeAuthorized.bind(files)
    let executionCount = 0
    files.executeAuthorized = vi.fn(async (manifest) => {
      executionCount += 1
      const execution = await executeAuthorized(manifest)
      return executionCount === 1 ? {
        ...execution,
        result: { ...execution.result, operationId: OPERATION_IDS[3] },
      } : execution
    }) as MemoryWorkspaceFiles['executeAuthorized']
    const state = setup({ files, writePolicy: 'workspace-grant' })
    state.streamChat.mockResolvedValueOnce(result({
      toolCalls: [call('edit_workspace_document', edit(), 'call_mismatch')],
    })).mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({
        toolCalls: [call('edit_workspace_document', edit(), 'call_fresh_blocked')],
      })).mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({
        toolCalls: [call('read_workspace_document', {
          path: 'notes/a.md', cursor: 0, maxChars: 100,
        }, 'call_real_reread')],
      })).mockResolvedValueOnce(result({
        toolCalls: [call('edit_workspace_document', edit(), 'call_after_reread')],
      })).mockResolvedValueOnce(result())

    await state.service.start(startInput({
      capabilities: { currentDocument: false, workspace: true },
    }))
    await waitEvent(state.events, 'completed')
    const firstOperationId = files.executed[0]!

    await state.service.start(continuedInput(state.events, {
      capabilities: { currentDocument: false, workspace: true },
      requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Try the edit again.' }],
    }))
    await waitEvent(state.events, 'completed', 2)
    const blockedWire = state.streamChat.mock.calls[3]![0].messages
    const blockedResult = blockedWire.find((message) => (
      message.role === 'tool' && message.toolCallId === 'call_fresh_blocked'
    )) as Extract<ModelChatInput['messages'][number], { role: 'tool' }>
    expect(JSON.parse(blockedResult.content)).toEqual({ kind: 'denied' })
    expect(files.planningStarted).toHaveLength(1)
    expect(files.executed).toEqual([firstOperationId])
    expect(state.events.filter((event) => event.type === 'authorization-requested')).toHaveLength(0)

    const third = await state.service.start(continuedInput(state.events, {
      capabilities: { currentDocument: false, workspace: true },
      requestId: THIRD_REQUEST_ID,
      messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'Reread and retry safely.' }],
    }))
    const freshPrompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    expect(files.requests).toContain('read:notes/a.md')
    expect(files.executed).toEqual([firstOperationId])
    await state.service.submitAuthorizationResult({
      requestId: third.requestId, operationId: freshPrompt.operationId, allowed: true,
    })
    await waitEvent(state.events, 'completed', 3)
    expect(files.executed).toEqual([firstOperationId, freshPrompt.operationId])
  })

  it.each(['anthropic', 'openai-responses'] as const)('preserves hidden reasoning and %s replay through tool continuation', async (protocol) => {
    const replay = providerReplay(protocol)
    const { service, events, streamChat } = setup()
    streamChat.mockResolvedValueOnce(result({ reasoningContent: 'hidden', providerReplay: replay,
      toolCalls: [call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 10 })] }))
      .mockResolvedValueOnce(result())
    await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(events, 'completed')
    expect(streamChat.mock.calls[1]![0].messages).toContainEqual(expect.objectContaining({
      role: 'assistant', reasoningContent: 'hidden', providerReplay: replay,
    }))
    expect(JSON.stringify(events)).not.toContain('encrypted-private-replay')
  })

  it('runs an Astra Responses tool round through the real adapter and keeps replay out of UI events', async () => {
    const requests: Array<Record<string, any>> = []
    const output = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted-private-replay' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_read', name: 'read_workspace_document', arguments: '{"path":"notes/a.md","cursor":0,"maxChars":10}', status: 'completed' },
    ]
    const client = createModelProtocolClient(async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/responses')
      requests.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ object: 'response', id: `resp_${requests.length}`, status: 'completed', output: requests.length === 1 ? output : [
        { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Read successfully.' }] },
      ] }), { headers: { 'content-type': 'application/json' } })
    })
    const state = setup({ models: modelSettings(connection({ provider: 'other', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-6-astra' })), streamChat: input => client.streamChat(input) })
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')
    expect(requests).toHaveLength(2)
    expect(state.files.requests).toContain('read:notes/a.md')
    const replayStart = requests[1]!.input.findIndex((item: Record<string, unknown>) => item.type === 'reasoning')
    expect(requests[1]!.input.slice(replayStart, replayStart + 2)).toEqual(output)
    expect(requests[1]!.input[replayStart + 2]).toMatchObject({ type: 'function_call_output', call_id: 'call_read' })
    expect(JSON.parse(requests[1]!.input[replayStart + 2].output)).toMatchObject({ kind: 'document', content: 'text' })
    expect(JSON.stringify(state.events)).not.toContain('encrypted-private-replay')
    expect(JSON.stringify(state.events)).toContain('Read successfully.')
  })

  it('reconciles accumulated visible deltas from every provider subrequest before the next user', async () => {
    const state = setup()
    state.streamChat.mockImplementationOnce(async (input) => {
      input.onDelta('Reading. ')
      return result({ toolCalls: [call('read_workspace_document', {
        path: 'notes/a.md', cursor: 0, maxChars: 100,
      })] })
    }).mockImplementationOnce(async (input) => {
      input.onDelta('Summary.')
      return result()
    }).mockResolvedValueOnce(result())

    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')
    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
        { id: SECOND_MESSAGE_ID, role: 'assistant', content: 'Reading. Summary.' },
        { id: THIRD_MESSAGE_ID, role: 'user', content: 'Continue.' },
      ],
      capabilities: { currentDocument: false, workspace: true },
    }))
    await waitEvent(state.events, 'completed', 2)

    const nextWire = JSON.stringify(state.streamChat.mock.calls[2]![0].messages)
    expect(nextWire).toContain('Reading. ')
    expect(nextWire).toContain('Summary.')
  })

  it('does not execute a terminal unknown mutation twice when a tool call repeats', async () => {
    const files = new MemoryWorkspaceFiles(); files.outcome = 'unknown'
    const { service, events, streamChat } = setup({ files })
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
      .mockResolvedValueOnce(result())
    const started = await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await service.submitAuthorizationResult({ requestId: started.requestId, operationId: prompt.operationId, allowed: true })
    await waitEvent(events, 'completed')
    expect(files.executed).toEqual([prompt.operationId])
    const last = streamChat.mock.calls[2]![0].messages.filter((message) => message.role === 'tool').at(-1)!
    expect(JSON.parse(last.content)).toMatchObject({ kind: 'mutation', state: 'unknown' })
  })

  it('blocks unknown-path mutations across requests until reread and explicit reauthorization', async () => {
    const state = setup({ writePolicy: 'document-grant' })
    state.files.outcome = 'unknown'
    state.streamChat
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_1')] }))
      .mockImplementationOnce(async (input) => { input.onDelta('First done'); return result() })
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_2')] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('read_workspace_document', {
        path: 'notes/a.md', cursor: 0, maxChars: 100,
      }, 'call_3')] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_4')] }))
      .mockResolvedValueOnce(result())

    const first = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const initialPrompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await state.service.submitAuthorizationResult({ requestId: first.requestId, operationId: initialPrompt.operationId, allowed: true })
    await waitEvent(state.events, 'completed')
    expect(state.events).toContainEqual(expect.objectContaining({
      type: 'operation-status', operationId: initialPrompt.operationId, status: 'unknown', paths: ['notes/a.md'],
    }))

    state.files.outcome = 'succeeded'
    const second = await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
        { id: SECOND_MESSAGE_ID, role: 'assistant', content: 'First done' },
        { id: THIRD_MESSAGE_ID, role: 'user', content: 'Try safely.' },
      ],
      capabilities: { currentDocument: false, workspace: true },
    }))
    const explicitPrompt = await waitEvent(state.events, 'authorization-requested', 2) as Extract<AiConversationEvent, { type: 'authorization-requested' }>

    expect(state.files.requests.filter((request) => request.startsWith('plan:'))).toHaveLength(2)
    expect(state.files.requests).toContain('read:notes/a.md')
    await state.service.submitAuthorizationResult({
      requestId: second.requestId, operationId: explicitPrompt.operationId, allowed: false,
    })
    await waitEvent(state.events, 'completed', 2)
  })

  it.each([
    ['a case alias', 'Notes/A.md', 'notes/a.md'],
    ['an external rename retaining file identity', 'notes/a.md', 'notes/b.md'],
  ] as const)(
    'binds an unknown barrier across %s until identity reread and fresh authorization',
    async (_scenario, initialPath, retryPath) => {
      const state = setup({ writePolicy: 'workspace-grant' })
      state.files.outcome = 'unknown'
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
        'edit_workspace_document', edit(initialPath),
      )] })).mockResolvedValueOnce(result())
      await state.service.start(startInput({
        capabilities: { currentDocument: false, workspace: true },
      }))
      await waitEvent(state.events, 'completed')
      expect(state.events.filter(event => event.type === 'authorization-requested')).toHaveLength(0)

      state.files.outcome = 'succeeded'
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
        'edit_workspace_document', edit(retryPath), 'call_2',
      )] })).mockResolvedValueOnce(result({ toolCalls: [call(
        'read_workspace_document', { path: retryPath, cursor: 0, maxChars: 100 }, 'call_3',
      )] })).mockResolvedValueOnce(result({ toolCalls: [call(
        'edit_workspace_document', edit(retryPath), 'call_4',
      )] })).mockResolvedValueOnce(result())
      const second = await state.service.start(continuedInput(state.events, {
        requestId: SECOND_REQUEST_ID,
        messages: [
          { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
          { id: SECOND_MESSAGE_ID, role: 'user', content: 'Reconcile and retry.' },
        ],
        capabilities: { currentDocument: false, workspace: true },
      }))

      const retryPrompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      expect(retryPrompt.toolCallId).toBe('call_4')
      await state.service.submitAuthorizationResult({
        requestId: second.requestId, operationId: retryPrompt.operationId, allowed: true,
      })
      await waitEvent(state.events, 'completed', 2)

      expect(state.files.requests).toContain(`read:${retryPath}`)
      expect(state.files.planningStarted).toHaveLength(2)
      expect(state.files.executed).toHaveLength(2)
    },
  )

  it('emits normalized provider usage without exposing credentials in wire messages', async () => {
    const usage = { inputTokens: 23_410, outputTokens: 10, totalTokens: 23_420, cachedInputTokens: 0, estimated: false }
    const { service, events, streamChat } = setup({ streamChat: async (input) => { input.onDelta('ok'); return result({ usage }) } })
    await service.start(startInput())
    await waitEvent(events, 'completed')
    expect(events).toContainEqual({ requestId: REQUEST_ID, type: 'usage', usage })
    expect(JSON.stringify(streamChat.mock.calls[0]![0].messages)).not.toContain('api-key')
  })

  it('conservatively estimates generated content and reasoning when provider usage is absent', async () => {
    const state = setup({ streamChat: async (input) => {
      input.onDelta('visible output')
      return result({ reasoningContent: 'hidden reasoning' })
    } })
    await state.service.start(startInput())
    await waitEvent(state.events, 'completed')

    const usage = [...state.events].reverse().find(
      (event): event is Extract<AiConversationEvent, { type: 'usage' }> => event.type === 'usage',
    )!.usage
    expect(usage.estimated).toBe(true)
    expect(usage.outputTokens).toBeGreaterThan(0)
    expect(usage.totalTokens).toBe(usage.inputTokens + usage.outputTokens)
  })

  it('cancels pending authorization as a denial and never executes it', async () => {
    const { service, events, files, streamChat } = setup()
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    const started = await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(events, 'authorization-requested')
    await service.cancel(started.requestId)
    expect(events.filter((event) => event.type === 'stopped')).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'authorization-result', allowed: false }))
    expect(files.executed).toEqual([])
  })

  it('maps unbounded provider details to a bounded public error', async () => {
    const { service, events } = setup({ streamChat: async () => {
      throw Object.assign(new ModelProtocolError('incompatible-response'), { detail: 'secret '.repeat(100_000) })
    } })
    await service.start(startInput())
    expect(await waitEvent(events, 'failed')).toEqual({ requestId: REQUEST_ID, type: 'failed',
      code: 'MODEL_INCOMPATIBLE_RESPONSE', message: '大模型服务返回的响应格式不兼容' })
    expect(JSON.stringify(events)).not.toContain('secret')
  })

  it('uses a canonical caller request ID only for correlation and rejects collision or wrong workspace ownership', async () => {
    const registry = new AiConversationRequestRegistry()
    const first = setup({ ownerId: 1, requestRegistry: registry })
    await first.service.start(startInput())
    await waitEvent(first.events, 'completed')
    expect(JSON.stringify(first.streamChat.mock.calls[0]![0].messages)).not.toContain(REQUEST_ID)

    const second = setup({ ownerId: 2, requestRegistry: registry })
    await expect(second.service.start(startInput())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(second.service.start(startInput({
      requestId: SECOND_REQUEST_ID,
      workspaceKey: 'workspace-b',
    }))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(second.streamChat).not.toHaveBeenCalled()
  })

  it('uses trusted workspace policy and newly activated workspace authority rather than the renderer policy', async () => {
    const { service, events, files, streamChat } = setup({ writePolicy: 'workspace-grant' })
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_2')] }))
      .mockResolvedValueOnce(result())
    await service.start(startInput({
      capabilities: { currentDocument: false, workspace: true }, writePolicy: 'ask-every-time',
    }))
    await waitEvent(events, 'completed')

    const switchTicket = await service.prepareWorkspaceSwitch()
    files.rootGeneration = '2.generation'
    files.activationEpoch = 2
    await service.activateWorkspace(switchTicket, await files.getRootCapability())
    service.setCapabilities({
      ownerId: 1,
      workspaceId: 'workspace-a',
      workspaceGeneration: '2.generation',
      conversationId: CONVERSATION_ID,
      capabilities: { currentDocument: false, workspace: true },
    })
    await service.start(continuedInput(events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
        { id: SECOND_MESSAGE_ID, role: 'user', content: 'Again.' },
      ],
      capabilities: { currentDocument: false, workspace: true },
      writePolicy: 'ask-every-time',
    }))
    await waitEvent(events, 'completed', 2)
    expect(streamChat.mock.calls[2]![0].messages).toEqual(expect.arrayContaining([
      { role: 'user', content: 'Please help.' },
    ]))
    expect(events.filter(event => event.type === 'authorization-requested')).toHaveLength(0)
    expect(files.executed).toHaveLength(2)
  })

  it('re-reads trusted write policy for each mutation and revokes grants when it changes', async () => {
    const state = setup({ writePolicy: 'document-grant' })
    state.streamChat
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_1')] }))
      .mockImplementationOnce(async () => {
        state.settings.setWritePolicy('ask-every-time')
        return result({ toolCalls: [call('edit_workspace_document', edit(), 'call_2')] })
      })
      .mockResolvedValueOnce(result())
    const started = await state.service.start(startInput({
      capabilities: { currentDocument: false, workspace: true },
      writePolicy: 'workspace-grant',
    }))
    const first = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    expect(first.scope).toBe('document')
    await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: first.operationId, allowed: true })
    const second = await waitEvent(state.events, 'authorization-requested', 2) as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    expect(second.scope).toBe('action')
    await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: second.operationId, allowed: false })
    await waitEvent(state.events, 'completed')
  })

  it('immediately denies pending authorization and revokes grants across policy ABA changes', async () => {
    const state = setup({ writePolicy: 'document-grant' })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    const started = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>

    state.settings.setWritePolicy('workspace-grant')
    state.settings.setWritePolicy('document-grant')

    expect(state.events).toContainEqual(expect.objectContaining({
      type: 'authorization-result', operationId: prompt.operationId, allowed: false,
    }))
    await expect(state.service.submitAuthorizationResult({
      requestId: started.requestId, operationId: prompt.operationId, allowed: true,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(state.files.executed).toEqual([])
  })

  it('lists the workspace root only through the list tool root sentinel', async () => {
    const { service, events, files, streamChat } = setup()
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('list_workspace_entries', {
      path: '', cursor: 0, maxEntries: 100, directoryVersion: null,
    })] })).mockResolvedValueOnce(result())
    await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(events, 'completed')
    expect(files.requests).toEqual(['list:'])
  })

  it('continues a root listing with its opaque directory version and sends real entries on wire', async () => {
    const files = new MemoryWorkspaceFiles()
    files.listEntries = vi.fn(async (input) => ({
      kind: 'entries' as const,
      directoryPath: '',
      directoryVersion: { workspaceGeneration: files.rootGeneration, directoryId: 'root-dir', revision: 'root-rev' },
      cursor: input.cursor,
      entries: input.cursor === 0
        ? [{ path: 'notes', name: 'notes', kind: 'directory' as const }]
        : [{ path: 'todo.md', name: 'todo.md', kind: 'document' as const }],
      nextCursor: input.cursor === 0 ? 1 : null,
    })) as MemoryWorkspaceFiles['listEntries']
    const state = setup({ files })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('list_workspace_entries', {
      path: '', cursor: 0, maxEntries: 1, directoryVersion: null,
    })] })).mockResolvedValueOnce(result({ toolCalls: [call('list_workspace_entries', {
      path: '', cursor: 1, maxEntries: 1,
      directoryVersion: { workspaceGeneration: files.rootGeneration, directoryId: 'root-dir', revision: 'root-rev' },
    }, 'call_2')] })).mockResolvedValueOnce(result())

    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')

    expect(files.listEntries).toHaveBeenCalledTimes(2)
    const wire = JSON.stringify(state.streamChat.mock.calls[2]![0].messages)
    expect(wire).toContain('notes')
    expect(wire).toContain('todo.md')
    expect(wire).toContain('root-dir')
  })

  it('rejects an ambiguous repeated cursor-zero workspace-document series in one turn', async () => {
    const state = setup()
    const first = call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 })
    const second = call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 }, 'call_2')
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [first] }))
      .mockResolvedValueOnce(result({ toolCalls: [second] }))
      .mockResolvedValueOnce(result())

    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')

    expect(state.files.requests.filter((item) => item === 'read:notes/a.md')).toHaveLength(1)
    const secondTool = state.streamChat.mock.calls[2]![0].messages.filter((message) => message.role === 'tool').at(-1)!
    expect(JSON.parse(secondTool.content)).toEqual({ kind: 'unavailable' })
  })

  it('invalidates a pending current-document open when the editor switches before the snapshot opens', async () => {
    const opened = deferred<AiCurrentDocumentSnapshot | null>()
    const { service, events, streamChat } = setup({ openCurrentDocument: () => opened.promise })
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_current_document', {
      cursor: 0, maxChars: 100,
    })] })).mockResolvedValueOnce(result())
    await service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
    await vi.waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1))
    await service.notifyCurrentDocumentChanged()
    const stale = Object.assign(snapshot('old.md', 'old', VERSION_A), { release: vi.fn() })
    opened.resolve(stale)
    await waitEvent(events, 'completed')
    const tool = streamChat.mock.calls[1]![0].messages.find((message) => message.role === 'tool')!
    expect(JSON.parse(tool.content)).toEqual({ kind: 'unavailable' })
    expect(stale.release).toHaveBeenCalledOnce()
  })

  it.each(['completed', 'failed', 'cancel', 'clear', 'switch', 'capability-off', 'dispose'] as const)(
    'releases an opened current-document snapshot exactly once when a turn is %s',
    async (ending) => {
      const continuation = deferred<ModelChatResult>()
      const opened = Object.assign(snapshot('active.md', 'text-more', VERSION_A), { release: vi.fn() })
      const state = setup({ openCurrentDocument: async () => opened })
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
        'read_current_document', { cursor: 0, maxChars: 4 },
      )] })).mockImplementationOnce(() => continuation.promise)
      const started = await state.service.start(startInput({
        capabilities: { currentDocument: true, workspace: false },
      }))
      await vi.waitFor(() => expect(state.streamChat).toHaveBeenCalledTimes(2))

      if (ending === 'completed') continuation.resolve(result())
      else if (ending === 'failed') continuation.reject(new ModelProtocolError('timeout'))
      else if (ending === 'cancel') await state.service.cancel(started.requestId)
      else if (ending === 'clear') await state.service.clearConversation('workspace-a', CONVERSATION_ID)
      else if (ending === 'switch') {
        let prepared = false
        const preparing = state.service.prepareWorkspaceSwitch().then((ticket) => {
          prepared = true
          return ticket
        })
        await new Promise((resolve) => { setTimeout(resolve, 20) })
        expect(prepared).toBe(false)
        continuation.reject(new DOMException('aborted', 'AbortError'))
        const ticket = await preparing
        state.files.workspaceId = 'workspace-b'
        state.files.rootGeneration = '2.generation'
        state.files.activationEpoch = 2
        await state.service.activateWorkspace(ticket, await state.files.getRootCapability())
      } else if (ending === 'capability-off') {
        state.service.setCapabilities({
          ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
          conversationId: CONVERSATION_ID,
          capabilities: { currentDocument: false, workspace: false },
        })
      } else {
        let disposed = false
        const disposing = state.service.dispose().then(() => { disposed = true })
        await new Promise((resolve) => { setTimeout(resolve, 20) })
        expect(disposed).toBe(false)
        continuation.reject(new DOMException('aborted', 'AbortError'))
        await disposing
      }

      if (ending === 'completed') await waitEvent(state.events, 'completed')
      if (ending === 'failed') await waitEvent(state.events, 'failed')
      expect(opened.release).toHaveBeenCalledOnce()
      continuation.resolve(result())
      await Promise.resolve()
      expect(opened.release).toHaveBeenCalledOnce()
    },
  )

  it('terminalizes denied and cleared pending manifests and rejects late approval', async () => {
    const { service, events, files, streamChat } = setup()
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    const started = await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>

    await service.clearConversation('workspace-a', CONVERSATION_ID)

    expect(files.abandoned).toEqual([prompt.operationId])
    await expect(service.submitAuthorizationResult({
      requestId: started.requestId, operationId: prompt.operationId, allowed: true,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it.each(['compacted', 'failed'] as const)(
    'retains a local %s compaction record from the real main service through the renderer before the start receipt',
    async (status) => {
      const listeners = new Set<(event: AiConversationEvent) => void>()
      const selected = connection({
        provider: 'other', baseUrl: 'https://models.example.com/v1', modelId: 'custom-chat',
        capabilityOverride: { contextWindowTokens: 100_000, maxInputTokens: 100_000, maxOutputTokens: 32_768 },
      })
      const state = setup({
        models: modelSettings(selected),
        onEvent: (event) => {
          const parsed = parseAiConversationEvent(event)
          if (parsed) for (const listener of listeners) listener(parsed)
        },
        streamChat: async (input) => {
          input.onDelta(input.requestedOutputTokens === 16_384
            ? status === 'failed' ? 'not-json' : JSON.stringify({
              version: 1, userGoals: ['continue'], decisions: [], workspaceFacts: [],
              unresolvedQuestions: [], nextSteps: [], retainedToolFacts: [], completedOperationIds: [],
            })
            : 'ok')
          return result()
        },
      })
      const api = {
        startAiConversation: vi.fn(async (input: StartAiConversationInput) => {
          try { return { ok: true as const, value: await state.service.start(input) } }
          catch { return { ok: false as const, error: {
            code: 'OPERATION_FAILED' as const, message: PUBLIC_ERROR_MESSAGES.OPERATION_FAILED,
          } } }
        }),
        onAiConversationEvent: (listener: (event: AiConversationEvent) => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        cancelAiConversation: vi.fn(async () => ({ ok: true as const, value: null })),
        clearAiConversation: vi.fn(async () => ({ ok: true as const, value: null })),
        getLargeModelSettings: vi.fn(),
        setAiConversationCapabilities: vi.fn(),
        setAiConversationSettings: vi.fn(),
        submitAiAuthorizationResult: vi.fn(),
      }
      const view = renderHook(() => useAiConversation({
        api, workspace: { workspaceId: 'workspace-a', workspaceGeneration: 'generation-1' },
      }))
      await act(async () => {
        await view.result.current.setCurrentDocumentAccess(false)
        await view.result.current.setWorkspaceAccess(false)
      })
      await act(async () => { await view.result.current.sendMessage('a'.repeat(25_000)) })
      await waitFor(() => expect(view.result.current.status).toBe('idle'))
      await act(async () => {
        expect(await view.result.current.sendMessage('b'.repeat(10_000))).toBe(status === 'compacted')
      })
      await waitFor(() => expect(view.result.current.timeline.filter((entry) => (
        entry.kind === 'context-compaction'
      ))).toHaveLength(1))
      const notice = state.events.find((event) => event.type === 'context-compaction')
      expect(notice).toMatchObject({ status, transcriptRevision: status === 'compacted' ? 3 : 2 })
      if (notice?.type === 'context-compaction' && notice.status === 'compacted') {
        expect(notice.contextWindowTokens).toBe(100_000)
        expect(notice.beforeTokens).toBeGreaterThan(notice.afterTokens)
      }
      expect(view.result.current.messages.some(({ content }) => content.includes('上下文'))).toBe(false)
      expect(JSON.stringify(state.streamChat.mock.calls)).not.toContain('上下文已压缩')
      expect(JSON.stringify(state.streamChat.mock.calls)).not.toContain('上下文压缩失败')
      render(createElement(AiConversationSidebar, {
        onClose: vi.fn(),
        ...view.result.current,
        configurationState: 'configured',
        onClear: vi.fn(), onOpenSettings: vi.fn(), onRetryConfiguration: vi.fn(),
        onSend: vi.fn(), onStop: vi.fn(), onCurrentDocumentAccessChange: vi.fn(),
        onWorkspaceAccessChange: vi.fn(), onWritePolicyChange: vi.fn(), onAuthorizationDecision: vi.fn(),
      }))
      const expectedText = notice?.type === 'context-compaction' && notice.status === 'compacted'
        ? `上下文已压缩 · ${Math.round(notice.beforeTokens / notice.contextWindowTokens * 100)}% → ${Math.round(notice.afterTokens / notice.contextWindowTokens * 100)}%`
        : '上下文压缩失败 · 已保留原上下文'
      expect(screen.getByLabelText('上下文压缩记录')).toHaveTextContent(expectedText)
      await state.service.dispose()
    },
  )

  it('compacts closed history before appending a prospective user message that crosses the soft limit', async () => {
    const compactModel = connection({
      provider: 'other',
      baseUrl: 'https://models.example.com/v1',
      modelId: 'custom-chat',
      capabilityOverride: { contextWindowTokens: 100_000, maxInputTokens: 100_000, maxOutputTokens: 32_768 },
    })
    const firstText = 'a'.repeat(25_000)
    const secondText = 'b'.repeat(10_000)
    const summary = JSON.stringify({
      version: 1, userGoals: ['continue'], decisions: [], workspaceFacts: [],
      unresolvedQuestions: [], nextSteps: [], retainedToolFacts: [], completedOperationIds: [],
    })
    const state = setup({ models: modelSettings(compactModel), streamChat: async (input) => {
      if (input.requestedOutputTokens === 16_384) {
        input.onDelta(summary)
        return result()
      }
      input.onDelta('ok')
      return result()
    } })
    await state.service.start(continuedInput(state.events, {
      messages: [{ id: MESSAGE_ID, role: 'user', content: firstText }],
    }))
    await waitEvent(state.events, 'completed')
    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: firstText },
        { id: SECOND_MESSAGE_ID, role: 'user', content: secondText },
      ],
    }))
    await waitEvent(state.events, 'completed', 2)

    const summaryEntry = state.streamChat.mock.calls.find(([input]) => input.requestedOutputTokens === 16_384)
    expect(summaryEntry, JSON.stringify(state.streamChat.mock.calls.map(([input]) => ({
      requestedOutputTokens: input.requestedOutputTokens,
      messageCount: input.messages.length,
    })))).toBeDefined()
    const summaryCall = summaryEntry![0]
    expect(JSON.stringify(summaryCall.messages)).not.toContain(secondText)
    const secondNormal = state.streamChat.mock.calls.at(-1)![0]
    expect(JSON.stringify(secondNormal.messages)).toContain('ARKDOWN_CONTEXT_CHECKPOINT_V1')
    expect(JSON.stringify(secondNormal.messages)).toContain(secondText)
  })

  it.each(['network', 'service-unavailable', 'cli-authentication', 'protocol-malformed'] as const)(
    'preserves structured %s failure from actual admission compaction without committing the candidate', async reason => {
      const model = connection({ provider: 'other', baseUrl: 'https://models.example.com/v1', modelId: 'custom-chat',
        capabilityOverride: { contextWindowTokens: 100_000, maxInputTokens: 100_000, maxOutputTokens: 32_768 } })
      const failure = new ModelProtocolError('incompatible-response', undefined,
        { version: 1, reason, stage: 'connect', source: 'local' })
      let summaries = 0
      const state = setup({ models: modelSettings(model), streamChat: async input => {
        if (input.requestedOutputTokens === 16_384) { summaries += 1; throw failure }
        input.onDelta('First answer')
        return result()
      } })
      const firstText = 'a'.repeat(25_000)
      await state.service.start(continuedInput(state.events, { messages: [{ id: MESSAGE_ID, role: 'user', content: firstText }] }))
      await waitEvent(state.events, 'completed')
      await expect(state.service.start(continuedInput(state.events, {
        requestId: SECOND_REQUEST_ID, messages: [
          { id: MESSAGE_ID, role: 'user', content: firstText },
          { id: SECOND_MESSAGE_ID, role: 'assistant', content: 'First answer' },
          { id: THIRD_MESSAGE_ID, role: 'user', content: 'b'.repeat(10_000) },
        ],
      }))).rejects.toBe(failure)
      expect(summaries).toBe(1)
      expect(state.events).toContainEqual(expect.objectContaining({ requestId: SECOND_REQUEST_ID,
        type: 'context-compaction', status: 'failed' }))
      expect(state.events.some(event => event.requestId === SECOND_REQUEST_ID && event.type === 'user-message-accepted')).toBe(false)
      await state.service.dispose()
    },
  )

  it('preserves a structured credential admission failure without starting a provider', async () => {
    const failure = new ModelProtocolError('authentication-failed', undefined,
      { version: 1, reason: 'cli-authentication', stage: 'configuration', source: 'local' })
    const streamChat = vi.fn(async () => result())
    const state = setup({ getCredentialSnapshot: async () => { throw failure }, streamChat })
    await expect(state.service.start(startInput())).rejects.toBe(failure)
    expect(streamChat).not.toHaveBeenCalled()
    await state.service.dispose()
  })

  it('does not consume a visible-assistant candidate when prospective compaction fails', async () => {
    const compactModel = connection({
      provider: 'other', baseUrl: 'https://models.example.com/v1', modelId: 'custom-chat',
      capabilityOverride: { contextWindowTokens: 100_000, maxInputTokens: 100_000, maxOutputTokens: 32_768 },
    })
    const firstText = 'a'.repeat(25_000)
    const secondText = 'b'.repeat(10_000)
    const summary = JSON.stringify({
      version: 1, userGoals: ['continue'], decisions: [], workspaceFacts: [],
      unresolvedQuestions: [], nextSteps: [], retainedToolFacts: [], completedOperationIds: [],
    })
    let summaryAttempts = 0
    const state = setup({ models: modelSettings(compactModel), streamChat: async (input) => {
      if (input.requestedOutputTokens === 16_384) {
        summaryAttempts += 1
        input.onDelta(summaryAttempts === 1 ? 'not-json' : summary)
        return result()
      }
      input.onDelta(input.messages.length === 2 ? 'First answer' : 'ok')
      return result()
    } })
    await state.service.start(continuedInput(state.events, {
      messages: [{ id: MESSAGE_ID, role: 'user', content: firstText }],
    }))
    await waitEvent(state.events, 'completed')
    const transcript = [
      { id: MESSAGE_ID, role: 'user' as const, content: firstText },
      { id: SECOND_MESSAGE_ID, role: 'assistant' as const, content: 'First answer' },
      { id: THIRD_MESSAGE_ID, role: 'user' as const, content: secondText },
    ]

    await expect(state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID, messages: transcript,
    }))).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await expect(state.service.start(continuedInput(state.events, {
      requestId: THIRD_REQUEST_ID, messages: transcript,
    }))).resolves.toMatchObject({ requestId: THIRD_REQUEST_ID })
    await waitEvent(state.events, 'completed', 2)
  })

  it('does not consume a visible-assistant candidate when a newer start replaces compaction', async () => {
    const compactModel = connection({
      provider: 'other', baseUrl: 'https://models.example.com/v1', modelId: 'custom-chat',
      capabilityOverride: { contextWindowTokens: 100_000, maxInputTokens: 100_000, maxOutputTokens: 32_768 },
    })
    const firstText = 'a'.repeat(25_000)
    const secondText = 'b'.repeat(10_000)
    const summaryGate = deferred<ModelChatResult>()
    const summary = JSON.stringify({
      version: 1, userGoals: ['continue'], decisions: [], workspaceFacts: [],
      unresolvedQuestions: [], nextSteps: [], retainedToolFacts: [], completedOperationIds: [],
    })
    let summaryCalls = 0
    const state = setup({ models: modelSettings(compactModel), streamChat: async (input) => {
      if (input.requestedOutputTokens === 16_384) {
        summaryCalls += 1
        if (summaryCalls === 1) return await summaryGate.promise
        input.onDelta(summary)
        return result()
      }
      input.onDelta(input.messages.length === 2 ? 'First answer' : 'ok')
      return result()
    } })
    await state.service.start(startInput({
      messages: [{ id: MESSAGE_ID, role: 'user', content: firstText }],
    }))
    await waitEvent(state.events, 'completed')
    const transcript = [
      { id: MESSAGE_ID, role: 'user' as const, content: firstText },
      { id: SECOND_MESSAGE_ID, role: 'assistant' as const, content: 'First answer' },
      { id: THIRD_MESSAGE_ID, role: 'user' as const, content: secondText },
    ]

    const replaced = state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID, messages: transcript,
    }))
    await vi.waitFor(() => expect(summaryCalls).toBe(1))
    const replacement = state.service.start(continuedInput(state.events, {
      requestId: THIRD_REQUEST_ID, messages: transcript,
    }))
    await expect(replacement).resolves.toMatchObject({ requestId: THIRD_REQUEST_ID })
    summaryGate.resolve(result())
    await expect(replaced).rejects.toMatchObject({ name: 'AbortError' })
    await waitEvent(state.events, 'completed', 2)
  })

  it('discards every model-switch candidate mutation when a newer start restores the original model', async () => {
    const selected = connection({ modelId: 'model-a' })
    const files = new MemoryWorkspaceFiles()
    const originalRoot = files.getRootCapability.bind(files)
    const finalRootGate = deferred<void>()
    let staleRootChecks = 0
    let gateStaleStart = false
    files.getRootCapability = vi.fn(async () => {
      if (gateStaleStart) {
        staleRootChecks += 1
        if (staleRootChecks === 4) await finalRootGate.promise
      }
      return await originalRoot()
    })
    const state = setup({ files, models: modelSettings(selected), streamChat: async (input) => {
      input.onDelta('ok')
      return result()
    } })
    await state.service.start(startInput())
    await waitEvent(state.events, 'completed')
    state.service.setCapabilities({
      ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
      conversationId: CONVERSATION_ID, capabilities: { currentDocument: true, workspace: false },
    })

    selected.modelId = 'model-b'
    gateStaleStart = true
    const stale = state.service.start(continuedInput(state.events, {
      capabilities: { currentDocument: true, workspace: false },
      requestId: SECOND_REQUEST_ID,
      messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'stale switch' }],
    }))
    await vi.waitFor(() => expect(staleRootChecks).toBe(4))
    selected.modelId = 'model-a'
    const replacement = state.service.start(continuedInput(state.events, {
      capabilities: { currentDocument: true, workspace: false },
      requestId: THIRD_REQUEST_ID,
      messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'replacement' }],
    }))
    await expect(replacement).resolves.toMatchObject({ requestId: THIRD_REQUEST_ID })
    finalRootGate.resolve()
    await expect(stale).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await waitEvent(state.events, 'completed', 2)

    const replacementNormal = state.streamChat.mock.calls.at(-1)![0]
    expect(replacementNormal.tools?.map((tool) => tool.name)).toContain('read_current_document')
  })

  it('does not overwrite a concurrent capability revision with a pending start candidate', async () => {
    const files = new MemoryWorkspaceFiles()
    const originalRoot = files.getRootCapability.bind(files)
    const finalRootGate = deferred<void>()
    let rootChecks = 0
    let gateCandidate = false
    files.getRootCapability = vi.fn(async () => {
      if (gateCandidate) {
        rootChecks += 1
        if (rootChecks === 4) await finalRootGate.promise
      }
      return await originalRoot()
    })
    const state = setup({ files })
    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: false } }))
    await waitEvent(state.events, 'completed')

    gateCandidate = true
    const pending = state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'pending' }],
    }))
    await vi.waitFor(() => expect(rootChecks).toBe(4))
    state.service.setCapabilities({
      ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
      conversationId: CONVERSATION_ID, capabilities: { currentDocument: false, workspace: false },
    })
    finalRootGate.resolve()

    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await state.service.start(continuedInput(state.events, {
      requestId: THIRD_REQUEST_ID,
      messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'retry' }],
    }))
    await waitEvent(state.events, 'completed', 2)
    expect(state.streamChat.mock.calls.at(-1)![0].tools).toEqual([])
  })

  it('does not overwrite a concurrent write-policy revision with a pending start candidate', async () => {
    const files = new MemoryWorkspaceFiles()
    const originalRoot = files.getRootCapability.bind(files)
    const finalRootGate = deferred<void>()
    let rootChecks = 0
    let gateCandidate = false
    files.getRootCapability = vi.fn(async () => {
      if (gateCandidate) {
        rootChecks += 1
        if (rootChecks === 4) await finalRootGate.promise
      }
      return await originalRoot()
    })
    const state = setup({ files, writePolicy: 'document-grant' })
    await state.service.start(startInput())
    await waitEvent(state.events, 'completed')

    gateCandidate = true
    const pending = state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'pending' }],
    }))
    await vi.waitFor(() => expect(rootChecks).toBe(4))
    state.settings.setWritePolicy('workspace-grant')
    finalRootGate.resolve()

    await expect(pending).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  })

  it('fails before the first provider send when the initial open turn exceeds the hard input limit', async () => {
    const limited = connection({
      provider: 'other', baseUrl: 'https://models.example.com/v1', modelId: 'limited-chat',
      capabilityOverride: { contextWindowTokens: 40_000, maxInputTokens: 1_000, maxOutputTokens: 100 },
    })
    const state = setup({ models: modelSettings(limited) })
    await state.service.start(continuedInput(state.events, {
      messages: [{ id: MESSAGE_ID, role: 'user', content: 'x'.repeat(2_000) }],
    }))

    expect(await waitEvent(state.events, 'failed')).toMatchObject({ code: 'TOOL_RESULT_TOO_LARGE' })
    expect(state.streamChat).not.toHaveBeenCalled()
  })

  it('checks the hard input limit again before a tool continuation provider send', async () => {
    const limited = connection({
      provider: 'other', baseUrl: 'https://models.example.com/v1', modelId: 'limited-workspace-chat',
      capabilityOverride: { contextWindowTokens: 160_000, maxInputTokens: 15_000, maxOutputTokens: 1_000 },
    })
    const state = setup({ models: modelSettings(limited) })
    state.files.readContent = 'z'.repeat(20_000)
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_workspace_document', {
      path: 'notes/a.md', cursor: 0, maxChars: 48_000,
    })] }))
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))

    expect(await waitEvent(state.events, 'failed')).toMatchObject({ code: 'TOOL_RESULT_TOO_LARGE' })
    expect(state.streamChat).toHaveBeenCalledOnce()
  })

  it('reports the general context limit only after closed-history compaction cannot fit retained context', async () => {
    const limited = connection({
      provider: 'other', baseUrl: 'https://models.example.com/v1', modelId: 'limited-history-chat',
      capabilityOverride: { contextWindowTokens: 150_000, maxInputTokens: 50_000, maxOutputTokens: 32_768 },
    })
    const largeSummary = JSON.stringify({
      version: 1,
      userGoals: ['g'.repeat(4_000)], decisions: ['d'.repeat(4_000)], workspaceFacts: [],
      unresolvedQuestions: ['q'.repeat(4_000)], nextSteps: ['n'.repeat(4_000)],
      retainedToolFacts: [], completedOperationIds: [],
    })
    let normalCalls = 0
    let state!: ReturnType<typeof setup>
    state = setup({ models: modelSettings(limited), streamChat: async (input) => {
      if (input.requestedOutputTokens === 16_384) {
        input.onDelta(largeSummary)
        return result()
      }
      normalCalls += 1
      if (normalCalls === 1) {
        input.onDelta('a'.repeat(6_000))
        return result()
      }
      state.service.setCapabilities({
        ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
        conversationId: CONVERSATION_ID,
        capabilities: { currentDocument: false, workspace: true },
      })
      return result({ toolCalls: [call('read_workspace_document', {
        path: 'notes/a.md', cursor: 0, maxChars: 48_000,
      })] })
    } })
    // Exceed the model-bounded 50K retained-context limit, while the open tool
    // transaction itself still fits and therefore permits a compaction attempt.
    state.files.readContent = 'z'.repeat(30_000)
    await state.service.start(startInput({
      messages: [{ id: MESSAGE_ID, role: 'user', content: 'u'.repeat(6_000) }],
    }))
    await waitEvent(state.events, 'completed')

    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: 'u'.repeat(6_000) },
        { id: SECOND_MESSAGE_ID, role: 'user', content: 'continue' },
      ],
    }))

    expect(await waitEvent(state.events, 'failed')).toMatchObject({ code: 'AI_CONTEXT_LIMIT_REACHED' })
    expect(state.streamChat.mock.calls.filter(([input]) => input.requestedOutputTokens === 16_384)).toHaveLength(1)
    expect(normalCalls).toBe(2)
  })

  it('does not compact an open mutation while authorization is pending', async () => {
    const compactModel = connection({
      provider: 'other', baseUrl: 'https://models.example.com/v1', modelId: 'custom-chat',
      capabilityOverride: { contextWindowTokens: 250_000, maxInputTokens: 100_000, maxOutputTokens: 32_768 },
    })
    const { service, events, streamChat } = setup({ models: modelSettings(compactModel) })
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    const started = await service.start(startInput({
      messages: [{ id: MESSAGE_ID, role: 'user', content: 'x'.repeat(5_000) }],
      capabilities: { currentDocument: false, workspace: true },
    }))
    await vi.waitFor(() => expect(
      events.filter((event) => event.type === 'authorization-requested'),
      JSON.stringify(events),
    ).toHaveLength(1))
    expect(streamChat.mock.calls.some(([input]) => input.requestedOutputTokens === 16_384)).toBe(false)
    await service.cancel(started.requestId)
  })

  it('rolls back a canceled partial assistant turn before the next user turn', async () => {
    const interrupted = deferred<ModelChatResult>()
    const { service, events, streamChat } = setup()
    streamChat.mockImplementationOnce(async (input) => {
      input.onDelta('partial')
      return interrupted.promise
    }).mockResolvedValueOnce(result())
    const started = await service.start(startInput())
    await waitEvent(events, 'delta')
    await service.cancel(started.requestId)
    interrupted.reject(new DOMException('aborted', 'AbortError'))
    await Promise.resolve()

    await service.start(continuedInput(events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
        { id: SECOND_MESSAGE_ID, role: 'user', content: 'Try again.' },
      ],
    }))
    await waitEvent(events, 'completed')

    const retryWire = JSON.stringify(streamChat.mock.calls[1]![0].messages)
    expect(retryWire).not.toContain('Please help.')
    expect(retryWire).toContain('Try again.')
  })

  it.each(['list', 'workspace-read', 'current-document'] as const)(
    'drops a late %s result after cancellation without mutating session wire or caches',
    async (kind) => {
      const gate = deferred<void>()
      const files = new MemoryWorkspaceFiles()
      if (kind === 'list') files.listGate = gate.promise
      if (kind === 'workspace-read') files.readGate = gate.promise
      const opened = snapshot('active.md', 'text', VERSION_A)
      const readPage = opened.readPage.bind(opened)
      if (kind === 'current-document') {
        opened.readPage = async (input, signal) => {
          await gate.promise
          return await readPage(input, signal)
        }
      }
      const state = setup({ files, openCurrentDocument: async () => opened })
      const tool = kind === 'list'
        ? call('list_workspace_entries', { path: '', cursor: 0, maxEntries: 100, directoryVersion: null })
        : kind === 'workspace-read'
          ? call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 })
          : call('read_current_document', { cursor: 0, maxChars: 100 })
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [tool] })).mockResolvedValueOnce(result())
      const started = await state.service.start(startInput({
        capabilities: { currentDocument: kind === 'current-document', workspace: kind !== 'current-document' },
      }))
      await vi.waitFor(() => {
        if (kind === 'list') expect(files.requests).toEqual(['list:'])
        else if (kind === 'workspace-read') expect(files.requests).toEqual(['read:notes/a.md'])
        else expect(state.openCurrentDocument).toHaveBeenCalledOnce()
      })

      await state.service.cancel(started.requestId)
      gate.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await state.service.start(continuedInput(state.events, {
        requestId: SECOND_REQUEST_ID,
        messages: [
          { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
          { id: SECOND_MESSAGE_ID, role: 'user', content: 'Try again.' },
        ],
      }))
      await waitEvent(state.events, 'completed')

      const retryMessages = state.streamChat.mock.calls.at(-1)![0].messages
      expect(retryMessages.some((message) => message.role === 'tool')).toBe(false)
      expect(JSON.stringify(retryMessages)).not.toContain(kind === 'list' ? 'notes/a.md' : '"kind":"document"')
    },
  )

  it.each(['list', 'workspace-read'] as const)(
    'passes the request abort signal through the %s file boundary',
    async (kind) => {
      const gate = deferred<void>()
      const files = new MemoryWorkspaceFiles()
      if (kind === 'list') files.listGate = gate.promise
      else files.readGate = gate.promise
      const state = setup({ files })
      const tool = kind === 'list'
        ? call('list_workspace_entries', { path: '', cursor: 0, maxEntries: 100, directoryVersion: null })
        : call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 })
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [tool] }))
      const started = await state.service.start(startInput({
        capabilities: { currentDocument: false, workspace: true },
      }))
      const signals = kind === 'list' ? files.listSignals : files.readSignals
      await vi.waitFor(() => expect(signals).toHaveLength(1))

      await state.service.cancel(started.requestId)
      expect(signals[0]).toBeInstanceOf(AbortSignal)
      expect(signals[0]?.aborted).toBe(true)
      gate.resolve()
    },
  )

  it('denies a pending structural action when trusted policy changes before approval', async () => {
    const state = setup()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
      'create_workspace_document', { path: 'new.md', content: 'new' },
    )] })).mockResolvedValueOnce(result())
    const started = await state.service.start(startInput({
      capabilities: { currentDocument: false, workspace: true },
      writePolicy: 'workspace-grant',
    }))
    const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    state.settings.setWritePolicy('workspace-grant')

    await expect(state.service.submitAuthorizationResult({
      requestId: started.requestId, operationId: prompt.operationId, allowed: true,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await waitEvent(state.events, 'completed')

    expect(state.events).toContainEqual(expect.objectContaining({
      type: 'authorization-result', operationId: prompt.operationId, allowed: false,
    }))
    expect(state.files.abandoned).toEqual([prompt.operationId])
    expect(state.files.executed).toEqual([])
  })

  it('rolls back a provider-failed turn before accepting the next user message', async () => {
    const { service, events, streamChat } = setup()
    streamChat.mockRejectedValueOnce(new ModelProtocolError('timeout')).mockResolvedValueOnce(result())
    await service.start(startInput())
    await waitEvent(events, 'failed')

    await service.start(continuedInput(events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
        { id: SECOND_MESSAGE_ID, role: 'user', content: 'Retry after failure.' },
      ],
    }))
    await waitEvent(events, 'completed')

    const retryWire = JSON.stringify(streamChat.mock.calls[1]![0].messages)
    expect(retryWire).not.toContain('Please help.')
    expect(retryWire).toContain('Retry after failure.')
  })

  it('terminalizes an authorization timeout exactly once and rejects a late approval', async () => {
    vi.useFakeTimers()
    try {
      const { service, events, files, streamChat } = setup()
      streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
        .mockResolvedValueOnce(result())
      const started = await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
      await vi.waitFor(() => expect(events.some((event) => event.type === 'authorization-requested')).toBe(true))
      const prompt = events.find((event): event is Extract<AiConversationEvent, { type: 'authorization-requested' }> => (
        event.type === 'authorization-requested'
      ))!

      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(events.some((event) => event.type === 'completed')).toBe(true))

      expect(files.abandoned).toEqual([prompt.operationId])
      expect(events.filter((event) => event.type === 'authorization-result')).toMatchObject([
        { operationId: prompt.operationId, allowed: false },
      ])
      await expect(service.submitAuthorizationResult({
        requestId: started.requestId, operationId: prompt.operationId, allowed: true,
      })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('disposes a pending authorization without late renderer events and terminalizes its manifest', async () => {
    const { service, events, files, streamChat } = setup()
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    const eventCount = events.length

    await service.dispose()
    await Promise.resolve()

    expect(files.abandoned).toEqual([prompt.operationId])
    expect(events).toHaveLength(eventCount)
  })

  it('uses live main-owned capability state when a stale advertised workspace tool arrives', async () => {
    const state = setup()
    state.streamChat.mockImplementationOnce(async () => {
      state.service.setCapabilities({
        ownerId: 1,
        workspaceId: 'workspace-a',
        workspaceGeneration: '1.generation',
        conversationId: CONVERSATION_ID,
        capabilities: { currentDocument: false, workspace: false },
      })
      return result({ toolCalls: [call('list_workspace_entries', {
        path: '', cursor: 0, maxEntries: 100, directoryVersion: null,
      })] })
    }).mockResolvedValueOnce(result())

    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')

    expect(state.files.requests).toEqual([])
    const tool = state.streamChat.mock.calls[1]![0].messages.find((message) => message.role === 'tool')!
    expect(JSON.parse(tool.content)).toEqual({ kind: 'denied', guidance: '请开启“AI 可查看工作区”。' })
  })

  it.each(['list', 'workspace-read', 'current-document'] as const)(
    'rejects a late %s result across a capability off-on ABA revision',
    async (kind) => {
      const gate = deferred<void>()
      const files = new MemoryWorkspaceFiles()
      if (kind === 'list') files.listGate = gate.promise
      if (kind === 'workspace-read') files.readGate = gate.promise
      const opened = snapshot('active.md', 'secret text', VERSION_A)
      if (kind === 'current-document') {
        const readPage = opened.readPage.bind(opened)
        opened.readPage = async (input, signal) => {
          await gate.promise
          return await readPage(input, signal)
        }
      }
      const state = setup({ files, openCurrentDocument: async () => opened })
      const tool = kind === 'list'
        ? call('list_workspace_entries', { path: '', cursor: 0, maxEntries: 100, directoryVersion: null })
        : kind === 'workspace-read'
          ? call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 })
          : call('read_current_document', { cursor: 0, maxChars: 100 })
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [tool] })).mockResolvedValueOnce(result())
      await state.service.start(startInput({
        capabilities: { currentDocument: kind === 'current-document', workspace: kind !== 'current-document' },
      }))
      await vi.waitFor(() => {
        if (kind === 'list') expect(files.requests).toEqual(['list:'])
        else if (kind === 'workspace-read') expect(files.requests).toEqual(['read:notes/a.md'])
        else expect(state.openCurrentDocument).toHaveBeenCalledOnce()
      })

      state.service.setCapabilities({
        ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
        conversationId: CONVERSATION_ID,
        capabilities: { currentDocument: false, workspace: false },
      })
      state.service.setCapabilities({
        ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
        conversationId: CONVERSATION_ID,
        capabilities: { currentDocument: kind === 'current-document', workspace: kind !== 'current-document' },
      })
      gate.resolve()
      await waitEvent(state.events, 'completed')

      const toolResult = state.streamChat.mock.calls[1]![0].messages.find((message) => message.role === 'tool')!
      expect(JSON.parse(toolResult.content)).toEqual({ kind: 'unavailable' })
    },
  )

  it('abandons a late mutation plan across a workspace capability off-on ABA revision', async () => {
    const gate = deferred<void>()
    const files = new MemoryWorkspaceFiles()
    files.planGate = gate.promise
    const state = setup({ files })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
      .mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await vi.waitFor(() => expect(files.planningStarted).toEqual([
      'edit_workspace_document:notes/a.md',
    ]))

    state.service.setCapabilities({
      ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
      conversationId: CONVERSATION_ID, capabilities: { currentDocument: false, workspace: false },
    })
    state.service.setCapabilities({
      ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
      conversationId: CONVERSATION_ID, capabilities: { currentDocument: false, workspace: true },
    })
    gate.resolve()
    await waitEvent(state.events, 'completed')

    expect(state.events.filter((event) => event.type === 'authorization-requested')).toEqual([])
    expect(files.executed).toEqual([])
    expect(files.abandoned).toEqual([OPERATION_IDS[0]])
  })

  it('binds capability changes to the current main owner and workspace generation', async () => {
    const state = setup()
    state.streamChat.mockImplementationOnce(async (input) => { input.onDelta('Done'); return result() })
      .mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')

    const switchTicket = await state.service.prepareWorkspaceSwitch()
    state.files.rootGeneration = '2.generation'
    state.files.activationEpoch = 2
    await state.service.activateWorkspace(switchTicket, await state.files.getRootCapability())
    expect(() => state.service.setCapabilities({
      ownerId: 1,
      workspaceId: 'workspace-a',
      workspaceGeneration: '1.generation',
      conversationId: CONVERSATION_ID,
      capabilities: { currentDocument: true, workspace: true },
    })).toThrow()
    expect(() => state.service.setCapabilities({
      ownerId: 1,
      workspaceId: 'workspace-a',
      workspaceGeneration: '2.generation',
      conversationId: CONVERSATION_ID,
      capabilities: { currentDocument: true, workspace: true },
    })).not.toThrow()

    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
        { id: SECOND_MESSAGE_ID, role: 'assistant', content: 'Done' },
        { id: THIRD_MESSAGE_ID, role: 'user', content: 'Continue.' },
      ],
      capabilities: { currentDocument: false, workspace: false },
    }))
    await waitEvent(state.events, 'completed', 2)
    expect(state.streamChat.mock.calls[1]![0].tools).toHaveLength(0)
  })

  it.each(['anthropic', 'openai-responses'] as const)('commits canonical visible assistants and removes %s replay on model switch', async (protocol) => {
    const state = setup()
    state.streamChat.mockImplementationOnce(async (input) => { input.onDelta('Canonical answer'); return result({
      reasoningContent: 'private reasoning',
      providerReplay: providerReplay(protocol),
    }) })
      .mockResolvedValueOnce(result())
    await state.service.start(startInput({ capabilities: { currentDocument: true, workspace: true } }))
    await waitEvent(state.events, 'completed')

    const replacement = connection({
      id: '550e8400-e29b-41d4-a716-446655440099',
      modelId: 'replacement-model',
    })
    state.models.connections = [replacement]
    state.models.aiConversation.connectionId = replacement.id
    await expect(state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
        { id: SECOND_MESSAGE_ID, role: 'assistant', content: 'Canonical answer' },
        { id: THIRD_MESSAGE_ID, role: 'user', content: 'Use the new model.' },
      ],
      capabilities: { currentDocument: true, workspace: true },
    }))).resolves.toMatchObject({ modelId: 'replacement-model' })
    await waitEvent(state.events, 'completed', 2)

    expect(state.streamChat.mock.calls[1]![0].tools).toHaveLength(7)
    expect(state.streamChat.mock.calls[1]![0].messages).toEqual(expect.arrayContaining([
      { role: 'user', content: 'Please help.' },
      { role: 'assistant', content: 'Canonical answer' },
      { role: 'user', content: 'Use the new model.' },
    ]))
    expect(state.streamChat.mock.calls[1]![0].messages.some((message) => 'reasoningContent' in message || 'providerReplay' in message || 'toolCalls' in message || message.role === 'tool')).toBe(false)
  })

  it('preserves an existing compaction checkpoint when rebuilding visible history for a new model', async () => {
    const state = setup({ models: modelSettings(connection({
      provider: 'other', modelId: 'first-model',
      capabilityOverride: { contextWindowTokens: 100_000, maxInputTokens: 100_000, maxOutputTokens: 32_768 },
    })), streamChat: async (input) => {
      if (input.requestedOutputTokens === 16_384) input.onDelta(JSON.stringify({
        version: 1, userGoals: ['整理笔记'], decisions: ['保留标题'],
        workspaceFacts: [{ path: 'notes/a.md', version: 'rev-a', fact: '已整理标题' }],
        unresolvedQuestions: [], nextSteps: ['继续检查'], retainedToolFacts: ['已检查笔记'], completedOperationIds: [],
      }))
      else input.onDelta('此前回答')
      return result({ reasoningContent: 'private reasoning' })
    } })
    await state.service.start(startInput({ messages: [{ id: MESSAGE_ID, role: 'user', content: 'a'.repeat(25_000) }] }))
    await waitEvent(state.events, 'completed')
    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID, messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'b'.repeat(10_000) }],
    }))
    await waitEvent(state.events, 'completed', 2)
    expect(state.events.some((event) => event.type === 'context-compaction' && event.status === 'compacted')).toBe(true)
    state.models.connections[0] = connection({ provider: 'other', modelId: 'larger-model',
      capabilityOverride: { contextWindowTokens: 250_000, maxInputTokens: 250_000, maxOutputTokens: 32_768 } })
    await state.service.start(continuedInput(state.events, {
      requestId: THIRD_REQUEST_ID, messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: '继续' }],
    }))
    await waitEvent(state.events, 'completed', 3)
    const messages = state.streamChat.mock.calls.at(-1)![0].messages
    const checkpoint = messages.find((message) => message.content.startsWith('ARKDOWN_CONTEXT_CHECKPOINT_V1\n'))
    expect(checkpoint).toBeDefined()
    expect(JSON.parse(checkpoint!.content.split('\n').slice(1).join('\n'))).toMatchObject({
      userGoals: ['整理笔记'], decisions: ['保留标题'],
      workspaceFacts: [{ path: 'notes/a.md', version: 'rev-a', fact: '已整理标题' }],
      nextSteps: ['继续检查'], retainedToolFacts: ['已检查笔记'],
    })
    expect(messages).toContainEqual({ role: 'assistant', content: '此前回答' })
    expect(messages.some((message) => 'reasoningContent' in message)).toBe(false)
  })

  it('compacts preserved history using the smaller selected model before sending the next user turn', async () => {
    const state = setup({ models: modelSettings(connection({ provider: 'other', modelId: 'large-model',
      capabilityOverride: { contextWindowTokens: 250_000, maxInputTokens: 250_000, maxOutputTokens: 32_768 },
    })), streamChat: async (input) => {
      input.onDelta(input.requestedOutputTokens === 16_384 ? JSON.stringify({
        version: 1, userGoals: ['continue previous question'], decisions: [], workspaceFacts: [],
        unresolvedQuestions: [], nextSteps: [], retainedToolFacts: [], completedOperationIds: [],
      }) : 'answer')
      return result()
    } })
    await state.service.start(startInput({ messages: [{ id: MESSAGE_ID, role: 'user', content: 'a'.repeat(25_000) }] }))
    await waitEvent(state.events, 'completed')
    state.models.connections[0] = connection({ provider: 'other', modelId: 'small-model',
      capabilityOverride: { contextWindowTokens: 100_000, maxInputTokens: 100_000, maxOutputTokens: 32_768 } })
    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID, messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'b'.repeat(10_000) }],
    }))
    await waitEvent(state.events, 'completed', 2)
    const summary = state.streamChat.mock.calls.find(([input]) => input.requestedOutputTokens === 16_384)![0]
    expect(summary.modelId).toBe('small-model')
    expect(summary.capabilityOverride?.contextWindowTokens).toBe(100_000)
    expect(JSON.stringify(summary.messages)).toContain('a'.repeat(25_000))
    expect(JSON.stringify(state.streamChat.mock.calls.at(-1)![0].messages)).toContain('continue previous question')
    expect(state.events).toContainEqual(expect.objectContaining({ type: 'context-compaction', status: 'compacted', contextWindowTokens: 100_000 }))
  })

  it.each(['document-grant', 'workspace-grant'] as const)('preserves completed operation facts and applies trusted %s after model switch', async (writePolicy) => {
    const state = setup({ writePolicy })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    if (writePolicy === 'document-grant') {
      const first = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      await state.service.submitAuthorizationResult({ requestId: REQUEST_ID, operationId: first.operationId, allowed: true })
    }
    await waitEvent(state.events, 'completed')
    const firstOperationId = state.files.executed[0]!
    state.settings.setSelectedModel('new-model')
    await state.service.start(continuedInput(state.events, {
      capabilities: { currentDocument: false, workspace: true },
      requestId: SECOND_REQUEST_ID, messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'use new model' }],
    }))
    await waitEvent(state.events, 'completed', 2)
    const switchedMessages = state.streamChat.mock.calls.at(-1)![0].messages
    const checkpoint = switchedMessages.find((message) => message.content.startsWith('ARKDOWN_CONTEXT_CHECKPOINT_V1\n'))
    expect(checkpoint?.content).toContain(firstOperationId)
    const facts = JSON.parse(checkpoint!.content.split('\n').slice(1).join('\n')).retainedToolFacts as string[]
    expect(facts.some((fact) => fact.includes('notes/a.md') && fact.includes('succeeded'))).toBe(true)
    expect(switchedMessages.some((message) => 'toolCalls' in message || message.role === 'tool')).toBe(false)
    state.service.setCapabilities({ ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
      conversationId: CONVERSATION_ID, capabilities: { currentDocument: false, workspace: true } })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit(), 'call_new')] }))
    await state.service.start(continuedInput(state.events, {
      capabilities: { currentDocument: false, workspace: true },
      requestId: THIRD_REQUEST_ID, messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'edit again' }],
    }))
    if (writePolicy === 'document-grant') {
      const next = await waitEvent(state.events, 'authorization-requested', 2) as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      expect(next.scope).toBe('document')
      await state.service.submitAuthorizationResult({ requestId: THIRD_REQUEST_ID, operationId: next.operationId, allowed: false })
    }
    await waitEvent(state.events, 'completed', 3)
    expect(state.files.executed).toHaveLength(writePolicy === 'document-grant' ? 1 : 2)
    if (writePolicy === 'workspace-grant') expect(state.events.filter(event => event.type === 'authorization-requested')).toHaveLength(0)
  })

  it.each(['succeeded', 'unknown'] as const)('keeps one consistent %s operation fact across consecutive model switches', async (outcome) => {
    const state = setup()
    state.files.outcome = outcome
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const authorization = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await state.service.submitAuthorizationResult({ requestId: REQUEST_ID, operationId: authorization.operationId, allowed: true })
    await waitEvent(state.events, 'completed')
    for (const [index, requestId, messageId, modelId] of [
      [2, SECOND_REQUEST_ID, SECOND_MESSAGE_ID, 'second-model'],
      [3, THIRD_REQUEST_ID, THIRD_MESSAGE_ID, 'third-model'],
    ] as const) {
      state.settings.setSelectedModel(modelId)
      await state.service.start(continuedInput(state.events, {
        requestId, messages: [{ id: messageId, role: 'user', content: 'Continue.' }],
      }))
      await waitEvent(state.events, 'completed', index)
      const messages = state.streamChat.mock.calls.at(-1)![0].messages
      const checkpointMessage = messages.find((message) => message.content.startsWith('ARKDOWN_CONTEXT_CHECKPOINT_V1\n'))!
      const checkpoint = JSON.parse(checkpointMessage.content.slice('ARKDOWN_CONTEXT_CHECKPOINT_V1\n'.length))
      expect(checkpoint.completedOperationIds).toEqual([authorization.operationId])
      const operations = (checkpoint.retainedToolFacts as string[]).flatMap((fact) => (
        JSON.parse(fact.slice('ARKDOWN_LOCAL_RECOVERY_V1\n'.length)).operations
      ))
      expect(operations).toEqual([{ operationId: authorization.operationId, state: outcome, paths: ['notes/a.md'], pathsOmitted: false }])
      expect(messages.some((message) => message.role === 'tool' || 'toolCalls' in message || 'providerReplay' in message)).toBe(false)
    }
  })

  it('treats reasoning effort as model identity and reapplies fresh read intent on the next turn', async () => {
    const qwen = connection({
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelId: 'qwen3.8-max',
    })
    const state = setup({ models: modelSettings(qwen) })
    state.streamChat
      .mockImplementationOnce(async (input) => { input.onDelta('First answer'); return result() })
      .mockResolvedValueOnce(result())
    await state.service.start(startInput({
      capabilities: { currentDocument: true, workspace: true },
    }))
    await waitEvent(state.events, 'completed')

    state.models.aiConversation.reasoningEffort = 'high'
    state.models.aiConversation.thinkingMode = 'disabled'
    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
        { id: SECOND_MESSAGE_ID, role: 'assistant', content: 'First answer' },
        { id: THIRD_MESSAGE_ID, role: 'user', content: 'Reason more deeply.' },
      ],
      capabilities: { currentDocument: true, workspace: true },
    }))
    await waitEvent(state.events, 'completed', 2)

    expect(state.streamChat.mock.calls[1]![0].reasoningEffort).toBe('high')
    expect(state.streamChat.mock.calls[1]![0].thinkingMode).toBe('disabled')
    expect(state.streamChat.mock.calls[1]![0].tools).toHaveLength(7)
  })

  it('validates an entire tool batch before the first call can cause a side effect', async () => {
    const { service, events, files, streamChat } = setup()
    streamChat.mockResolvedValueOnce(result({ toolCalls: [
      call('edit_workspace_document', edit(), 'call_1'),
      call('read_workspace_document', { path: '../escape', cursor: 0, maxChars: 100 }, 'call_2'),
    ] }))

    await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(events, 'failed')

    expect(files.requests).toEqual([])
    expect(events.some((event) => event.type === 'authorization-requested')).toBe(false)
  })

  it('drains an executing mutation to a terminal audit before clear completes', async () => {
    const gate = deferred<void>()
    const files = new MemoryWorkspaceFiles()
    files.executionGate = gate.promise
    const { service, events, streamChat } = setup({ files })
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    const started = await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await service.submitAuthorizationResult({ requestId: started.requestId, operationId: prompt.operationId, allowed: true })
    await vi.waitFor(() => expect(files.executed).toEqual([prompt.operationId]))

    let clearFinished = false
    const clearing = service.clearConversation('workspace-a', CONVERSATION_ID)
      .then(() => { clearFinished = true })
    await Promise.resolve()
    expect(clearFinished).toBe(false)

    gate.resolve()
    await clearing
    expect(events).toContainEqual(expect.objectContaining({ type: 'audit', action: 'edited' }))
  })

  it.each(['succeeded', 'unknown'] as const)(
    'recovers a complete terminal mutation call/result pair after cancellation (%s)',
    async (outcome) => {
      const execution = deferred<void>()
      const state = setup()
      state.files.executionGate = execution.promise
      state.files.outcome = outcome
      state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
        .mockResolvedValueOnce(result())
      const started = await state.service.start(startInput({
        capabilities: { currentDocument: false, workspace: true },
      }))
      const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      await state.service.submitAuthorizationResult({
        requestId: started.requestId, operationId: prompt.operationId, allowed: true,
      })
      await vi.waitFor(() => expect(state.files.executed).toEqual([prompt.operationId]))

      const cancellation = state.service.cancel(started.requestId)
      execution.resolve()
      await cancellation
      expect(state.streamChat).toHaveBeenCalledOnce()

      await state.service.start(continuedInput(state.events, {
        requestId: SECOND_REQUEST_ID,
        messages: [
          { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
          { id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue after recovery.' },
        ],
        capabilities: { currentDocument: false, workspace: true },
      }))
      await waitEvent(state.events, 'completed')
      const recoveryWire = state.streamChat.mock.calls[1]![0].messages
      const assistantIndex = recoveryWire.findIndex((message) => message.role === 'assistant'
        && message.toolCalls?.some((item) => item.id === 'call_1'))
      expect(assistantIndex).toBeGreaterThan(0)
      expect(recoveryWire[assistantIndex + 1]).toMatchObject({ role: 'tool', toolCallId: 'call_1' })
      expect(JSON.parse((recoveryWire[assistantIndex + 1] as Extract<ModelChatInput['messages'][number], { role: 'tool' }>).content))
        .toMatchObject({ kind: 'mutation', operationId: prompt.operationId, state: outcome })
    },
  )

  it('restores a read-before-mutation assistant batch once with every ordered terminal result', async () => {
    const files = new MemoryWorkspaceFiles()
    const secondExecution = deferred<void>()
    const executeAuthorized = files.executeAuthorized.bind(files)
    let executionCount = 0
    files.executeAuthorized = vi.fn(async (operation) => {
      executionCount += 1
      if (executionCount === 2) await secondExecution.promise
      return await executeAuthorized(operation)
    }) as MemoryWorkspaceFiles['executeAuthorized']
    const replay = {
      protocol: 'anthropic' as const,
      blocks: [{ type: 'thinking' as const, thinking: 'hidden', signature: 'signed' }],
    }
    const state = setup({ files, writePolicy: 'workspace-grant' })
    state.streamChat.mockResolvedValueOnce(result({
      reasoningContent: 'private batch reasoning', providerReplay: replay,
      toolCalls: [
        call('read_workspace_document', {
          path: 'notes/read-first.md', cursor: 0, maxChars: 100,
        }, 'call_read'),
        call('edit_workspace_document', edit('notes/a.md', VERSION_A), 'call_mutation_1'),
        call('edit_workspace_document', edit('notes/b.md', VERSION_B), 'call_mutation_2'),
      ],
    })).mockImplementationOnce(async (input) => {
      input.onDelta('Recovered.')
      return result()
    }).mockImplementationOnce(async (input) => {
      input.onDelta('New answer.')
      return result()
    })

    const first = await state.service.start(startInput({
      capabilities: { currentDocument: false, workspace: true },
    }))
    await vi.waitFor(() => expect(executionCount).toBe(2))
    const cancellation = state.service.cancel(first.requestId)
    secondExecution.resolve()
    await cancellation

    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue after recovery.' }],
      capabilities: { currentDocument: false, workspace: true },
    }))
    await waitEvent(state.events, 'completed')

    const recoveryWire = state.streamChat.mock.calls[1]![0].messages
    const assistantIndex = recoveryWire.findIndex((message) => message.role === 'assistant'
      && message.toolCalls?.some((item) => item.id === 'call_read'))
    expect(recoveryWire.slice(assistantIndex)).toMatchObject([
      {
        role: 'assistant', reasoningContent: 'private batch reasoning', providerReplay: replay,
        toolCalls: [{ id: 'call_read' }, { id: 'call_mutation_1' }, { id: 'call_mutation_2' }],
      },
      { role: 'tool', toolCallId: 'call_read' },
      { role: 'tool', toolCallId: 'call_mutation_1' },
      { role: 'tool', toolCallId: 'call_mutation_2' },
    ])
    expect(recoveryWire.filter((message) => message.role === 'tool').map((message) => message.toolCallId))
      .toEqual(['call_read', 'call_mutation_1', 'call_mutation_2'])
    expect(JSON.parse((recoveryWire[assistantIndex + 1] as Extract<ModelChatInput['messages'][number], { role: 'tool' }>).content))
      .toMatchObject({ kind: 'document', path: 'notes/read-first.md' })
    expect(files.executed).toHaveLength(2)
  })

  it.each(['compaction-error', 'compaction-cancel'] as const)(
    'keeps recovery closure and the prospective user failure-atomic across %s so the next start can recover',
    async (failure) => {
      const compactModel = connection({
        provider: 'other', baseUrl: 'https://models.example.com/v1', modelId: 'recovery-chat',
        capabilityOverride: { contextWindowTokens: 250_000, maxInputTokens: 200_000, maxOutputTokens: 32_768 },
      })
      const files = new MemoryWorkspaceFiles()
      const execution = deferred<void>()
      files.executionGate = execution.promise
      const firstSummary = deferred<ModelChatResult>()
      let firstSummaryInput: ModelChatInput | undefined
      let failFirstSummary = true
      let normalCalls = 0
      let operationId = ''
      const validSummary = (input: ModelChatInput) => JSON.stringify({
        version: 1, userGoals: ['continue'], decisions: [], workspaceFacts: [],
        unresolvedQuestions: [], nextSteps: [], retainedToolFacts: [],
        completedOperationIds: operationId !== '' && JSON.stringify(input.messages).includes(operationId)
          ? [operationId] : [],
      })
      const state = setup({ files, models: modelSettings(compactModel), streamChat: async (input) => {
        if (input.requestedOutputTokens === 16_384) {
          if (failFirstSummary) {
            failFirstSummary = false
            if (failure === 'compaction-error') {
              input.onDelta('not-json')
              return result()
            }
            firstSummaryInput = input
            return await firstSummary.promise
          }
          input.onDelta(validSummary(input))
          return result()
        }
        normalCalls += 1
        if (normalCalls === 1) {
          input.onDelta('History answer.')
          return result()
        }
        if (normalCalls === 2) {
          return result({ toolCalls: [call('edit_workspace_document', edit())] })
        }
        input.onDelta(normalCalls === 3 ? 'Discarded recovery closure.'
          : normalCalls === 4 ? 'Committed recovery closure.' : 'New answer.')
        return result()
      } })

      await state.service.start(startInput({
        messages: [{ id: MESSAGE_ID, role: 'user', content: 'h'.repeat(85_000) }],
      }))
      await waitEvent(state.events, 'completed')
      state.service.setCapabilities({
        ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
        conversationId: CONVERSATION_ID,
        capabilities: { currentDocument: false, workspace: true },
      })
      const mutation = await state.service.start(continuedInput(state.events, {
      capabilities: { currentDocument: false, workspace: true },
        requestId: SECOND_REQUEST_ID,
        messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Apply the edit.' }],
      }))
      const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      operationId = prompt.operationId
      await state.service.submitAuthorizationResult({
        requestId: mutation.requestId, operationId, allowed: true,
      })
      await vi.waitFor(() => expect(files.executed).toEqual([operationId]))
      const mutationCancellation = state.service.cancel(mutation.requestId)
      execution.resolve()
      await mutationCancellation
      state.service.setCapabilities({
        ownerId: 1, workspaceId: 'workspace-a', workspaceGeneration: '1.generation',
        conversationId: CONVERSATION_ID,
        capabilities: { currentDocument: false, workspace: false },
      })

      const recoveryRevision = latestTranscriptRevision(state.events)
      const eventsBeforeFailedRecovery = state.events.length
      const failedRecovery = await state.service.start(startInput({
        requestId: THIRD_REQUEST_ID,
        acknowledgedTranscriptRevision: recoveryRevision,
        messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'p'.repeat(80_000) }],
        capabilities: { currentDocument: false, workspace: false },
      }))
      expect(failedRecovery.transcriptRevision).toBe(recoveryRevision)
      if (failure === 'compaction-error') {
        await waitEvent(state.events, 'failed')
      } else {
        await vi.waitFor(() => expect(firstSummaryInput).toBeDefined())
        await state.service.cancel(failedRecovery.requestId)
        firstSummaryInput!.onDelta(validSummary(firstSummaryInput!))
        firstSummary.resolve(result())
        await Promise.resolve()
        await Promise.resolve()
      }

      const failedAttemptEvents = state.events.slice(eventsBeforeFailedRecovery)
      expect(failedAttemptEvents.some((event) => [
        'message-start', 'delta', 'usage', 'message-completed', 'user-message-accepted',
      ].includes(event.type))).toBe(false)

      await expect(state.service.start(startInput({
        requestId: '950e8400-e29b-41d4-a716-446655440010',
        acknowledgedTranscriptRevision: recoveryRevision,
        messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'p'.repeat(80_000) }],
        capabilities: { currentDocument: false, workspace: false },
      }))).resolves.toMatchObject({ transcriptRevision: recoveryRevision })
      await waitEvent(state.events, 'completed', 2)

      const committedRecovery = [...state.streamChat.mock.calls].reverse().find(([input]) => (
        input.requestedOutputTokens === 32_768 && input.tools?.length === 0
        && JSON.stringify(input.messages).includes(operationId)
        && !JSON.stringify(input.messages).includes('p'.repeat(1_000))
      ))?.[0]
      expect(committedRecovery).toBeDefined()
      const normalAfterRecovery = [...state.streamChat.mock.calls].reverse().find(([input]) => (
        input.requestedOutputTokens === 32_768
        && JSON.stringify(input.messages).includes('p'.repeat(1_000))
      ))?.[0]
      expect(normalAfterRecovery).toBeDefined()
      expect(JSON.stringify(state.events)).not.toContain('Discarded recovery closure.')
      expect(JSON.stringify(state.events)).toContain('Committed recovery closure.')
    },
    15_000,
  )

  it.each(['credential', 'root'] as const)(
    'discards a recovery candidate after a newer start reserves generation while its %s check is deferred',
    async (deferredCheck) => {
      const files = new MemoryWorkspaceFiles()
      const originalRoot = files.getRootCapability.bind(files)
      const rootGate = deferred<Awaited<ReturnType<MemoryWorkspaceFiles['getRootCapability']>>>()
      const rootBlocked = deferred<void>()
      let gateNewerRoot = false
      let newerRootCalls = 0
      files.getRootCapability = vi.fn(async () => {
        if (gateNewerRoot) {
          newerRootCalls += 1
          if (deferredCheck === 'root' && newerRootCalls === 2) {
            rootBlocked.resolve()
            return await rootGate.promise
          }
        }
        return await originalRoot()
      })

      const selected = connection()
      const models = modelSettings(selected)
      const credentialGate = deferred<{ connection: ModelConnectionSummary; apiKey: string | null }>()
      const credentialBlocked = deferred<void>()
      let gateNewerCredential = false
      const getCredentialSnapshot = vi.fn(async () => {
        if (gateNewerCredential && deferredCheck === 'credential') {
          credentialBlocked.resolve()
          return await credentialGate.promise
        }
        return { connection: selected, apiKey: 'api-key' }
      })
      const mutationExecution = deferred<void>()
      files.executionGate = mutationExecution.promise
      const staleRecovery = deferred<ModelChatResult>()
      const staleRecoveryReturned = deferred<void>()
      let ordinaryCalls = 0
      const state = setup({ files, models, getCredentialSnapshot, streamChat: async (input) => {
        ordinaryCalls += 1
        if (ordinaryCalls === 1) {
          return result({ toolCalls: [call('edit_workspace_document', edit())] })
        }
        if (ordinaryCalls === 2) {
          const response = await staleRecovery.promise
          staleRecoveryReturned.resolve()
          return response
        }
        input.onDelta(ordinaryCalls === 3 ? 'Fresh recovery.' : 'Fresh answer.')
        return result()
      } })

      const mutation = await state.service.start(startInput({
        capabilities: { currentDocument: false, workspace: true },
      }))
      const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      await state.service.submitAuthorizationResult({
        requestId: mutation.requestId, operationId: prompt.operationId, allowed: true,
      })
      await vi.waitFor(() => expect(files.executed).toEqual([prompt.operationId]))
      const cancellation = state.service.cancel(mutation.requestId)
      mutationExecution.resolve()
      await cancellation

      const recoveryRevision = latestTranscriptRevision(state.events)
      const stale = await state.service.start(startInput({
        requestId: SECOND_REQUEST_ID,
        acknowledgedTranscriptRevision: recoveryRevision,
        messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Stale recovery user.' }],
        capabilities: { currentDocument: false, workspace: true },
      }))
      expect(stale.transcriptRevision).toBe(recoveryRevision)
      await vi.waitFor(() => expect(state.streamChat).toHaveBeenCalledTimes(2))

      gateNewerCredential = true
      gateNewerRoot = true
      const staleEventsBeforeReservation = state.events.filter((event) => (
        event.requestId === SECOND_REQUEST_ID
      )).length
      const newer = state.service.start(startInput({
        requestId: THIRD_REQUEST_ID,
        acknowledgedTranscriptRevision: recoveryRevision,
        messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: 'Newer recovery user.' }],
        capabilities: { currentDocument: false, workspace: true },
      }))
      await (deferredCheck === 'credential' ? credentialBlocked.promise : rootBlocked.promise)

      const staleInput = state.streamChat.mock.calls[1]![0]
      staleInput.onDelta('STALE RECOVERY MUST NOT COMMIT')
      staleRecovery.resolve(result())
      await staleRecoveryReturned.promise
      for (let index = 0; index < 8; index += 1) await Promise.resolve()

      if (deferredCheck === 'credential') {
        credentialGate.resolve({ connection: selected, apiKey: 'api-key' })
      } else {
        rootGate.resolve(await originalRoot())
      }
      await expect(newer).resolves.toMatchObject({
        requestId: THIRD_REQUEST_ID,
        transcriptRevision: recoveryRevision,
      })
      await waitEvent(state.events, 'completed')

      expect(state.events.filter((event) => event.requestId === SECOND_REQUEST_ID))
        .toHaveLength(staleEventsBeforeReservation)
      expect(JSON.stringify(state.events)).not.toContain('STALE RECOVERY MUST NOT COMMIT')
      expect(JSON.stringify(state.events)).toContain('Fresh recovery.')
      expect(files.executed).toEqual([prompt.operationId])
    },
  )

  it('closes an Anthropic multi-operation recovery locally before a new model compacts and accepts the user', async () => {
    const largeProfile = {
      contextWindowTokens: 250_000, maxInputTokens: 200_000, maxOutputTokens: 32_768,
    }
    const longRelativePath = Array.from({ length: 90 }, (_, index) => (
      `segment-${index.toString().padStart(3, '0')}-${'x'.repeat(180)}`
    )).join('/')
    const anthropic = connection({
      provider: 'other', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com',
      modelId: 'claude-recovery', capabilityOverride: largeProfile,
    })
    const models = modelSettings(anthropic)
    const files = new MemoryWorkspaceFiles()
    const executeAuthorized = files.executeAuthorized.bind(files)
    const unknownExecution = deferred<void>()
    const unknownStarted = deferred<void>()
    let executionCount = 0
    files.executeAuthorized = vi.fn(async (manifest) => {
      executionCount += 1
      if (executionCount === 1) return await executeAuthorized(manifest)
      files.executed.push(manifest.operationId)
      if (executionCount === 2) throw new Error('bounded local failure')
      unknownStarted.resolve()
      await unknownExecution.promise
      throw new AiOperationOutcomeUnknownError()
    }) as MemoryWorkspaceFiles['executeAuthorized']
    const replay = {
      protocol: 'anthropic' as const,
      blocks: [{
        type: 'thinking' as const,
        thinking: 'anthropic-private-reasoning C:\\private\\never-send.txt nonce-secret',
        signature: 'signed-provider-state',
      }],
    }
    let ordinaryCalls = 0
    let summaryInput: ModelChatInput | undefined
    const state = setup({ files, models, writePolicy: 'workspace-grant', streamChat: async (input) => {
      if (input.requestedOutputTokens === 16_384) {
        summaryInput = input
        input.onDelta(JSON.stringify({
          version: 1, userGoals: ['continue safely'], decisions: [], workspaceFacts: [],
          unresolvedQuestions: [], nextSteps: ['reread affected relative paths'], retainedToolFacts: [],
          completedOperationIds: [files.executed[0]!, files.executed[2]!],
        }))
        return result()
      }
      ordinaryCalls += 1
      if (ordinaryCalls === 1) {
        return result({
          reasoningContent: 'anthropic-private-reasoning', providerReplay: replay,
          toolCalls: [
            call('edit_workspace_document', edit('notes/succeeded.md', VERSION_A), 'call_succeeded'),
            call('edit_workspace_document', edit('notes/failed.md', VERSION_B), 'call_failed'),
            call('edit_workspace_document', edit(longRelativePath, {
              fileId: 'file-c', revision: 'rev-c', size: 4, mtimeMs: 1,
            }), 'call_unknown'),
          ],
        })
      }
      input.onDelta('New model answer.')
      return result()
    } })

    const mutation = await state.service.start(startInput({
      messages: [{ id: MESSAGE_ID, role: 'user', content: 'h'.repeat(85_000) }],
      capabilities: { currentDocument: false, workspace: true },
    }))
    await unknownStarted.promise
    const cancellation = state.service.cancel(mutation.requestId)
    unknownExecution.resolve()
    await cancellation
    expect(files.executed).toHaveLength(3)

    const replacement = connection({
      provider: 'other', protocol: 'openai', baseUrl: 'https://new-model.example.com/v1',
      modelId: 'new-model', capabilityOverride: largeProfile,
    })
    state.models.connections[0] = replacement
    state.models.aiConversation.connectionId = replacement.id
    state.settings.setSelectedModel('new-model')
    const recoveryRevision = latestTranscriptRevision(state.events)
    const resumed = await state.service.start(startInput({
      requestId: SECOND_REQUEST_ID,
      acknowledgedTranscriptRevision: recoveryRevision,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'p'.repeat(80_000) }],
      capabilities: { currentDocument: false, workspace: false },
    }))
    expect(resumed).toMatchObject({ modelId: 'new-model', transcriptRevision: recoveryRevision })
    await waitEvent(state.events, 'completed')

    const authorityDelta = state.events.find((event): event is Extract<AiConversationEvent, { type: 'delta' }> => (
      event.type === 'delta' && event.delta.startsWith('ARKDOWN_LOCAL_RECOVERY_V1\n')
    ))
    expect(authorityDelta).toBeDefined()
    const authority = JSON.parse(authorityDelta!.delta.slice('ARKDOWN_LOCAL_RECOVERY_V1\n'.length))
    expect(authority).toEqual({
      version: 1,
      instruction: '上一工具事务已在本地结束，勿重放。再次依赖相关文件或修改前，重新读取受影响的相对路径。未知结果及 completedOperationIds 不代表操作成功。',
      operationsOmitted: false,
      operations: [
        { operationId: files.executed[0], state: 'succeeded', paths: ['notes/succeeded.md'], pathsOmitted: false },
        { operationId: files.executed[1], state: 'failed', paths: ['notes/failed.md'], pathsOmitted: false },
        { operationId: files.executed[2], state: 'unknown', paths: [], pathsOmitted: true },
      ],
    })
    expect(authorityDelta!.delta.length).toBeLessThan(16_384)

    expect(summaryInput).toBeDefined()
    const newModelWire = JSON.stringify(state.streamChat.mock.calls.slice(1).map(([input]) => input.messages))
    expect(newModelWire).not.toContain('anthropic-private-reasoning')
    expect(newModelWire).not.toContain('signed-provider-state')
    expect(newModelWire).not.toContain('nonce-secret')
    expect(newModelWire).not.toContain('C:\\\\private')
    expect(newModelWire).not.toContain('call_succeeded')
    expect(newModelWire).not.toContain(longRelativePath)
    const lineageMessage = summaryInput!.messages.find((message) => (
      message.role === 'assistant' && message.content.startsWith('ARKDOWN_CONTEXT_CHECKPOINT_V1\n')
    ))!
    const lineage = JSON.parse(lineageMessage.content.slice('ARKDOWN_CONTEXT_CHECKPOINT_V1\n'.length))
    expect(lineage.completedOperationIds).toEqual([files.executed[0], files.executed[2]])
    expect(ordinaryCalls).toBe(2)
    const normalInput = state.streamChat.mock.calls.at(-1)![0]
    expect(normalInput.tools).toEqual([])
    expect(JSON.stringify(normalInput.messages)).toContain('ARKDOWN_LOCAL_RECOVERY_V1')
    expect(JSON.stringify(normalInput.messages)).toContain('p'.repeat(1_000))

    const completedRevisions = state.events
      .filter((event): event is Extract<AiConversationEvent, { type: 'message-completed' }> => event.type === 'message-completed')
      .map((event) => event.transcriptRevision)
    expect(completedRevisions).toEqual([2, 3, 5])
    expect(state.events).toContainEqual(expect.objectContaining({
      requestId: SECOND_REQUEST_ID,
      type: 'user-message-accepted',
      messageId: SECOND_MESSAGE_ID,
      transcriptRevision: 4,
    }))
  }, 15_000)

  it.each(['anthropic', 'openai-responses'] as const)('recovers one exact %s replay-bearing assistant batch before accepting the queued user turn', async (protocol) => {
    const files = new MemoryWorkspaceFiles()
    const secondExecution = deferred<void>()
    const executeAuthorized = files.executeAuthorized.bind(files)
    let executionCount = 0
    files.executeAuthorized = vi.fn(async (operation) => {
      executionCount += 1
      if (executionCount === 2) await secondExecution.promise
      return await executeAuthorized(operation)
    }) as MemoryWorkspaceFiles['executeAuthorized']
    const replay = providerReplay(protocol)
    const state = setup({ files, writePolicy: 'workspace-grant' })
    state.streamChat.mockResolvedValueOnce(result({
      reasoningContent: 'private chain', providerReplay: replay,
      toolCalls: [
        call('edit_workspace_document', edit('notes/a.md', VERSION_A), 'call_1'),
        call('edit_workspace_document', edit('notes/b.md', VERSION_B), 'call_2'),
      ],
    })).mockImplementationOnce(async (input) => {
      input.onDelta('Recovered.')
      return result()
    }).mockImplementationOnce(async (input) => {
      input.onDelta('New answer.')
      return result()
    }).mockImplementationOnce(async (input) => {
      input.onDelta('Later answer.')
      return result()
    })

    const first = await state.service.start(startInput({
      capabilities: { currentDocument: false, workspace: true }, writePolicy: 'workspace-grant',
    }))
    await vi.waitFor(() => expect(executionCount).toBe(2))
    const cancellation = state.service.cancel(first.requestId)
    secondExecution.resolve()
    await cancellation

    const resumed = await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue after recovery.' }],
      capabilities: { currentDocument: false, workspace: true },
    }))
    expect(resumed.transcriptRevision).toBe(2)
    await waitEvent(state.events, 'completed')

    const recoveryInput = state.streamChat.mock.calls[1]![0]
    expect(recoveryInput.tools).toEqual([])
    expect(JSON.stringify(recoveryInput.messages)).not.toContain('Continue after recovery.')
    const recoveredAssistant = recoveryInput.messages.filter((message) => message.role === 'assistant').at(-1)!
    expect(recoveredAssistant).toMatchObject({
      reasoningContent: 'private chain', providerReplay: replay,
      toolCalls: [{ id: 'call_1' }, { id: 'call_2' }],
    })
    const recoveredTools = recoveryInput.messages.filter((message) => message.role === 'tool').slice(-2)
    expect(recoveredTools.map((message) => message.toolCallId)).toEqual(['call_1', 'call_2'])

    const normalInput = state.streamChat.mock.calls[2]![0]
    expect(JSON.stringify(normalInput.messages)).toContain('Continue after recovery.')
    expect(JSON.stringify(normalInput.messages)).toContain('Recovered.')
    const accepted = state.events.find((event): event is Extract<AiConversationEvent, { type: 'user-message-accepted' }> => (
      event.type === 'user-message-accepted' && event.messageId === SECOND_MESSAGE_ID
    ))!
    const completedRevisions = state.events
      .filter((event): event is Extract<AiConversationEvent, { type: 'message-completed' }> => event.type === 'message-completed')
      .map((event) => event.transcriptRevision)
    expect(completedRevisions).toEqual([2, 3, 5])
    expect(accepted.transcriptRevision).toBe(4)
    expect(files.executed).toHaveLength(2)

    await state.service.start(continuedInput(state.events, {
      requestId: '950e8400-e29b-41d4-a716-446655440008',
      messages: [{ id: '950e8400-e29b-41d4-a716-446655440009', role: 'user', content: 'One more.' }],
    }))
    await waitEvent(state.events, 'completed', 2)
    expect(JSON.stringify(state.streamChat.mock.calls[3]![0].messages)).toContain('New answer.')
    expect(files.executed).toHaveLength(2)
  })

  it.each(['cancel', 'switch', 'dispose'] as const)(
    'aborts and drains a hung mutation plan without creating a manifest on %s',
    async (ending) => {
    const state = setup()
    state.files.planGate = new Promise<void>(() => {})
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    const started = await state.service.start(startInput({
      capabilities: { currentDocument: false, workspace: true },
    }))
    await vi.waitFor(() => expect(state.files.planningStarted).toEqual([
      'edit_workspace_document:notes/a.md',
    ]))

    if (ending === 'cancel') {
      await settlesWithin(state.service.cancel(started.requestId))
    } else if (ending === 'switch') {
      const ticket = await settlesWithin(state.service.prepareWorkspaceSwitch())
      await state.service.abortWorkspaceSwitch(ticket)
    } else {
      await settlesWithin(state.service.dispose())
    }

    expect(state.files.planSignals).toHaveLength(1)
    expect(state.files.planSignals[0]?.aborted).toBe(true)
    expect(state.files.abandoned).toEqual([])
    expect(state.files.executed).toEqual([])
    expect(state.events.filter((event) => event.type === 'authorization-requested')).toEqual([])
    },
  )

  it('terminalizes an approved manifest when cancellation wins before execution begins', async () => {
    const { service, events, files, streamChat } = setup()
    streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    const started = await service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>

    const approval = service.submitAuthorizationResult({
      requestId: started.requestId,
      operationId: prompt.operationId,
      allowed: true,
    })
    const cancellation = service.cancel(started.requestId)
    await Promise.all([approval, cancellation])

    expect(files.abandoned).toEqual([prompt.operationId])
    expect(files.executed).toEqual([])
  })

  it('rejects a wrong-workspace start without canceling the valid active owner request', async () => {
    const running = deferred<ModelChatResult>()
    const { service, events, streamChat } = setup({ streamChat: () => running.promise })
    const active = await service.start(startInput())
    await waitEvent(events, 'started')

    await expect(service.start(startInput({
      requestId: SECOND_REQUEST_ID,
      workspaceKey: 'workspace-b',
    }))).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    expect(streamChat.mock.calls[0]![0].signal.aborted).toBe(false)
    expect(events.some((event) => event.type === 'stopped')).toBe(false)
    await service.cancel(active.requestId)
    running.reject(new DOMException('aborted', 'AbortError'))
  })

  it('does not cancel a credential-pending valid start for a later wrong-workspace request', async () => {
    const credential = deferred<{ connection: ModelConnectionSummary; apiKey: string | null }>()
    const getCredentialSnapshot = vi.fn(() => credential.promise)
    const state = setup({ getCredentialSnapshot })
    const first = state.service.start(startInput())
    await vi.waitFor(() => expect(getCredentialSnapshot).toHaveBeenCalledOnce())

    await expect(state.service.start(startInput({
      requestId: SECOND_REQUEST_ID,
      workspaceKey: 'workspace-b',
    }))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    credential.resolve({ connection: state.models.connections[0]!, apiKey: 'api-key' })

    await expect(first).resolves.toMatchObject({ requestId: REQUEST_ID })
    await waitEvent(state.events, 'completed')
  })

  it('does not cancel a root-pending valid start for a later wrong-workspace request', async () => {
    const files = new MemoryWorkspaceFiles()
    const firstRoot = deferred<Awaited<ReturnType<MemoryWorkspaceFiles['getRootCapability']>>>()
    const originalRoot = files.getRootCapability.bind(files)
    let rootCalls = 0
    files.getRootCapability = vi.fn(async () => {
      rootCalls += 1
      return rootCalls === 1 ? await firstRoot.promise : await originalRoot()
    })
    const state = setup({ files })
    const first = state.service.start(startInput())
    await vi.waitFor(() => expect(files.getRootCapability).toHaveBeenCalledOnce())

    await expect(state.service.start(startInput({
      requestId: SECOND_REQUEST_ID,
      workspaceKey: 'workspace-b',
    }))).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    firstRoot.resolve(await originalRoot())

    await expect(first).resolves.toMatchObject({ requestId: REQUEST_ID })
    await waitEvent(state.events, 'completed')
  })

  it('atomically invalidates a credential-pending start when workspace activation changes', async () => {
    const credential = deferred<{ connection: ModelConnectionSummary; apiKey: string | null }>()
    const files = new MemoryWorkspaceFiles()
    const getCredentialSnapshot = vi.fn(() => credential.promise)
    const state = setup({ files, getCredentialSnapshot })
    const staleStart = state.service.start(startInput())
    await vi.waitFor(() => expect(getCredentialSnapshot).toHaveBeenCalledOnce())

    const preparing = state.service.prepareWorkspaceSwitch()
    let prepared = false
    const preparedResult = preparing.then((ticket) => {
      prepared = true
      return ticket
    })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(prepared).toBe(false)
    credential.resolve({ connection: state.models.connections[0]!, apiKey: 'api-key' })

    await expect(staleStart).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    const ticket = await preparedResult
    files.workspaceId = 'workspace-b'
    files.rootGeneration = '2.generation'
    files.activationEpoch = 2
    await state.service.activateWorkspace(ticket, await files.getRootCapability())
    expect(state.streamChat).not.toHaveBeenCalled()
  })

  it('revalidates every root identity field after credentials resolve', async () => {
    const files = new MemoryWorkspaceFiles()
    const state = setup({ files, getCredentialSnapshot: async () => {
      files.rootGeneration = '2.generation'
      files.activationEpoch = 2
      files.rootFileId = 'replacement-root'
      return { connection: connection(), apiKey: 'api-key' }
    } })

    await expect(state.service.start(startInput())).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(state.streamChat).not.toHaveBeenCalled()
  })

  it('revalidates root identity after draining the prior active mutation', async () => {
    const execution = deferred<void>()
    const files = new MemoryWorkspaceFiles()
    files.executionGate = execution.promise
    const originalRoot = files.getRootCapability.bind(files)
    files.getRootCapability = vi.fn(originalRoot)
    const state = setup({ files })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
    const first = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
    await state.service.submitAuthorizationResult({
      requestId: first.requestId, operationId: prompt.operationId, allowed: true,
    })
    await vi.waitFor(() => expect(files.executed).toEqual([prompt.operationId]))
    const callsBeforeReplacement = vi.mocked(files.getRootCapability).mock.calls.length

    const replacement = state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
        { id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue.' },
      ],
    }))
    await vi.waitFor(() => expect(vi.mocked(files.getRootCapability).mock.calls.length)
      .toBeGreaterThanOrEqual(callsBeforeReplacement + 2))
    files.rootFileId = 'replacement-root'
    execution.resolve()

    await expect(replacement).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(state.streamChat).toHaveBeenCalledOnce()
  })

  it('revalidates root identity before atomically committing a start candidate', async () => {
    const files = new MemoryWorkspaceFiles()
    const originalRoot = files.getRootCapability.bind(files)
    let rootCalls = 0
    files.getRootCapability = vi.fn(async () => {
      rootCalls += 1
      if (rootCalls === 4) files.rootFileId = 'replacement-root'
      return await originalRoot()
    })
    const state = setup({ files })

    await expect(state.service.start(startInput())).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(state.events).toEqual([])
    expect(state.streamChat).not.toHaveBeenCalled()
  })

  it('cancels a credential-pending start when the selected model configuration changes', async () => {
    const credential = deferred<{ connection: ModelConnectionSummary; apiKey: string | null }>()
    const state = setup({ getCredentialSnapshot: () => credential.promise })
    const staleStart = state.service.start(startInput())
    await Promise.resolve()

    state.settings.setSelectedModel('deepseek-v4-flash')
    credential.resolve({ connection: connection(), apiKey: 'api-key' })

    await expect(staleStart).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(state.streamChat).not.toHaveBeenCalled()
  })

  it('cancels an active turn and revokes read capabilities when model configuration changes', async () => {
    const running = deferred<ModelChatResult>()
    const state = setup({ streamChat: () => running.promise })
    const first = await state.service.start(startInput({
      capabilities: { currentDocument: false, workspace: true },
    }))
    await waitEvent(state.events, 'started')

    state.settings.setSelectedModel('deepseek-v4-flash')
    await waitEvent(state.events, 'stopped')
    expect(state.streamChat.mock.calls[0]![0].signal.aborted).toBe(true)
    running.reject(new DOMException('aborted', 'AbortError'))

    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_workspace_document', {
      path: 'notes/a.md', cursor: 0, maxChars: 100,
    })] })).mockResolvedValueOnce(result())
    await state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [
        { id: MESSAGE_ID, role: 'user', content: 'Please help.' },
        { id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue.' },
      ],
      capabilities: { currentDocument: false, workspace: true },
    }))
    await waitEvent(state.events, 'completed')
    expect(state.files.requests).toEqual(['read:notes/a.md'])
    expect(first.requestId).toBe(REQUEST_ID)
  })

  it('uses a process-lifetime default request registry across service instances', async () => {
    const sharedRequestId = '750e8400-e29b-41d4-a716-446655440000'
    const first = setup({ ownerId: 41, useDefaultRequestRegistry: true })
    const second = setup({ ownerId: 42, useDefaultRequestRegistry: true })

    await first.service.start(startInput({ requestId: sharedRequestId }))
    await waitEvent(first.events, 'completed')
    await expect(second.service.start(startInput({ requestId: sharedRequestId })))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('gates new starts immediately, invalidates pending starts, and aborts only against the unchanged root', async () => {
    const credential = deferred<{ connection: ModelConnectionSummary; apiKey: string | null }>()
    const getCredentialSnapshot = vi.fn(() => credential.promise)
    const state = setup({ getCredentialSnapshot })
    const pendingStart = state.service.start(startInput())
    await vi.waitFor(() => expect(getCredentialSnapshot).toHaveBeenCalledOnce())

    const prepared = state.service.prepareWorkspaceSwitch()
    let switchReady = false
    const switchResult = prepared.then((ticket) => {
      switchReady = true
      return ticket
    })
    await expect(state.service.start(startInput({ requestId: SECOND_REQUEST_ID })))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(switchReady).toBe(false)
    credential.resolve({ connection: state.models.connections[0]!, apiKey: 'api-key' })
    await expect(pendingStart).rejects.toMatchObject({ code: 'OPERATION_FAILED' })

    const ticket = await switchResult
    await state.service.abortWorkspaceSwitch(ticket)
    await expect(state.service.start(startInput({ requestId: SECOND_REQUEST_ID })))
      .resolves.toMatchObject({ requestId: SECOND_REQUEST_ID })
  })

  it('drains a start blocked in root validation before returning the switch ticket', async () => {
    const files = new MemoryWorkspaceFiles()
    const rootGate = deferred<Awaited<ReturnType<MemoryWorkspaceFiles['getRootCapability']>>>()
    const originalRoot = files.getRootCapability.bind(files)
    let rootCalls = 0
    files.getRootCapability = vi.fn(async () => {
      rootCalls += 1
      return rootCalls === 1 ? await rootGate.promise : await originalRoot()
    })
    const state = setup({ files })
    const pendingStart = state.service.start(startInput())
    await vi.waitFor(() => expect(files.getRootCapability).toHaveBeenCalledOnce())

    let prepared = false
    const preparing = state.service.prepareWorkspaceSwitch().then((ticket) => {
      prepared = true
      return ticket
    })
    await vi.waitFor(() => expect(files.getRootCapability).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(prepared).toBe(false)

    rootGate.resolve(await originalRoot())
    await expect(pendingStart).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    const ticket = await preparing
    await state.service.abortWorkspaceSwitch(ticket)
  })

  it('drains a start blocked in context compaction before returning the switch ticket', async () => {
    const compactModel = connection({
      provider: 'other', baseUrl: 'https://models.example.com/v1', modelId: 'custom-chat',
      capabilityOverride: { contextWindowTokens: 100_000, maxInputTokens: 100_000, maxOutputTokens: 32_768 },
    })
    const firstText = 'a'.repeat(25_000)
    const secondText = 'b'.repeat(10_000)
    const summaryGate = deferred<ModelChatResult>()
    let summaryCalls = 0
    const state = setup({ models: modelSettings(compactModel), streamChat: async (input) => {
      if (input.requestedOutputTokens === 16_384) {
        summaryCalls += 1
        return await summaryGate.promise
      }
      input.onDelta('First answer')
      return result()
    } })
    await state.service.start(startInput({
      messages: [{ id: MESSAGE_ID, role: 'user', content: firstText }],
    }))
    await waitEvent(state.events, 'completed')
    const pendingStart = state.service.start(continuedInput(state.events, {
      requestId: SECOND_REQUEST_ID,
      messages: [{ id: THIRD_MESSAGE_ID, role: 'user', content: secondText }],
    }))
    await vi.waitFor(() => expect(summaryCalls).toBe(1))

    let prepared = false
    const preparing = state.service.prepareWorkspaceSwitch().then((ticket) => {
      prepared = true
      return ticket
    })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(prepared).toBe(false)

    let disposed = false
    const disposing = state.service.dispose().then(() => { disposed = true })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(disposed).toBe(false)

    const pendingResult = expect(pendingStart).rejects.toMatchObject({ name: 'AbortError' })
    const prepareResult = expect(preparing).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    summaryGate.resolve(result())
    await Promise.all([pendingResult, prepareResult, disposing])
  })

  it('drains the active provider loop before returning a workspace-switch ticket', async () => {
    const running = deferred<ModelChatResult>()
    const state = setup({ streamChat: () => running.promise })
    await state.service.start(startInput())
    await waitEvent(state.events, 'started')

    let prepared = false
    const preparing = state.service.prepareWorkspaceSwitch().then((ticket) => {
      prepared = true
      return ticket
    })
    await vi.waitFor(() => expect(state.streamChat.mock.calls[0]![0].signal.aborted).toBe(true))
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(prepared).toBe(false)

    running.reject(new DOMException('aborted', 'AbortError'))
    const ticket = await preparing
    expect(prepared).toBe(true)

    state.files.workspaceId = 'workspace-b'
    state.files.rootGeneration = '2.generation'
    state.files.activationEpoch = 2
    state.files.rootFileId = 'root-workspace-b'
    await state.service.activateWorkspace(ticket, await state.files.getRootCapability())
    await expect(state.service.start(startInput({
      requestId: SECOND_REQUEST_ID,
      conversationId: '750e8400-e29b-41d4-a716-446655440001',
      workspaceKey: 'workspace-b',
    }))).resolves.toMatchObject({ requestId: SECOND_REQUEST_ID })
  })

  it('keeps a failed activation closed and accepts only the current ticket and trusted committed root', async () => {
    const state = setup()
    const ticket = await state.service.prepareWorkspaceSwitch()
    const copiedTicket = Object.freeze({ ...ticket }) as typeof ticket

    await expect(state.service.abortWorkspaceSwitch(copiedTicket))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    state.files.workspaceId = 'workspace-b'
    state.files.rootGeneration = '2.generation'
    state.files.activationEpoch = 2
    state.files.rootFileId = 'root-workspace-b'
    const committedRoot = await state.files.getRootCapability()
    await expect(state.service.activateWorkspace(ticket, {
      ...committedRoot,
      rootFileId: 'forged-root',
    })).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await expect(state.service.start(startInput({ workspaceKey: 'workspace-b' })))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await expect(state.service.abortWorkspaceSwitch(ticket))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })

    await state.service.activateWorkspace(ticket, committedRoot)
    await expect(state.service.abortWorkspaceSwitch(ticket))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  })

  it('fails closed for concurrent prepare, activate, abort, and start operations', async () => {
    const state = setup()
    const ticket = await state.service.prepareWorkspaceSwitch()
    await expect(state.service.prepareWorkspaceSwitch()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await expect((state.service as unknown as { activateWorkspace(): Promise<void> }).activateWorkspace())
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })

    const committedRoot = await state.files.getRootCapability()
    const rootGate = deferred<typeof committedRoot>()
    state.files.getRootCapability = vi.fn(() => rootGate.promise)
    const activation = state.service.activateWorkspace(ticket, committedRoot)

    await expect(state.service.abortWorkspaceSwitch(ticket))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await expect(state.service.activateWorkspace(ticket, committedRoot))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await expect(state.service.start(startInput()))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })

    rootGate.resolve(committedRoot)
    await activation
    await expect(state.service.abortWorkspaceSwitch(ticket))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  })

  it('deactivates to no workspace and permits only a later ticketed activation', async () => {
    const state = setup()
    const ticket = await state.service.prepareWorkspaceSwitch()
    await state.service.deactivateWorkspace(ticket)

    await expect(state.service.start(startInput())).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    const nextTicket = await state.service.prepareWorkspaceSwitch()
    await state.service.activateWorkspace(nextTicket, await state.files.getRootCapability())
    await expect(state.service.start(startInput())).resolves.toMatchObject({ requestId: REQUEST_ID })
  })

  it('never reopens a switch gate when dispose wins while prepare is draining', async () => {
    const running = deferred<ModelChatResult>()
    const state = setup({ streamChat: () => running.promise })
    await state.service.start(startInput())
    await vi.waitFor(() => expect(state.streamChat).toHaveBeenCalledOnce())
    const preparing = state.service.prepareWorkspaceSwitch()
    const disposing = state.service.dispose()
    const preparationResult = expect(preparing).rejects.toMatchObject({ code: 'OPERATION_FAILED' })

    running.reject(new DOMException('aborted', 'AbortError'))
    await preparationResult
    await disposing
    await expect(state.service.start(startInput({ requestId: SECOND_REQUEST_ID })))
      .rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  })

  it('joins a switch drain after the active slot is cleared instead of returning dispose early', async () => {
    const running = deferred<ModelChatResult>()
    const state = setup({ streamChat: () => running.promise })
    await state.service.start(startInput())
    await vi.waitFor(() => expect(state.streamChat).toHaveBeenCalledOnce())
    const preparing = state.service.prepareWorkspaceSwitch()
    await waitEvent(state.events, 'stopped')

    let disposed = false
    const disposing = state.service.dispose().then(() => { disposed = true })
    const earlyResult = await Promise.race([
      disposing.then(() => 'disposed' as const),
      new Promise<'waiting'>((resolve) => { setTimeout(() => resolve('waiting'), 20) }),
    ])
    expect(earlyResult).toBe('waiting')
    expect(disposed).toBe(false)

    const preparationResult = expect(preparing).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    running.reject(new DOMException('aborted', 'AbortError'))
    await Promise.all([preparationResult, disposing])
  })

  it('joins a current-document release already owned by a concurrent switch drain', async () => {
    const continuation = deferred<ModelChatResult>()
    const releaseGate = deferred<void>()
    const opened = Object.assign(snapshot('active.md', 'text-more', VERSION_A), {
      release: vi.fn(() => releaseGate.promise),
    })
    const state = setup({ openCurrentDocument: async () => opened })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(
      'read_current_document', { cursor: 0, maxChars: 4 },
    )] })).mockImplementationOnce(() => continuation.promise)
    await state.service.start(startInput({
      capabilities: { currentDocument: true, workspace: false },
    }))
    await vi.waitFor(() => expect(state.streamChat).toHaveBeenCalledTimes(2))

    const preparing = state.service.prepareWorkspaceSwitch()
    await vi.waitFor(() => expect(opened.release).toHaveBeenCalledOnce())
    let disposed = false
    const disposing = state.service.dispose().then(() => { disposed = true })
    const preparationResult = expect(preparing).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    continuation.reject(new DOMException('aborted', 'AbortError'))

    const earlyResult = await Promise.race([
      disposing.then(() => 'disposed' as const),
      new Promise<'waiting'>((resolve) => { setTimeout(() => resolve('waiting'), 20) }),
    ])
    expect(earlyResult).toBe('waiting')
    expect(disposed).toBe(false)

    releaseGate.resolve()
    await Promise.all([preparationResult, disposing])
    expect(opened.release).toHaveBeenCalledOnce()
  })

  it('drains pending starts before dispose resolves and shares one concurrent disposal', async () => {
    const credential = deferred<{ connection: ModelConnectionSummary; apiKey: string | null }>()
    const getCredentialSnapshot = vi.fn(() => credential.promise)
    const state = setup({ getCredentialSnapshot })
    const pendingStart = state.service.start(startInput())
    await vi.waitFor(() => expect(getCredentialSnapshot).toHaveBeenCalledOnce())

    let disposed = false
    const firstDispose = state.service.dispose().then(() => { disposed = true })
    const secondDispose = state.service.dispose()
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(disposed).toBe(false)

    credential.resolve({ connection: state.models.connections[0]!, apiKey: 'api-key' })
    await expect(pendingStart).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await Promise.all([firstDispose, secondDispose])
    expect(disposed).toBe(true)
  })

  it('joins a credential start already removed from pendingStarts by prepare', async () => {
    const credential = deferred<{ connection: ModelConnectionSummary; apiKey: string | null }>()
    const getCredentialSnapshot = vi.fn(() => credential.promise)
    const state = setup({ getCredentialSnapshot })
    const pendingStart = state.service.start(startInput())
    await vi.waitFor(() => expect(getCredentialSnapshot).toHaveBeenCalledOnce())
    const preparing = state.service.prepareWorkspaceSwitch()
    await new Promise((resolve) => { setTimeout(resolve, 20) })

    let disposed = false
    const disposing = state.service.dispose().then(() => { disposed = true })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(disposed).toBe(false)

    const startResult = expect(pendingStart).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    const prepareResult = expect(preparing).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    credential.resolve({ connection: state.models.connections[0]!, apiKey: 'api-key' })
    await Promise.all([startResult, prepareResult, disposing])
  })

  it('joins prepare while its initial trusted root lookup is unresolved', async () => {
    const files = new MemoryWorkspaceFiles()
    const rootGate = deferred<Awaited<ReturnType<MemoryWorkspaceFiles['getRootCapability']>>>()
    const originalRoot = files.getRootCapability.bind(files)
    files.getRootCapability = vi.fn(() => rootGate.promise)
    const state = setup({ files })
    const preparing = state.service.prepareWorkspaceSwitch()
    await vi.waitFor(() => expect(files.getRootCapability).toHaveBeenCalledOnce())

    let disposed = false
    const disposing = state.service.dispose().then(() => { disposed = true })
    await new Promise((resolve) => { setTimeout(resolve, 20) })
    expect(disposed).toBe(false)

    const prepareResult = expect(preparing).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    rootGate.resolve(await originalRoot())
    await Promise.all([prepareResult, disposing])
  })

  it.each(['activate', 'abort'] as const)(
    'joins %s while its trusted root check is unresolved',
    async (operation) => {
      const state = setup()
      const ticket = await state.service.prepareWorkspaceSwitch()
      const committedRoot = await state.files.getRootCapability()
      const rootGate = deferred<typeof committedRoot>()
      state.files.getRootCapability = vi.fn(() => rootGate.promise)
      const switching = operation === 'activate'
        ? state.service.activateWorkspace(ticket, committedRoot)
        : state.service.abortWorkspaceSwitch(ticket)
      await vi.waitFor(() => expect(state.files.getRootCapability).toHaveBeenCalledOnce())

      let disposed = false
      const disposing = state.service.dispose().then(() => { disposed = true })
      await new Promise((resolve) => { setTimeout(resolve, 20) })
      expect(disposed).toBe(false)

      const switchResult = expect(switching).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
      rootGate.resolve(committedRoot)
      await Promise.all([switchResult, disposing])
    },
  )
})


describe('conversation observed thinking timing', () => {
  it.each(['completed', 'failed', 'cancel'] as const)('times real recovery model output while preserving atomic publication (%s)', async ending => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const execution = deferred<void>(), recovery = deferred<ModelChatResult>(), files = new MemoryWorkspaceFiles()
    files.executionGate = execution.promise
    const state = setup({ files })
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit())] }))
      .mockImplementationOnce(async input => {
        now = 100
        input.onReasoning?.(true)
        input.onDelta('Recovered.')
        return recovery.promise
      })
    try {
      const first = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
      const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      await state.service.submitAuthorizationResult({ requestId: first.requestId, operationId: prompt.operationId, allowed: true })
      await vi.waitFor(() => expect(files.executed).toHaveLength(1))
      const cancellation = state.service.cancel(first.requestId)
      execution.resolve()
      await cancellation
      const resumed = await state.service.start(continuedInput(state.events, {
        requestId: SECOND_REQUEST_ID,
        messages: [{ id: SECOND_MESSAGE_ID, role: 'user', content: 'Continue' }],
        capabilities: { currentDocument: false, workspace: true },
      }))
      await vi.waitFor(() => expect(state.streamChat).toHaveBeenCalledTimes(2))
      expect(state.streamChat.mock.calls[1]![0].onReasoning).toBeTypeOf('function')
      expect(state.streamChat.mock.calls[1]![0].onProcess).toBeUndefined()
      expect(state.events.filter(event => event.type === 'thinking')).toEqual([])
      now = 1100
      if (ending === 'completed') {
        recovery.resolve(result())
        await waitEvent(state.events, 'completed')
        const timing = state.events.filter(event => event.type === 'thinking')
        expect(timing.map(event => [event.active, event.elapsedMs])).toEqual([[true, 0], [false, 1000]])
        const start = state.events.findIndex(event => event.type === 'message-start' && event.messageId === timing[0]!.messageId)
        const end = state.events.findIndex(event => event.type === 'message-completed' && event.messageId === timing[0]!.messageId)
        expect(state.events.indexOf(timing[0]!)).toBeGreaterThan(start)
        expect(state.events.indexOf(timing[1]!)).toBeLessThan(end)
        const process = state.events.filter(event => event.requestId === resumed.requestId && event.type.startsWith('process-'))
        expect(process.length).toBeGreaterThan(0)
        expect(process.every(event => 'round' in event && event.round === 2)).toBe(true)
      } else {
        if (ending === 'cancel') { await state.service.cancel(resumed.requestId); recovery.resolve(result()) }
        else recovery.reject(new ModelProtocolError('incompatible-response'))
        await waitEvent(state.events, ending === 'cancel' ? 'stopped' : 'failed', ending === 'cancel' ? 2 : 1)
        expect(state.events.filter(event => event.type === 'thinking')).toEqual([])
      }
    } finally {
      execution.resolve(); recovery.resolve(result())
      await state.service.dispose()
      clock.mockRestore()
    }
  })
  it('does not count permission and real tool execution gates between thinking rounds', async () => {
    let now = 0, round = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const execution = deferred<void>(), files = new MemoryWorkspaceFiles()
    files.executionGate = execution.promise
    try {
      const state = setup({ files, streamChat: async input => {
        input.onReasoning?.(true)
        now += 500
        if (++round === 1) return result({ toolCalls: [call('edit_workspace_document', edit())] })
        input.onDelta('Done')
        return result()
      } })
      const started = await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
      const prompt = await waitEvent(state.events, 'authorization-requested') as Extract<AiConversationEvent, { type: 'authorization-requested' }>
      expect(state.events.filter(event => event.type === 'thinking').at(-1)).toMatchObject({ active: false, elapsedMs: 500 })
      now = 50_000
      await state.service.submitAuthorizationResult({ requestId: started.requestId, operationId: prompt.operationId, allowed: true })
      await vi.waitFor(() => expect(files.executed).toHaveLength(1))
      expect(state.events.filter(event => event.type === 'thinking')).toHaveLength(2)
      now = 100_000
      execution.resolve()
      await waitEvent(state.events, 'completed')
      expect(state.events.filter(event => event.type === 'thinking').map(event => [event.active, event.elapsedMs])).toEqual([[true, 0], [false, 500], [true, 0], [false, 500]])
      await state.service.dispose()
    } finally { execution.resolve(); clock.mockRestore() }
  })
  it('closes each model round before executing tools and starts the next round from zero', async () => {
    let now = 0, round = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const state = setup({ streamChat: async input => {
        round += 1
        if (round === 1) {
          now = 1000; input.onReasoning?.(true)
          now = 1250
          return result({ toolCalls: [call('read_current_document', { cursor: 0, maxChars: 100 })] })
        }
        expect(state.events.filter(event => event.type === 'thinking')).toEqual([
          expect.objectContaining({ active: true, elapsedMs: 0 }), expect.objectContaining({ active: false, elapsedMs: 250 }),
        ])
        now = 90000; input.onReasoning?.(true)
        now = 90500; input.onReasoning?.(false)
        input.onDelta('Answer')
        return result()
      } })
      await state.service.start(startInput())
      await waitEvent(state.events, 'completed')
      const timing = state.events.filter(event => event.type === 'thinking')
      expect(timing.map(event => [event.active, event.elapsedMs])).toEqual([[true, 0], [false, 250], [true, 0], [false, 500]])
      expect(timing[0]!.messageId).not.toBe(timing[2]!.messageId)
      expect(timing.every(event => parseAiConversationEvent(event))).toBe(true)
      await state.service.dispose()
    } finally { clock.mockRestore() }
  })
  it.each(['failed', 'cancel'] as const)('freezes before %s cleanup, without exposing private reasoning text', async ending => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const gate = deferred<ModelChatResult>()
    try {
      const state = setup({ streamChat: async input => {
        input.onReasoning?.(true)
        return gate.promise
      } })
      await state.service.start(startInput())
      await waitEvent(state.events, 'thinking')
      now = 1234
      if (ending === 'cancel') {
        await state.service.cancel(REQUEST_ID)
        now = 99000
        gate.resolve(result())
        await waitEvent(state.events, 'stopped')
      } else {
        gate.reject(new ModelProtocolError('incompatible-response'))
        await waitEvent(state.events, 'failed')
      }
      expect(state.events.filter(event => event.type === 'thinking').map(event => [event.active, event.elapsedMs])).toEqual([[true, 0], [false, 1234]])
      await state.service.dispose()
    } finally { clock.mockRestore() }
  })
})

describe('typed safe recycle failure feedback', () => {
  it.each([
    ['typed-delete', 'delete_workspace_document', new WorkspaceAiFileError('AI_RECYCLE_UNAVAILABLE' as never, 'private native error'), true, 'failed'],
    ['spoofed-delete', 'delete_workspace_document', Object.assign(new Error('private error'), { code: 'AI_RECYCLE_UNAVAILABLE' }), false, 'failed'],
    ['generic-delete', 'delete_workspace_document', new WorkspaceAiFileError('AI_COMMIT_UNAVAILABLE', 'private error'), false, 'failed'],
    ['unknown-delete', 'delete_workspace_document', new AiOperationOutcomeUnknownError(), false, 'unknown'],
    ['typed-edit', 'edit_workspace_document', new WorkspaceAiFileError('AI_RECYCLE_UNAVAILABLE' as never, 'private native error'), false, 'failed'],
  ] as const)('limits safe feedback to %s without changing workspace policy authorization', async (_name, toolName, error, safe, terminal) => {
    const files = new MemoryWorkspaceFiles()
    let executions = 0
    const original = files.executeAuthorized.bind(files)
    files.executeAuthorized = async (...args) => { if (executions++ === 0) throw error; return original(...args) }
    const state = setup({ files, writePolicy: 'workspace-grant' })
    const args = toolName === 'delete_workspace_document' ? { path: 'notes/a.md', expectedVersion: VERSION_A } : edit()
    state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call(toolName, args)] }))
      .mockResolvedValueOnce(result({ toolCalls: [call('edit_workspace_document', edit('notes/b.md', VERSION_B), 'call_2')] }))
      .mockResolvedValueOnce(result())
    try {
      await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
      await waitEvent(state.events, 'completed')
      const response = JSON.parse(state.streamChat.mock.calls[1]![0].messages.filter(message => message.role === 'tool').at(-1)!.content)
      expect(response).toEqual({ kind: 'mutation', operationId: OPERATION_IDS[0], state: terminal, paths: ['notes/a.md'],
        ...(safe ? { reason: 'recycle-unavailable', guidance: '当前版本的 AI 暂不支持安全移入回收站，本次删除未执行，文件保留在原位置。请在资源管理器中手动移入回收站。' } : {}) })
      const event = state.events.filter(event => event.type === 'process-tool' && event.toolCallId === 'call_1').at(-1)
      expect(event).toMatchObject({ status: terminal })
      expect(event && 'reason' in event ? event.reason : undefined).toBe(safe ? 'recycle-unavailable' : undefined)
      expect(state.events.filter(event => event.type === 'audit' && event.action === 'deleted')).toEqual([])
      expect(JSON.stringify(state.events)).not.toContain('private')
      if (terminal !== 'unknown') expect(state.events.filter(event => event.type === 'authorization-requested')).toHaveLength(0)
    } finally { await state.service.dispose() }
  })
})

it('caches the safe recycle rejection and keeps read series closed without replaying the delete', async () => {
  const files = new MemoryWorkspaceFiles()
  const execute = vi.spyOn(files, 'executeAuthorized').mockRejectedValue(new WorkspaceAiFileError('AI_RECYCLE_UNAVAILABLE', 'private error'))
  const state = setup({ files, writePolicy: 'workspace-grant' })
  const deleting = call('delete_workspace_document', { path: 'notes/a.md', expectedVersion: VERSION_A }, 'call_delete')
  state.streamChat.mockResolvedValueOnce(result({ toolCalls: [call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 })] }))
    .mockResolvedValueOnce(result({ toolCalls: [deleting] }))
    .mockResolvedValueOnce(result({ toolCalls: [deleting, call('read_workspace_document', { path: 'notes/a.md', cursor: 0, maxChars: 100 }, 'call_read_again')] }))
    .mockResolvedValueOnce(result())
  try {
    await state.service.start(startInput({ capabilities: { currentDocument: false, workspace: true } }))
    await waitEvent(state.events, 'completed')
    const original = state.events.filter(event => event.type === 'process-tool' && event.toolCallId === 'call_delete' && event.status === 'failed')
    expect(original).toHaveLength(2)
    expect(original[0]).toMatchObject({ cached: false, reason: 'recycle-unavailable' })
    expect(original[1]).toMatchObject({ cached: true, reason: 'recycle-unavailable' })
    for (const event of original) expect(parseAiConversationEvent(event)).toEqual(event)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(files.requests.filter(item => item.startsWith('read:'))).toHaveLength(1)
    const tools = state.streamChat.mock.calls[3]![0].messages.filter(message => message.role === 'tool').slice(-2)
    expect(JSON.parse(tools[0]!.content)).toMatchObject({ state: 'failed', reason: 'recycle-unavailable' })
    expect(JSON.parse(tools[1]!.content)).toEqual({ kind: 'unavailable' })
    expect(state.events.some(event => event.type === 'operation-status' && event.status === 'unknown')).toBe(false)
  } finally { await state.service.dispose() }
})
