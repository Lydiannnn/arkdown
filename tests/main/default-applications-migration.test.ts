import { expect, it, vi } from 'vitest'
import { registerDefaultApplications, DefaultApplicationsService } from '../../src/main/default-applications/service'
import { DefaultApplicationsStartup } from '../../src/main/default-applications/startup'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { PublicError } from '../../src/shared/public-errors'
import { MemoryRegistry } from './shell-registry-fake'

const oldExe = 'C:\\旧版 Arkdown\\Arkdown.exe'
const exe = 'C:\\新版 Arkdown\\Arkdown.exe'
const explicit = { explicitEnable: true }

it('can register after uninstall retained only empty known keys', async () => {
  const registry = new MemoryRegistry()
  for (const id of ['Markdown', 'Text', 'Docx', 'OtherMarkdown']) {
    for (const suffix of ['', '\\shell', '\\shell\\open', '\\shell\\open\\command', '\\DefaultIcon']) {
      registry.seed(`Arkdown.Document.${id}${suffix}`, {}, true)
    }
  }
  registry.seed('@Capabilities', {}, true)
  registry.seed('@Capabilities\\FileAssociations', {}, true)
  await registerDefaultApplications(registry, exe, undefined, explicit)
  expect((await registry.read('Arkdown.Document.Markdown\\shell\\open\\command'))?.values[''].data).toBe(`"${exe}" "%1"`)
  expect((await registry.read('@Capabilities'))?.values.ApplicationIcon.data).toBe(`"${exe}",0`)
})

it('does not reclaim empty known keys with an unknown activation subtree', async () => {
  const registry = new MemoryRegistry()
  registry.seed('Arkdown.Document.Markdown\\shell\\open\\command', {}, true)
  registry.seed('Arkdown.Document.Markdown\\CurVer', {}, true)
  const before = structuredClone(registry.user)
  await expect(registerDefaultApplications(registry, exe, undefined, explicit)).rejects.toThrow()
  expect(registry.user).toEqual(before)
  expect(registry.writes).toBe(0)
})

function seedOldPair(registry: MemoryRegistry, user = true) {
  for (const [id, description] of [['Markdown', 'Markdown 文档'], ['Text', '文本文档']]) {
    registry.seed(`Arkdown.Document.${id}`, { '': description }, user)
    registry.seed(`Arkdown.Document.${id}\\DefaultIcon`, { '': `"${oldExe}",0` }, user)
    registry.seed(`Arkdown.Document.${id}\\shell\\open\\command`, { '': `"${oldExe}" "%1"` }, user)
  }
  registry.seed('@Capabilities', {
    ApplicationName: 'Arkdown', ApplicationDescription: 'Markdown 和文本文档编辑器', ApplicationIcon: `"${oldExe}",0`,
  }, true)
  registry.seed('@Capabilities\\FileAssociations', { '.md': 'Arkdown.Document.Markdown', '.txt': 'Arkdown.Document.Text' }, true)
  registry.seed('@RegisteredApplications', { Arkdown: 'Software\\Arkdown\\Capabilities', OtherApp: 'Software\\OtherApp\\Capabilities' }, true)
}

it.each([true, false])('explicitly migrates the original two-type registration without changing defaults (user scope: %s)', async user => {
  const registry = new MemoryRegistry()
  seedOldPair(registry, user)
  registry.seed('.txt', { '': 'txtfile' }, true)
  registry.seed('txtfile\\shell\\open\\command', { '': '"C:\\Windows\\notepad.exe" "%1"' }, true)
  registry.choices.set('.txt', 'Applications\\Notepad.exe')
  registry.choices.set('.md', 'md_auto_file')
  const machine = structuredClone(registry.machine), choices = structuredClone(registry.choices)
  await registerDefaultApplications(registry, exe, undefined, explicit)
  for (const id of ['Markdown', 'Text', 'Docx', 'OtherMarkdown']) {
    expect((await registry.read(`Arkdown.Document.${id}\\shell\\open\\command`))?.values[''].data).toBe(`"${exe}" "%1"`)
  }
  expect((await registry.read('@Capabilities'))?.values.ApplicationIcon.data).toBe(`"${exe}",0`)
  expect((await registry.read('@RegisteredApplications'))?.values.OtherApp.data).toBe('Software\\OtherApp\\Capabilities')
  expect((await registry.read('.txt'))?.values[''].data).toBe('txtfile')
  expect((await registry.read('txtfile\\shell\\open\\command'))?.values[''].data).toContain('notepad.exe')
  expect(registry.choices).toEqual(choices)
  expect(registry.machine).toEqual(machine)
})

it('migrates current-format branding icons and remains idempotent', async () => {
  const registry = new MemoryRegistry()
  await registerDefaultApplications(registry, oldExe)
  await registerDefaultApplications(registry, exe, undefined, explicit)
  expect((await registry.read('Arkdown.Document.Markdown\\DefaultIcon'))?.values[''].data).toBe('"C:\\新版 Arkdown\\resources\\branding\\ark-md.ico",0')
  const writes = registry.writes
  await registerDefaultApplications(registry, exe, undefined, explicit)
  expect(registry.writes).toBe(writes)
})

it.each(['foreign-command', 'foreign-icon', 'extra-handler', 'partial'])('does not adopt unrelated registration: %s', async variant => {
  const registry = new MemoryRegistry()
  seedOldPair(registry)
  const key = 'Arkdown.Document.Markdown'
  if (variant === 'foreign-command') registry.seed(`${key}\\shell\\open\\command`, { '': '"C:\\Other\\Other.exe" "%1"' }, true)
  if (variant === 'foreign-icon') registry.seed(`${key}\\DefaultIcon`, { '': '"C:\\Other\\custom.ico",0' }, true)
  if (variant === 'extra-handler') registry.seed(`${key}\\shell\\open\\command`, { '': `"${oldExe}" "%1"`, DelegateExecute: '{foreign}' }, true)
  if (variant === 'partial') registry.user.delete(`${key}\\shell\\open\\command`.toLowerCase())
  const before = structuredClone(registry.user)
  await expect(registerDefaultApplications(registry, exe, undefined, explicit)).rejects.toThrow()
  expect(registry.user).toEqual(before)
  expect(registry.writes).toBe(0)
})

it('restores old registration when migration fails partway', async () => {
  const registry = new MemoryRegistry()
  await registerDefaultApplications(registry, oldExe)
  const before = structuredClone(registry.user)
  registry.failAt = registry.writes + 4
  await expect(registerDefaultApplications(registry, exe, undefined, explicit)).rejects.toThrow('write failed')
  expect(registry.user).toEqual(before)
})

it('reports registration conflicts as default-app errors and does not open Settings on failure', async () => {
  const open = vi.fn(async () => {})
  const service = new DefaultApplicationsService({
    query: async () => ({ markdown: false, text: false }),
    register: async () => { throw new PublicError('SHELL_INTEGRATION_CONFLICT') }, open,
  })
  await expect(service.openSettings()).rejects.toMatchObject({ code: 'DEFAULT_APPLICATIONS_CONFLICT' })
  expect(open).not.toHaveBeenCalled()
})

it.each(['query', 'register'] as const)('retries the second-launch offer after %s failure', async step => {
  const settings = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null, defaultApplicationsPrompt: { starts: 1, handled: false } })
  const prompt = vi.fn(async () => true)
  const query = vi.fn(async () => ({ markdown: false, text: false }))
  const apply = vi.fn(async () => ({ markdown: true, text: true }))
  if (step === 'query') query.mockRejectedValueOnce(new Error('query failed'))
  else apply.mockRejectedValueOnce(new Error('register failed'))
  const service = { getStatus: query, setEnabled: apply }
  await expect(new DefaultApplicationsStartup(settings, service, '1.0.2').onReady(prompt)).rejects.toThrow()
  expect(settings.get().defaultApplicationsPrompt).toEqual({ starts: 2, handled: false, version: '1.0.2' })
  await new DefaultApplicationsStartup(settings, service, '1.0.2').onReady(prompt)
  expect(settings.get().defaultApplicationsPrompt).toEqual({ starts: 2, handled: true, version: '1.0.2' })
  expect(apply).toHaveBeenCalledTimes(step === 'query' ? 1 : 2)
})
