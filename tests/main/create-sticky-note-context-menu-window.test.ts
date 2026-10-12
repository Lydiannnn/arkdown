import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => {
  const switches = new Map<string, string>()
  const shown = vi.fn()
  const hidden = vi.fn()
  const commandLine = {
    hasSwitch: (name: string) => switches.has(name),
    appendSwitch: vi.fn((name: string) => { switches.set(name, '') }),
    removeSwitch: vi.fn((name: string) => { switches.delete(name) }),
  }
  const BrowserWindow = vi.fn(function MockBrowserWindow() {
    return {
      showInactive: shown,
      hide: hidden,
      setAlwaysOnTop: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn(), once: vi.fn() },
      loadURL: vi.fn(async () => undefined), loadFile: vi.fn(async () => undefined),
    }
  })
  return { switches, shown, hidden, commandLine, BrowserWindow }
})

vi.mock('electron', () => ({ app: { commandLine: harness.commandLine }, BrowserWindow: harness.BrowserWindow }))

import { createStickyNoteContextMenuBrowserWindow } from '../../src/main/create-sticky-note-context-menu-window'

const ANIMATION_SWITCH = 'wm-window-animations-disabled'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

describe('sticky menu native visibility animation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harness.shown.mockReset()
    harness.hidden.mockReset()
    harness.switches.clear()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173')
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.unstubAllGlobals()
  })

  it('starts transparent and ignores input without forwarding mouse movement', () => {
    const window = createStickyNoteContextMenuBrowserWindow()
    expect(harness.BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({ opacity: 0, show: false }))
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('disables Aura animation only during the actual Windows show and restores the command line', () => {
    const window = createStickyNoteContextMenuBrowserWindow()
    const observed: boolean[] = []
    harness.shown.mockImplementation(function (this: unknown) {
      expect(this).toBe(window)
      observed.push(harness.switches.has(ANIMATION_SWITCH))
    })

    window.showInactive()
    window.showInactive()

    expect(observed).toEqual([true, true])
    expect(harness.switches.has(ANIMATION_SWITCH)).toBe(false)
  })

  it('restores a temporary switch when native show throws', () => {
    const window = createStickyNoteContextMenuBrowserWindow()
    harness.shown.mockImplementation(() => {
      expect(harness.switches.has(ANIMATION_SWITCH)).toBe(true)
      throw new Error('native show failed')
    })

    expect(() => window.showInactive()).toThrow('native show failed')
    expect(harness.switches.has(ANIMATION_SWITCH)).toBe(false)
  })

  it('uses the same no-animation policy for hiding and reopening the cached overlay', () => {
    const window = createStickyNoteContextMenuBrowserWindow()
    const transitions: string[] = []
    harness.shown.mockImplementation(function (this: unknown) {
      expect(this).toBe(window)
      expect(harness.switches.has(ANIMATION_SWITCH)).toBe(true)
      transitions.push('show')
    })
    harness.hidden.mockImplementation(function (this: unknown) {
      expect(this).toBe(window)
      expect(harness.switches.has(ANIMATION_SWITCH)).toBe(true)
      transitions.push('hide')
    })

    for (let i = 0; i < 3; i++) {
      window.showInactive()
      expect(harness.switches.has(ANIMATION_SWITCH)).toBe(false)
      window.hide()
      expect(harness.switches.has(ANIMATION_SWITCH)).toBe(false)
    }
    expect(transitions).toEqual(['show', 'hide', 'show', 'hide', 'show', 'hide'])
  })

  it('restores a temporary switch when native hide throws', () => {
    const window = createStickyNoteContextMenuBrowserWindow()
    harness.hidden.mockImplementation(() => {
      expect(harness.switches.has(ANIMATION_SWITCH)).toBe(true)
      throw new Error('native hide failed')
    })
    expect(() => window.hide()).toThrow('native hide failed')
    expect(harness.switches.has(ANIMATION_SWITCH)).toBe(false)
  })

  it('preserves an existing animation switch and its value', () => {
    harness.switches.set(ANIMATION_SWITCH, 'existing-value')
    const window = createStickyNoteContextMenuBrowserWindow()
    window.showInactive()
    window.hide()

    expect(harness.switches.get(ANIMATION_SWITCH)).toBe('existing-value')
    expect(harness.commandLine.appendSwitch).not.toHaveBeenCalled()
    expect(harness.commandLine.removeSwitch).not.toHaveBeenCalled()
  })

  it('keeps unrelated switches unchanged', () => {
    harness.switches.set('another-switch', 'keep-me')
    const window = createStickyNoteContextMenuBrowserWindow()
    window.showInactive()
    window.hide()

    expect([...harness.switches]).toEqual([['another-switch', 'keep-me']])
  })

  it('uses the ordinary native show on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const window = createStickyNoteContextMenuBrowserWindow()
    window.showInactive()
    window.hide()

    expect(harness.shown).toHaveBeenCalledOnce()
    expect(harness.hidden).toHaveBeenCalledOnce()
    expect(harness.commandLine.appendSwitch).not.toHaveBeenCalled()
    expect(harness.commandLine.removeSwitch).not.toHaveBeenCalled()
  })
})
