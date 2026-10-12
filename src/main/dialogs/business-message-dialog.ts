import { BrowserWindow, screen, type IpcMain, type IpcMainInvokeEvent, type MessageBoxOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { BUSINESS_MESSAGE_CHANNELS as channels, parseBusinessMessageState, type BusinessMessageState } from '../../shared/business-message-dialog'

type MessageOptions = Pick<MessageBoxOptions, 'type' | 'title' | 'message' | 'detail' | 'buttons' | 'defaultId' | 'cancelId' | 'noLink'>
interface Request {
  owner?: BrowserWindow
  state: BusinessMessageState
  resolve(result: { response: number }): void
  reject(error: Error): void
  ownerClosed(): void
  view?: BrowserWindow
  timer?: ReturnType<typeof setTimeout>
  loaded: boolean
  ready: boolean
  shown: boolean
  settled: boolean
}

/** Independent of the document renderer: usable before startup recovery and in tray-only Arknote. */
export function createBusinessMessageDialog(options: {
  ipcMain: IpcMain
  preloadPath: string
  rendererUrl?: string
  rendererFile: string
  appearance(): { dark: boolean }
}) {
  let active: Request | undefined
  let disposed = false
  const queue: Request[] = []
  const unavailable = () => new Error('提示窗口暂不可用，未收到确认。请重试。')

  function finish(request: Request, response?: number) {
    if (request.settled) return
    request.settled = true
    if (request.timer) clearTimeout(request.timer)
    request.owner?.removeListener('closed', request.ownerClosed)
    const index = queue.indexOf(request)
    if (index >= 0) queue.splice(index, 1)
    if (active === request) active = undefined
    if (response === undefined) request.reject(unavailable())
    else request.resolve({ response })
    // Create any queued view first: briefly having no windows must not quit the application.
    pump()
    if (request.view && !request.view.isDestroyed()) request.view.destroy()
  }
  function showWhenReady(request: Request) {
    if (!request.settled && request.loaded && request.ready && !request.shown) {
      try {
        request.view!.show()
        request.shown = true
        clearTimeout(request.timer)
      } catch { finish(request) }
    }
  }
  function pump() {
    if (disposed || active) return
    const request = queue.shift()
    if (!request) return
    active = request
    if (request.owner?.isDestroyed()) { finish(request); return }
    try {
      const view = new BrowserWindow({
        ...(request.owner ? { parent: request.owner, modal: true } : {}),
        width: 520, height: 320, minWidth: 420, minHeight: 120,
        title: request.state.title, frame: false, show: false, resizable: true,
        minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: !!request.owner, backgroundColor: request.state.dark ? '#202124' : '#ffffff',
        webPreferences: { preload: options.preloadPath, sandbox: true, contextIsolation: true,
          nodeIntegration: false, webSecurity: true },
      })
      request.view = view
      view.removeMenu()
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const deny = (event: { preventDefault(): void }) => event.preventDefault()
      view.webContents.on('will-navigate', deny)
      view.webContents.on('will-redirect', deny)
      view.webContents.once('render-process-gone', () => finish(request))
      view.webContents.once('destroyed', () => finish(request))
      view.on('close', event => { event.preventDefault(); finish(request, request.shown ? request.state.cancelId : undefined) })
      request.timer = setTimeout(() => finish(request), 15_000)
      let loaded: Promise<void>
      if (options.rendererUrl) {
        const url = new URL(options.rendererUrl)
        url.search = ''; url.hash = ''; url.searchParams.set('surface', 'business-dialog')
        loaded = view.loadURL(url.toString())
      } else loaded = view.loadFile(options.rendererFile, { query: { surface: 'business-dialog' } })
      void loaded.then(() => { request.loaded = true; showWhenReady(request) }, () => finish(request))
    } catch { finish(request) }
  }
  function authorize(event: IpcMainInvokeEvent): Request | undefined {
    const request = active
    return request && !request.settled && request.view && !request.view.isDestroyed()
      && event.sender === request.view.webContents && event.senderFrame === request.view.webContents.mainFrame
      ? request : undefined
  }
  options.ipcMain.handle(channels.get, event => authorize(event)?.state ?? null)
  options.ipcMain.handle(channels.ready, (event, input: unknown) => {
    const request = authorize(event)
    if (!request || !input || typeof input !== 'object'
      || (input as { requestId?: unknown }).requestId !== request.state.requestId) return false
    const height = (input as { height?: unknown }).height
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return false
    try {
      const view = request.view!, before = view.getBounds(), content = view.getContentBounds()
      const area = screen.getDisplayMatching(before).workArea
      const chromeHeight = Math.max(0, before.height - content.height)
      const fitted = Math.max(120, Math.min(Math.ceil(height), area.height - 32 - chromeHeight))
      if (content.height !== fitted) view.setContentSize(content.width, fitted)
      const after = view.getBounds()
      const centeredY = request.shown ? before.y : before.y + (before.height - after.height) / 2
      const y = Math.round(Math.max(area.y + 16, Math.min(centeredY, area.y + area.height - after.height - 16)))
      if (after.y !== y) view.setPosition(after.x, y)
    } catch { finish(request); return false }
    request.ready = true
    showWhenReady(request)
    return true
  })
  options.ipcMain.handle(channels.respond, (event, input: unknown) => {
    const request = authorize(event)
    if (!request?.shown || !input || typeof input !== 'object') return false
    const value = input as { requestId?: unknown; response?: unknown }
    if (value.requestId !== request.state.requestId || !Number.isInteger(value.response)
      || (value.response as number) < 0 || (value.response as number) >= request.state.buttons.length) return false
    finish(request, value.response as number)
    return true
  })
  return {
    async showMessageBox(owner: BrowserWindow | undefined, input: MessageOptions): Promise<{ response: number }> {
      if (disposed || owner?.isDestroyed()) return Promise.reject(unavailable())
      const buttons = input.buttons?.length ? [...input.buttons] : ['确定']
      const state = parseBusinessMessageState({ requestId: randomUUID(), title: input.title || 'Arkdown',
        message: input.message, detail: input.detail || '', buttons, defaultId: input.defaultId ?? 0,
        cancelId: input.cancelId ?? Math.max(0, buttons.findIndex(text => ['取消', '否', '稍后'].includes(text))),
        dark: options.appearance().dark })
      if (!state) return Promise.reject(unavailable())
      return new Promise((resolve, reject) => {
        const request: Request = { owner, state, resolve, reject, loaded: false, ready: false, shown: false, settled: false,
          ownerClosed: () => finish(request) }
        owner?.once('closed', request.ownerClosed)
        queue.push(request)
        pump()
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const channel of Object.values(channels)) options.ipcMain.removeHandler(channel)
      for (const request of [...(active ? [active] : []), ...queue]) finish(request)
    },
  }
}
