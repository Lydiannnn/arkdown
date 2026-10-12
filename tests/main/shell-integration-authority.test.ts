import { expect, it, vi } from 'vitest'
import { ShellIntegrationService } from '../../src/main/shell-integration/service'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { createSettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-schema'
import { reduceSettingsTransaction } from '../../src/main/settings/settings-transaction-reducer'
import type { SettingsStorageResult } from '../../src/main/settings/settings-transaction-store'
import type { SettingsTransactionRequest } from '../../src/main/settings/settings-transaction-types'
import type { ShellMenuRegistration } from '../../src/main/shell-integration/registration'

function fixture() {
  let current = createSettingsTransactionSnapshot({ lastWorkspace: null,
    shellIntegration: { documentOpenMenu: false, markdownShellNew: false } })
  const apply = vi.fn(async (request: SettingsTransactionRequest): Promise<SettingsStorageResult> => {
    const result = reduceSettingsTransaction(current, request)
    if (result.status !== 'prepared') return result
    current = result.snapshot
    return { status: 'committed', snapshot: current, cleanupPending: true }
  })
  const authority = new SettingsAuthority({ readSnapshot: async () => structuredClone(current), apply,
    readModelExecutionSnapshot: async () => { throw new Error('unused') }, encryptCredential: () => { throw new Error('unused') },
    admitModelExecution: async <T>(_expected: unknown, _target: unknown, start: () => { completion: Promise<T> }) => start() })
  const native = { documentOpenMenu: false, markdownShellNew: false }
  const setEnabled = vi.fn<Pick<ShellMenuRegistration, 'setEnabled'>['setEnabled']>(async (feature, enabled, persist = async () => {}) => {
    if (feature === 'desktopNote') throw new Error('not part of main settings')
    const before = native[feature]
    native[feature] = enabled
    try { await persist() } catch (error) { native[feature] = before; throw error }
  })
  const service = new ShellIntegrationService({ setEnabled }, { authority })
  return { service, setEnabled, native, current: () => current, apply, authority }
}

it('retains original feature observation while merging an unrelated remote feature', async () => {
  const test = fixture()
  const observed = await test.service.readObserved()
  await test.authority.apply({ baseRevision: 0, operations: [{ kind: 'shell-integration.set', feature: 'markdownShellNew',
    value: true, expected: { value: false, revision: 0 } }] })
  const result = await test.service.updateObserved({ feature: 'documentOpenMenu', enabled: true, observed })
  expect(result.values).toEqual({ documentOpenMenu: true, markdownShellNew: true })
  expect(test.native.documentOpenMenu).toBe(true)
  expect(test.setEnabled).toHaveBeenCalledOnce()
})

it('rejects stale ABA before native registration even when display has already refreshed', async () => {
  const test = fixture(), observed = await test.service.readObserved()
  await test.service.updateObserved({ feature: 'documentOpenMenu', enabled: true, observed })
  const newer = await test.service.readObserved()
  await test.service.updateObserved({ feature: 'documentOpenMenu', enabled: false, observed: newer })
  await test.service.readObserved()
  test.setEnabled.mockClear()
  await expect(test.service.updateObserved({ feature: 'documentOpenMenu', enabled: true, observed }))
    .rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  expect(test.setEnabled).not.toHaveBeenCalled()
  expect(test.current().settings.shellIntegration?.documentOpenMenu).toBe(false)
})

it('lets the registry owner roll back this attempt after a cross-process change during registration', async () => {
  const test = fixture(), observed = await test.service.readObserved()
  test.setEnabled.mockImplementationOnce(async (_feature, _enabled, persist) => {
    test.native.documentOpenMenu = true
    await test.authority.apply({ baseRevision: 0, operations: [{ kind: 'shell-integration.set', feature: 'documentOpenMenu',
      value: true, expected: { value: false, revision: 0 } }] })
    try { await persist!() } catch (error) { test.native.documentOpenMenu = false; throw error }
  })
  await expect(test.service.updateObserved({ feature: 'documentOpenMenu', enabled: true, observed }))
    .rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  expect(test.setEnabled).toHaveBeenCalledOnce()
  expect(test.native.documentOpenMenu).toBe(false)
  expect(test.current().settings.shellIntegration?.documentOpenMenu).toBe(true)
})

it('captures an enqueued command and rejects the legacy writer in authority composition', async () => {
  const test = fixture(), observed = await test.service.readObserved()
  const input = { feature: 'documentOpenMenu' as const, enabled: true, observed }
  const applying = test.service.updateObserved(input)
  input.enabled = false
  observed.values.documentOpenMenu = true
  await applying
  expect(test.current().settings.shellIntegration?.documentOpenMenu).toBe(true)
  await expect(test.service.update({ feature: 'documentOpenMenu', enabled: false })).rejects.toThrow('SHELL_LEGACY_WRITER_DISABLED')
})

it('acknowledges a committed setting even when registry connection teardown subsequently fails', async () => {
  const test = fixture(), observed = await test.service.readObserved()
  test.setEnabled.mockImplementationOnce(async (_feature, _enabled, persist) => {
    test.native.documentOpenMenu = true
    await persist!()
    throw new Error('registry connection close failed')
  })
  const result = await test.service.updateObserved({ feature: 'documentOpenMenu', enabled: true, observed })
  expect(result.values.documentOpenMenu).toBe(true)
  expect(result.unavailable).toEqual([])
  expect(test.native.documentOpenMenu).toBe(true)
  expect(test.setEnabled).toHaveBeenCalledOnce()
})

it('restores from fresh authority and rolls back if the enabled preference changes while restoring', async () => {
  const test = fixture()
  await test.authority.apply({ baseRevision: 0, operations: [{ kind: 'shell-integration.set', feature: 'documentOpenMenu',
    value: true, expected: { value: false, revision: 0 } }] })
  test.setEnabled.mockImplementationOnce(async (_feature, _enabled, persist) => {
    await test.authority.apply({ baseRevision: 1, operations: [{ kind: 'shell-integration.set', feature: 'documentOpenMenu',
      value: false, expected: { value: true, revision: 1 } }] })
    await persist!()
  })
  await expect(test.service.restoreEnabled()).rejects.toThrow('无法恢复部分右键菜单')
  expect((await test.service.readObserved()).values.documentOpenMenu).toBe(false)
})
