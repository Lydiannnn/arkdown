import { expect, it, vi } from 'vitest'
import { restoreArkdownContextMenus } from '../../src/main/shell-integration/startup'
import { createArknoteContextMenuSettings } from '../../src/main/arknote/context-menu-settings'
import { DEFAULT_ARKNOTE_SETTINGS } from '../../src/main/arknote/arknote-settings-store'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { ShellIntegrationService } from '../../src/main/shell-integration/service'
import { ShellMenuRegistration } from '../../src/main/shell-integration/registration'
import { MemoryRegistry } from './shell-registry-fake'

it('does not restore a menu from stale settings after a newer opt-out is queued', async () => {
  let resume!: () => void
  const gate = new Promise<void>(resolve => { resume = resolve })
  const settings = new SettingsCoordinator({ save: async () => { await gate } }, { lastWorkspace: null })
  const registry = new MemoryRegistry()
  const registration = new ShellMenuRegistration({ executablePath: 'C:\\Arkdown.exe', registry })
  const service = new ShellIntegrationService(registration, settings)
  const update = service.update({ feature: 'documentOpenMenu', enabled: false })
  const restore = service.restoreEnabled()
  resume()
  await Promise.all([update, restore])
  expect(service.get().documentOpenMenu).toBe(false)
  expect(await registry.read('SystemFileAssociations\\.md\\shell\\Arkdown')).toBeNull()
})

it('initializes the independent desktop menu while Arkdown menu restoration is pending, and waits for both', async () => {
  const registry = new MemoryRegistry()
  const desktop = new ShellMenuRegistration({ executablePath: 'C:\\Arknote.exe', registry })
  let releaseShell!: () => void
  let shellFinished = false
  let startupFinished = false
  const shellPending = new Promise<void>((resolve) => { releaseShell = resolve })
  const startup = restoreArkdownContextMenus({ restoreEnabled: async () => {
    await shellPending
    shellFinished = true
  } }, async () => {
    await desktop.setEnabled('desktopNote', true)
  }, () => {}, {}).then(() => { startupFinished = true })
  try {
    await vi.waitFor(async () => {
      expect((await registry.read('DesktopBackground\\Shell\\Arknote\\command'))?.values[''].data)
        .toBe('"C:\\Arknote.exe" --new-note')
    }, { timeout: 200 })
    expect(shellFinished).toBe(false)
    expect(startupFinished).toBe(false)
  } finally {
    releaseShell()
    await startup
  }
  expect(shellFinished).toBe(true)
  expect(startupFinished).toBe(true)
})

it('ordinary Arkdown initializes Arknote even when its own first menu fails', async () => {
  const registry = new MemoryRegistry()
  registry.failAt = 1
  const shell = new ShellIntegrationService(new ShellMenuRegistration({ executablePath: 'C:\\Arkdown.exe', registry }),
    new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null }))
  const desktopRegistry = new MemoryRegistry()
  const desktop = new ShellMenuRegistration({ executablePath: 'C:\\Arknote.exe', registry: desktopRegistry })
  const readArknoteSettings = async () => {
    const state = await createArknoteContextMenuSettings(DEFAULT_ARKNOTE_SETTINGS,
      { setEnabled: (enabled, persist) => desktop.setEnabled('desktopNote', enabled, persist) },
      { save: async () => {} }, { sync: () => {} }, () => {})
    return state.get()
  }
  const report = vi.fn()
  await restoreArkdownContextMenus(shell, readArknoteSettings, report, {})
  expect(shell.get()).toEqual({ documentOpenMenu: false, markdownShellNew: true })
  expect((await registry.read('.md\\ShellNew'))?.values.NullFile.data).toBe('')
  expect((await desktopRegistry.read('DesktopBackground\\Shell\\Arknote\\command'))?.values[''].data).toBe('"C:\\Arknote.exe" --new-note')
  expect(report).toHaveBeenCalledOnce()
})

it('ordinary E2E never starts Arknote for registration and reports shell refusal', async () => {
  const readArknoteSettings = vi.fn()
  const report = vi.fn()
  await restoreArkdownContextMenus({ restoreEnabled: async () => { throw new Error('blocked') } }, readArknoteSettings, report, { ARKDOWN_E2E: '1' })
  expect(readArknoteSettings).not.toHaveBeenCalled()
  expect(report).toHaveBeenCalledOnce()
})

it('waits for Arknote to settle even when shell initialization finishes first', async () => {
  let failArknote!: (error: Error) => void
  const pending = new Promise<unknown>((_resolve, reject) => { failArknote = reject })
  const report = vi.fn()
  let finished = false
  const operation = restoreArkdownContextMenus({ restoreEnabled: async () => {} },
    () => pending, report, {}).then(() => { finished = true })
  await Promise.resolve()
  await Promise.resolve()
  expect(finished).toBe(false)
  const failure = new Error('Arknote unavailable')
  failArknote(failure)
  await operation
  expect(report).toHaveBeenCalledWith('Could not initialize Arknote desktop registration', failure)
  expect(finished).toBe(true)
})

it('failed Arknote startup stays unchecked without saving a false opt-out and can retry', async () => {
  const registry = new MemoryRegistry()
  registry.failAt = 1
  const registration = new ShellMenuRegistration({ executablePath: 'C:\\Arknote.exe', registry })
  const save = vi.fn(async () => {})
  const state = await createArknoteContextMenuSettings(DEFAULT_ARKNOTE_SETTINGS,
    { setEnabled: (enabled, persist) => registration.setEnabled('desktopNote', enabled, persist) },
    { save }, { sync: () => {} }, () => {})
  expect(state.get().registerDesktopContextMenu).toBe(false)
  expect(save).not.toHaveBeenCalled()
  expect(DEFAULT_ARKNOTE_SETTINGS.registerDesktopContextMenu).toBe(true)
  await state.update((current) => ({ ...current, themeColor: '#2563EB' }))
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ themeColor: '#2563EB', registerDesktopContextMenu: true }))
  expect(state.get().registerDesktopContextMenu).toBe(false)
  await state.update((current) => ({ ...current, registerDesktopContextMenu: true }))
  expect(state.get().registerDesktopContextMenu).toBe(true)
  expect((await registry.read('DesktopBackground\\Shell\\Arknote\\command'))?.values[''].data).toBe('"C:\\Arknote.exe" --new-note')
  expect(save).toHaveBeenCalledTimes(2)
})

it('Arknote preserves explicit false and rolls back a retry if settings cannot be saved', async () => {
  const registry = new MemoryRegistry()
  const registration = new ShellMenuRegistration({ executablePath: 'C:\\Arknote.exe', registry })
  const state = await createArknoteContextMenuSettings({ ...DEFAULT_ARKNOTE_SETTINGS, registerDesktopContextMenu: false },
    { setEnabled: (enabled, persist) => registration.setEnabled('desktopNote', enabled, persist) },
    { save: async () => { throw new Error('save failed') } }, { sync: () => {} }, () => {})
  expect(registry.writes).toBe(0)
  await expect(state.update((current) => ({ ...current, registerDesktopContextMenu: true }))).rejects.toThrow('save failed')
  expect(state.get().registerDesktopContextMenu).toBe(false)
  expect(await registry.read('DesktopBackground\\Shell\\Arknote')).toBeNull()
})
