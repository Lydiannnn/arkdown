import { expect, it, vi } from 'vitest'
import { ShellMenuRegistration } from '../../src/main/shell-integration/registration'
import { MemoryRegistry } from './shell-registry-fake'
import type { RegistryValue } from '../../src/main/shell-integration/windows-registry'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { ShellIntegrationService } from '../../src/main/shell-integration/service'

const exe = 'C:\\中文 Apps\\Arkdown.exe'
const str = (data: string): RegistryValue => ({ kind: 'String', data })

it.each([true, false])('adds the icon during an explicit pre-brand fallback takeover (journal: %s)', async (hasJournal) => {
  const registry = new MemoryRegistry()
  await new ShellMenuRegistration({ executablePath: 'C:\\Old\\Arkdown.exe', registry }).setEnabled('markdownShellNew', true)
  registry.user.delete('arkdown.markdown\\defaulticon')
  const journalKey = 'arkdown.shellintegration\\markdownshellnew'
  if (hasJournal) {
    const journal = registry.user.get(journalKey)!
    const owned = JSON.parse(journal.values.Ownership.data as string)
    owned.values = owned.values.filter((entry: { key: string }) => !entry.key.endsWith('DefaultIcon'))
    owned.createdKeys = owned.createdKeys.filter((key: string) => !key.endsWith('DefaultIcon'))
    journal.values.Ownership = str(JSON.stringify(owned))
  } else registry.user.delete(journalKey)
  const before = structuredClone(registry.user)
  const current = new ShellMenuRegistration({ executablePath: exe, registry })
  await expect(current.setEnabled('markdownShellNew', true, async () => { throw new Error('save failed') }, { explicitEnable: true })).rejects.toThrow('save failed')
  expect(registry.user).toEqual(before)
  await current.setEnabled('markdownShellNew', true, undefined, { explicitEnable: true })
  expect((await registry.read('Arkdown.Markdown\\DefaultIcon'))?.values[''].data).toContain('C:\\中文 Apps\\resources\\branding\\ark-md.ico')
})

it.each(['success', 'save failure', 'foreign icon'])('upgrades the owned pre-brand ShellNew fallback: %s', async (scenario) => {
  const registry = new MemoryRegistry()
  const registration = new ShellMenuRegistration({ executablePath: exe, registry })
  await registration.setEnabled('markdownShellNew', true)
  const iconKey = 'arkdown.markdown\\defaulticon'
  registry.user.delete(iconKey)
  const journal = registry.user.get('arkdown.shellintegration\\markdownshellnew')!
  const owned = JSON.parse(journal.values.Ownership.data as string)
  owned.values = owned.values.filter((entry: { key: string }) => entry.key.toLowerCase() !== iconKey)
  owned.createdKeys = owned.createdKeys.filter((key: string) => key.toLowerCase() !== iconKey)
  journal.values.Ownership = str(JSON.stringify(owned))
  if (scenario === 'foreign icon') registry.seed('Arkdown.Markdown\\DefaultIcon', { '': 'C:\\Foreign\\custom.ico,0' }, true)
  const before = structuredClone(registry.user)
  if (scenario !== 'success') {
    await expect(registration.setEnabled('markdownShellNew', true, async () => {
      if (scenario === 'save failure') throw new Error('save failed')
    })).rejects.toThrow()
    expect(registry.user).toEqual(before)
    return
  }
  await registration.setEnabled('markdownShellNew', true)
  expect((await registry.read(iconKey))?.values[''].data).toContain('ark-md.ico')
  expect(registry.choices.size).toBe(0)
  await registration.setEnabled('markdownShellNew', false)
  expect(await registry.read(iconKey)).toBeNull()
})

it.each(['clean', 'foreign', 'concurrent foreign', 'save failure'])('narrows the legacy Open journal atomically: %s', async (scenario) => {
  const { registry, registration } = fixture()
  await registration.setEnabled('documentOpenMenu', true)
  const key = 'SystemFileAssociations\\.docx\\shell\\Arkdown'
  const extra = [{ key, name: '', value: str('使用 Arkdown 打开') }, { key, name: 'Icon', value: str(exe) },
    { key: `${key}\\command`, name: '', value: str(`"${exe}" "%1"`) }]
  const ledger = registry.user.get('arkdown.shellintegration\\documentopenmenu')!
  const ownership = JSON.parse(ledger.values.Ownership.data as string)
  for (const entry of extra) ownership.createdKeys.push(...await registry.change(entry.key, entry.name, null, entry.value))
  ownership.values.push(...extra)
  ledger.values.Ownership = str(JSON.stringify(ownership))
  if (scenario === 'foreign') registry.user.get(key.toLowerCase())!.values.Foreign = str('preserve')
  const before = structuredClone(registry.user)
  if (scenario === 'concurrent foreign') {
    const change = registry.change.bind(registry)
    let injected = false
    registry.change = async (...args) => {
      const created = await change(...args)
      if (!injected && args[0] === key && args[3] === null) {
        injected = true
        registry.user.get(key.toLowerCase())!.values.Foreign = str('preserve')
      }
      return created
    }
    before.get(key.toLowerCase())!.values.Foreign = str('preserve')
  }
  const operation = registration.setEnabled('documentOpenMenu', true, async () => {
    if (scenario === 'save failure') throw new Error('save failed')
  })
  if (scenario === 'clean') {
    await operation
    expect(await registry.read(key)).toBeNull()
    expect(await registry.read('SystemFileAssociations\\.md\\shell\\Arkdown')).not.toBeNull()
  } else {
    await expect(operation).rejects.toThrow()
    expect(registry.user).toEqual(before)
  }
})

function fixture() {
  const registry = new MemoryRegistry()
  registry.seed('.txt', { '': 'txtfile' })
  registry.seed('txtfile\\shell\\open\\command', { '': '"C:\\Notepad3.exe" "%1"' })
  registry.seed('.txt\\ShellNew', { NullFile: '' })
  registry.seed('.md', { '': 'md_auto_file' })
  registry.seed('md_auto_file\\shell\\open\\command', { '': '"C:\\Notepad3.exe" "%1"' })
  const registration = new ShellMenuRegistration({ executablePath: exe, registry })
  return { registry, registration }
}

it('registers default menus on first startup while construction and reads stay side-effect free', async () => {
  const { registry, registration } = fixture()
  const settings = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null })
  const service = new ShellIntegrationService(registration, settings)
  expect(service.get()).toEqual({ documentOpenMenu: true, markdownShellNew: true })
  expect(registry.writes).toBe(0)
  await service.restoreEnabled()
  expect((await registry.read('SystemFileAssociations\\.md\\shell\\Arkdown\\command'))?.values['']).toEqual(str(`"${exe}" "%1"`))
  expect((await registry.read('.md\\ShellNew'))?.values.NullFile).toEqual(str(''))
})

it('leaves explicitly disabled menus unregistered on startup', async () => {
  const { registry, registration } = fixture()
  const settings = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null, shellIntegration: { documentOpenMenu: false, markdownShellNew: false } })
  await new ShellIntegrationService(registration, settings).restoreEnabled()
  expect(registry.writes).toBe(0)
})

it('registers supported document verbs from the main executable and disables idempotently', async () => {
  const { registry, registration } = fixture()
  await registration.setEnabled('documentOpenMenu', true)
  expect((await registry.read('SystemFileAssociations\\.md\\shell\\Arkdown\\command'))?.values['']).toEqual(str(`"${exe}" "%1"`))
  expect(await registry.read('SystemFileAssociations\\.docx\\shell\\Arkdown\\command')).toBeNull()
  expect(await registry.read('SystemFileAssociations\\.png')).toBeNull()
  expect((await registry.read('.txt'))?.values['']).toEqual(str('txtfile'))
  await registration.setEnabled('documentOpenMenu', false)
  await registration.setEnabled('documentOpenMenu', false)
  expect([...registry.user.keys()]).toEqual([])
})

it('exposes failed startup registration as unchecked and retries the requested true', async () => {
  const { registry, registration } = fixture()
  const settings = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null })
  const service = new ShellIntegrationService(registration, settings)
  registry.failAt = 1
  await expect(service.restoreEnabled()).rejects.toThrow()
  expect(service.get()).toEqual({ documentOpenMenu: false, markdownShellNew: true })
  registry.failAt = -1
  await service.update({ feature: 'documentOpenMenu', enabled: true })
  expect(service.get().documentOpenMenu).toBe(true)
})

it('rejects third-party command, handlers and unknown strategies without mutation', async () => {
  for (const values of [{ Command: 'foreign' }, { Handler: '{foreign}' }, { FileName: 'template.md' }, { UnknownStrategy: '' }] as Record<string, string>[]) {
    const { registry, registration } = fixture()
    registry.seed('.md\\ShellNew', { NullFile: '', ...values })
    await expect(registration.setEnabled('markdownShellNew', true)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
    expect(registry.writes).toBe(0)
  }
})

it('preserves later foreign edits and keeps disable uncommitted', async () => {
  const { registry, registration } = fixture()
  await registration.setEnabled('markdownShellNew', true)
  registry.seed('.md\\ShellNew', { NullFile: 'later owner' }, true)
  await expect(registration.setEnabled('markdownShellNew', false)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  expect((await registry.read('.md\\ShellNew'))?.values.NullFile).toEqual(str('later owner'))
})

it('rolls back only this operation on partial failure and JSON save failure', async () => {
  const { registry, registration } = fixture()
  registry.failAt = 2
  await expect(registration.setEnabled('documentOpenMenu', true)).rejects.toThrow()
  expect([...registry.user.keys()]).toEqual([])
  registry.failAt = -1
  const settings = new SettingsCoordinator({ save: async () => { throw new Error('JSON failed') } }, { lastWorkspace: null, shellIntegration: { documentOpenMenu: false, markdownShellNew: false } })
  const service = new ShellIntegrationService(registration, settings)
  await expect(service.update({ feature: 'markdownShellNew', enabled: true })).rejects.toThrow('JSON failed')
  expect(service.get().markdownShellNew).toBe(false)
  expect((await registry.read('.txt\\ShellNew'))?.values).toEqual({ NullFile: str('') })
  expect([...registry.user.keys()]).toEqual([])
})

it('preserves a usable MD type and open; only truly unassociated Markdown gets a reversible fallback', async () => {
  const { registry, registration } = fixture()
  await registration.setEnabled('markdownShellNew', true)
  expect((await registry.read('.md'))?.values['']).toEqual(str('md_auto_file'))
  expect((await registry.read('md_auto_file\\shell\\open\\command'))?.values['']).toEqual(str('"C:\\Notepad3.exe" "%1"'))
  expect((await registry.read('.md\\ShellNew'))?.values.NullFile).toEqual(str(''))
  await registration.setEnabled('markdownShellNew', false)
  registry.machine.delete('.md')
  await registration.setEnabled('markdownShellNew', true)
  expect((await registry.read('.md'))?.values['']).toEqual(str('Arkdown.Markdown'))
  await registration.setEnabled('markdownShellNew', false)
  expect(await registry.read('.md')).toBeNull()
  expect(await registry.read('Arkdown.Markdown')).toBeNull()
})

it('rejects broken Markdown selection rather than replacing it', async () => {
  const { registry, registration } = fixture()
  registry.seed('.md', { '': 'broken' })
  await expect(registration.setEnabled('markdownShellNew', true)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_UNSUPPORTED' })
  expect(registry.writes).toBe(0)
})

it('serializes native apply, JSON persistence and rollback across features', async () => {
  const { registry, registration } = fixture()
  let release!: () => void
  const saved = new Promise<void>((resolve) => { release = resolve })
  const first = registration.setEnabled('documentOpenMenu', true, () => saved)
  const second = registration.setEnabled('markdownShellNew', true)
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(await registry.read('.md\\ShellNew')).toBeNull()
  release()
  await Promise.all([first, second])
  expect((await registry.read('.md\\ShellNew'))?.values.NullFile).toEqual(str(''))
})

it('does not claim successful re-enable after a foreign creation handler was added', async () => {
  const { registry, registration } = fixture()
  await registration.setEnabled('markdownShellNew', true)
  registry.seed('.md\\ShellNew', { NullFile: '', Handler: '{foreign}' }, true)
  await expect(registration.setEnabled('markdownShellNew', true)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  expect((await registry.read('.md\\ShellNew'))?.values.Handler).toEqual(str('{foreign}'))
})

it('does not adopt an existing NullFile or claim it still works after its owner removes it', async () => {
  const { registry, registration } = fixture()
  registry.seed('.md\\ShellNew', { NullFile: '' }, true)
  await registration.setEnabled('markdownShellNew', true)
  registry.user.delete('.md\\shellnew')
  await expect(registration.setEnabled('markdownShellNew', true)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  await registration.setEnabled('markdownShellNew', false)
  expect(await registry.read('.md\\ShellNew')).toBeNull()
})

it('rejects a later foreign verb handler even when its original command still matches', async () => {
  const { registry, registration } = fixture()
  await registration.setEnabled('documentOpenMenu', true)
  registry.seed('SystemFileAssociations\\.md\\shell\\Arkdown\\command', { '': `"${exe}" "%1"`, DelegateExecute: '{foreign}' }, true)
  await expect(registration.setEnabled('documentOpenMenu', true)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  expect((await registry.read('SystemFileAssociations\\.md\\shell\\Arkdown\\command'))?.values.DelegateExecute).toEqual(str('{foreign}'))
})

it.each(['disable', 'repair', 'new registration', 'new journal', 'delete journal'] as const)(
  'preserves foreign values inserted after preflight during %s and never persists the change', async (scenario) => {
    const { registry, registration } = fixture()
    const existing = scenario === 'disable' || scenario === 'repair' || scenario === 'delete journal'
    if (existing) await registration.setEnabled('markdownShellNew', true)
    if (scenario === 'repair') registry.user.delete('.md\\shellnew')
    const journal = scenario === 'new journal' || scenario === 'delete journal'
    const target = journal ? 'Arkdown.ShellIntegration\\markdownShellNew' : '.md\\ShellNew'
    const name = journal ? 'Ownership' : 'NullFile'
    const injectAt = scenario === 'new registration' ? 1 : 2
    const originalRead = registry.read.bind(registry)
    let reads = 0
    registry.read = async (key, scope = 'effective') => {
      if (key.toLowerCase() === target.toLowerCase() && scope === 'user' && ++reads === injectAt) {
        registry.seed(target, { [name]: 'foreign after preflight' }, true)
      }
      return originalRead(key, scope)
    }
    const persist = vi.fn(async () => {})
    await expect(registration.setEnabled('markdownShellNew', scenario !== 'disable' && scenario !== 'delete journal', persist))
      .rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
    expect(persist).not.toHaveBeenCalled()
    expect((await originalRead(target, 'user'))?.values[name]).toEqual(str('foreign after preflight'))
  },
)

it('repairs later enabled features after an earlier startup conflict and reports the failure afterward', async () => {
  const { registry, registration } = fixture()
  await registration.setEnabled('documentOpenMenu', true)
  await registration.setEnabled('markdownShellNew', true)
  registry.seed('SystemFileAssociations\\.md\\shell\\Arkdown\\command', { '': 'foreign command' }, true)
  registry.user.delete('.md\\shellnew')
  const settings = new SettingsCoordinator({ save: async () => {} }, {
    lastWorkspace: null, shellIntegration: { documentOpenMenu: true, markdownShellNew: true },
  })
  const service = new ShellIntegrationService(registration, settings)
  await expect(service.restoreEnabled()).rejects.toThrow()
  expect((await registry.read('.md\\ShellNew'))?.values.NullFile).toEqual(str(''))
  expect((await registry.read('SystemFileAssociations\\.md\\shell\\Arkdown\\command'))?.values['']).toEqual(str('foreign command'))
})
