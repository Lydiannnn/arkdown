import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { DEFAULT_SHELL_INTEGRATION_PREFERENCES } from '../../src/shared/shell-integration-preferences'
import { PublicError } from '../../src/shared/public-errors'

it('accepts only a boolean for direct registration and returns the effective status', async () => {
  const setEnabled = vi.fn(async (enabled: boolean) => ({ markdown: enabled, text: false }))
  const operations = createIpcOperations({ chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never,
    getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(),
    defaultApplications: { getStatus: vi.fn(), openSettings: vi.fn(), setEnabled } })
  for (const payload of [undefined, null, 1, 'true', { enabled: true }, { executable: 'other.exe' }]) {
    expect(await operations.setDefaultApplicationsEnabled(payload)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(setEnabled).not.toHaveBeenCalled()
  expect(await operations.setDefaultApplicationsEnabled(true)).toEqual({ ok: true, value: { markdown: true, text: false } })
  expect(await operations.setDefaultApplicationsEnabled(false)).toEqual({ ok: true, value: { markdown: false, text: false } })
})

it('accepts no default-app registry paths, executable, extension or URL from the renderer', async () => {
  const getStatus = vi.fn(async () => ({ markdown: false, text: true })), openSettings = vi.fn(async () => {})
  const operations = createIpcOperations({ chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never,
    getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(), defaultApplications: { getStatus, openSettings, setEnabled: vi.fn() } })
  for (const payload of [{ uri: 'https://other' }, { executable: 'other.exe' }, { extension: '.docx' }, { key: 'UserChoice' }]) {
    expect(await operations.getDefaultApplicationsStatus(payload)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(await operations.openDefaultApplicationsSettings(payload)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(openSettings).not.toHaveBeenCalled(); expect(getStatus).not.toHaveBeenCalled()
  expect(await operations.getDefaultApplicationsStatus()).toEqual({ ok: true, value: { markdown: false, text: true } })
  expect(await operations.openDefaultApplicationsSettings()).toEqual({ ok: true, value: null })
})

it('requires the fixed feature and original observation and validates authoritative responses', async () => {
  const observed = { values: { ...DEFAULT_SHELL_INTEGRATION_PREFERENCES }, unavailable: [],
    observation: { version: 1 as const, revision: 0, minimumBaseRevision: 0, fields: {} } }
  const readObserved = vi.fn(async () => observed)
  const updateObserved = vi.fn(async () => observed)
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never,
    getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(),
    shellIntegration: { readObserved, updateObserved },
  })
  await expect(operations.getShellIntegrationPreferences()).resolves.toEqual({ ok: true, value: observed })
  expect(updateObserved).not.toHaveBeenCalled()
  for (const input of [{ feature: 'shell', enabled: true, observed }, { feature: 'markdownShellNew', enabled: 1, observed },
    { feature: 'markdownShellNew', enabled: true }, { feature: 'markdownShellNew', enabled: true, observed, command: 'foreign' }]) {
    await expect(operations.updateShellIntegrationPreference(input)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(updateObserved).not.toHaveBeenCalled()
  await expect(operations.updateShellIntegrationPreference({ feature: 'markdownShellNew', enabled: true, observed })).resolves.toMatchObject({ ok: true, value: observed })
  expect(updateObserved).toHaveBeenCalledExactlyOnceWith({ feature: 'markdownShellNew', enabled: true, observed })
  updateObserved.mockRejectedValueOnce(new PublicError('SHELL_INTEGRATION_CONFLICT'))
  await expect(operations.updateShellIntegrationPreference({ feature: 'markdownShellNew', enabled: false, observed })).resolves.toMatchObject({ ok: false, error: { code: 'SHELL_INTEGRATION_CONFLICT' } })
})
