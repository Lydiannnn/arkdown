import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain } from 'electron'
import type { CloseAttemptSnapshot } from '../../src/main/close/close-attempt-coordinator'
import { CLOSE_RECOVERY_CHANNELS } from '../../src/shared/close-recovery'
import { CLOSE_PREPARATION_CHANNELS } from '../../src/shared/close-preparation'

const electron = vi.hoisted(() => ({ next: undefined as unknown, options: undefined as unknown, showMessageBox: vi.fn(), copy: vi.fn() }))
vi.mock('electron', () => ({ clipboard: { writeText: electron.copy }, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  BrowserWindow: class { constructor(options: unknown) { electron.options = options; return electron.next as BrowserWindow } } }))
import { createNativeCloseRecovery } from '../../src/main/close/native-close-recovery'

class FakeWindow extends EventEmitter {
  destroyed = false
  webContents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => this.destroyed, send: vi.fn(), setWindowOpenHandler: vi.fn() })
  isDestroyed = () => this.destroyed
  show = vi.fn(); showInactive = vi.fn(); hide = vi.fn(); removeMenu = vi.fn()
  getBounds = vi.fn(() => ({ x: 200, y: 200, width: 490, height: 275 }))
  getContentBounds = vi.fn(() => ({ x: 200, y: 200, width: 490, height: 275 }))
  setContentSize = vi.fn(); setPosition = vi.fn()
  loadURL = vi.fn(async () => undefined); loadFile = vi.fn(async () => undefined)
  destroy = vi.fn(() => { this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed') })
}
const snapshot: CloseAttemptSnapshot = { attemptId: '00000000-0000-4000-8000-000000000001', generation: 1, revealRevision: 0, state: 'running',
  error: null, rendererUnavailable: null, canReturn: false, canRetry: false,
  progress: { stage: 'settle-document', feedback: 'progress', elapsedMs: 600, stageElapsedMs: 600, idleMs: 600, rendererAliveAt: null, pending: {} } }
function setup(rendererUrl?: string) {
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  const ipc = { handle: (name: string, handler: (event: unknown, input?: unknown) => unknown) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) }
  const child = new FakeWindow(), owner = new FakeWindow()
  electron.next = child
  const host = createNativeCloseRecovery({ ipcMain: ipc as unknown as IpcMain,
    preloadPath: 'controlled-preload.js', rendererFile: 'controlled-index.html', rendererUrl,
    version: '1.0.3', platform: 'win32', diagnostics: { record: vi.fn() }, nativeTheme: { shouldUseDarkColors: false },
    appearance: () => ({ editorTheme: 'dark', themeColor: '#123456' }),
    showMessageBox: electron.showMessageBox,
  })
  const binding = host.attach(owner as unknown as BrowserWindow)
  const acknowledge = () => handlers.get(CLOSE_RECOVERY_CHANNELS.ready)!({ sender: child.webContents, senderFrame: child.webContents.mainFrame }, { attemptId: snapshot.attemptId, generation: 1 })
  return { host, binding, child, owner, handlers, acknowledge }
}
beforeEach(() => { vi.clearAllMocks() })
it('fits the recovery window to measured content without accepting stale or foreign height commands', async () => {
  const s = setup(); s.binding.notify(snapshot)
  const ready = s.handlers.get(CLOSE_RECOVERY_CHANNELS.ready)!
  const event = { sender: s.child.webContents, senderFrame: s.child.webContents.mainFrame }
  expect(ready(event, { attemptId: snapshot.attemptId, generation: 1, height: 182.25 })).toBe(true)
  expect(s.child.setContentSize).toHaveBeenCalledWith(490, 183)
  s.child.setContentSize.mockClear()
  for (const value of [NaN, -1, Infinity]) expect(ready(event, { attemptId: snapshot.attemptId, generation: 1, height: value })).toBe(false)
  expect(ready(event, { attemptId: snapshot.attemptId, generation: 2, height: 100 })).toBe(false)
  expect(ready({ ...event, senderFrame: {} }, { attemptId: snapshot.attemptId, generation: 1, height: 100 })).toBe(false)
  expect(s.child.setContentSize).not.toHaveBeenCalled()
  expect(ready(event, { attemptId: snapshot.attemptId, generation: 1, height: 9000 })).toBe(true)
  expect(s.child.setContentSize).toHaveBeenCalledWith(490, 1048)
  s.host.dispose()
})
it('loads a sandboxed child with no inherited URL data and uses current main frame authorization', async () => {
  const s = setup('http://localhost:3000/?private=1#secret')
  s.binding.notify(snapshot)
  s.acknowledge()
  await vi.waitFor(() => expect(s.child.showInactive).toHaveBeenCalledOnce())
  expect(electron.options).toMatchObject({ parent: s.owner, frame: false, show: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } })
  expect(s.child.loadURL).toHaveBeenCalledExactlyOnceWith('http://localhost:3000/?surface=close-recovery')
  const old = s.child.webContents.mainFrame; s.child.webContents.mainFrame = {}
  const get = s.handlers.get(CLOSE_RECOVERY_CHANNELS.get)!
  expect(get({ sender: s.child.webContents, senderFrame: old })).toBeNull()
  expect(get({ sender: s.child.webContents, senderFrame: s.child.webContents.mainFrame })).toMatchObject({ dark: true, themeColor: '#123456' })
  const preventDefault = vi.fn(); s.child.webContents.emit('will-navigate', { preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  s.binding.notify({ ...snapshot, state: 'cancelled' })
  expect(s.owner.webContents.send).toHaveBeenCalledExactlyOnceWith(CLOSE_PREPARATION_CHANNELS.released, { attemptId: snapshot.attemptId, generation: 1 })
  s.host.dispose(); expect(s.owner.destroy).not.toHaveBeenCalled()
})
it('treats child close as cancellation of an AI prompt, without closing the document window', async () => {
  const s = setup(); s.binding.notify(snapshot)
  const decision = s.binding.confirmStopAi(snapshot)
  s.acknowledge()
  await vi.waitFor(() => expect(s.child.show).toHaveBeenCalledOnce())
  const preventDefault = vi.fn(); s.child.emit('close', { preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce(); expect(await decision).toBe(false)
  expect(s.owner.destroy).not.toHaveBeenCalled()
  s.host.dispose()
})
it('offers only explicit safe choices when independent renderer loading fails', async () => {
  const s = setup(); s.child.loadFile.mockRejectedValueOnce(new Error('private error/path'))
  electron.showMessageBox.mockResolvedValue({ response: 0 })
  s.binding.notify(snapshot)
  await vi.waitFor(() => expect(electron.showMessageBox).toHaveBeenCalledOnce())
  expect(electron.showMessageBox).toHaveBeenCalledWith(s.owner, expect.objectContaining({ buttons: ['保留窗口', '复制诊断'], cancelId: 0, defaultId: 0 }))
  expect(JSON.stringify(electron.showMessageBox.mock.calls)).not.toContain('private error/path')
  expect(s.owner.destroy).not.toHaveBeenCalled()
  s.host.dispose()
})

it('never authorizes AI cancellation or closes the owner when the styled fallback also fails', async () => {
  const s = setup(); s.child.loadFile.mockRejectedValueOnce(new Error('recovery unavailable'))
  electron.showMessageBox.mockRejectedValueOnce(new Error('dialog unavailable'))
  s.binding.notify(snapshot)
  let settled = false
  const decision = s.binding.confirmStopAi(snapshot).then(value => { settled = true; return value })
  await vi.waitFor(() => expect(electron.showMessageBox).toHaveBeenCalledOnce())
  expect(electron.showMessageBox).toHaveBeenCalledWith(s.owner, expect.objectContaining({
    buttons: ['继续使用', '停止任务并关闭'], defaultId: 0, cancelId: 0,
  }))
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(s.owner.destroy).not.toHaveBeenCalled()
  s.host.dispose()
  expect(await decision).toBe(false)
})

it('retains the owner when the user cancels the styled AI fallback', async () => {
  const s = setup(); s.child.loadFile.mockRejectedValueOnce(new Error('recovery unavailable'))
  electron.showMessageBox.mockResolvedValueOnce({ response: 0 })
  s.binding.notify(snapshot)
  const decision = s.binding.confirmStopAi(snapshot)
  expect(await decision).toBe(false)
  expect(s.owner.destroy).not.toHaveBeenCalled()
  s.host.dispose()
})
