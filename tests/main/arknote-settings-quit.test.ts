import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArknoteSettingsQuitBarrier } from '../../src/main/arknote/arknote-settings-quit'
import { ArknoteServiceRuntime } from '../../src/main/arknote/arknote-service-runtime'
import { ArknoteImmediateSave } from '../../src/renderer/settings/arknote-immediate-save'
import { DEFAULT_ARKNOTE_PREFERENCES, copyArknotePreferences } from '../../src/shared/arknote-preferences'
import { CLOSE_CHANNELS } from '../../src/shared/contracts'

function harness() {
  const ipc = new EventEmitter(), contents = new EventEmitter(), frame = {}
  const order: string[] = []
  let paused = false, closed = false, persisted = copyArknotePreferences(DEFAULT_ARKNOTE_PREFERENCES)
  let firstResolve!: () => void
  const firstWrite = new Promise<void>(resolve => { firstResolve = resolve })
  const persist = vi.fn(async input => {
    if (paused) throw new Error('mutation gate paused')
    order.push('save:' + input.launchAtLogin)
    if (persist.mock.calls.length === 1) await firstWrite
    persisted = copyArknotePreferences({ ...persisted, ...input })
    return persisted
  })
  const queue = new ArknoteImmediateSave(persisted, persist, () => {})
  const wc = Object.assign(contents, { mainFrame: frame, send: vi.fn((_channel, payload) => {
    void queue.flush().then(ok => ipc.emit(CLOSE_CHANNELS.response, { sender: wc, senderFrame: frame }, { requestId: payload.requestId, ok }))
  }) })
  const window = Object.assign(new EventEmitter(), { webContents: wc, isDestroyed: () => closed, setEnabled: vi.fn(), focus: vi.fn() })
  const barrier = new ArknoteSettingsQuitBarrier({ ipcMain: ipc, window, timeoutMs: 1000 })
  const quit = vi.fn(() => order.push('quit'))
  const capture = vi.fn(async () => { order.push('notes-flush') })
  const resume = vi.fn(() => { paused = false })
  const service = new ArknoteServiceRuntime({ launchArguments: [], store: { initialize: async () => {} },
    session: { restore: async () => 0, captureAndFlush: capture },
    pipe: { start: async () => {}, stop: async () => {}, broadcast: () => {} }, tray: { initialize: () => {}, destroy: () => {} },
    windows: { closeAll: async () => { order.push('close'); closed = true; window.emit('closed') } },
    mutations: { pauseAndDrain: async () => { paused = true; order.push('pause') }, resume },
    openBox: async () => {}, createNote: async () => {}, openSettings: async () => {}, quitApp: quit,
    prepareToQuit: () => barrier.prepare(), cancelQuitPreparation: () => barrier.cancel(),
  })
  return { queue, persist, barrier, service, window, wc, ipc, order, quit, capture, firstResolve, persisted: () => persisted }
}
afterEach(() => vi.useRealTimers())

describe('settings save barrier before service quit', () => {
  it('drains both edits before pausing IPC when the first save is still in flight', async () => {
    const t = harness()
    t.queue.change({ launchAtLogin: true })
    t.queue.change({ launchAtLogin: false })
    const quitting = t.service.flushAndQuit()
    await vi.waitFor(() => expect(t.wc.send).toHaveBeenCalled())
    expect(t.order).toEqual(['save:true'])
    t.firstResolve()
    await quitting
    expect(t.order).toEqual(['save:true', 'save:false', 'pause', 'notes-flush', 'close', 'quit'])
    expect(t.persisted().launchAtLogin).toBe(false)
    expect(t.quit).toHaveBeenCalledOnce()
  })
  it('keeps the window and service alive on save failure, then permits a successful retry', async () => {
    const t = harness()
    t.queue.change({ launchAtLogin: true })
    t.queue.change({ launchAtLogin: false })
    t.persist.mockRejectedValueOnce(new Error('disk unavailable'))
    const quitting = t.service.flushAndQuit()
    await vi.waitFor(() => expect(t.wc.send).toHaveBeenCalled())
    t.firstResolve()
    await expect(quitting).rejects.toThrow('设置')
    expect(t.order).not.toContain('pause')
    expect(t.order).not.toContain('close')
    expect(t.quit).not.toHaveBeenCalled()
    expect(t.window.setEnabled).toHaveBeenLastCalledWith(true)
    await t.service.flushAndQuit()
    expect(t.persisted().launchAtLogin).toBe(false)
    expect(t.quit).toHaveBeenCalledOnce()
  })
  it('has a hard deadline even while the renderer keeps sending heartbeats', async () => {
    vi.useFakeTimers()
    const t = harness()
    t.wc.send.mockImplementation((_channel, payload) => {
      const heartbeat = setInterval(() => t.ipc.emit(CLOSE_CHANNELS.heartbeat, { sender: t.wc, senderFrame: t.wc.mainFrame }, payload), 50)
      setTimeout(() => clearInterval(heartbeat), 1500)
    })
    const preparing = t.barrier.prepare()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await preparing).toBe(false)
    expect(t.window.setEnabled).toHaveBeenLastCalledWith(true)
    expect(t.ipc.listenerCount(CLOSE_CHANNELS.response)).toBe(0)
    t.barrier.dispose()
  })
  it('restores the prepared settings window when a later note-save stage cancels quit', async () => {
    const t = harness()
    t.capture.mockRejectedValueOnce(new Error('note save failed'))
    await expect(t.service.flushAndQuit()).rejects.toThrow('note save failed')
    expect(t.window.isDestroyed()).toBe(false)
    expect(t.window.setEnabled).toHaveBeenLastCalledWith(true)
    expect(t.quit).not.toHaveBeenCalled()
    await t.service.flushAndQuit()
    expect(t.quit).toHaveBeenCalledOnce()
  })
  it('rejects a response from another frame and lets cancellation restore the window', async () => {
    const t = harness()
    t.wc.send.mockImplementation((_channel, payload) => {
      t.ipc.emit(CLOSE_CHANNELS.response, { sender: t.wc, senderFrame: {} }, { ...payload, ok: true })
    })
    const preparing = t.barrier.prepare()
    t.barrier.cancel()
    expect(await preparing).toBe(false)
    expect(t.window.setEnabled).toHaveBeenLastCalledWith(true)
  })
})
