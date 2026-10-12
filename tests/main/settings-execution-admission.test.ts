import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'
import { connectionEditRequest, connectionRemoveRequest, connectionTestRequest, modelFeatureRequest, observeModelSettings } from '../../src/main/settings/settings-command-adapter'
import type { ModelConnectionSummary } from '../../src/shared/large-model-settings'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const id = '550e8400-e29b-41d4-a716-446655440000'
const cipher = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(`synthetic:${value}`), decrypt: (value: Buffer) => value.toString().slice(10) }
const connection: ModelConnectionSummary = { id, name: 'Synthetic', provider: 'other', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://example.com/v1', modelId: 'synthetic', apiKeyHint: '••••test', status: 'untested', lastTestedAt: null, capabilityOverride: null }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-admission-'))
  roots.push(root)
  const store = new SettingsTransactionStore(root, cipher)
  await store.apply({ baseRevision: 0, operations: [{ kind: 'model-connection.add', connection, expectedAbsentRevision: 0 }] }, { id, ciphertext: store.encryptCredential('original-test') })
  await store.apply(modelFeatureRequest(observeModelSettings(await store.readSnapshot()), 'aiConversation', { connectionId: id }))
  const observed = observeModelSettings(await store.readSnapshot())
  const second = new SettingsTransactionStore(root, cipher, {}, 500)
  return { root, store, second, observed, admit: store.admitModelExecution.bind(store) }
}

describe('finite model execution admission under the original settings lock', () => {
  it('registers once and releases the lease before long work completes', async () => {
    const { second, observed, admit } = await fixture()
    let finish!: (value: string) => void
    const completion = new Promise<string>(resolve => { finish = resolve })
    const start = vi.fn(() => ({ completion }))
    const admitted = await admit(observed, { feature: 'aiConversation' }, start)
    expect(start).toHaveBeenCalledOnce()
    expect(await second.apply({ baseRevision: observed.observation.revision, operations: [{ kind: 'workspace.set', value: 'after-admission', mode: 'last-writer-wins' }] })).toMatchObject({ status: 'committed' })
    finish('done')
    expect(await admitted.completion).toBe('done')
  })

  it('denies a remotely changed policy before the operation enters execution', async () => {
    const { second, observed, admit } = await fixture()
    await second.apply(modelFeatureRequest(observed, 'aiConversation', { writePolicy: 'workspace-grant' }))
    const start = vi.fn(() => ({ completion: Promise.resolve() }))
    await expect(admit(observed, { feature: 'aiConversation' }, start)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_AUTHORITY_CHANGED' })
    expect(start).not.toHaveBeenCalled()
  })

  it('denies credential generation changes even when the public key hint is unchanged', async () => {
    const { second, observed, admit } = await fixture()
    await second.apply(connectionEditRequest(observed, connection, true), { id, ciphertext: second.encryptCredential('replacement-test') })
    const start = vi.fn(() => ({ completion: Promise.resolve() }))
    await expect(admit(observed, { connectionId: id }, start)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_AUTHORITY_CHANGED' })
    expect(start).not.toHaveBeenCalled()
  })

  it('does not treat a status/time-only test result as a model input change', async () => {
    const { second, observed, admit } = await fixture()
    await second.apply(connectionTestRequest(observed, id, 'connected', '2026-10-04T00:00:00.000Z'))
    const start = vi.fn(() => ({ completion: Promise.resolve('accepted') }))
    const admitted = await admit(observed, { feature: 'aiConversation' }, start)
    expect(await admitted.completion).toBe('accepted')
  })

  it('does not start with a deleted binding', async () => {
    const { store, second, observed, admit } = await fixture()
    await second.apply(connectionRemoveRequest(observed, id), { id, ciphertext: null })
    const start = vi.fn(() => ({ completion: Promise.resolve() }))
    await expect(admit(observed, { feature: 'aiConversation' }, start)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_AUTHORITY_CHANGED' })
    expect(start).not.toHaveBeenCalled()
    expect((await store.readSnapshot()).settings.models!.connections).toEqual([])
  })

  it('does not bypass unresolved pending recovery to enter execution', async () => {
    const { root, observed, admit } = await fixture()
    await writeFile(path.join(root, 'model-settings.pending.json'), '{broken')
    const start = vi.fn(() => ({ completion: Promise.resolve() }))
    await expect(admit(observed, { feature: 'aiConversation' }, start)).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_RECOVERY_REQUIRED' })
    expect(start).not.toHaveBeenCalled()
  })
})
