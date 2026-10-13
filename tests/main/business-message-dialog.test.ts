// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain } from 'electron'
import { BUSINESS_MESSAGE_CHANNELS as channels } from '../../src/shared/business-message-dialog'

const electron = vi.hoisted(() => ({ windows: [] as any[], create: undefined as unknown }))
vi.mock('electron', () => ({ BrowserWindow: class { constructor(options: unknown) {
  const window = (electron.create as (options: unknown) => unknown)(options)
  electron.windows.push(window); return window as BrowserWindow
} }, screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }) } }))
import { createBusinessMessageDialog } from '../../src/main/dialogs/business-message-dialog'
import { DefaultApplicationsStartup } from '../../src/main/default-applications/startup'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'

class FakeWindow extends EventEmitter {
  destroyed = false
  webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler: vi.fn() })
  constructor(readonly options: unknown) { super() }
  isDestroyed = () => this.destroyed
  bounds = { x: 380, y: 200, width: 520, height: 320 }
  getBounds = () => ({ ...this.bounds })
  getContentBounds = () => ({ ...this.bounds })
  setContentSize = vi.fn((width: number, height: number) => { Object.assign(this.bounds, { width, height }) })
  setPosition = vi.fn((x: number, y: number) => { Object.assign(this.bounds, { x, y }) })
  show = vi.fn(); removeMenu = vi.fn()
  loadURL = vi.fn(async () => undefined); loadFile = vi.fn(async () => undefined)
  destroy = vi.fn(() => { this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed') })
}
const hosts: Array<{ dispose(): void }> = []
function setup() {
  electron.windows = []; electron.create = (options: unknown) => new FakeWindow(options)
  const handlers = new Map<string, (event: any, input?: any) => any>()
  const ipc = { handle: (name: string, handler: any) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) }
  const host = createBusinessMessageDialog({ ipcMain: ipc as unknown as IpcMain, preloadPath: 'preload.js',
    rendererFile: 'index.html', rendererUrl: 'http://localhost:3000/?secret=1#private', appearance: () => ({ dark: true }) })
  hosts.push(host)
  const child = () => electron.windows.at(-1) as FakeWindow
  const event = () => ({ sender: child().webContents, senderFrame: child().webContents.mainFrame })
  const get = () => handlers.get(channels.get)!(event())
  const ready = (height = 200) => handlers.get(channels.ready)!(event(), { requestId: get().requestId, height })
  const choose = (response: number) => handlers.get(channels.respond)!(event(), { requestId: get().requestId, response })
  return { host, handlers, child, event, get, ready, choose }
}
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); vi.useRealTimers() })

it('cancels an optional prompt still loading when a workspace interaction takes priority', async () => {
  const s = setup(), controller = new AbortController()
  const result = s.host.showMessageBox(undefined, {
    message: '是否将 Arkdown 设为默认程序？', buttons: ['是', '否'], cancelId: 1,
  }, controller.signal)
  const outcome = result.then(() => 'answered', error => error.name)
  const loadingWindow = s.child()
  controller.abort()
  await Promise.resolve()
  expect(loadingWindow.destroyed).toBe(true)
  expect(loadingWindow.show).not.toHaveBeenCalled()
  expect(await outcome).toBe('AbortError')
})

it('does not cancel an optional prompt that the user is already viewing', async () => {
  const s = setup(), controller = new AbortController()
  const result = s.host.showMessageBox(undefined, { message: '默认程序', buttons: ['是', '否'], cancelId: 1 }, controller.signal)
  s.ready(); await Promise.resolve()
  controller.abort()
  expect(s.child().destroyed).toBe(false)
  expect(s.child().show).toHaveBeenCalledOnce()
  s.choose(1)
  expect(await result).toEqual({ response: 1 })
})

it('does not create a view for an already deferred optional prompt', async () => {
  const s = setup(), controller = new AbortController()
  controller.abort()
  await expect(s.host.showMessageBox(undefined, { message: '默认程序' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(electron.windows).toHaveLength(0)
})

it('removes an aborted queued prompt without dismissing the currently visible dialog', async () => {
  const s = setup(), controller = new AbortController()
  const first = s.host.showMessageBox(undefined, { message: '正在处理工作区', buttons: ['确定'] })
  s.ready(); await Promise.resolve()
  const visible = s.child()
  const queued = s.host.showMessageBox(undefined, { message: '默认程序' }, controller.signal)
  const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  expect(visible.destroyed).toBe(false)
  expect(electron.windows).toHaveLength(1)
  s.choose(0)
  await first
  expect(electron.windows).toHaveLength(1)
})

it('keeps a deferred startup reminder pending while the independent close reminder remains usable', async () => {
  const s = setup()
  const settings = new SettingsCoordinator({ save: async () => {} }, {
    lastWorkspace: null, defaultApplicationsPrompt: { starts: 1, handled: false, version: '1.0.4' },
  })
  const startup = new DefaultApplicationsStartup(settings, {
    getStatus: async () => ({ markdown: true, text: false }),
    setEnabled: async () => ({ markdown: true, text: true }),
  }, '1.0.4')
  const prompt = async (signal?: AbortSignal) => {
    const result = await s.host.showMessageBox(undefined, { message: '默认程序', buttons: ['是', '否'], cancelId: 1 }, signal)
    return result.response === 0
  }
  const starting = startup.onReady(prompt)
  await vi.waitFor(() => expect(electron.windows).toHaveLength(1))
  startup.deferStartupOffer()
  await starting
  expect(settings.get().defaultApplicationsPrompt).toMatchObject({ starts: 2, handled: false })
  const closing = startup.onClose(prompt)
  await vi.waitFor(() => expect(electron.windows).toHaveLength(2))
  s.ready(); await Promise.resolve(); s.choose(1)
  await closing
  expect(settings.get().defaultApplicationsPrompt).toMatchObject({ starts: 2, handled: false, closeHandled: true })
})
const recovery = { title: '保留的草稿', message: '是否恢复？', detail: '文档仍保留。', buttons: ['恢复', '暂不恢复'], defaultId: 0, cancelId: 1 }
it('fits measured content before showing, keeps the width, and caps long content to the work area', async () => {
  const s = setup(); const result = s.host.showMessageBox(undefined, recovery)
  await Promise.resolve()
  s.child().show.mockImplementation(() => { expect(s.child().bounds.height).toBe(170) })
  expect(s.ready(169.4)).toBe(true)
  expect(s.child().bounds).toEqual({ x: 380, y: 275, width: 520, height: 170 })
  s.ready(10_000)
  expect(s.child().bounds).toEqual({ x: 380, y: 16, width: 520, height: 688 })
  expect(s.child().show).toHaveBeenCalledOnce()
  s.ready(1)
  expect(s.child().bounds.height).toBe(120)
  s.choose(0); await result
})
it('rejects missing or invalid measurements without revealing an unmeasured window', async () => {
  const s = setup(); const result = s.host.showMessageBox(undefined, recovery)
  const ready = s.handlers.get(channels.ready)!
  for (const height of [undefined, '200', NaN, Infinity, -1, 0]) {
    expect(ready(s.event(), { requestId: s.get().requestId, height })).toBe(false)
  }
  await Promise.resolve(); expect(s.child().show).not.toHaveBeenCalled()
  s.ready(); s.choose(1); await result
})
it('works without a document window and waits for both load and authenticated renderer readiness', async () => {
  const s = setup(); const result = s.host.showMessageBox(undefined, recovery)
  expect(s.child().options).toMatchObject({ frame: false, show: false, skipTaskbar: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
  expect(s.child().loadURL).toHaveBeenCalledWith('http://localhost:3000/?surface=business-dialog')
  expect(s.get()).toMatchObject({ ...recovery, dark: true })
  await Promise.resolve(); expect(s.child().show).not.toHaveBeenCalled()
  s.ready(); expect(s.child().show).toHaveBeenCalledOnce()
  s.choose(0); expect(await result).toEqual({ response: 0 }); expect(s.child().destroy).toHaveBeenCalledOnce()
})
it('rejects spoofed frames, stale requests and invalid decisions without consuming the request', async () => {
  const s = setup(); const result = s.host.showMessageBox(undefined, recovery)
  const get = s.handlers.get(channels.get)!, respond = s.handlers.get(channels.respond)!
  expect(get({ sender: {}, senderFrame: s.event().senderFrame })).toBeNull()
  expect(get({ sender: s.event().sender, senderFrame: {} })).toBeNull()
  const requestId = s.get().requestId
  for (const input of [{ requestId: 'old', response: 0 }, { requestId, response: -1 }, { requestId, response: 2 }, { requestId, response: 0.5 }]) {
    expect(respond(s.event(), input)).toBe(false)
  }
  expect(s.choose(0)).toBe(false) // renderer must first acknowledge readiness
  s.ready(); await Promise.resolve(); s.choose(1)
  expect(await result).toEqual({ response: 1 })
  expect(respond(s.event(), { requestId, response: 0 })).toBe(false)
})
it('maps an actual window close to cancel and never destroys the document owner', async () => {
  const s = setup(), owner = new FakeWindow({})
  const result = s.host.showMessageBox(owner as unknown as BrowserWindow, recovery)
  expect(s.child().options).toMatchObject({ parent: owner, modal: true, skipTaskbar: true })
  s.ready(); await Promise.resolve()
  const preventDefault = vi.fn(); s.child().emit('close', { preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce(); expect(await result).toEqual({ response: 1 })
  expect(owner.destroy).not.toHaveBeenCalled()
})
it.each(['load', 'crash', 'timeout', 'owner', 'dispose'] as const)('rejects %s failure without implying recovery was declined', async kind => {
  vi.useFakeTimers(); const s = setup(), owner = new FakeWindow({})
  if (kind === 'load') electron.create = (options: unknown) => {
    const child = new FakeWindow(options); child.loadURL.mockRejectedValue(new Error('private path')); return child
  }
  const result = s.host.showMessageBox(owner as unknown as BrowserWindow, recovery)
  const assertion = expect(result).rejects.toThrow('提示窗口暂不可用')
  if (kind === 'crash') s.child().webContents.emit('render-process-gone')
  if (kind === 'timeout') await vi.advanceTimersByTimeAsync(15_001)
  if (kind === 'owner') owner.emit('closed')
  if (kind === 'dispose') s.host.dispose()
  await assertion; expect(owner.destroy).not.toHaveBeenCalled()
})
it('serializes concurrent prompts and rejects pending requests when their owner closes', async () => {
  const s = setup(), owner = new FakeWindow({})
  const first = s.host.showMessageBox(undefined, recovery)
  const second = s.host.showMessageBox(owner as unknown as BrowserWindow, recovery)
  const third = s.host.showMessageBox(undefined, { message: '完成' })
  const rejected = expect(second).rejects.toThrow('提示窗口暂不可用')
  owner.emit('closed'); await rejected
  expect(electron.windows).toHaveLength(1)
  s.ready(); await Promise.resolve(); s.choose(1); await first
  expect(electron.windows).toHaveLength(2)
  expect(s.get()).toMatchObject({ buttons: ['确定'], defaultId: 0, cancelId: 0 })
  s.ready(); await Promise.resolve(); s.choose(0); await third
})
it('does not allow navigation or new windows', async () => {
  const s = setup(); const result = s.host.showMessageBox(undefined, recovery)
  const failure = expect(result).rejects.toThrow()
  const preventDefault = vi.fn(); s.child().webContents.emit('will-navigate', { preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(s.child().webContents.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://example.com' })).toEqual({ action: 'deny' })
  s.host.dispose(); await failure
})
it('rejects native show failure instead of leaving a confirmed but invisible request hanging', async () => {
  const s = setup(); const result = s.host.showMessageBox(undefined, recovery)
  const failure = expect(result).rejects.toThrow('提示窗口暂不可用')
  s.child().show.mockImplementation(() => { throw new Error('native failure') })
  await Promise.resolve(); s.ready(); await failure
})
it('treats a never-shown window closing as unavailability, not user dismissal', async () => {
  const s = setup(); const result = s.host.showMessageBox(undefined, recovery)
  const failure = expect(result).rejects.toThrow('提示窗口暂不可用')
  s.child().emit('close', { preventDefault: vi.fn() }); await failure
})
