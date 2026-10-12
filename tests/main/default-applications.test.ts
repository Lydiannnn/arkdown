import { expect, it, vi } from 'vitest'
import { DefaultApplicationsService, defaultApplicationsSettingsUri, registerDefaultApplications, refreshOwnedDefaultApplications } from '../../src/main/default-applications/service'
import { DefaultApplicationsStartup } from '../../src/main/default-applications/startup'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { MemoryRegistry } from './shell-registry-fake'
const exe = 'C:\\中文 Apps\\Arkdown.exe'

it.each([
  ['10.0.19045', 'ms-settings:defaultapps'],
  ['10.0.22000', 'ms-settings:defaultapps'],
  ['10.0.22621', 'ms-settings:defaultapps'],
  ['10.0.22631', 'ms-settings:defaultapps?registeredAppUser=Arkdown'],
  ['10.0.26100', 'ms-settings:defaultapps?registeredAppUser=Arkdown'],
])('uses the application page only on Windows builds known to support it: %s', (version, uri) => {
  expect(defaultApplicationsSettingsUri(version)).toBe(uri)
})

it('registers four document icon groups without choosing defaults and preserves conflicts', async () => {
  const registry = new MemoryRegistry()
  await registerDefaultApplications(registry, exe)
  expect((await registry.read('@Capabilities\\FileAssociations'))?.values).toMatchObject({
    '.md': { kind: 'String', data: 'Arkdown.Document.Markdown' }, '.txt': { kind: 'String', data: 'Arkdown.Document.Text' },
    '.docx': { kind: 'String', data: 'Arkdown.Document.Docx' }, '.qmd': { kind: 'String', data: 'Arkdown.Document.OtherMarkdown' },
  })
  expect((await registry.read('@Capabilities\\FileAssociations'))?.values).not.toHaveProperty('.pdf')
  for (const [id, icon] of [['Markdown', 'md'], ['Text', 'txt'], ['Docx', 'docx'], ['OtherMarkdown', 'markdown-other']]) {
    expect((await registry.read(`Arkdown.Document.${id}\\DefaultIcon`))?.values[''].data).toBe(`"C:\\中文 Apps\\resources\\branding\\ark-${icon}.ico",0`)
  }
  expect(await registry.read('.md')).toBeNull()
  expect(registry.choices.size).toBe(0)
  const before = structuredClone(registry.user), writes = registry.writes
  await registerDefaultApplications(registry, exe)
  expect(registry.writes).toBe(writes)
  await expect(registerDefaultApplications(registry, 'C:\\Other\\Arkdown.exe')).rejects.toThrow()
  expect(registry.user).toEqual(before)
})

it('refreshes only current-copy owned registrations and leaves UserChoice and extension defaults intact', async () => {
  const registry = new MemoryRegistry()
  await refreshOwnedDefaultApplications(registry, exe)
  expect(registry.writes).toBe(0)
  await registerDefaultApplications(registry, exe)
  registry.seed('Arkdown.Document.Markdown\\DefaultIcon', { '': `"${exe}",0` }, true)
  registry.seed('.docx', { '': 'Word.Document.12' }, true)
  registry.choices.set('.md', 'Arkdown.Document.Markdown')
  registry.choices.set('.txt', 'Notepad')
  const choices = structuredClone(registry.choices)
  await refreshOwnedDefaultApplications(registry, 'C:\\NewCopy\\Arkdown.exe')
  expect((await registry.read('Arkdown.Document.Markdown\\DefaultIcon'))?.values[''].data).toBe(`"${exe}",0`)
  await refreshOwnedDefaultApplications(registry, exe)
  expect((await registry.read('Arkdown.Document.Markdown\\DefaultIcon'))?.values[''].data).toContain('ark-md.ico')
  expect(registry.choices).toEqual(choices)
  expect((await registry.read('.docx'))?.values[''].data).toBe('Word.Document.12')
})

it('restores the previous icon if a later upgrade write fails', async () => {
  const registry = new MemoryRegistry()
  await registerDefaultApplications(registry, exe)
  registry.seed('Arkdown.Document.Markdown\\DefaultIcon', { '': `"${exe}",0` }, true)
  registry.seed('Arkdown.Document.Text\\DefaultIcon', { '': `"${exe}",0` }, true)
  const before = structuredClone(registry.user)
  registry.failAt = registry.writes + 2
  await expect(registerDefaultApplications(registry, exe)).rejects.toThrow('write failed')
  expect(registry.user).toEqual(before)
})

it('rejects a foreign icon even inside an otherwise owned candidate', async () => {
  const registry = new MemoryRegistry()
  await registerDefaultApplications(registry, exe)
  registry.seed('Arkdown.Document.Markdown\\DefaultIcon', { '': 'C:\\Other\\custom.ico,0' }, true)
  const before = structuredClone(registry.user)
  await expect(registerDefaultApplications(registry, exe)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  expect(registry.user).toEqual(before)
})
it('rolls back candidate registration after partial failure', async () => {
  const registry = new MemoryRegistry()
  registry.failAt = 5
  await expect(registerDefaultApplications(registry, exe)).rejects.toThrow()
  expect(registry.user.size).toBe(0)
})
it('rolls back new candidate values if a foreign handler appears during registration', async () => {
  const registry = new MemoryRegistry()
  const change = registry.change.bind(registry)
  let injected = false
  registry.change = async (...args) => {
    const created = await change(...args)
    if (!injected) {
      injected = true
      registry.seed('Arkdown.Document.Markdown\\shell\\open\\command', { DelegateExecute: '{foreign}' }, true)
    }
    return created
  }
  await expect(registerDefaultApplications(registry, exe)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  expect((await registry.read('Arkdown.Document.Markdown\\shell\\open\\command'))?.values).toEqual({ DelegateExecute: { kind: 'String', data: '{foreign}' } })
  expect(await registry.read('@RegisteredApplications')).toBeNull()
})
it('does not adopt a partial foreign candidate with only a matching description', async () => {
  const registry = new MemoryRegistry()
  registry.seed('Arkdown.Document.Markdown', { '': 'Markdown 文档' }, true)
  const before = structuredClone(registry.user)
  await expect(registerDefaultApplications(registry, exe)).rejects.toThrow()
  expect(registry.user).toEqual(before)
})
it('queries actual executables and never reports Settings launch as defaults success', async () => {
  const query = vi.fn(async () => ({ markdown: false, text: true }))
  const register = vi.fn(async () => {}), open = vi.fn(async () => {})
  const service = new DefaultApplicationsService({ query, register, open })
  await expect(service.getStatus()).resolves.toEqual({ markdown: false, text: true })
  await service.openSettings()
  expect(register).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce()
  await expect(service.getStatus()).resolves.toEqual({ markdown: false, text: true })
  query.mockRejectedValueOnce(new Error('query failed'))
  await expect(service.getStatus()).rejects.toThrow('query failed')
})
it('drains outstanding status queries through their cleanup, including failures', async () => {
  let fail!: (error: Error) => void
  const query = new Promise<never>((_resolve, reject) => { fail = reject })
  const service = new DefaultApplicationsService({ query: () => query, register: async () => {}, open: async () => {} })
  const pending = service.getStatus()
  const rejected = expect(pending).rejects.toThrow('query failed')
  let drained = false
  const cleanup = service.drain().then(() => { drained = true })
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(drained).toBe(false)
  fail(new Error('query failed'))
  await rejected
  await cleanup
  expect(drained).toBe(true)
})
it.each(['yes', 'later', 'already'] as const)('prompts only once on second normal start: %s', async (answer) => {
  const settings = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null })
  const prompt = vi.fn(async () => answer === 'yes'), setEnabled = vi.fn(async () => ({ markdown: true, text: true }))
  const service = { getStatus: async () => ({ markdown: answer === 'already', text: answer === 'already' }), setEnabled }
  const first = new DefaultApplicationsStartup(settings, service, '1.0.2')
  await first.onReady(prompt); await first.onReady(prompt)
  expect(prompt).not.toHaveBeenCalled()
  await new DefaultApplicationsStartup(settings, service, '1.0.2').onReady(prompt)
  await new DefaultApplicationsStartup(settings, service, '1.0.2').onReady(prompt)
  expect(prompt).toHaveBeenCalledTimes(answer === 'already' ? 0 : 1)
  expect(setEnabled).toHaveBeenCalledTimes(answer === 'yes' ? 1 : 0)
  expect(settings.get().defaultApplicationsPrompt).toEqual({ starts: 2, handled: true, version: '1.0.2' })
})
it('does not prompt or claim progress when atomic startup persistence fails', async () => {
  const settings = new SettingsCoordinator({ save: async () => { throw new Error('save failed') } }, { lastWorkspace: null })
  const prompt = vi.fn(async () => true)
  const startup = new DefaultApplicationsStartup(settings, { getStatus: async () => ({ markdown: false, text: false }), setEnabled: vi.fn() }, '1.0.2')
  await expect(startup.onReady(prompt)).rejects.toThrow('save failed')
  expect(prompt).not.toHaveBeenCalled()
  expect(settings.get().defaultApplicationsPrompt).toBeUndefined()
})
