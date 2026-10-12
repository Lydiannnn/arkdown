import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ options: undefined as any, next: undefined as any, showSaveDialog: vi.fn(), createFromDataURL: vi.fn(), writeFileAtomic: vi.fn() }))
vi.mock('write-file-atomic', () => ({ default: electron.writeFileAtomic }))
vi.mock('electron', () => ({ dialog: { showSaveDialog: electron.showSaveDialog }, nativeImage: { createFromDataURL: electron.createFromDataURL }, clipboard: { writeImage: vi.fn() }, BrowserWindow: class {
  constructor(options: unknown) { electron.options = options; return electron.next }
} }))

import { createMermaidViewerWindow } from '../../src/main/mermaid-viewer/native-window'
import { IPC_CHANNELS } from '../../src/shared/contracts'

class Window extends EventEmitter {
  destroyed = false
  maximized = false
  fullscreen = false
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: {}, isDestroyed: () => this.destroyed, send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  })
  isDestroyed = () => this.destroyed
  isMinimized = () => false
  isMaximized = () => this.maximized
  isFullScreen = () => this.fullscreen
  restore = vi.fn()
  show = vi.fn()
  focus = vi.fn()
  minimize = vi.fn()
  maximize = () => { this.maximized = true; this.emit('maximize') }
  unmaximize = () => { this.maximized = false; this.emit('unmaximize') }
  setFullScreen = (value: boolean) => { this.fullscreen = value; this.emit(value ? 'enter-full-screen' : 'leave-full-screen') }
  close = () => this.destroy()
  destroy = () => { this.destroyed = true; this.emit('closed') }
  removeMenu = vi.fn()
  loadURL = vi.fn(async () => undefined)
  loadFile = vi.fn(async () => undefined)
}

const snapshot = {
  svgDataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`,
  colorScheme: 'dark' as const, themeColor: '#123456',
}

function setup(options: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: any, input?: unknown) => any>()
  const ipcMain = {
    handle: (channel: string, handler: (event: any, input?: unknown) => any) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  }
  const window = new Window()
  electron.next = window
  const handle = createMermaidViewerWindow({
    snapshot, ipcMain, preloadPath: 'preload.js', rendererFile: 'index.html',
    rendererUrl: 'http://localhost:3000/?private=1#secret',
    workArea: { x: -800, y: 20, width: 800, height: 500 }, ...options,
  })
  const invoke = (channel: string, input?: unknown, event = {
    sender: window.webContents, senderFrame: window.webContents.mainFrame,
  }) => handlers.get(channel)!(event, input)
  return { window, handle, handlers, invoke }
}

beforeEach(() => { electron.options = undefined; electron.next = undefined; vi.clearAllMocks() })

it('saves a validated full PNG through a viewer-owned native dialog and treats cancellation quietly', async () => {
  const s = setup()
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(1000, 16); bytes.writeUInt32BE(400, 20); bytes[24] = 8; bytes[25] = 6
  const pngDataUrl = `data:image/png;base64,${bytes.toString('base64')}`
  electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: 'C:\\exports\\whole-diagram' })
    .mockResolvedValueOnce({ canceled: true })
  electron.createFromDataURL.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 1000, height: 400 }), toPNG: () => Buffer.from('canonical-png') })
  try {
    expect(await s.invoke(IPC_CHANNELS.saveMermaidImage, { svgDataUrl: snapshot.svgDataUrl, pngDataUrl })).toEqual({ ok: true, value: null })
    expect(electron.showSaveDialog).toHaveBeenCalledWith(s.window, expect.objectContaining({ defaultPath: 'Mermaid 图形.png', filters: [{ name: 'PNG 图片', extensions: ['png'] }] }))
    expect(electron.writeFileAtomic).toHaveBeenCalledExactlyOnceWith('C:\\exports\\whole-diagram.png', Buffer.from('canonical-png'), { fsync: true })
    expect(await s.invoke(IPC_CHANNELS.saveMermaidImage, { svgDataUrl: snapshot.svgDataUrl, pngDataUrl })).toEqual({ ok: true, value: null })
    expect(electron.writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(await s.invoke(IPC_CHANNELS.saveMermaidImage, { svgDataUrl: snapshot.svgDataUrl, pngDataUrl }, { sender: s.window.webContents, senderFrame: {} })).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
    expect(electron.showSaveDialog).toHaveBeenCalledTimes(2)
    expect(await s.invoke(IPC_CHANNELS.copyMermaidImage, { pngDataUrl })).toMatchObject({ ok: false })
  } finally { s.handle.dispose() }
})

it('creates a sandboxed independent resizable viewer inside its owner display work area', async () => {
  const s = setup()
  expect(electron.options).toMatchObject({
    frame: false, show: false, resizable: true, maximizable: true,
    backgroundColor: '#171717',
    webPreferences: { preload: 'preload.js', sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  })
  expect(electron.options.parent).toBeUndefined()
  expect(electron.options.x).toBeGreaterThanOrEqual(-800)
  expect(electron.options.y).toBeGreaterThanOrEqual(20)
  expect(electron.options.x + electron.options.width).toBeLessThanOrEqual(0)
  expect(electron.options.y + electron.options.height).toBeLessThanOrEqual(520)
  expect(s.window.loadURL).not.toHaveBeenCalled()
  await s.handle.load()
  expect(s.window.loadURL).toHaveBeenCalledWith('http://localhost:3000/?surface=mermaid-viewer')
  s.handle.dispose()
})

it('serves only the owned mainframe snapshot and window controls', async () => {
  const s = setup()
  expect(await s.invoke(IPC_CHANNELS.getMermaidViewerSnapshot)).toEqual({ ok: true, value: snapshot })
  expect(await s.invoke(IPC_CHANNELS.getMermaidViewerSnapshot, undefined, {
    sender: s.window.webContents, senderFrame: {},
  })).toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  expect(await s.invoke(IPC_CHANNELS.readDocument, { path: 'secret.md' })).toMatchObject({ ok: false })
  expect(await s.invoke(IPC_CHANNELS.openMermaidViewer, snapshot)).toMatchObject({ ok: false })
  expect(await s.invoke(IPC_CHANNELS.controlWindow, { action: 'toggle-maximize' })).toMatchObject({ ok: true, value: { maximized: true, fullscreen: false } })
  expect(await s.invoke(IPC_CHANNELS.controlWindow, { action: 'toggle-maximize' })).toMatchObject({ ok: true, value: { maximized: false } })
  s.handle.dispose()
  expect(s.handlers.size).toBe(0)
})

it('denies navigation, redirects and popups; renderer failure closes and disposes the viewer', () => {
  const s = setup()
  const event = { preventDefault: vi.fn() }
  s.window.webContents.emit('will-navigate', event)
  s.window.webContents.emit('will-redirect', event)
  expect(event.preventDefault).toHaveBeenCalledTimes(2)
  expect(s.window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })
  s.window.webContents.emit('render-process-gone')
  expect(s.window.destroyed).toBe(true)
  expect(s.handlers.size).toBe(0)
  expect(s.window.webContents.listenerCount('will-navigate')).toBe(0)
})

it('uses the packaged viewer route and light native background without embedding SVG in the URL', async () => {
  const s = setup({ rendererUrl: undefined, snapshot: { ...snapshot, colorScheme: 'light' } })
  expect(electron.options.backgroundColor).toBe('#ffffff')
  await s.handle.load()
  expect(s.window.loadFile).toHaveBeenCalledWith('index.html', { query: { surface: 'mermaid-viewer' } })
  s.handle.dispose()
})
