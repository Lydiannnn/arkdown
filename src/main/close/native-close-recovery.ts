import { BrowserWindow, clipboard, screen, type IpcMain, type MessageBoxOptions, type NativeTheme } from 'electron'
import { CLOSE_RECOVERY_CHANNELS, type CloseRecoveryAction } from '../../shared/close-recovery'
import { CLOSE_PREPARATION_CHANNELS } from '../../shared/close-preparation'
import { createCloseRecoveryHost, type CloseRecoveryView } from './close-recovery-host'
import type { CloseDiagnosticLog } from './close-diagnostic-log'

/** This window is independent of the document renderer whose responsiveness is being checked. */
export function createNativeCloseRecovery(options: {
  ipcMain: IpcMain
  preloadPath: string
  rendererUrl?: string
  rendererFile: string
  version: string
  platform: 'win32' | 'darwin' | 'linux'
  diagnostics: Pick<CloseDiagnosticLog, 'record'>
  nativeTheme: Pick<NativeTheme, 'shouldUseDarkColors'>
  appearance(): { editorTheme: string; themeColor?: string }
  showMessageBox(owner: BrowserWindow | undefined, options: Pick<MessageBoxOptions,
    'type' | 'title' | 'message' | 'detail' | 'buttons' | 'defaultId' | 'cancelId' | 'noLink'>): Promise<{ response: number }>
}) {
  const host = createCloseRecoveryHost<BrowserWindow>({
    handle: (channel, handler) => options.ipcMain.handle(channel, handler),
    removeHandler: channel => options.ipcMain.removeHandler(channel),
    version: options.version, platform: options.platform,
    copy: text => clipboard.writeText(text), record: event => options.diagnostics.record(event),
    createView(owner, events): CloseRecoveryView {
      const window = new BrowserWindow({ parent: owner, width: 490, height: 220, minWidth: 430, minHeight: 120,
        title: '关闭 Arkdown', frame: false, show: false, resizable: true, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, backgroundColor: '#202020',
        webPreferences: { preload: options.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
      })
      let disposed = false
      const deny = (event: { preventDefault(): void }) => event.preventDefault()
      const unavailable = () => { if (!disposed) events.unavailable() }
      window.removeMenu()
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', deny)
      window.webContents.on('will-redirect', deny)
      window.webContents.on('render-process-gone', unavailable)
      window.webContents.once('destroyed', unavailable)
      window.on('close', event => { if (!disposed) { event.preventDefault(); events.close() } })
      let ready: Promise<void>
      try {
        if (options.rendererUrl) {
          const url = new URL(options.rendererUrl)
          url.search = ''; url.hash = ''; url.searchParams.set('surface', 'close-recovery')
          ready = window.loadURL(url.toString())
        } else ready = window.loadFile(options.rendererFile, { query: { surface: 'close-recovery' } })
      } catch (error) { ready = Promise.reject(error) }
      return {
        sender: window.webContents,
        // Resolve the main frame at authorization time: Chromium may replace it during initial navigation.
        get mainFrame() { return window.webContents.mainFrame },
        ready,
        send: state => { window.webContents.send(CLOSE_RECOVERY_CHANNELS.changed, state) },
        show: focus => { if (focus) window.show(); else window.showInactive() },
        hide: () => window.hide(),
        fit(height) {
          if (disposed || window.isDestroyed()) return
          const before = window.getBounds(), content = window.getContentBounds()
          const area = screen.getDisplayMatching(before).workArea
          const chromeHeight = Math.max(0, before.height - content.height)
          const fitted = Math.max(120, Math.min(Math.ceil(height), area.height - 32 - chromeHeight))
          if (content.height !== fitted) window.setContentSize(content.width, fitted)
          const after = window.getBounds()
          const y = Math.round(Math.max(area.y + 16, Math.min(before.y, area.y + area.height - after.height - 16)))
          if (after.y !== y) window.setPosition(after.x, y)
        },
        destroy: () => { if (disposed) return; disposed = true; if (!window.isDestroyed()) window.destroy() },
      }
    },
    async fallback(owner, state) {
      if (owner.isDestroyed()) return undefined
      const choices: Array<{ text: string; action: CloseRecoveryAction['action'] | undefined }> = state.confirmAi
        ? [{ text: '继续使用', action: 'continue-using' }, { text: '停止任务并关闭', action: 'stop-ai-and-close' }]
        : [{ text: '保留窗口', action: undefined }, { text: '复制诊断', action: 'copy' },
            ...(state.canReturn ? [{ text: '返回编辑', action: 'return' as const }] : []),
            ...(state.canRetry ? [{ text: '重试关闭', action: 'retry' as const }] : [])]
      const result = await options.showMessageBox(owner, { type: 'info', title: '关闭 Arkdown',
        message: state.confirmAi ? 'AI 任务仍在运行，是否停止任务并关闭？' : '关闭状态界面暂不可用，当前窗口会继续保留。',
        detail: state.confirmAi ? '已提交的修改不会被撤销。'
          : '尚未确认完成的操作不会被强制中断。可复制诊断信息，或在结果确定后安全返回、重试。',
        buttons: choices.map(choice => choice.text), defaultId: 0, cancelId: 0, noLink: true,
      })
      return owner.isDestroyed() ? undefined : choices[result.response]?.action
    },
  })
  return {
    attach(owner: BrowserWindow) {
      return host.attach(owner, {
        release: attempt => {
          if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send(CLOSE_PREPARATION_CHANNELS.released, attempt)
        },
        theme: () => {
          const appearance = options.appearance()
          return { dark: appearance.editorTheme === 'dark' || appearance.editorTheme === 'system' && options.nativeTheme.shouldUseDarkColors,
            themeColor: appearance.themeColor ?? '#c82929' }
        },
      })
    },
    dispose: () => host.dispose(),
  }
}
