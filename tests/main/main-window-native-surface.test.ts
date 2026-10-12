import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createMainWindowNativeSurfaceController } from '../../src/main/main-window-native-surface'
import { createStickyNoteNativeSurfaceController } from '../../src/main/sticky-notes/sticky-note-native-surface'

function harness() {
  const addon = { attach: vi.fn(() => true), configure: vi.fn(() => true), resize: vi.fn(() => true), detach: vi.fn(), clear: vi.fn(), setGlassDecoration: vi.fn(() => true), setAcrylicBorderHidden: vi.fn(() => true) }
  const events = new EventEmitter()
  const window = Object.assign(events, {
    isDestroyed: vi.fn(() => false), getNativeWindowHandle: () => Buffer.from('0100000000000000', 'hex'),
    setBackgroundMaterial: vi.fn(), setHasShadow: vi.fn(),
  })
  return { addon, window }
}

describe('main window persistent Mica', () => {
  it('follows OS updates only in system mode, without persisting the resolved color', () => {
    const { addon, window } = harness()
    const main = createMainWindowNativeSurfaceController({ platform: 'win32', load: () => addon })
    main.bind(window)
    main.setSystemDark(true)
    expect(addon.configure).toHaveBeenLastCalledWith(1n, expect.objectContaining({ tintColor: '#202020' }))
    main.setTheme('minimal')
    addon.configure.mockClear()
    main.setSystemDark(false)
    main.setSystemDark(true)
    expect(addon.configure).not.toHaveBeenCalled()
    main.setTheme('system')
    expect(addon.configure).toHaveBeenLastCalledWith(1n, expect.objectContaining({ tintColor: '#202020' }))
  })
  it('updates only main HWND recipes without detaching Mica or changing notes', () => {
    const { addon, window } = harness()
    const main = createMainWindowNativeSurfaceController({ platform: 'win32', load: () => addon })
    const notes = createStickyNoteNativeSurfaceController({ platform: 'win32', load: () => addon })
    const note = harness().window
    note.getNativeWindowHandle = () => Buffer.from('0200000000000000', 'hex')
    notes.bind(note, { mode: 'material', materialPresetId: 'mica-light' })
    main.bind(window)
    addon.configure.mockClear()
    main.setTheme('dark')
    expect(addon.configure).toHaveBeenCalledExactlyOnceWith(1n, expect.objectContaining({ tintColor: '#202020' }))
    window.emit('blur')
    window.emit('focus')
    expect(addon.detach).not.toHaveBeenCalled()
    main.setTheme('minimal')
    expect(addon.configure).toHaveBeenLastCalledWith(1n, { tintColor: '#F3F3F3', tintOpacity: 0, luminosityOpacity: 1, saturation: 1 })
  })

  it('keeps a fixed wallpaper recipe independent of sticky-note preferences', () => {
    const { addon, window } = harness()
    const main = createMainWindowNativeSurfaceController({ platform: 'win32', load: () => addon })
    main.bind(window)
    expect(addon.attach).toHaveBeenCalledWith(1n)
    expect(addon.configure).toHaveBeenLastCalledWith(1n, { tintColor: '#F3F3F3', tintOpacity: 0, luminosityOpacity: 1, saturation: 1 })
    const notes = createStickyNoteNativeSurfaceController({ platform: 'win32', load: () => addon })
    notes.setAppearance({ tintColor: '#000000', tintOpacity: 1, luminosityOpacity: 0, saturation: 0 })
    expect(addon.configure).toHaveBeenCalledTimes(1)
    window.emit('blur')
    window.emit('focus')
    expect(addon.attach).toHaveBeenCalledTimes(1)
    expect(addon.setGlassDecoration).not.toHaveBeenCalled()
    expect(addon.setAcrylicBorderHidden).not.toHaveBeenCalled()
    expect(window.setHasShadow).toHaveBeenCalledWith(true)
  })

  it('resizes the owned surface and only releases after a completed close', () => {
    const { addon, window } = harness()
    createMainWindowNativeSurfaceController({ platform: 'win32', load: () => addon }).bind(window)
    window.emit('resize')
    expect(addon.resize).toHaveBeenCalledWith(1n)
    window.emit('close')
    expect(addon.detach).not.toHaveBeenCalled()
    window.emit('closed')
    expect(addon.detach).toHaveBeenCalledWith(1n)
    expect(window.listenerCount('resize')).toBe(0)
    expect(addon.clear).not.toHaveBeenCalled()
  })

  it('retains the system Mica fallback when native attachment fails', () => {
    const { addon, window } = harness()
    addon.attach.mockReturnValue(false)
    createMainWindowNativeSurfaceController({ platform: 'win32', load: () => addon }).bind(window)
    expect(window.setBackgroundMaterial).toHaveBeenLastCalledWith('mica')
    expect(addon.configure).not.toHaveBeenCalled()
    expect(addon.detach).toHaveBeenCalledWith(1n)
  })

  it('closing one main window leaves another HWND using the shared module intact', () => {
    const { addon, window } = harness()
    const peer = harness().window
    peer.getNativeWindowHandle = () => Buffer.from('0200000000000000', 'hex')
    const main = createMainWindowNativeSurfaceController({ platform: 'win32', load: () => addon })
    main.bind(window)
    main.bind(peer)
    window.emit('closed')
    expect(addon.detach.mock.calls).toEqual([[1n]])
    peer.emit('resize')
    expect(addon.resize).toHaveBeenLastCalledWith(2n)
    expect(addon.clear).not.toHaveBeenCalled()
  })
})
