import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { registerIpc } from '../../src/main/ipc/register-ipc'
import { WindowStateCoordinator } from '../../src/main/window-state'
import { IPC_CHANNELS, WINDOW_STATE_CHANGED_CHANNEL } from '../../src/shared/contracts'

function createRegistrar() {
  const handlers = new Map<
    string,
    (event: { sender: unknown; senderFrame: unknown }, input?: unknown) => unknown
  >()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (typeof handlers extends Map<unknown, infer H> ? H : never)) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  }
}

class FakeWebContents extends EventEmitter {
  destroyed = false
  readonly mainFrame = {}
  readonly send = vi.fn()

  isDestroyed(): boolean { return this.destroyed }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  readonly webContents = new FakeWebContents()
  maximized = false
  fullscreen = false
  readonly close = vi.fn()
  readonly maximize = vi.fn()
  readonly minimize = vi.fn()
  readonly setFullScreen = vi.fn()
  readonly unmaximize = vi.fn()
  readonly isFullScreen = vi.fn(() => this.fullscreen)
  readonly isMaximized = vi.fn(() => this.maximized)
  private readonly windowMessageHooks = new Map<number, (wParam: Buffer, lParam: Buffer) => Buffer | null | void>()
  readonly hookWindowMessage = vi.fn((message: number, callback: (wParam: Buffer, lParam: Buffer) => Buffer | null | void) => {
    this.windowMessageHooks.set(message, callback)
  })
  readonly unhookWindowMessage = vi.fn((message: number) => {
    this.windowMessageHooks.delete(message)
  })

  isDestroyed(): boolean { return this.destroyed }

  emitWindowMessage(message: number, hitTest: number): Buffer | null | void {
    const wParam = Buffer.alloc(8)
    wParam.writeUInt32LE(hitTest)
    return this.windowMessageHooks.get(message)?.(wParam, Buffer.alloc(8))
  }
}

function registerWindow(
  window: FakeWindow,
  coordinator: WindowStateCoordinator,
  ipcMain = createRegistrar(),
) {
  const registration = registerIpc({
    ipcMain,
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    window,
    workspace: {} as never,
    documents: {} as never,
    getLastWorkspace: () => null,
    setLastWorkspace: () => undefined,
    reportError: vi.fn(),
    controlWindow: (action) => coordinator.controlWindow(action),
    getWindowState: () => coordinator.getSnapshot(),
  })
  const control = ipcMain.handlers.get(IPC_CHANNELS.controlWindow)
  if (!control) throw new Error('Window control handler was not registered')
  return { control, ipcMain, registration }
}

describe('WindowStateCoordinator', () => {
  it('freezes an initial revision-zero snapshot and returns the cached object', () => {
    const window = new FakeWindow()
    window.maximized = true
    const coordinator = new WindowStateCoordinator(window, vi.fn())

    expect(coordinator.getSnapshot()).toEqual({
      maximized: true,
      fullscreen: false,
      revision: 0,
    })
    expect(Object.isFrozen(coordinator.getSnapshot())).toBe(true)
    expect(coordinator.getSnapshot()).toBe(coordinator.getSnapshot())
    expect(window.isMaximized).toHaveBeenCalledOnce()
    expect(window.isFullScreen).toHaveBeenCalledOnce()
  })

  it('advances only for confirmed state-specific fullscreen changes', () => {
    const window = new FakeWindow()
    const observed = vi.fn()
    const coordinator = new WindowStateCoordinator(window, observed)

    window.emit('enter-full-screen')
    const first = coordinator.getSnapshot()
    window.emit('enter-full-screen')
    window.fullscreen = true
    window.emit('leave-full-screen')
    window.emit('leave-full-screen')
    window.fullscreen = false
    window.emit('enter-full-screen')

    expect(first).toEqual({ maximized: false, fullscreen: true, revision: 1 })
    expect(coordinator.getSnapshot()).toEqual({
      maximized: false,
      fullscreen: true,
      revision: 3,
    })
    expect(observed).toHaveBeenCalledTimes(3)
    expect(window.webContents.send).toHaveBeenCalledTimes(3)
  })

  it('accepts state-specific Electron events before native getters catch up', () => {
    const window = new FakeWindow()
    const observed = vi.fn()
    const coordinator = new WindowStateCoordinator(window, observed)

    window.emit('enter-full-screen')
    expect(coordinator.getSnapshot()).toEqual({
      maximized: false,
      fullscreen: true,
      revision: 1,
    })

    window.fullscreen = true
    window.emit('leave-full-screen')
    expect(coordinator.getSnapshot()).toEqual({
      maximized: false,
      fullscreen: false,
      revision: 2,
    })

    window.fullscreen = false
    window.emit('maximize')
    expect(coordinator.getSnapshot()).toEqual({
      maximized: false,
      fullscreen: false,
      revision: 2,
    })
    expect(window.setFullScreen).toHaveBeenLastCalledWith(true)

    window.fullscreen = true
    window.emit('enter-full-screen')
    window.maximized = true
    window.emit('unmaximize')
    expect(coordinator.getSnapshot()).toEqual({
      maximized: false,
      fullscreen: true,
      revision: 3,
    })
    expect(observed).toHaveBeenCalledTimes(3)
  })

  it('caches before publishing and gives the callback and owner renderer one frozen object', () => {
    const window = new FakeWindow()
    let coordinator!: WindowStateCoordinator
    const observed = vi.fn((snapshot) => {
      expect(coordinator.getSnapshot()).toBe(snapshot)
    })
    coordinator = new WindowStateCoordinator(window, observed)

    window.fullscreen = true
    window.emit('enter-full-screen')

    const snapshot = coordinator.getSnapshot()
    expect(observed).toHaveBeenCalledWith(snapshot)
    expect(window.webContents.send).toHaveBeenCalledWith(
      WINDOW_STATE_CHANGED_CHANNEL,
      snapshot,
    )
    expect(window.webContents.send.mock.calls[0]?.[1]).toBe(snapshot)
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('treats controls as requests and returns the old cache until native confirmation', () => {
    const window = new FakeWindow()
    const coordinator = new WindowStateCoordinator(window, vi.fn())
    const initial = coordinator.getSnapshot()

    expect(coordinator.controlWindow('toggle-fullscreen')).toBe(initial)
    expect(window.setFullScreen).toHaveBeenLastCalledWith(true)
    expect(coordinator.controlWindow('toggle-maximize')).toBe(initial)
    expect(window.maximize).not.toHaveBeenCalled()
    expect(window.setFullScreen).toHaveBeenCalledTimes(1)
    expect(coordinator.controlWindow('minimize')).toBe(initial)
    expect(window.minimize).toHaveBeenCalledOnce()
    expect(coordinator.controlWindow('exit-fullscreen')).toBe(initial)
    expect(window.setFullScreen).toHaveBeenCalledTimes(1)

    window.fullscreen = true
    window.emit('enter-full-screen')
    const confirmed = coordinator.getSnapshot()
    expect(coordinator.controlWindow('exit-fullscreen')).toBe(confirmed)
    expect(window.setFullScreen).toHaveBeenLastCalledWith(false)
    expect(coordinator.controlWindow('close')).toBe(confirmed)
    expect(window.close).toHaveBeenCalledOnce()
  })

  it('converts native title-bar maximize gestures into one confirmed fullscreen transition', () => {
    const window = new FakeWindow()
    const observed = vi.fn()
    const coordinator = new WindowStateCoordinator(window, observed)

    window.emit('maximize')
    window.emit('maximize')

    expect(window.unmaximize).toHaveBeenCalledTimes(2)
    expect(window.setFullScreen).toHaveBeenCalledTimes(1)
    expect(window.setFullScreen).toHaveBeenCalledWith(true)
    expect(coordinator.getSnapshot()).toEqual({
      maximized: false,
      fullscreen: false,
      revision: 0,
    })
    expect(observed).not.toHaveBeenCalled()

    window.fullscreen = true
    window.emit('enter-full-screen')
    expect(coordinator.getSnapshot()).toEqual({
      maximized: false,
      fullscreen: true,
      revision: 1,
    })

    window.emit('maximize')
    expect(window.unmaximize).toHaveBeenCalledTimes(3)
    expect(window.setFullScreen).toHaveBeenCalledTimes(2)
    expect(window.setFullScreen).toHaveBeenLastCalledWith(false)
  })

  it('routes frameless client and caption double-clicks through the guarded fullscreen toggle', () => {
    const window = new FakeWindow()
    const coordinator = new WindowStateCoordinator(window, vi.fn())

    window.emitWindowMessage(0x00a3, 0x0a)
    expect(window.setFullScreen).not.toHaveBeenCalled()

    const consumed = window.emitWindowMessage(0x00a3, 0x01)
    window.emitWindowMessage(0x00a3, 0x01)
    expect(consumed).toEqual(Buffer.alloc(8))
    expect(window.maximize).not.toHaveBeenCalled()
    expect(window.unmaximize).not.toHaveBeenCalled()
    expect(window.setFullScreen).toHaveBeenCalledTimes(1)
    expect(window.setFullScreen).toHaveBeenCalledWith(true)

    window.fullscreen = true
    window.emit('enter-full-screen')
    window.emitWindowMessage(0x00a3, 0x02)
    expect(window.setFullScreen).toHaveBeenCalledTimes(2)
    expect(window.setFullScreen).toHaveBeenLastCalledWith(false)

    coordinator.dispose()
    window.emitWindowMessage(0x00a3, 0x02)
    expect(window.unhookWindowMessage).toHaveBeenCalledWith(0x00a3)
    expect(window.setFullScreen).toHaveBeenCalledTimes(2)
  })

  it('recognizes two native title-bar presses when Windows suppresses the double-click message', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T00:00:00.000Z'))
    try {
      const window = new FakeWindow()
      new WindowStateCoordinator(window, vi.fn())

      window.emitWindowMessage(0x00a1, 0x01)
      vi.advanceTimersByTime(120)
      window.emitWindowMessage(0x00a1, 0x01)

      expect(window.maximize).not.toHaveBeenCalled()
      expect(window.unmaximize).not.toHaveBeenCalled()
      expect(window.setFullScreen).toHaveBeenCalledOnce()
      expect(window.setFullScreen).toHaveBeenCalledWith(true)
      expect(window.hookWindowMessage).toHaveBeenCalledWith(0x00a1, expect.any(Function))

      window.fullscreen = true
      window.emit('enter-full-screen')
      vi.advanceTimersByTime(600)
      window.emitWindowMessage(0x00a1, 0x01)
      vi.advanceTimersByTime(120)
      window.emitWindowMessage(0x00a1, 0x01)
      expect(window.setFullScreen).toHaveBeenCalledTimes(2)
      expect(window.setFullScreen).toHaveBeenLastCalledWith(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses repeated fullscreen controls until Electron confirms the requested state', () => {
    const window = new FakeWindow()
    const coordinator = new WindowStateCoordinator(window, vi.fn())

    coordinator.controlWindow('toggle-fullscreen')
    coordinator.controlWindow('toggle-fullscreen')
    coordinator.controlWindow('exit-fullscreen')
    expect(window.setFullScreen).toHaveBeenCalledTimes(1)
    expect(window.setFullScreen).toHaveBeenCalledWith(true)

    window.fullscreen = true
    window.emit('enter-full-screen')
    coordinator.controlWindow('toggle-fullscreen')
    coordinator.controlWindow('toggle-fullscreen')
    expect(window.setFullScreen).toHaveBeenCalledTimes(2)
    expect(window.setFullScreen).toHaveBeenLastCalledWith(false)

    window.fullscreen = false
    window.emit('leave-full-screen')
    expect(coordinator.getSnapshot()).toEqual({
      maximized: false,
      fullscreen: false,
      revision: 2,
    })
  })

  it('keeps two coordinators isolated through owner-specific IPC', async () => {
    const firstWindow = new FakeWindow()
    const secondWindow = new FakeWindow()
    const firstCoordinator = new WindowStateCoordinator(firstWindow, vi.fn())
    const secondCoordinator = new WindowStateCoordinator(secondWindow, vi.fn())
    const ipcMain = createRegistrar()
    const first = registerWindow(firstWindow, firstCoordinator, ipcMain)
    const second = registerWindow(secondWindow, secondCoordinator, ipcMain)

    firstWindow.fullscreen = true
    firstWindow.emit('enter-full-screen')

    const firstEvent = {
      sender: firstWindow.webContents,
      senderFrame: firstWindow.webContents.mainFrame,
    }
    const secondEvent = {
      sender: secondWindow.webContents,
      senderFrame: secondWindow.webContents.mainFrame,
    }
    await expect(first.ipcMain.handlers.get(IPC_CHANNELS.getWindowState)?.(firstEvent))
      .resolves.toEqual({
        ok: true,
        value: { maximized: false, fullscreen: true, revision: 1 },
      })
    await expect(second.ipcMain.handlers.get(IPC_CHANNELS.getWindowState)?.(secondEvent))
      .resolves.toEqual({
        ok: true,
        value: { maximized: false, fullscreen: false, revision: 0 },
      })
    expect(secondWindow.webContents.send).not.toHaveBeenCalled()

    first.registration.dispose()
    second.registration.dispose()
  })

  it.each(['dispose', 'closed', 'web-contents-destroyed'] as const)(
    'removes every listener and prevents later native reads on %s',
    (cleanup) => {
      const window = new FakeWindow()
      const observed = vi.fn()
      const coordinator = new WindowStateCoordinator(window, observed)
      window.isFullScreen.mockClear()
      window.isMaximized.mockClear()

      if (cleanup === 'dispose') coordinator.dispose()
      else if (cleanup === 'closed') window.emit('closed')
      else window.webContents.emit('destroyed')
      coordinator.dispose()

      expect(window.listenerCount('maximize')).toBe(0)
      expect(window.listenerCount('unmaximize')).toBe(0)
      expect(window.listenerCount('enter-full-screen')).toBe(0)
      expect(window.listenerCount('leave-full-screen')).toBe(0)
      expect(window.listenerCount('closed')).toBe(0)
      expect(window.webContents.listenerCount('destroyed')).toBe(0)
      window.fullscreen = true
      window.emit('enter-full-screen')
      expect(window.isFullScreen).not.toHaveBeenCalled()
      expect(window.isMaximized).not.toHaveBeenCalled()
      expect(observed).not.toHaveBeenCalled()
      expect(window.webContents.send).not.toHaveBeenCalled()
    },
  )
})

describe('owned BrowserWindow fullscreen controls', () => {
  it('preserves sender and main-frame ownership for fullscreen actions', async () => {
    const window = new FakeWindow()
    const coordinator = new WindowStateCoordinator(window, vi.fn())
    const { control, registration } = registerWindow(window, coordinator)

    await expect(control({
      sender: window.webContents,
      senderFrame: {},
    }, { action: 'toggle-fullscreen' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNTRUSTED_SENDER' },
    })
    expect(window.setFullScreen).not.toHaveBeenCalled()

    registration.dispose()
  })
})
