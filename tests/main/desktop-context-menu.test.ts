import { describe, expect, it } from 'vitest'
import { DesktopContextMenuRegistration } from '../../src/main/arknote/desktop-context-menu'
import { MemoryRegistry } from './shell-registry-fake'

const key = 'DesktopBackground\\Shell\\Arknote'
const executablePath = 'C:\\Portable Apps\\Arkdown\\Arknote.exe'

describe('DesktopContextMenuRegistration ownership', () => {
  it('adopts the exact full legacy enabled registration and reverses only known values', async () => {
    const registry = new MemoryRegistry()
    registry.seed(key, { '': '创建新便签', Icon: executablePath }, true)
    registry.seed(`${key}\\command`, { '': `"${executablePath}" --new-note` }, true)
    const registration = new DesktopContextMenuRegistration({ executablePath, registry })
    await registration.setEnabled(true)
    await registration.setEnabled(false)
    await registration.setEnabled(false)
    expect(await registry.read(key)).toBeNull()
    expect(await registry.read(`${key}\\command`)).toBeNull()
  })

  it('rejects foreign and partial lookalikes, preserving later foreign values', async () => {
    const registry = new MemoryRegistry()
    registry.seed(key, { '': '创建新便签', Icon: executablePath }, true)
    registry.seed(`${key}\\command`, { '': 'foreign' }, true)
    const registration = new DesktopContextMenuRegistration({ executablePath, registry })
    await expect(registration.setEnabled(true)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
    expect(registry.writes).toBe(0)
    registry.user.clear()
    await registration.setEnabled(true)
    registry.seed(`${key}\\command`, { '': 'later foreign' }, true)
    await expect(registration.setEnabled(false)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
    expect((await registry.read(`${key}\\command`))?.values[''].data).toBe('later foreign')
  })

  it('rolls back partial failure and JSON save failure without deleting shared keys', async () => {
    const registry = new MemoryRegistry()
    const registration = new DesktopContextMenuRegistration({ executablePath, registry })
    registry.failAt = 3
    await expect(registration.setEnabled(true)).rejects.toThrow()
    expect([...registry.user.keys()]).toEqual([])
    registry.failAt = -1
    await expect(registration.setEnabled(true, async () => { throw new Error('JSON failure') })).rejects.toThrow('JSON failure')
    expect([...registry.user.keys()]).toEqual([])
    await registration.setEnabled(true)
    await expect(registration.setEnabled(false, async () => { throw new Error('JSON failure') })).rejects.toThrow('JSON failure')
    expect((await registry.read(`${key}\\command`))?.values[''].data).toBe(`"${executablePath}" --new-note`)
  })
})
