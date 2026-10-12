import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { DEFAULT_SHELL_INTEGRATION_PREFERENCES } from '../../src/shared/shell-integration-preferences'

it('uses fixed channels and rejects malformed preference responses', async () => {
  const observed = { values: { ...DEFAULT_SHELL_INTEGRATION_PREFERENCES }, unavailable: [],
    observation: { version: 1 as const, revision: 0, minimumBaseRevision: 0, fields: {} } }
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: observed })
  const api = createArkdownApi(invoke)
  await expect(api.getShellIntegrationPreferences!()).resolves.toEqual({ ok: true, value: observed })
  await api.updateShellIntegrationPreference!({ feature: 'markdownShellNew', enabled: true, observed })
  expect(invoke.mock.calls).toEqual([
    ['settings:get-shell-integration'],
    ['settings:update-shell-integration', { feature: 'markdownShellNew', enabled: true, observed }],
  ])
  invoke.mockResolvedValue({ ok: true, value: { ...DEFAULT_SHELL_INTEGRATION_PREFERENCES, foreign: true } })
  await expect(api.getShellIntegrationPreferences!()).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })
  invoke.mockClear()
  await expect(api.updateShellIntegrationPreference!({ feature: 'markdownShellNew', enabled: true } as never))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(invoke).not.toHaveBeenCalled()
})
import { IPC_CHANNELS } from '../../src/shared/contracts'

it('validates direct-registration results rather than treating a successful IPC as association success', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: { markdown: true, text: false } })
  const api = createArkdownApi(invoke)
  expect(await api.setDefaultApplicationsEnabled!(true)).toEqual({ ok: true, value: { markdown: true, text: false } })
  expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.setDefaultApplicationsEnabled, true)
  for (const value of [null, true, { markdown: true }, { markdown: true, text: true, extra: 1 }]) {
    invoke.mockResolvedValueOnce({ ok: true, value })
    expect(await api.setDefaultApplicationsEnabled!(false)).toMatchObject({ ok: false })
  }
})

it('uses no-input default-app channels and validates actual status responses', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: { markdown: true, text: false } })
  const api = createArkdownApi(invoke)
  expect(await api.getDefaultApplicationsStatus!()).toEqual({ ok: true, value: { markdown: true, text: false } })
  invoke.mockResolvedValueOnce({ ok: true, value: null })
  expect(await api.openDefaultApplicationsSettings!()).toEqual({ ok: true, value: null })
  expect(invoke.mock.calls).toEqual([[IPC_CHANNELS.getDefaultApplicationsStatus], [IPC_CHANNELS.openDefaultApplicationsSettings]])
  for (const value of [true, null, { markdown: true }, { markdown: true, text: 1 }, { markdown: true, text: true, saved: true }]) {
    invoke.mockResolvedValueOnce({ ok: true, value })
    expect(await api.getDefaultApplicationsStatus!()).toMatchObject({ ok: false })
  }
})
