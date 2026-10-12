import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'
import { connectionEditRequest, connectionRemoveRequest, connectionTestRequest, modelFeatureRequest, observeModelSettings } from '../../src/main/settings/settings-command-adapter'
import type { ModelConnectionSummary } from '../../src/shared/large-model-settings'
import type { ConnectModelInput } from '../../src/main/models/model-connection-service'
import { ModelProtocolError } from '../../src/main/models/model-errors'
import type { ModelProtocolClient } from '../../src/main/models/model-protocol-client'
import type { ModelCatalogClient } from '../../src/main/models/model-catalog-client'

const modulePath = '../../src/main/models/transactional-model-connection-service'
const implementation = await import(modulePath).catch(() => ({})) as typeof import('../../src/main/models/transactional-model-connection-service')
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const id = '550e8400-e29b-41d4-a716-446655440000'
const newId = '550e8400-e29b-41d4-a716-446655440001'
const cipher = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(`synthetic:${value}`), decrypt: (value: Buffer) => value.toString().slice(10) }
const connection: ModelConnectionSummary = { id, name: 'Original', provider: 'other', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://example.com/v1', modelId: 'synthetic', apiKeyHint: '••••test', status: 'untested', lastTestedAt: null, capabilityOverride: null }
function edited(patch: Partial<ConnectModelInput> = {}): ConnectModelInput {
  return { id, name: connection.name, provider: connection.provider, accessType: 'standard-api', protocol: connection.protocol, baseUrl: connection.baseUrl, modelId: connection.modelId, ...patch }
}
async function fixture(secretCipher = cipher) {
  expect(implementation.TransactionalModelConnectionService).toBeTypeOf('function')
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-model-service-')); roots.push(root)
  const store = new SettingsTransactionStore(root, secretCipher)
  await store.apply({ baseRevision: 0, operations: [{ kind: 'model-connection.add', connection, expectedAbsentRevision: 0 }] }, { id, ciphertext: store.encryptCredential('original-test') })
  const authority = new SettingsAuthority(store)
  const protocol = { testConnection: vi.fn<ModelProtocolClient['testConnection']>(async () => undefined) }
  const catalog = { listModels: vi.fn<ModelCatalogClient['listModels']>(async () => ({ models: ['synthetic'], recommendedModelId: 'synthetic' })) }
  const service = new implementation.TransactionalModelConnectionService(authority, protocol, catalog, { nowIso: () => '2026-10-04T00:00:00.000Z', createId: () => newId })
  return { store, second: new SettingsTransactionStore(root, secretCipher), authority, protocol, catalog, service, observed: await service.getSettings() }
}

describe('transactional model service using original UI observations', () => {
  it.each(['binding ABA', 'model endpoint'] as const)('guards thinking-mode-only intent against an intervening %s change', async change => {
    const { service, second, observed } = await fixture()
    await second.apply(modelFeatureRequest(observed, 'aiConversation', { connectionId: id, thinkingMode: 'disabled', reasoningEffort: 'high' }))
    const original = observeModelSettings(await second.readSnapshot())
    if (change === 'binding ABA') {
      await second.apply(modelFeatureRequest(original, 'aiConversation', { connectionId: null }))
      const interim = observeModelSettings(await second.readSnapshot())
      await second.apply(modelFeatureRequest(interim, 'aiConversation', { connectionId: id }))
    } else await second.apply(connectionEditRequest(original, { ...connection, baseUrl: 'https://changed.example/v1' }))
    const before = await second.readSnapshot()
    expect(await service.setFeature(original, 'aiConversation', { thinkingMode: 'enabled' })).toMatchObject({ status: 'conflict' })
    expect(await second.readSnapshot()).toEqual(before)
    expect(await service.setFeature(original, 'aiConversation', { writePolicy: 'document-grant' })).toMatchObject({ status: 'committed' })
  })

  it('changes thinking mode without normalizing the original reasoning effort or advancing its field revision', async () => {
    const { service, second, observed } = await fixture()
    await second.apply(modelFeatureRequest(observed, 'aiConversation', { connectionId: id, thinkingMode: 'disabled', reasoningEffort: 'high' }))
    const before = await second.readSnapshot()
    expect(await service.setFeature(observeModelSettings(before), 'aiConversation', { thinkingMode: 'enabled' })).toMatchObject({ status: 'committed' })
    const after = await second.readSnapshot()
    expect(after.settings.models!.aiConversation).toMatchObject({ thinkingMode: 'enabled', reasoningEffort: 'high' })
    expect(after.fieldRevisions.fields['models.aiConversation.reasoningEffort']).toBe(before.fieldRevisions.fields['models.aiConversation.reasoningEffort'])
  })

  it('preserves an unrelated remote name while committing the probed model edit', async () => {
    const { service, second, protocol, observed } = await fixture()
    await second.apply(connectionEditRequest(observed, { ...connection, name: 'Remote name' }))
    const result = await service.connect(observed, edited({ modelId: 'edited-model' }))
    expect(result).toMatchObject({ status: 'committed', snapshot: { settings: { connections: [{ name: 'Remote name', modelId: 'edited-model', status: 'connected' }] } } })
    expect(protocol.testConnection).toHaveBeenCalledOnce()
    expect(protocol.testConnection.mock.calls[0]![0]).toMatchObject({ modelId: 'edited-model', apiKey: 'original-test' })
  })

  it('does not let an intervening fresh read bless a retained stale form', async () => {
    const { service, second, protocol, observed } = await fixture()
    await second.apply(connectionEditRequest(observed, { ...connection, baseUrl: 'https://changed.example/v1' }))
    await service.getSettings()
    expect(await service.connect(observed, edited({ name: 'Local edit' }))).toMatchObject({ status: 'conflict' })
    expect(protocol.testConnection).not.toHaveBeenCalled()
  })

  it('rejects a delayed test result after credential replacement and never replays the probe', async () => {
    const { service, second, protocol, observed } = await fixture()
    let finish!: () => void
    protocol.testConnection.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = service.test(observed, id)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await second.apply(connectionEditRequest(observed, connection, true), { id, ciphertext: second.encryptCredential('replacement-test') })
    finish()
    expect(await pending).toMatchObject({ mutation: { status: 'conflict' } })
    expect(protocol.testConnection).toHaveBeenCalledOnce()
    expect((await second.readSnapshot()).settings.models!.connections[0]!.status).toBe('untested')
  })

  it('preserves protocol failure detail while only committing test status and time', async () => {
    const { service, protocol, observed } = await fixture()
    const failure = new ModelProtocolError('authentication-failed')
    protocol.testConnection.mockRejectedValueOnce(failure)
    const result = await service.test(observed, id)
    expect(result).toMatchObject({ mutation: { status: 'committed', snapshot: { settings: { connections: [{ name: 'Original', status: 'authentication-failed' }] } } } })
    expect(result.failure).toBe(failure)
  })

  it('does not resurrect a remotely deleted model or replace its deleted credential', async () => {
    const { service, second, protocol, observed } = await fixture()
    await second.apply(connectionRemoveRequest(observed, id), { id, ciphertext: null })
    expect(await service.connect(observed, edited({ apiKey: 'replacement-test' }))).toMatchObject({ status: 'conflict' })
    expect(protocol.testConnection).not.toHaveBeenCalled()
    expect((await second.readSnapshot()).settings.models!.connections).toEqual([])
  })

  it('creates a stable main-issued ID and commits its tested credential as one owner transaction', async () => {
    const { service, store, observed } = await fixture()
    const result = await service.connect(observed, edited({ id: undefined, name: 'New', apiKey: 'new-test' }))
    expect(result).toMatchObject({ status: 'committed' })
    expect(await store.readModelExecutionSnapshot({ connectionId: newId })).toMatchObject({ connection: { name: 'New', status: 'connected' }, apiKey: 'new-test' })
  })

  it('never commits the supplied replacement credential after a failed probe', async () => {
    const { service, store, protocol, observed } = await fixture()
    protocol.testConnection.mockRejectedValueOnce(new ModelProtocolError('timeout'))
    await expect(service.connect(observed, edited({ apiKey: 'replacement-test' }))).rejects.toMatchObject({ status: 'timeout' })
    expect(await store.readModelExecutionSnapshot({ connectionId: id })).toMatchObject({ apiKey: 'original-test' })
  })

  it('uses observed feature fields so unrelated updates merge and same-field ABA conflicts', async () => {
    const { service, second, observed } = await fixture()
    await second.apply(modelFeatureRequest(observed, 'aiConversation', { writePolicy: 'workspace-grant' }))
    expect(await service.setFeature(observed, 'aiConversation', { connectionId: id })).toMatchObject({ status: 'committed', snapshot: { settings: { aiConversation: { connectionId: id, writePolicy: 'workspace-grant' } } } })
    const fresh = observeModelSettings(await second.readSnapshot())
    await second.apply(modelFeatureRequest(fresh, 'aiConversation', { writePolicy: 'ask-every-time' }))
    expect(await service.setFeature(observed, 'aiConversation', { writePolicy: 'document-grant' })).toMatchObject({ status: 'conflict' })
  })

  it('does not publish a catalog result after stored credentials change while listing', async () => {
    const { service, second, catalog, observed } = await fixture()
    let finish!: (value: { models: string[]; recommendedModelId: string | null }) => void
    catalog.listModels.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = service.listModels(observed, { id, provider: 'other', protocol: 'openai', baseUrl: connection.baseUrl })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await second.apply(connectionEditRequest(observed, connection, true), { id, ciphertext: second.encryptCredential('replacement-test') })
    finish({ models: ['old-result'], recommendedModelId: null })
    expect(await pending).toMatchObject({ status: 'conflict' })
    expect(catalog.listModels).toHaveBeenCalledOnce()
  })

  it('treats a concurrent newer test result as a test-field conflict', async () => {
    const { service, second, protocol, observed } = await fixture()
    protocol.testConnection.mockImplementationOnce(async () => {
      await second.apply(connectionTestRequest(observed, id, 'connected', '2026-10-04T00:01:00.000Z'))
    })
    expect(await service.test(observed, id)).toMatchObject({ mutation: { status: 'conflict' } })
  })

  it('normalizes latest bound reasoning when model inputs change without overwriting the new binding or policy', async () => {
    const { service, second, protocol, observed } = await fixture()
    protocol.testConnection.mockImplementationOnce(async () => {
      await second.apply(modelFeatureRequest(observed, 'aiConversation', { connectionId: id, reasoningEffort: 'xhigh', writePolicy: 'document-grant' }))
    })
    expect(await service.connect(observed, edited({ modelId: 'gpt-5' }))).toMatchObject({ status: 'committed', snapshot: { settings: { aiConversation: { connectionId: id, reasoningEffort: 'default', writePolicy: 'document-grant' } } } })
    const current = await second.readSnapshot()
    expect(current.fieldRevisions.fields['models.aiConversation.reasoningEffort']).toBe(current.revision)
    expect(current.fieldRevisions.fields['models.aiConversation.writePolicy']).toBeLessThan(current.revision)
  })

  it('replaces an undecryptable old credential using the supplied new key without reading the old plaintext', async () => {
    const decrypt = vi.fn(() => { throw new Error('synthetic unavailable old ciphertext') })
    const { service, protocol, observed } = await fixture({ ...cipher, decrypt })
    expect(await service.connect(observed, edited({ apiKey: 'replacement-test' }))).toMatchObject({ status: 'committed' })
    expect(decrypt).not.toHaveBeenCalled()
    expect(protocol.testConnection.mock.calls[0]![0].apiKey).toBe('replacement-test')
  })

  it('does not derive a preference write from a status-only test result', async () => {
    const { service, second, protocol, observed } = await fixture()
    await service.connect(observed, edited({ modelId: 'gpt-5' }))
    const current = observeModelSettings(await second.readSnapshot())
    await second.apply(modelFeatureRequest(current, 'aiConversation', { connectionId: id, reasoningEffort: 'xhigh' }))
    const beforeTest = observeModelSettings(await second.readSnapshot())
    protocol.testConnection.mockRejectedValueOnce(new ModelProtocolError('timeout'))
    expect(await service.test(beforeTest, id)).toMatchObject({ mutation: { status: 'committed', snapshot: { settings: { aiConversation: { reasoningEffort: 'xhigh' } } } } })
  })

  it.each([
    ['effort', { reasoningEffort: undefined }],
    ['binding', { connectionId: undefined }],
    ['both', { connectionId: undefined, reasoningEffort: undefined }],
  ] as const)('omits undefined %s before deriving a policy patch', async (_label, omitted) => {
    const { service, second, observed } = await fixture()
    await service.connect(observed, edited({ modelId: 'gpt-5' }))
    await second.apply(modelFeatureRequest(observeModelSettings(await second.readSnapshot()), 'aiConversation', { connectionId: id, reasoningEffort: 'high' }))
    const before = await second.readSnapshot()
    expect(await service.setFeature(observeModelSettings(before), 'aiConversation', { writePolicy: 'workspace-grant', ...omitted })).toMatchObject({ status: 'committed', snapshot: { settings: { aiConversation: { connectionId: id, reasoningEffort: 'high', writePolicy: 'workspace-grant' } } } })
    const after = await second.readSnapshot()
    expect(after.revision).toBe(before.revision + 1)
    expect(after.fieldRevisions.fields['models.aiConversation.connectionId']).toBe(before.fieldRevisions.fields['models.aiConversation.connectionId'])
    expect(after.fieldRevisions.fields['models.aiConversation.reasoningEffort']).toBe(before.fieldRevisions.fields['models.aiConversation.reasoningEffort'])
    expect(after.fieldRevisions.fields['models.aiConversation.writePolicy']).toBe(after.revision)
  })

  it('keeps all-undefined feature input a no-op without changing persisted values or revisions', async () => {
    const { service, second, observed } = await fixture()
    await second.apply(modelFeatureRequest(observed, 'aiConversation', { connectionId: id, reasoningEffort: 'high' }))
    const before = await second.readSnapshot()
    expect(await service.setFeature(observeModelSettings(before), 'aiConversation', { connectionId: undefined, reasoningEffort: undefined, thinkingMode: undefined, writePolicy: undefined })).toMatchObject({ status: 'unchanged' })
    expect(await second.readSnapshot()).toEqual(before)
  })

  it('preserves explicit null binding and explicit effort semantics while retaining original-observation CAS', async () => {
    const { service, second, observed } = await fixture()
    await second.apply(modelFeatureRequest(observed, 'aiConversation', { connectionId: id, reasoningEffort: 'high' }))
    const before = await second.readSnapshot()
    const original = observeModelSettings(before)
    expect(await service.setFeature(original, 'aiConversation', { connectionId: undefined, reasoningEffort: 'low' })).toMatchObject({ status: 'committed', snapshot: { settings: { aiConversation: { connectionId: id, reasoningEffort: 'low' } } } })
    const afterEffort = await second.readSnapshot()
    expect(afterEffort.fieldRevisions.fields['models.aiConversation.connectionId']).toBe(before.fieldRevisions.fields['models.aiConversation.connectionId'])
    expect(afterEffort.fieldRevisions.fields['models.aiConversation.reasoningEffort']).toBe(afterEffort.revision)
    expect(await service.setFeature(observeModelSettings(afterEffort), 'aiConversation', { connectionId: null, reasoningEffort: undefined })).toMatchObject({ status: 'committed', snapshot: { settings: { aiConversation: { connectionId: null, reasoningEffort: 'low' } } } })
    const afterNull = await second.readSnapshot()
    expect(afterNull.fieldRevisions.fields['models.aiConversation.connectionId']).toBe(afterNull.revision)
    expect(afterNull.fieldRevisions.fields['models.aiConversation.reasoningEffort']).toBe(afterEffort.fieldRevisions.fields['models.aiConversation.reasoningEffort'])
    await second.apply(modelFeatureRequest(observeModelSettings(afterNull), 'aiConversation', { writePolicy: 'workspace-grant' }))
    await service.getSettings()
    const beforeConflict = await second.readSnapshot()
    expect(await service.setFeature(original, 'aiConversation', { writePolicy: 'document-grant', connectionId: undefined, reasoningEffort: undefined })).toMatchObject({ status: 'conflict', conflicts: [{ kind: 'field', field: 'models.aiConversation.writePolicy' }] })
    expect(await second.readSnapshot()).toEqual(beforeConflict)
  })
})
