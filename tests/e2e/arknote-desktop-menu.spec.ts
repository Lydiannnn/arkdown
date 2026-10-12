import { expect, test } from '@playwright/test'
import { execFile as execFileCallback } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { DesktopContextMenuRegistration } from '../../src/main/arknote/desktop-context-menu'
import { WindowsShellRegistry, type RegistryBoundary } from '../../src/main/shell-integration/windows-registry'

const execFile = promisify(execFileCallback)
const REG = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')

test('Arknote enables and disables its command through an isolated HKCU registry subtree', async () => {
  test.skip(process.platform !== 'win32', 'Windows registry contract')
  const temporaryRoot = `ArkdownContextMenuTests\\${process.pid}-${Date.now()}`
  const native = new WindowsShellRegistry()
  const rewrite = (key: string) => `${temporaryRoot}\\${key}`
  const registry: RegistryBoundary = {
    read: (key, scope) => native.read(rewrite(key), scope),
    userChoice: async () => null,
    change: async (key, name, before, after) => (await native.change(rewrite(key), name, before, after))
      .filter((created) => created.startsWith(`${temporaryRoot}\\`))
      .map((created) => created.slice(temporaryRoot.length + 1)),
    removeEmpty: (key) => native.removeEmpty(rewrite(key)),
    notify: () => native.notify(),
    close: () => native.close(),
  }
  const executablePath = 'C:\\Portable Apps\\Arkdown\\Arknote.exe'
  const registration = new DesktopContextMenuRegistration({ executablePath, registry })
  const menuKey = 'DesktopBackground\\Shell\\Arknote'
  try {
    await registration.setEnabled(true)
    expect((await registry.read(menuKey))?.values.Icon.data).toBe(executablePath)
    expect((await registry.read(`${menuKey}\\command`))?.values[''].data).toBe(`"${executablePath}" --new-note`)
    await registration.setEnabled(false)
    expect(await registry.read(menuKey)).toBeNull()
  } finally {
    await native.close()
    await execFile(REG, ['delete', `HKCU\\Software\\Classes\\${temporaryRoot}`, '/f'], { timeout: 10_000, windowsHide: true })
      .catch(() => undefined)
  }
})
