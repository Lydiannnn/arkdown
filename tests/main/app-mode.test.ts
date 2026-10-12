import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  configureAppProfile,
  desktopAppMode,
  startDesktopApp,
} from '../../src/main/app-mode'

describe('desktop application mode', () => {
  it('starts Arknote only when the executable itself is Arknote.exe', () => {
    expect(desktopAppMode('C:\\Portable\\Arknote.exe')).toBe('arknote')
    expect(desktopAppMode('C:\\Portable\\ARKNOTE.EXE')).toBe('arknote')
    expect(desktopAppMode('C:\\Portable\\Arkdown.exe')).toBe('arkdown')
    expect(desktopAppMode('C:\\Portable\\arknote-helper.exe')).toBe('arkdown')
    expect(desktopAppMode('C:\\Electron\\electron.exe')).toBe('arkdown')
  })

  it('gives Arknote an isolated portable profile before Electron becomes ready', () => {
    const setName = vi.fn()
    const setPath = vi.fn()

    configureAppProfile({
      app: { setName, setPath },
      mode: 'arknote',
      portableRoot: 'C:\\Portable\\Arkdown',
    })

    expect(setName).toHaveBeenCalledWith('Arknote')
    expect(setPath).toHaveBeenCalledWith(
      'userData',
      path.join(
        'C:\\Portable\\Arkdown',
        'portable-data',
        'arknote',
        'electron-profile',
      ),
    )
  })

  it('does not override the Arkdown application name or profile', () => {
    const setName = vi.fn()
    const setPath = vi.fn()

    configureAppProfile({
      app: { setName, setPath },
      mode: 'arkdown',
      portableRoot: 'C:\\Portable\\Arkdown',
    })

    expect(setName).not.toHaveBeenCalled()
    expect(setPath).not.toHaveBeenCalled()
  })

  it('starts only the entrypoint selected by the executable mode', async () => {
    const startArkdown = vi.fn(async () => undefined)
    const startArknote = vi.fn(async () => undefined)

    await startDesktopApp('arknote', { startArkdown, startArknote })

    expect(startArknote).toHaveBeenCalledTimes(1)
    expect(startArkdown).not.toHaveBeenCalled()
  })
})
