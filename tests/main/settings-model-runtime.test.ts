import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'
import { connectionEditRequest, modelFeatureRequest, observeModelSettings } from '../../src/main/settings/settings-command-adapter'
import { codexCliModelConnectionId, type ModelConnectionSummary } from '../../src/shared/large-model-settings'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const id = '550e8400-e29b-41d4-a716-446655440000'
const cipher = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(`synthetic:${value}`), decrypt: (value: Buffer) => value.toString().slice(10) }
const connection: ModelConnectionSummary = { id, name: 'Synthetic', provider: 'other', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://example.com/v1', modelId: 'synthetic', apiKeyHint: '••••test', status: 'untested', lastTestedAt: null, capabilityOverride: null }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-model-runtime-')); roots.push(root)
  const store = new SettingsTransactionStore(root, cipher)
  await store.apply({ baseRevision: 0, operations: [{ kind: 'model-connection.add', connection, expectedAbsentRevision: 0 }] }, { id, ciphertext: store.encryptCredential('original-test') })
  await store.apply(modelFeatureRequest(observeModelSettings(await store.readSnapshot()), 'aiConversation', { connectionId: id }))
  return { store, second: new SettingsTransactionStore(root, cipher, {}, 500), authority: new SettingsAuthority(store) }
}

describe('main-only authority model runtime', () => {
  it('pairs fresh credentials and values while notifications and display cache contain no secret', async () => {
    const { authority, second } = await fixture()
    const before = observeModelSettings(await authority.readFresh())
    await second.apply(connectionEditRequest(before, { ...connection, baseUrl: 'https://remote.example/v1' }, true), { id, ciphertext: second.encryptCredential('remote-secret') })
    const notify = vi.fn(); authority.subscribe(notify)
    expect(authority.readExecution).toBeTypeOf('function')
    const execution = await authority.readExecution({ feature: 'aiConversation' })
    expect(execution).toMatchObject({ connection: { baseUrl: 'https://remote.example/v1' }, apiKey: 'remote-secret', observed: { settings: { aiConversation: { connectionId: id } } } })
    expect(JSON.stringify(authority.getDisplaySnapshot())).not.toContain('remote-secret')
    expect(JSON.stringify(notify.mock.calls)).not.toContain('remote-secret')
    execution.observed.settings.connections[0]!.name = 'mutated copy'
    expect(authority.getDisplaySnapshot().settings.models!.connections[0]!.name).toBe('Synthetic')
  })

  it('does not retain the queue or lease while admitted completion is pending', async () => {
    const { authority } = await fixture()
    expect(authority.readExecution).toBeTypeOf('function')
    const execution = await authority.readExecution({ feature: 'aiConversation' })
    let finish!: () => void
    const completion = new Promise<void>(resolve => { finish = resolve })
    const admitted = await authority.admitExecution(execution.observed, { feature: 'aiConversation' }, () => ({ completion }))
    expect(await authority.apply({ baseRevision: execution.observed.observation.revision, operations: [{ kind: 'workspace.set', value: 'later', mode: 'last-writer-wins' }] })).toMatchObject({ status: 'committed' })
    finish(); await admitted.completion
  })

  it('rejects new execution work after disposal', async () => {
    const { authority } = await fixture()
    expect(authority.readExecution).toBeTypeOf('function')
    const execution = await authority.readExecution({ connectionId: id })
    authority.dispose()
    await expect(authority.readExecution({ connectionId: id })).rejects.toThrow('SETTINGS_AUTHORITY_DISPOSED')
    await expect(authority.admitExecution(execution.observed, { connectionId: id }, () => ({ completion: Promise.resolve() }))).rejects.toThrow('SETTINGS_AUTHORITY_DISPOSED')
    expect(() => authority.encryptCredential('unused')).toThrow('SETTINGS_AUTHORITY_DISPOSED')
  })

  it('conservatively rejects Codex admission when only aggregate test status/time changes', async () => {
    const { store, second } = await fixture()
    const cli = { cliVersion: '1.0.0', status: 'connected' as const, lastTestedAt: '2026-10-04T00:00:00.000Z', models: [{ modelId: 'synthetic', displayName: 'Synthetic', isDefault: true, supportedReasoningEfforts: ['low' as const], defaultReasoningEffort: 'low' as const }] }
    const before = await store.readSnapshot()
    expect(await store.apply({ baseRevision: before.revision, operations: [{ kind: 'codex-cli.record-test', value: cli, expected: { value: null, revision: 0 } }] })).toMatchObject({ status: 'committed' })
    const observed = observeModelSettings(await store.readSnapshot())
    const start = vi.fn(() => ({ completion: Promise.resolve('accepted') }))
    const target = { connectionId: codexCliModelConnectionId('synthetic') }
    expect(await (await store.admitModelExecution(observed, target, start)).completion).toBe('accepted')
    await second.apply({ baseRevision: observed.observation.revision, operations: [{ kind: 'codex-cli.record-test', value: { ...cli, lastTestedAt: '2026-10-04T00:01:00.000Z' }, expected: { value: observed.settings.codexCli, revision: observed.observation.fields['models.codexCli']! } }] })
    await expect(store.admitModelExecution(observed, target, start)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_AUTHORITY_CHANGED' })
    expect(start).toHaveBeenCalledOnce()
  })
})
