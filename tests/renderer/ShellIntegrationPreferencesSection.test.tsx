import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ShellIntegrationPreferencesSection } from '../../src/renderer/settings/ShellIntegrationPreferencesSection'
import type { ArkdownApi } from '../../src/shared/contracts'
import type { ShellIntegrationSnapshot } from '../../src/shared/shell-integration-preferences'
import { ShellIntegrationPreferenceDraft } from '../../src/renderer/settings/shell-integration-preference-draft'
import { createPreferencePersistence } from '../../src/renderer/settings/preference-update-queue'

const snapshot = (revision = 4): ShellIntegrationSnapshot => ({ values: { documentOpenMenu: false, markdownShellNew: false },
  unavailable: [], observation: { version: 1, revision, minimumBaseRevision: 0, fields: { documentOpenMenu: revision } } })
const label = 'md/txt文档上右键增加“使用Arkdown打开”'

it('keeps a failed choice and original observation until explicit reload', async () => {
  const observed = snapshot()
  const get = vi.fn(async () => ({ ok: true as const, value: structuredClone(observed) }))
  const update = vi.fn(async () => ({ ok: false as const, error: { code: 'SHELL_INTEGRATION_CONFLICT' as const, message: '设置已更改' } }))
  window.arkdown = { getShellIntegrationPreferences: get, updateShellIntegrationPreference: update } as unknown as ArkdownApi
  render(<ShellIntegrationPreferencesSection desktopEnabled={false} draft={new ShellIntegrationPreferenceDraft(createPreferencePersistence())} />)
  const checkbox = screen.getByRole('checkbox', { name: label })
  await waitFor(() => expect(checkbox).toBeEnabled())
  fireEvent.click(checkbox)
  await screen.findByText('设置已更改')
  expect(checkbox).toBeChecked()
  expect(update).toHaveBeenCalledExactlyOnceWith({ feature: 'documentOpenMenu', enabled: true, observed })
  expect(get).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '重新加载右键菜单设置' }))
  await waitFor(() => expect(checkbox).not.toBeChecked())
  expect(screen.queryByText('设置已更改')).not.toBeInTheDocument()
  expect(get).toHaveBeenCalledTimes(2)
})

it('keeps each simultaneous feature mutation tied to its own opening snapshot', async () => {
  const observed = snapshot()
  let finish!: (value: { ok: true; value: ShellIntegrationSnapshot }) => void
  const update = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce({ ok: true, value: { ...snapshot(6), values: { documentOpenMenu: true, markdownShellNew: true } } })
  window.arkdown = { getShellIntegrationPreferences: async () => ({ ok: true, value: observed }),
    updateShellIntegrationPreference: update } as unknown as ArkdownApi
  render(<ShellIntegrationPreferencesSection desktopEnabled={false} draft={new ShellIntegrationPreferenceDraft(createPreferencePersistence())} />)
  await waitFor(() => expect(screen.getByRole('checkbox', { name: label })).toBeEnabled())
  fireEvent.click(screen.getByRole('checkbox', { name: label }))
  fireEvent.click(screen.getByRole('checkbox', { name: '在右键‘新建’菜单中增加 Markdown 文档' }))
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
  await act(async () => finish({ ok: true, value: { ...snapshot(5), values: { documentOpenMenu: true, markdownShellNew: false } } }))
  expect(update.mock.calls.map(([input]) => input.observed.observation.revision)).toEqual([4, 4])
  expect(screen.getByRole('checkbox', { name: '在右键‘新建’菜单中增加 Markdown 文档' })).toBeChecked()
})
