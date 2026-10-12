import { expect, it, vi } from 'vitest'
import { DefaultApplicationsService, enableDefaultApplications, registerDefaultApplications, refreshOwnedDefaultApplications, unregisterDefaultApplications } from '../../src/main/default-applications/service'
import { MemoryRegistry } from './shell-registry-fake'
import { DefaultApplicationsStartup } from '../../src/main/default-applications/startup'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'

const exe = 'C:\\Apps\\Arkdown.exe'

it.each([
  ['CurVer', '', 'Foreign.Editor'],
  ['CLSID', '', '{foreign-handler}'],
  ['shell', '', 'edit'],
  ['shell\\open', 'DelegateExecute', '{foreign-handler}'],
  ['shell\\open\\ddeexec', '', 'foreign-command'],
])('preflights both formats before detaching a redirected handler: %s', async (suffix, name, value) => {
  const registry = new MemoryRegistry()
  await enableDefaultApplications(registry, exe)
  registry.choices.set('.md', 'Arkdown.Document.Markdown')
  registry.choices.set('.txt', 'Arkdown.Document.Text')
  registry.seed(`Arkdown.Document.Text\\${suffix}`, { [name]: value }, true)
  const before = structuredClone(registry.user), choices = structuredClone(registry.choices)
  await expect(unregisterDefaultApplications(registry, exe)).rejects.toThrow()
  expect(registry.user).toEqual(before)
  expect(registry.choices).toEqual(choices)
})

it('validates a damaged txt backup before releasing the md UserChoice', async () => {
  const registry = new MemoryRegistry()
  await enableDefaultApplications(registry, exe)
  registry.choices.set('.md', 'Arkdown.Document.Markdown')
  registry.choices.set('.txt', 'Arkdown.Document.Text')
  registry.seed('@DefaultApplicationsState', { '.txt': '{damaged' }, true)
  const before = structuredClone(registry.user), choices = structuredClone(registry.choices)
  await expect(unregisterDefaultApplications(registry, exe)).rejects.toThrow()
  expect(registry.user).toEqual(before)
  expect(registry.choices).toEqual(choices)
})

it.each([true, false])('startup directly applies the affirmative answer and remembers either answer: %s', async accepted => {
  const settings = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null, defaultApplicationsPrompt: { starts: 1, handled: false } })
  const setEnabled = vi.fn(async () => ({ markdown: true, text: true }))
  const openSettings = vi.fn()
  const service = { getStatus: async () => ({ markdown: false, text: false }), setEnabled, openSettings }
  await new DefaultApplicationsStartup(settings, service, '1.0.2').onReady(async () => accepted)
  expect(setEnabled).toHaveBeenCalledTimes(accepted ? 1 : 0)
  expect(openSettings).not.toHaveBeenCalled()
  expect(settings.get().defaultApplicationsPrompt?.handled).toBe(true)
})

it('reports an incomplete association once without claiming success or repeatedly prompting', async () => {
  const settings = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null, defaultApplicationsPrompt: { starts: 1, handled: false } })
  const service = { getStatus: async () => ({ markdown: false, text: false }), setEnabled: async () => ({ markdown: true, text: false }) }
  const prompt = vi.fn(async () => true)
  await expect(new DefaultApplicationsStartup(settings, service, '1.0.2').onReady(prompt)).rejects.toMatchObject({ code: 'DEFAULT_APPLICATIONS_NOT_APPLIED' })
  await new DefaultApplicationsStartup(settings, service, '1.0.2').onReady(prompt)
  expect(prompt).toHaveBeenCalledOnce()
})

it('can enable, disable and re-enable unclaimed extensions while restoring their previous fallback', async () => {
  const registry = new MemoryRegistry()
  registry.seed('.txt', { '': 'txtfile' }, true)
  await enableDefaultApplications(registry, exe)
  expect((await registry.read('.txt'))?.values[''].data).toBe('Arkdown.Document.Text')
  expect((await registry.read('.md'))?.values[''].data).toBe('Arkdown.Document.Markdown')
  await unregisterDefaultApplications(registry, exe)
  expect((await registry.read('.txt'))?.values[''].data).toBe('txtfile')
  expect((await registry.read('.md'))?.values['']).toBeUndefined()
  await enableDefaultApplications(registry, exe)
  expect((await registry.read('.txt'))?.values[''].data).toBe('Arkdown.Document.Text')
})

it('preserves explicit defaults and does not overwrite a later choice when disabled', async () => {
  const registry = new MemoryRegistry()
  registry.choices.set('.txt', 'Notepad')
  registry.seed('.txt', { '': 'txtfile' }, true)
  await enableDefaultApplications(registry, exe)
  expect((await registry.read('.txt'))?.values[''].data).toBe('txtfile')
  expect(registry.choices.get('.txt')).toBe('Notepad')
  registry.seed('.md', { '': 'OtherEditor' }, true)
  await unregisterDefaultApplications(registry, exe)
  expect((await registry.read('.md'))?.values[''].data).toBe('OtherEditor')
  expect(registry.choices.get('.txt')).toBe('Notepad')
})

it('registers then returns effective status without opening Windows Settings', async () => {
  let registered = false
  const open = vi.fn(async () => {})
  const service = new DefaultApplicationsService({
    query: async () => ({ markdown: registered, text: registered }),
    register: async () => { registered = true }, open,
  })
  expect(await service.setEnabled(true)).toEqual({ markdown: true, text: true })
  expect(open).not.toHaveBeenCalled()
})

it('returns partial effective status instead of assuming registration sets both defaults', async () => {
  const open = vi.fn(async () => {})
  const service = new DefaultApplicationsService({
    query: async () => ({ markdown: true, text: false }), register: async () => {}, open,
  })
  expect(await service.setEnabled(true)).toEqual({ markdown: true, text: false })
  expect(open).not.toHaveBeenCalled()
})

it('disables through the unregister operation and queries the resulting state', async () => {
  let registered = true
  const open = vi.fn(async () => {})
  const service = new DefaultApplicationsService({
    query: async () => ({ markdown: registered, text: registered }), register: async () => {},
    unregister: async () => { registered = false }, open,
  })
  expect(await service.setEnabled(false)).toEqual({ markdown: false, text: false })
  expect(open).not.toHaveBeenCalled()
})

it('removes only current-copy md/txt associations and does not re-enable them during startup refresh', async () => {
  const registry = new MemoryRegistry()
  await registerDefaultApplications(registry, exe)
  registry.choices.set('.md', 'Arkdown.Document.Markdown')
  registry.choices.set('.txt', 'Notepad')
  registry.choices.set('.text', 'Arkdown.Document.Text')
  registry.seed('.md', { '': 'Arkdown.Document.Markdown', ContentType: 'text/markdown' }, true)
  registry.seed('.txt', { '': 'txtfile' }, true)
  registry.seed('.md\\OpenWithProgids', { 'Arkdown.Document.Markdown': '', OtherEditor: '' }, true)
  const machine = structuredClone(registry.machine)
  await unregisterDefaultApplications(registry, exe)
  expect(registry.choices.get('.md')).toBeUndefined()
  expect(registry.choices.get('.txt')).toBe('Notepad')
  expect(registry.choices.get('.text')).toBe('Arkdown.Document.Text')
  expect((await registry.read('.md'))?.values).toEqual({ ContentType: { kind: 'String', data: 'text/markdown' } })
  expect((await registry.read('.txt'))?.values[''].data).toBe('txtfile')
  expect((await registry.read('.md\\OpenWithProgids'))?.values).toEqual({ OtherEditor: { kind: 'String', data: '' } })
  expect((await registry.read('@Capabilities\\FileAssociations'))?.values).not.toHaveProperty('.md')
  expect((await registry.read('@Capabilities\\FileAssociations'))?.values).not.toHaveProperty('.txt')
  expect((await registry.read('@Capabilities\\FileAssociations'))?.values['.docx'].data).toBe('Arkdown.Document.Docx')
  // The shared Text handler must remain usable by .text and existing references.
  expect((await registry.read('Arkdown.Document.Text\\shell\\open\\command'))?.values[''].data).toBe(`"${exe}" "%1"`)
  const beforeRefresh = structuredClone(registry.user)
  await refreshOwnedDefaultApplications(registry, exe)
  expect(registry.user).toEqual(beforeRefresh)
  expect(registry.machine).toEqual(machine)
  await registerDefaultApplications(registry, exe, undefined, { explicitEnable: true })
  expect((await registry.read('@Capabilities\\FileAssociations'))?.values['.md'].data).toBe('Arkdown.Document.Markdown')
})

it('does not unregister another installed copy or foreign handlers', async () => {
  const registry = new MemoryRegistry()
  await registerDefaultApplications(registry, exe)
  registry.choices.set('.md', 'Arkdown.Document.Markdown')
  const before = structuredClone(registry.user)
  await unregisterDefaultApplications(registry, 'C:\\Other\\Arkdown.exe')
  expect(registry.user).toEqual(before)
  expect(registry.choices.get('.md')).toBe('Arkdown.Document.Markdown')
})

it('retains valid handlers and reports failure when Windows refuses to release an owned default', async () => {
  const registry = new MemoryRegistry()
  await registerDefaultApplications(registry, exe)
  registry.choices.set('.md', 'Arkdown.Document.Markdown')
  registry.releaseOwnedDefault = async () => { throw new Error('protected association') }
  const before = structuredClone(registry.user)
  await expect(unregisterDefaultApplications(registry, exe)).rejects.toThrow('protected association')
  expect(registry.user).toEqual(before)
  expect(registry.choices.get('.md')).toBe('Arkdown.Document.Markdown')
})
