import { expect, it } from 'vitest'
import { ShellMenuRegistration } from '../../src/main/shell-integration/registration'
import { ShellIntegrationService } from '../../src/main/shell-integration/service'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { DesktopContextMenuRegistration } from '../../src/main/arknote/desktop-context-menu'
import { createArknoteContextMenuSettings } from '../../src/main/arknote/context-menu-settings'
import { DEFAULT_ARKNOTE_SETTINGS } from '../../src/main/arknote/arknote-settings-store'
import { MemoryRegistry } from './shell-registry-fake'

const oldExe = 'C:\\Old\\Arkdown.exe'
const currentExe = 'C:\\Current\\Arkdown.exe'
const features = ['documentOpenMenu', 'markdownShellNew', 'desktopNote'] as const
const commandKeys = {
  documentOpenMenu: 'SystemFileAssociations\\.md\\shell\\Arkdown\\command',
  markdownShellNew: 'Arkdown.Markdown\\shell\\open\\command',
  desktopNote: 'DesktopBackground\\Shell\\Arknote\\command',
}
const str = (data: string) => ({ kind: 'String', data })
const current = (registry: MemoryRegistry) => new ShellMenuRegistration({ executablePath: currentExe, registry })

it.each(features)('explicit enable transfers old journal and disable ownership: %s', async (feature) => {
  const registry = new MemoryRegistry()
  const old = new ShellMenuRegistration({ executablePath: oldExe, registry })
  await old.setEnabled(feature, true)
  const before = structuredClone(registry.user)
  const registration = current(registry)
  await expect(registration.setEnabled(feature, true)).rejects.toThrow()
  await expect(registration.setEnabled(feature, false)).rejects.toThrow()
  expect(registry.user).toEqual(before)
  await registration.setEnabled(feature, true, undefined, { explicitEnable: true })
  expect((await registry.read(commandKeys[feature]))?.values['']).toEqual(str(
    feature === 'desktopNote' ? '"C:\\Current\\Arkdown.exe" --new-note' : '"C:\\Current\\Arkdown.exe" "%1"'))
  await expect(old.setEnabled(feature, false)).rejects.toThrow()
  await registration.setEnabled(feature, false)
  expect(await registry.read(commandKeys[feature])).toBeNull()
})

it.each(features)('explicitly retakes an old copy written over a current-copy journal: %s', async (feature) => {
  const registry = new MemoryRegistry()
  const registration = current(registry)
  await registration.setEnabled(feature, true)
  if (feature !== 'markdownShellNew') {
    const keys = feature === 'desktopNote' ? ['DesktopBackground\\Shell\\Arknote']
      : ['SystemFileAssociations\\.md\\shell\\Arkdown', 'SystemFileAssociations\\.txt\\shell\\Arkdown']
    for (const key of keys) registry.user.get(key.toLowerCase())!.values.Icon = str(oldExe)
    for (const key of keys) registry.user.get(`${key}\\command`.toLowerCase())!.values[''] = str(
      feature === 'desktopNote' ? '"C:\\Old\\Arkdown.exe" --new-note' : '"C:\\Old\\Arkdown.exe" "%1"')
  } else registry.user.get(commandKeys.markdownShellNew.toLowerCase())!.values[''] = str('"C:\\Old\\Arkdown.exe" "%1"')
  const before = structuredClone(registry.user)
  await expect(registration.setEnabled(feature, true)).rejects.toThrow()
  await expect(registration.setEnabled(feature, false)).rejects.toThrow()
  expect(registry.user).toEqual(before)
  await expect(registration.setEnabled(feature, true, async () => { throw new Error('save failed') }, { explicitEnable: true })).rejects.toThrow('save failed')
  expect(registry.user).toEqual(before)
  await registration.setEnabled(feature, true, undefined, { explicitEnable: true })
  expect((await registry.read(commandKeys[feature]))?.values[''].data).toContain(currentExe)
  await registration.setEnabled(feature, false)
  expect(await registry.read(commandKeys[feature])).toBeNull()
})

it.each(['documentOpenMenu', 'desktopNote'] as const)('adopts complete historical same-name old registration without journal: %s', async (feature) => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled(feature, true)
  registry.user.delete(`arkdown.shellintegration\\${feature.toLowerCase()}`)
  await current(registry).setEnabled(feature, true, undefined, { explicitEnable: true })
  expect((await registry.read(commandKeys[feature]))?.values[''].data).toContain(currentExe)
  await current(registry).setEnabled(feature, false)
  expect((await registry.read(commandKeys[feature]))?.values['']).toBeUndefined()
})

it('rebinds the complete historical Markdown fallback without a journal and keeps disable reversible', async () => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('markdownShellNew', true)
  registry.user.delete('arkdown.shellintegration\\markdownshellnew')
  const registration = current(registry)
  await registration.setEnabled('markdownShellNew', true, undefined, { explicitEnable: true })
  expect((await registry.read(commandKeys.markdownShellNew))?.values[''].data).toBe('"C:\\Current\\Arkdown.exe" "%1"')
  await registration.setEnabled('markdownShellNew', false)
  expect((await registry.read('.md'))?.values['']).toBeUndefined()
  expect((await registry.read('.md\\ShellNew'))?.values.NullFile.data).toBe('')
})

it.each(features)('restores old registration and journal when explicit enable persistence fails: %s', async (feature) => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled(feature, true)
  const before = structuredClone(registry.user)
  await expect(current(registry).setEnabled(feature, true, async () => { throw new Error('save failed') }, { explicitEnable: true }))
    .rejects.toThrow('save failed')
  expect(registry.user).toEqual(before)
})

it.each(features)('preserves another copy changing values after takeover: %s', async (feature) => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled(feature, true)
  const registration = current(registry)
  await registration.setEnabled(feature, true, undefined, { explicitEnable: true })
  registry.seed(commandKeys[feature], { '': 'foreign later command' }, true)
  await expect(registration.setEnabled(feature, false)).rejects.toThrow()
  expect((await registry.read(commandKeys[feature]))?.values[''].data).toBe('foreign later command')
})

it('explicit Markdown enable preserves a working foreign default and preexisting NullFile', async () => {
  const registry = new MemoryRegistry()
  registry.seed('.md', { '': 'Foreign.Markdown' }, true)
  registry.seed('Foreign.Markdown', { '': 'Foreign markdown' }, true)
  registry.seed('Foreign.Markdown\\shell\\open\\command', { '': '"C:\\Foreign.exe" "%1"' }, true)
  registry.seed('.md\\ShellNew', { NullFile: '' }, true)
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('markdownShellNew', true)
  const registration = current(registry)
  await registration.setEnabled('markdownShellNew', true, undefined, { explicitEnable: true })
  await registration.setEnabled('markdownShellNew', false)
  expect((await registry.read('.md'))?.values[''].data).toBe('Foreign.Markdown')
  expect((await registry.read('Foreign.Markdown\\shell\\open\\command'))?.values[''].data).toBe('"C:\\Foreign.exe" "%1"')
  expect((await registry.read('.md\\ShellNew'))?.values.NullFile.data).toBe('')
})

it('rolls back old description metadata as well as menu values after explicit default-confirmed takeover fails', async () => {
  const registry = new MemoryRegistry()
  registry.seed('.md', { '': 'Foreign.Markdown' }, true)
  registry.seed('Foreign.Markdown', {}, true)
  registry.seed('Foreign.Markdown\\shell\\open\\command', { '': '"C:\\Foreign.exe" "%1"' }, true)
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('markdownShellNew', true)
  registry.choices.set('.md', 'Arkdown.Document.Markdown')
  const before = structuredClone(registry.user)
  const registration = new ShellMenuRegistration({ executablePath: currentExe, registry, isCurrentMarkdownDefault: async () => true })
  await expect(registration.setEnabled('markdownShellNew', true, async () => { throw new Error('save failed') }, { explicitEnable: true })).rejects.toThrow('save failed')
  expect(registry.user).toEqual(before)
  expect(registry.choices.get('.md')).toBe('Arkdown.Document.Markdown')
})

it('service startup refuses the old copy but an explicit checked update takes it over', async () => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('documentOpenMenu', true)
  const settings = new SettingsCoordinator({ save: async () => {} }, {
    lastWorkspace: null, shellIntegration: { documentOpenMenu: true, markdownShellNew: false },
  })
  const service = new ShellIntegrationService(current(registry), settings)
  await expect(service.restoreEnabled()).rejects.toThrow()
  expect(service.get().documentOpenMenu).toBe(false)
  await service.update({ feature: 'documentOpenMenu', enabled: true })
  expect(service.get().documentOpenMenu).toBe(true)
  expect((await registry.read(commandKeys.documentOpenMenu))?.values[''].data).toBe('"C:\\Current\\Arkdown.exe" "%1"')
})

it('Arknote startup and unrelated settings save cannot take over; checkbox update can', async () => {
  const registry = new MemoryRegistry()
  await new DesktopContextMenuRegistration({ executablePath: oldExe, registry }).setEnabled(true)
  const before = structuredClone(registry.user)
  const state = await createArknoteContextMenuSettings(DEFAULT_ARKNOTE_SETTINGS,
    new DesktopContextMenuRegistration({ executablePath: currentExe, registry }),
    { save: async () => {} }, { sync: () => {} }, () => {})
  expect(state.get().registerDesktopContextMenu).toBe(false)
  await state.update((settings) => ({ ...settings, themeColor: '#2563EB' }))
  expect(registry.user).toEqual(before)
  await state.update((settings) => ({ ...settings, registerDesktopContextMenu: true }))
  expect(state.get().registerDesktopContextMenu).toBe(true)
  expect((await registry.read(commandKeys.desktopNote))?.values[''].data).toBe('"C:\\Current\\Arkdown.exe" --new-note')
})

it.each(['before', 'during'] as const)('refuses additional foreign verb handlers %s takeover', async (when) => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('documentOpenMenu', true)
  const command = commandKeys.documentOpenMenu.toLowerCase()
  const inject = () => { registry.user.get(command)!.values.DelegateExecute = str('{foreign}') }
  const before = structuredClone(registry.user)
  before.get(command)!.values.DelegateExecute = str('{foreign}')
  if (when === 'before') inject()
  else {
    const change = registry.change.bind(registry)
    registry.change = async (...args) => {
      const created = await change(...args)
      if (args[0].toLowerCase() === command && args[3]?.data === '"C:\\Current\\Arkdown.exe" "%1"') inject()
      return created
    }
  }
  let persisted = false
  await expect(current(registry).setEnabled('documentOpenMenu', true, async () => { persisted = true }, { explicitEnable: true })).rejects.toThrow()
  expect(persisted).toBe(false)
  expect(registry.user).toEqual(before)
})

it('retains CAS on observed takeover values and rolls earlier changes back', async () => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('documentOpenMenu', true)
  const command = commandKeys.documentOpenMenu.toLowerCase()
  const before = structuredClone(registry.user)
  before.get(command)!.values[''] = str('concurrent foreign')
  const change = registry.change.bind(registry)
  registry.change = async (...args) => {
    if (args[0].toLowerCase() === command && args[3]?.data === '"C:\\Current\\Arkdown.exe" "%1"') {
      registry.user.get(command)!.values[''] = str('concurrent foreign')
    }
    return change(...args)
  }
  await expect(current(registry).setEnabled('documentOpenMenu', true, undefined, { explicitEnable: true })).rejects.toThrow()
  expect(registry.user).toEqual(before)
})

it('does not authorize a new foreign baseline after historical verb recognition', async () => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('documentOpenMenu', true)
  const command = commandKeys.documentOpenMenu.toLowerCase()
  const read = registry.read.bind(registry)
  registry.read = async (key, scope = 'effective') => {
    if (key.toLowerCase() === command && scope === 'user') registry.user.get(command)!.values[''] = str('late foreign')
    return read(key, scope)
  }
  await expect(current(registry).setEnabled('documentOpenMenu', true, undefined, { explicitEnable: true })).rejects.toThrow()
  expect((await read(command))?.values[''].data).toBe('late foreign')
})

it('takes over fixed document verbs while retaining historical extra extensions without cleanup', async () => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('documentOpenMenu', true)
  const ledger = registry.user.get('arkdown.shellintegration\\documentopenmenu')!
  const ownership = JSON.parse(ledger.values.Ownership.data as string)
  const key = 'SystemFileAssociations\\.docx\\shell\\Arkdown'
  registry.seed(key, { '': 'legacy title', Foreign: 'preserve' }, true)
  registry.seed(`${key}\\command`, { '': 'legacy command' }, true)
  ownership.values.push({ key, name: '', value: str('legacy title') })
  ownership.createdKeys.push(key)
  ledger.values.Ownership = str(JSON.stringify(ownership))
  const before = await registry.read(key)
  const cleaned: string[] = []
  const clean = registry.removeEmpty.bind(registry)
  registry.removeEmpty = async (key) => { cleaned.push(key); await clean(key) }
  const registration = current(registry)
  await registration.setEnabled('documentOpenMenu', true, undefined, { explicitEnable: true })
  await registration.setEnabled('documentOpenMenu', false)
  expect(await registry.read(key)).toEqual(before)
  expect((await registry.read(`${key}\\command`))?.values[''].data).toBe('legacy command')
  expect(cleaned.some((key) => key.includes('.docx'))).toBe(false)
})

it.each(['arbitrary created key', 'malformed JSON'] as const)('rejects an unsafe old journal without takeover writes: %s', async (scenario) => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('documentOpenMenu', true)
  const ledger = registry.user.get('arkdown.shellintegration\\documentopenmenu')!
  const ownership = JSON.parse(ledger.values.Ownership.data as string)
  ownership.createdKeys.push('Unrelated\\PrivateData')
  ledger.values.Ownership = str(scenario === 'malformed JSON' ? '{broken' : JSON.stringify(ownership))
  const before = structuredClone(registry.user)
  await expect(current(registry).setEnabled('documentOpenMenu', true, undefined, { explicitEnable: true })).rejects.toThrow()
  expect(registry.user).toEqual(before)
})

it('preserves old Markdown fallback if a foreign program has replaced its command', async () => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('markdownShellNew', true)
  registry.seed(commandKeys.markdownShellNew, { '': '"C:\\Foreign.exe" "%1"' }, true)
  const before = structuredClone(registry.user)
  await expect(current(registry).setEnabled('markdownShellNew', true, undefined, { explicitEnable: true })).rejects.toThrow()
  expect(registry.user).toEqual(before)
})

it('refuses rebinding a Markdown fallback with an external open handler', async () => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('markdownShellNew', true)
  registry.user.get(commandKeys.markdownShellNew.toLowerCase())!.values.DelegateExecute = str('{foreign}')
  const before = structuredClone(registry.user)
  await expect(current(registry).setEnabled('markdownShellNew', true, undefined, { explicitEnable: true })).rejects.toThrow()
  expect(registry.user).toEqual(before)
})

it.each(['registry failure', 'foreign creation handler'] as const)('preserves old state on takeover %s', async (scenario) => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: oldExe, registry }).setEnabled('markdownShellNew', true)
  if (scenario === 'registry failure') registry.failAt = registry.writes + 2
  else registry.user.get('.md\\shellnew')!.values.Handler = str('{foreign}')
  const before = structuredClone(registry.user)
  await expect(current(registry).setEnabled('markdownShellNew', true, undefined, { explicitEnable: true })).rejects.toThrow()
  expect(registry.user).toEqual(before)
})
