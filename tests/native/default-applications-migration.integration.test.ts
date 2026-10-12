// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createWindowsDefaultApplications, defaultApplicationsSettingsUri } from '../../src/main/default-applications/service'
import { createRegistryWorker, isolatedRegistryRoot, WindowsShellRegistry } from '../../src/main/shell-integration/windows-registry'
import { release } from 'node:os'

it.skipIf(process.env.ARKDOWN_NATIVE_DEFAULT_APPLICATIONS !== '1')('migrates only after explicit Settings request through the native isolated registry', async () => {
  expect(process.platform).toBe('win32')
  expect(isolatedRegistryRoot()).toMatch(/^Software\\ArkdownNativeTests\\[a-z0-9-]+$/i)
  // This observer stays open across service calls. It must not reserve the
  // service's serialized write lane, which those calls need to acquire.
  const registry = new WindowsShellRegistry(createRegistryWorker())
  const open = vi.fn(async (_uri: string) => {})
  const oldExe = 'C:\\Old Arkdown\\Arkdown.exe', exe = 'C:\\新版本\\Arkdown.exe'
  const current = createWindowsDefaultApplications(exe, open)
  try {
    expect(await registry.read('Arkdown.Document.Markdown')).toBeNull()
    await createWindowsDefaultApplications(oldExe, open).openSettings()
    const key = 'Arkdown.Document.Markdown\\shell\\open\\command'
    const before = await registry.read(key)
    await current.refreshOwnedRegistration()
    expect(await registry.read(key)).toEqual(before)
    await current.openSettings()
    for (const id of ['Markdown', 'Text', 'Docx', 'OtherMarkdown']) {
      expect((await registry.read(`Arkdown.Document.${id}\\shell\\open\\command`))?.values[''].data).toBe(`"${exe}" "%1"`)
    }
    expect((await registry.read('@Capabilities'))?.values.ApplicationIcon.data).toBe(`"${exe}",0`)
    expect(await registry.read('.md')).toBeNull()
    expect(await registry.read('.txt')).toBeNull()
    expect(await registry.userChoice('.md')).toBeNull()
    expect(await registry.userChoice('.txt')).toBeNull()
    expect(await current.getStatus()).toEqual({ markdown: false, text: false })
    expect(open).toHaveBeenLastCalledWith(defaultApplicationsSettingsUri(release()))
    expect(open).toHaveBeenCalledTimes(2)
  } finally {
    await registry.close()
    // Remove only our logical keys, entirely beneath the required isolated root.
    const cleanup = new WindowsShellRegistry()
    const remove = async (key: string): Promise<void> => {
      const snapshot = await cleanup.read(key, 'user')
      if (!snapshot) return
      for (const subkey of snapshot.subkeys) await remove(`${key}\\${subkey}`)
      for (const [name, value] of Object.entries(snapshot.values)) await cleanup.change(key, name, value, null)
      await cleanup.removeEmpty(key)
    }
    try {
      for (const key of ['Arkdown.Document.Markdown', 'Arkdown.Document.Text', 'Arkdown.Document.Docx', 'Arkdown.Document.OtherMarkdown', '@Capabilities', '@RegisteredApplications']) await remove(key)
    } finally { await cleanup.close() }
  }
}, 90_000)
