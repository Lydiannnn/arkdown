import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiConversationRequestRegistry, AiConversationSessionService, type WorkspaceAiFileBoundary } from '../../src/main/models/ai-conversation-session-service'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'
import { connectionEditRequest, connectionTestRequest, modelFeatureRequest, observeModelSettings } from '../../src/main/settings/settings-command-adapter'
import { AiOperationJournal } from '../../src/main/workspace/ai-operation-journal'
import type { WorkspaceAiMutationExecution } from '../../src/main/workspace/workspace-ai-file-service'
import { DEFAULT_LARGE_MODEL_SETTINGS, type ModelConnectionSummary } from '../../src/shared/large-model-settings'
import type { AiConversationEvent, AiOperationManifest, StartAiConversationInput } from '../../src/shared/ai-conversation'
import type { ModelChatResult, ModelProtocolClient } from '../../src/main/models/model-protocol-client'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const id = '550e8400-e29b-41d4-a716-446655440000'
const operationId = '550e8400-e29b-41d4-a716-446655440005'
const cipher = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(`synthetic:${value}`), decrypt: (value: Buffer) => value.toString().slice(10) }
const connection: ModelConnectionSummary = { id, name: 'Synthetic', provider: 'other', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://example.com/v1', modelId: 'synthetic', apiKeyHint: '••••test', status: 'connected', lastTestedAt: null, capabilityOverride: null }
const version = { fileId: 'file-a', revision: 'revision-a', size: 4, mtimeMs: 1 }
const result = (patch: Partial<ModelChatResult> = {}): ModelChatResult => ({ toolCalls: [], reasoningContent: '', providerReplay: null, usage: null, ...patch })
const editResult = () => result({ toolCalls: [{ id: 'call_edit', name: 'edit_workspace_document', argumentsJson: JSON.stringify({ path: 'notes/a.md', content: 'next', expectedVersion: version }) }] })
const input: StartAiConversationInput = { requestId: '550e8400-e29b-41d4-a716-446655440001', conversationId: '550e8400-e29b-41d4-a716-446655440002', workspaceKey: 'workspace-a', acknowledgedTranscriptRevision: 0,
  messages: [{ id: '550e8400-e29b-41d4-a716-446655440003', role: 'user' as const, content: 'Synthetic request' }], capabilities: { currentDocument: false, workspace: true }, writePolicy: 'ask-every-time' as const }
async function fixture(legacy = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-authority-')); roots.push(root)
  const store = new SettingsTransactionStore(root, cipher)
  if (legacy) {
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({ lastWorkspace: null, models: { ...DEFAULT_LARGE_MODEL_SETTINGS, connections: [connection], aiConversation: { ...DEFAULT_LARGE_MODEL_SETTINGS.aiConversation, connectionId: id } } }))
    await writeFile(path.join(root, 'model-secrets.json'), JSON.stringify({ version: 1, secrets: { [id]: store.encryptCredential('original-test') } }))
  } else {
    await store.apply({ baseRevision: 0, operations: [{ kind: 'model-connection.add', connection, expectedAbsentRevision: 0 }] }, { id, ciphertext: store.encryptCredential('original-test') })
    await store.apply(modelFeatureRequest(observeModelSettings(await store.readSnapshot()), 'aiConversation', { connectionId: id }))
  }
  const authority = new SettingsAuthority(store); await authority.readFresh()
  const events: AiConversationEvent[] = []
  const journal = new AiOperationJournal<WorkspaceAiMutationExecution>()
  let executionGate: Promise<void> | undefined
  let onExecuting: (() => void) | undefined
  const files: WorkspaceAiFileBoundary = {
    getRootCapability: async () => ({ windowId: 1, workspaceId: 'workspace-a', rootGeneration: 1, workspaceGeneration: '1.generation', rootFinalPath: 'C:\\synthetic', rootVolumeSerial: 'volume', rootFileId: 'root-file' }),
    listEntries: async () => { throw new Error('unused') }, readDocument: async () => { throw new Error('unused') },
    planCreate: async () => { throw new Error('unused') }, planRename: async () => { throw new Error('unused') }, planDelete: async () => { throw new Error('unused') },
    planEdit: async (edit, key) => {
      const manifest: AiOperationManifest = { operationId, idempotencyKey: key, nonce: 'synthetic-nonce', workspaceGeneration: '1.generation', toolName: 'edit_workspace_document', relativePaths: [edit.path], expectedVersions: [edit.expectedVersion] }
      journal.plan(manifest); journal.transition(operationId, 'awaitingApproval'); return manifest
    },
    authorize: manifest => { journal.authorize(manifest.operationId, manifest.nonce) },
    abandon: manifest => { const state = journal.get(manifest.operationId)?.state; if (state === 'awaitingApproval' || state === 'authorized') journal.transition(manifest.operationId, 'failed') },
    executeAuthorized: manifest => {
      const pending = journal.execute(manifest.operationId, async () => {
        onExecuting?.()
        await executionGate
        return { result: { kind: 'mutation', operationId: manifest.operationId, state: 'succeeded', paths: [...manifest.relativePaths] }, localAudit: { kind: 'edited', absolutePaths: ['C:\\synthetic\\notes\\a.md'] }, successorVersion: version }
      })
      return pending.then(entry => entry.result!)
    },
  }
  const streamChat = vi.fn<ModelProtocolClient['streamChat']>(async () => result())
  const service = new AiConversationSessionService({ ownerId: 1, requestRegistry: new AiConversationRequestRegistry(), authority,
    client: { streamChat, testConnection: async () => undefined }, events: { emit: event => events.push(event) }, files, currentDocument: { openSnapshot: async () => null } })
  return { authority, store, second: new SettingsTransactionStore(root, cipher, {}, 500), service, streamChat, files, events, journal,
    setExecutionGate(gate: Promise<void>) { executionGate = gate }, setOnExecuting(callback: () => void) { onExecuting = callback } }
}
const waitEvent = async (events: AiConversationEvent[], type: AiConversationEvent['type']) => vi.waitFor(() => expect(events.some(event => event.type === type)).toBe(true))

describe('AI authority reads and synchronous file execution admission', () => {
  it('rejects credential ABA after the paired read before any provider request', async () => {
    const { authority, second, service, streamChat } = await fixture()
    const read = authority.readExecution.bind(authority)
    vi.spyOn(authority, 'readExecution').mockImplementationOnce(async target => {
      const paired = await read(target)
      await second.apply(connectionEditRequest(paired.observed, connection, true), { id, ciphertext: second.encryptCredential('replacement-test') })
      await second.apply(connectionEditRequest(observeModelSettings(await second.readSnapshot()), connection, true), { id, ciphertext: second.encryptCredential('original-test') })
      return paired
    })
    await expect(service.start(input)).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(streamChat).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('refreshes before accepting an approval so policy ABA cannot grant execution', async () => {
    const { second, service, streamChat, events, journal } = await fixture()
    streamChat.mockResolvedValueOnce(editResult())
    await service.start(input); await waitEvent(events, 'authorization-requested')
    await second.apply(modelFeatureRequest(observeModelSettings(await second.readSnapshot()), 'aiConversation', { writePolicy: 'workspace-grant' }))
    await second.apply(modelFeatureRequest(observeModelSettings(await second.readSnapshot()), 'aiConversation', { writePolicy: 'ask-every-time' }))
    await service.submitAuthorizationResult({ requestId: input.requestId, operationId, allowed: true })
    await waitEvent(events, 'completed')
    expect(journal.get(operationId)?.state).toBe('failed')
    expect(events).toContainEqual(expect.objectContaining({ type: 'authorization-result', allowed: false }))
    await service.dispose()
  })

  it.each(['ask-every-time', 'workspace-grant'] as const)('rechecks %s under the lock before journal executing registration', async policy => {
    const { authority, second, service, streamChat, events, journal } = await fixture()
    if (policy === 'workspace-grant') await second.apply(modelFeatureRequest(observeModelSettings(await second.readSnapshot()), 'aiConversation', { writePolicy: policy }))
    streamChat.mockResolvedValueOnce(editResult())
    const admit = authority.admitExecution.bind(authority)
    let changed = false
    vi.spyOn(authority, 'admitExecution').mockImplementation(async (observed, target, start) => {
      if (!changed && journal.get(operationId)?.state === (policy === 'workspace-grant' ? 'awaitingApproval' : 'authorized')) {
        changed = true
        await second.apply(modelFeatureRequest(observeModelSettings(await second.readSnapshot()), 'aiConversation', { writePolicy: 'document-grant' }))
      }
      return admit(observed, target, start)
    })
    await service.start(input)
    if (policy === 'ask-every-time') {
      await waitEvent(events, 'authorization-requested')
      await service.submitAuthorizationResult({ requestId: input.requestId, operationId, allowed: true })
    }
    await waitEvent(events, 'completed')
    expect(changed).toBe(true)
    expect(journal.get(operationId)?.state).toBe('failed')
    if (policy === 'workspace-grant') expect(events.some(event => event.type === 'authorization-requested')).toBe(false)
    await service.dispose()
  })

  it.each(['ask-every-time', 'workspace-grant'] as const)('registers %s journal execution synchronously and does not undo an admitted mutation', async policy => {
    const { second, service, streamChat, events, journal, setExecutionGate, setOnExecuting } = await fixture()
    if (policy === 'workspace-grant') await second.apply(modelFeatureRequest(observeModelSettings(await second.readSnapshot()), 'aiConversation', { writePolicy: policy }))
    let finish!: () => void
    setExecutionGate(new Promise<void>(resolve => { finish = resolve }))
    let registeredState: string | undefined
    setOnExecuting(() => { registeredState = journal.get(operationId)?.state })
    streamChat.mockResolvedValueOnce(editResult())
    await service.start(input)
    if (policy === 'ask-every-time') {
      await waitEvent(events, 'authorization-requested')
      await service.submitAuthorizationResult({ requestId: input.requestId, operationId, allowed: true })
    }
    await vi.waitFor(() => expect(registeredState).toBe('executing'))
    expect(await second.apply(modelFeatureRequest(observeModelSettings(await second.readSnapshot()), 'aiConversation', { writePolicy: policy === 'workspace-grant' ? 'ask-every-time' : 'workspace-grant' }))).toMatchObject({ status: 'committed' })
    let stopped = false
    const cancel = service.cancel(input.requestId).then(() => { stopped = true })
    expect(stopped).toBe(false)
    finish(); await cancel
    expect(journal.get(operationId)?.state).toBe('succeeded')
    if (policy === 'workspace-grant') expect(events.some(event => event.type === 'authorization-requested')).toBe(false)
    await service.dispose()
  })

  it('does not invalidate an active request for a standard API status/time-only update', async () => {
    const { authority, second, service, streamChat, events } = await fixture()
    let finish!: () => void
    streamChat.mockImplementationOnce(async request => {
      await new Promise<void>(resolve => { finish = resolve })
      expect(request.signal.aborted).toBe(false)
      return result()
    })
    await service.start(input); await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const observed = observeModelSettings(await second.readSnapshot())
    await second.apply(connectionTestRequest(observed, id, 'timeout', '2026-10-04T00:00:00.000Z'))
    await authority.readFresh(); finish()
    await waitEvent(events, 'completed')
    expect(events.some(event => event.type === 'stopped')).toBe(false)
    await service.dispose()
  })

  it('does not use the Codex token for a legacy standard connection with no revision row yet', async () => {
    const { authority, second, service, streamChat, events } = await fixture(true)
    let finish!: () => void
    streamChat.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve }); return result() })
    await service.start(input); await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    try {
      await second.apply({ baseRevision: 0, operations: [{ kind: 'codex-cli.record-test', value: { cliVersion: 'synthetic', status: 'connected', lastTestedAt: '2026-10-04T00:00:00.000Z' }, expected: { value: null, revision: 0 } }] })
      await authority.readFresh()
      expect(streamChat.mock.calls[0]![0].signal.aborted).toBe(false)
      finish(); await waitEvent(events, 'completed')
    } finally { finish(); await service.dispose() }
  })
})
