import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'
import { modelFeatureRequest, observeModelSettings } from '../../src/main/settings/settings-command-adapter'
import { codexCliModelConnectionId, type CodexCliConnectionSummary } from '../../src/shared/large-model-settings'
import type { CodexCliProbeResult } from '../../src/main/codex/codex-cli-connection-test'

const modulePath = '../../src/main/codex/transactional-codex-connection-service'
const implementation = await import(modulePath).catch(() => ({})) as typeof import('../../src/main/codex/transactional-codex-connection-service')
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const cipher = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
const cli: CodexCliConnectionSummary = { cliVersion: 'synthetic-1', status: 'connected', lastTestedAt: '2026-10-04T00:00:00.000Z', models: [{ modelId: 'original', displayName: 'Original', supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low', isDefault: true }] }
async function fixture(initial: CodexCliConnectionSummary | null = cli) {
  expect(implementation.TransactionalCodexConnectionService).toBeTypeOf('function')
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-codex-transaction-')); roots.push(root)
  const store = new SettingsTransactionStore(root, cipher)
  if (initial) await store.apply({ baseRevision: 0, operations: [{ kind: 'codex-cli.record-test', value: initial, expected: { value: null, revision: 0 } }] })
  const authority = new SettingsAuthority(store)
  const tester = { test: vi.fn(async (): Promise<CodexCliProbeResult> => ({ status: 'connected', cliVersion: 'synthetic-2', models: [] })), dispose: vi.fn(async () => undefined) }
  const service = new implementation.TransactionalCodexConnectionService(authority, tester, () => '2026-10-04T00:01:00.000Z')
  return { store, second: new SettingsTransactionStore(root, cipher), authority, service, tester, observed: observeModelSettings(await authority.readFresh()) }
}

describe('transactional Codex probe CAS with synthetic tester', () => {
  it('preserves a model newly referenced during the probe and unrelated latest fields', async () => {
    const { service, tester, second, observed } = await fixture()
    tester.test.mockImplementationOnce(async () => {
      await second.apply(modelFeatureRequest(observed, 'aiConversation', { connectionId: codexCliModelConnectionId('original'), writePolicy: 'workspace-grant' }))
      return { status: 'connected', cliVersion: 'synthetic-2', models: [] }
    })
    expect(await service.test(observed)).toMatchObject({ status: 'connected', mutation: { status: 'committed', snapshot: { settings: { codexCli: { cliVersion: 'synthetic-2', models: [{ modelId: 'original', unavailable: true, isDefault: false }] }, aiConversation: { writePolicy: 'workspace-grant' } } } } })
    expect(tester.test).toHaveBeenCalledOnce()
  })

  it('does not recreate a connection removed while the probe runs', async () => {
    const { service, tester, second, observed } = await fixture()
    tester.test.mockImplementationOnce(async () => {
      await second.apply({ baseRevision: observed.observation.revision, operations: [{ kind: 'codex-cli.remove', expected: { value: observed.settings.codexCli, revision: observed.observation.fields['models.codexCli']! } }] })
      return { status: 'connected', cliVersion: 'synthetic-2' }
    })
    expect(await service.test(observed)).toMatchObject({ mutation: { status: 'conflict' } })
    expect((await second.readSnapshot()).settings.models!.codexCli).toBeNull()
  })

  it('rejects a stale aggregate observation before invoking the tester', async () => {
    const { service, tester, second, observed } = await fixture()
    await second.apply({ baseRevision: observed.observation.revision, operations: [{ kind: 'codex-cli.record-test', value: { ...cli, lastTestedAt: '2026-10-04T00:00:30.000Z' }, expected: { value: cli, revision: observed.observation.fields['models.codexCli']! } }] })
    expect(await service.test(observed)).toMatchObject({ mutation: { status: 'conflict' } })
    expect(tester.test).not.toHaveBeenCalled()
  })

  it('does not create a record when the first probe fails', async () => {
    const { service, tester, store, observed } = await fixture(null)
    tester.test.mockResolvedValueOnce({ status: 'not-found' })
    expect(await service.test(observed)).toMatchObject({ status: 'not-found', mutation: { status: 'unchanged' } })
    expect((await store.readSnapshot()).revision).toBe(0)
  })

  it('records a failed probe against the observed existing summary without discarding its catalog', async () => {
    const { service, tester, observed } = await fixture()
    tester.test.mockResolvedValueOnce({ status: 'connected' })
    expect(await service.test(observed)).toMatchObject({ status: 'incompatible-response', mutation: { status: 'committed', snapshot: { settings: { codexCli: { cliVersion: cli.cliVersion, status: 'incompatible-response', models: cli.models } } } } })
  })

  it('removes only matching current bindings and preserves unrelated latest policy', async () => {
    const { service, second, observed } = await fixture()
    await second.apply(modelFeatureRequest(observed, 'aiConversation', { connectionId: codexCliModelConnectionId('original'), writePolicy: 'document-grant' }))
    expect(await service.remove(observed)).toMatchObject({ status: 'committed', snapshot: { settings: { codexCli: null, aiConversation: { connectionId: null, writePolicy: 'document-grant' } } } })
  })

  it('does not commit a completed probe after disposal and awaits tester cleanup', async () => {
    const { service, tester, store, observed } = await fixture()
    let finish!: (result: CodexCliProbeResult) => void
    tester.test.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = service.test(observed)
    const rejected = expect(pending).rejects.toThrow('Codex CLI connection service is disposed')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const disposing = service.dispose()
    finish({ status: 'connected', cliVersion: 'ignored' })
    await rejected; await disposing
    expect(tester.dispose).toHaveBeenCalledOnce()
    expect((await store.readSnapshot()).settings.models!.codexCli!.cliVersion).toBe(cli.cliVersion)
  })

  it('does not invoke even an injected tester when disposal happens during the authority read', async () => {
    const { service, tester, store, authority, observed } = await fixture()
    const snapshot = await store.readSnapshot()
    let release!: () => void
    vi.spyOn(authority, 'readFresh').mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(snapshot) }))
    const pending = service.test(observed)
    const rejected = expect(pending).rejects.toThrow('Codex CLI connection service is disposed')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const disposing = service.dispose()
    release()
    await rejected; await disposing
    expect(tester.test).not.toHaveBeenCalled()
    expect(tester.dispose).toHaveBeenCalledOnce()
    expect(await store.readSnapshot()).toEqual(snapshot)
  })
})
