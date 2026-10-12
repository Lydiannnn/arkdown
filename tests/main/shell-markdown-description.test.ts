import { expect, it, vi } from 'vitest'
import { ShellMenuRegistration } from '../../src/main/shell-integration/registration'
import { ShellIntegrationService } from '../../src/main/shell-integration/service'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { MemoryRegistry } from './shell-registry-fake'
import { registerDefaultApplications } from '../../src/main/default-applications/service'
import type { RegistryValue } from '../../src/main/shell-integration/windows-registry'

const exe = 'C:\\Apps\\Arkdown.exe'
const type = 'md_auto_file'
const open = '"C:\\Notepad3.exe" "%1"'
const description = { kind: 'String', data: 'Markdown 文档' }
const journal = 'Arkdown.ShellIntegration\\markdownShellNew'
const existingDescriptions: Record<string, string>[] = [
  { '': 'Existing Markdown' },
  { FriendlyTypeName: '@C:\\Other\\resources.dll,-10' },
  { '': 'Existing Markdown', FriendlyTypeName: '@C:\\Other\\resources.dll,-10' },
]
const invalidDescriptions: Record<string, RegistryValue>[] = [
  { '': { kind: 'String', data: '' } },
  { '': { kind: 'DWord', data: 7 } },
  { FriendlyTypeName: { kind: 'String', data: '' } },
  { FriendlyTypeName: { kind: 'String', data: 'not an indirect resource' } },
]
function fixture() {
  const registry = new MemoryRegistry()
  registry.seed('.md', { '': type, 'Content Type': 'text/markdown' }, true)
  registry.seed(type, { CustomMetadata: 'preserve' }, true)
  registry.seed(`${type}\\shell\\open\\command`, { '': open }, true)
  registry.choices.set('.md', type)
  return { registry, registration: new ShellMenuRegistration({ executablePath: exe, registry }) }
}

it('keeps New reversible across fresh fallback, dedicated default selection and restart without owning the candidate', async () => {
  const registry = new MemoryRegistry()
  const registration = new ShellMenuRegistration({ executablePath: exe, registry, isCurrentMarkdownDefault: async () => true })
  await registration.setEnabled('markdownShellNew', true)
  expect((await registry.read('.md'))?.values[''].data).toBe('Arkdown.Markdown')
  await registerDefaultApplications(registry, exe)
  const candidate = structuredClone([...registry.user].filter(([key]) => key.startsWith('arkdown.document.markdown')))
  registry.choices.set('.md', 'Arkdown.Document.Markdown')
  await registration.setEnabled('markdownShellNew', false)
  expect(await registry.read('Arkdown.Markdown')).toBeNull()
  expect(await registry.read('.md')).toBeNull()
  await registration.setEnabled('markdownShellNew', true)
  expect((await registry.read('.md\\ShellNew'))?.values.NullFile.data).toBe('')
  expect((await registry.read('.md'))?.values['']).toBeUndefined()
  expect([...registry.user].filter(([key]) => key.startsWith('arkdown.document.markdown'))).toEqual(candidate)
  const restarted = new ShellMenuRegistration({ executablePath: exe, registry, isCurrentMarkdownDefault: async () => true })
  const writes = registry.writes
  await restarted.setEnabled('markdownShellNew', true)
  expect(registry.writes).toBe(writes)
  await restarted.setEnabled('markdownShellNew', false)
  await restarted.setEnabled('markdownShellNew', true)
  registry.choices.set('.md', 'Other.Type')
  const before = structuredClone(registry.user)
  for (const enabled of [true, false]) {
    await expect(restarted.setEnabled('markdownShellNew', enabled)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
    expect(registry.user).toEqual(before)
  }
  expect(await registry.userChoice('.md')).toBe('Other.Type')
})

it.each(['other executable', 'changed command', 'nested New layout'])('does not enable New against an unsafe dedicated candidate after fallback removal: %s', async (scenario) => {
  const registry = new MemoryRegistry()
  const registration = new ShellMenuRegistration({ executablePath: exe, registry, isCurrentMarkdownDefault: async () => scenario !== 'other executable' })
  await registration.setEnabled('markdownShellNew', true)
  await registerDefaultApplications(registry, exe)
  registry.choices.set('.md', 'Arkdown.Document.Markdown')
  await registration.setEnabled('markdownShellNew', false)
  if (scenario === 'changed command') registry.seed('Arkdown.Document.Markdown\\shell\\open\\command', { '': '"C:\\Other\\Arkdown.exe" "%1"' }, true)
  if (scenario === 'nested New layout') registry.seed('Arkdown.Document.Markdown\\ShellNew', {}, true)
  const before = structuredClone(registry.user)
  await expect(registration.setEnabled('markdownShellNew', true)).rejects.toThrow()
  expect(registry.user).toEqual(before)
})

it('rebinds only an explicitly selected current Arkdown candidate and preserves later foreign changes', async () => {
  const { registry, registration } = fixture()
  await registration.setEnabled('markdownShellNew', true)
  registry.choices.set('.md', 'Arkdown.Document.Markdown')
  const current = new ShellMenuRegistration({ executablePath: exe, registry, isCurrentMarkdownDefault: async () => true })
  await current.setEnabled('markdownShellNew', true)
  expect(JSON.parse((await registry.read(journal))!.values.Ownership.data as string).markdownDescription.userChoice).toBe('Arkdown.Document.Markdown')
  await current.setEnabled('markdownShellNew', false)
  await current.setEnabled('markdownShellNew', true)
  registry.choices.set('.md', 'Other.Type')
  const before = structuredClone(registry.user)
  await expect(current.setEnabled('markdownShellNew', false)).rejects.toThrow()
  expect(registry.user).toEqual(before)
})
it.each(['other copy', 'legacy fallback', 'changed open'])('rejects unsafe candidate binding migration: %s', async (scenario) => {
  const { registry, registration } = fixture()
  await registration.setEnabled('markdownShellNew', true)
  registry.choices.set('.md', scenario === 'legacy fallback' ? 'Arkdown.Markdown' : 'Arkdown.Document.Markdown')
  if (scenario === 'changed open') registry.seed(`${type}\\shell\\open\\command`, { '': 'other.exe' }, true)
  const before = structuredClone(registry.user)
  const current = new ShellMenuRegistration({ executablePath: exe, registry, isCurrentMarkdownDefault: async () => scenario !== 'other copy' })
  await expect(current.setEnabled('markdownShellNew', true)).rejects.toThrow()
  expect(registry.user).toEqual(before)
})

it('adds only a missing bound type description and restores the complete original state after re-enable', async () => {
  const { registry, registration } = fixture()
  const baseline = structuredClone(registry.user)
  await registration.setEnabled('markdownShellNew', true)
  expect((await registry.read(type))?.values).toEqual({ CustomMetadata: { kind: 'String', data: 'preserve' }, '': description })
  expect((await registry.read('.md'))?.values['']?.data).toBe(type)
  expect((await registry.read(`${type}\\shell\\open\\command`))?.values['']?.data).toBe(open)
  expect(await registry.userChoice('.md')).toBe(type)
  const restarted = new ShellMenuRegistration({ executablePath: exe, registry })
  const writes = registry.writes
  await restarted.setEnabled('markdownShellNew', true)
  expect(registry.writes).toBe(writes)
  await restarted.setEnabled('markdownShellNew', false)
  await restarted.setEnabled('markdownShellNew', false)
  expect(registry.user).toEqual(baseline)
})

it.each(existingDescriptions)('preserves preexisting descriptions and never claims them: %j', async (values) => {
  const { registry, registration } = fixture()
  registry.seed(type, values, true)
  const baseline = structuredClone(registry.user)
  await registration.setEnabled('markdownShellNew', true)
  await registration.setEnabled('markdownShellNew', false)
  expect(registry.user).toEqual(baseline)
  expect(await registry.userChoice('.md')).toBe(type)
})

it.each(invalidDescriptions)('rejects empty or malformed existing metadata without overwriting it: %j', async (values) => {
  const { registry, registration } = fixture()
  registry.user.get(type)!.values = values
  const baseline = structuredClone(registry.user)
  await expect(registration.setEnabled('markdownShellNew', true)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_UNSUPPORTED' })
  expect(registry.writes).toBe(0)
  expect(registry.user).toEqual(baseline)
})

it.each(['partial write', 'settings save'] as const)('rolls back the description as well as NullFile after %s failure', async (failure) => {
  const { registry, registration } = fixture()
  const baseline = structuredClone(registry.user)
  if (failure === 'partial write') registry.failAt = 2
  const settings = new SettingsCoordinator({ save: async () => { if (failure === 'settings save') throw new Error('save failed') } }, { lastWorkspace: null })
  const service = new ShellIntegrationService(registration, settings)
  await expect(service.update({ feature: 'markdownShellNew', enabled: true })).rejects.toThrow()
  expect(service.get().markdownShellNew).toBe(false)
  expect(registry.user).toEqual(baseline)
})

it.each(['description', 'description removed', 'friendly name', 'extension', 'open', 'UserChoice'] as const)(
  'preserves an external %s edit and refuses both re-enable and disable', async (edit) => {
    const { registry, registration } = fixture()
    await registration.setEnabled('markdownShellNew', true)
    if (edit === 'description') registry.user.get(type)!.values[''] = { kind: 'String', data: 'Other owner' }
    if (edit === 'description removed') delete registry.user.get(type)!.values['']
    if (edit === 'friendly name') registry.user.get(type)!.values.FriendlyTypeName = { kind: 'String', data: '@C:\\Other.dll,-1' }
    if (edit === 'extension') registry.seed('.md', { '': 'Other.Type' }, true)
    if (edit === 'open') registry.seed(`${type}\\shell\\open\\command`, { '': 'other.exe "%1"' }, true)
    if (edit === 'UserChoice') registry.choices.set('.md', 'Other.Type')
    const changed = structuredClone(registry.user), choices = structuredClone(registry.choices)
    const persist = vi.fn(async () => {})
    for (const enabled of [true, false]) {
      await expect(registration.setEnabled('markdownShellNew', enabled, persist)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
      expect(registry.user).toEqual(changed)
      expect(registry.choices).toEqual(choices)
    }
    expect(persist).not.toHaveBeenCalled()
  },
)

it('rejects a forged description journal that targets a different ProgID', async () => {
  const { registry, registration } = fixture()
  registry.seed('Other.Type', { '': 'Markdown 文档' }, true)
  registry.seed(journal, { Ownership: JSON.stringify({ executable: exe, createdKeys: [],
    markdownDescription: { progId: 'Other.Type', userChoice: type, open: { kind: 'String', data: open } },
    values: [{ key: 'Other.Type', name: '', value: description }],
  }) }, true)
  const baseline = structuredClone(registry.user)
  await expect(registration.setEnabled('markdownShellNew', false)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  expect(registry.writes).toBe(0)
  expect(registry.user).toEqual(baseline)
})

it('preserves a description inserted between planning and the CAS write', async () => {
  const { registry, registration } = fixture()
  const read = registry.read.bind(registry)
  registry.read = async (key, scope = 'effective') => {
    if (key === type && scope === 'user') registry.user.get(type)!.values[''] = { kind: 'String', data: 'Concurrent owner' }
    return read(key, scope)
  }
  const persist = vi.fn(async () => {})
  await expect(registration.setEnabled('markdownShellNew', true, persist)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  expect((await read(type))?.values['']?.data).toBe('Concurrent owner')
  expect(await read('.md\\ShellNew')).toBeNull()
  expect(persist).not.toHaveBeenCalled()
})
