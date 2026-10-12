// @vitest-environment node
import { expect, it } from 'vitest'
import { ShellMenuRegistration } from '../../src/main/shell-integration/registration'
import { isolatedRegistryRoot, WindowsShellRegistry } from '../../src/main/shell-integration/windows-registry'

const enabled = process.env.ARKDOWN_NATIVE_SHELL_TAKEOVER === '1'

it.skipIf(!enabled)('takes over all three old registrations through the isolated native Windows boundary', async () => {
  // Require both safeguards before constructing a native worker. No real Classes
  // or Explorer UserChoice registration is touched by this opt-in probe.
  expect(process.platform).toBe('win32')
  expect(isolatedRegistryRoot()).toMatch(/^Software\\ArkdownNativeTests\\[a-z0-9-]+$/i)
  const registry = new WindowsShellRegistry()
  const old = new ShellMenuRegistration({ executablePath: 'C:\\Old\\Arkdown.exe', registry })
  const current = new ShellMenuRegistration({ executablePath: 'C:\\Current\\Arkdown.exe', registry })
  try {
    expect(await registry.read('Arkdown.ShellIntegration')).toBeNull()
    for (const [feature, command] of [
      ['documentOpenMenu', 'SystemFileAssociations\\.md\\shell\\Arkdown\\command'],
      ['markdownShellNew', 'Arkdown.Markdown\\shell\\open\\command'],
      ['desktopNote', 'DesktopBackground\\Shell\\Arknote\\command'],
    ] as const) {
      await old.setEnabled(feature, true)
      const journal = `Arkdown.ShellIntegration\\${feature}`
      const beforeCommand = await registry.read(command)
      const beforeJournal = await registry.read(journal)
      await expect(current.setEnabled(feature, true)).rejects.toThrow()
      await expect(current.setEnabled(feature, false)).rejects.toThrow()
      await expect(current.setEnabled(feature, true, async () => { throw new Error('native save failure') }, { explicitEnable: true }))
        .rejects.toThrow('native save failure')
      expect(await registry.read(command)).toEqual(beforeCommand)
      expect(await registry.read(journal)).toEqual(beforeJournal)
      await current.setEnabled(feature, true, undefined, { explicitEnable: true })
      const after = (await registry.read(command))!.values['']
      expect(after.data).toBe(feature === 'desktopNote' ? '"C:\\Current\\Arkdown.exe" --new-note' : '"C:\\Current\\Arkdown.exe" "%1"')
      await expect(old.setEnabled(feature, false)).rejects.toThrow()
      // Older copies without a journal can write their command over our journal.
      const verbKeys = feature === 'desktopNote' ? ['DesktopBackground\\Shell\\Arknote']
        : feature === 'documentOpenMenu' ? ['SystemFileAssociations\\.md\\shell\\Arkdown', 'SystemFileAssociations\\.txt\\shell\\Arkdown'] : []
      for (const key of verbKeys) {
        await registry.change(key, 'Icon', (await registry.read(key))!.values.Icon, { kind: 'String', data: 'C:\\Old\\Arkdown.exe' })
        await registry.change(`${key}\\command`, '', (await registry.read(`${key}\\command`))!.values[''],
          { kind: 'String', data: feature === 'desktopNote' ? '"C:\\Old\\Arkdown.exe" --new-note' : '"C:\\Old\\Arkdown.exe" "%1"' })
      }
      if (feature === 'markdownShellNew') await registry.change(command, '', after, { kind: 'String', data: '"C:\\Old\\Arkdown.exe" "%1"' })
      await expect(current.setEnabled(feature, true)).rejects.toThrow()
      await current.setEnabled(feature, true, undefined, { explicitEnable: true })
      expect((await registry.read(command))!.values['']).toEqual(after)
      const foreign = { kind: 'String', data: 'foreign later command' }
      await registry.change(command, '', after, foreign)
      await expect(current.setEnabled(feature, false)).rejects.toThrow()
      expect((await registry.read(command))!.values['']).toEqual(foreign)
      await registry.change(command, '', foreign, after)
      await current.setEnabled(feature, false)
      expect(await registry.read(command)).toBeNull()
    }
    expect(await registry.userChoice('.md')).toBeNull()
    expect(await registry.read('Arkdown.ShellIntegration')).toBeNull()
  } finally {
    await registry.close()
  }
}, 90_000)
