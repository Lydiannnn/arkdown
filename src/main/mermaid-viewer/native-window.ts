import { BrowserWindow, clipboard, dialog, nativeImage, type NativeImage, type Rectangle } from 'electron'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import type { MermaidViewerSnapshot } from '../../shared/mermaid-viewer'
import { WINDOW_STATE_CHANGED_CHANNEL, type WindowControlAction, type WindowStateSnapshot } from '../../shared/contracts'
import { appError } from '../../shared/public-errors'
import { registerMermaidViewerWindowIpc } from '../ipc/register-ipc'
import type { MermaidViewerHandle } from './manager'
import { MermaidImageExportService } from '../assets/mermaid-image-export-service'

interface MermaidViewerWindowOptions {
  snapshot: MermaidViewerSnapshot
  workArea: Rectangle
  preloadPath: string
  rendererUrl?: string
  rendererFile: string
  ipcMain: Parameters<typeof registerMermaidViewerWindowIpc>[0]['ipcMain']
}

export function createMermaidViewerWindow(options: MermaidViewerWindowOptions): MermaidViewerHandle {
  const { workArea } = options
  if (![workArea.x, workArea.y, workArea.width, workArea.height].every(Number.isFinite)
    || workArea.width < 1 || workArea.height < 1
    || Object.values(workArea).some(value => Math.abs(value) > 1_000_000)) {
    throw appError('INVALID_INPUT')
  }
  const width = Math.max(1, Math.min(1120, Math.floor(workArea.width * 0.85)))
  const height = Math.max(1, Math.min(820, Math.floor(workArea.height * 0.85)))
  const window = new BrowserWindow({
    width, height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    minWidth: Math.min(480, width), minHeight: Math.min(320, height),
    title: 'Mermaid 图形 — Arkdown',
    frame: false, show: false, resizable: true, movable: true,
    minimizable: true, maximizable: true, fullscreenable: true,
    autoHideMenuBar: true,
    backgroundColor: options.snapshot.colorScheme === 'dark' ? '#171717' : '#ffffff',
    webPreferences: {
      preload: options.preloadPath,
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
    },
  })
  let disposed = false
  let registration: ReturnType<typeof registerMermaidViewerWindowIpc> | undefined
  let state: WindowStateSnapshot = { maximized: false, fullscreen: false, revision: 0 }
  const publishState = () => {
    if (disposed || window.isDestroyed() || window.webContents.isDestroyed()) return
    const maximized = window.isMaximized()
    const fullscreen = window.isFullScreen()
    if (state.maximized === maximized && state.fullscreen === fullscreen) return
    state = { maximized, fullscreen, revision: state.revision + 1 }
    window.webContents.send(WINDOW_STATE_CHANGED_CHANNEL, state)
  }
  const controlWindow = (action: WindowControlAction) => {
    if (disposed || window.isDestroyed()) return state
    if (action === 'minimize') window.minimize()
    else if (action === 'toggle-maximize') {
      if (window.isFullScreen()) window.setFullScreen(false)
      else if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    } else if (action === 'toggle-fullscreen') window.setFullScreen(!window.isFullScreen())
    else if (action === 'exit-fullscreen') window.setFullScreen(false)
    else window.close()
    publishState()
    return state
  }
  const denyNavigation = (event: { preventDefault(): void }) => event.preventDefault()
  const dispose = () => {
    if (disposed) return
    disposed = true
    registration?.dispose()
    window.removeListener('closed', dispose)
    window.removeListener('maximize', publishState)
    window.removeListener('unmaximize', publishState)
    window.removeListener('enter-full-screen', publishState)
    window.removeListener('leave-full-screen', publishState)
    window.webContents.removeListener('will-navigate', denyNavigation)
    window.webContents.removeListener('will-redirect', denyNavigation)
    window.webContents.removeListener('render-process-gone', destroy)
    window.webContents.removeListener('destroyed', destroy)
  }
  const destroy = () => {
    dispose()
    if (!window.isDestroyed()) window.destroy()
  }
  try {
    window.removeMenu()
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', denyNavigation)
    window.webContents.on('will-redirect', denyNavigation)
    window.webContents.on('render-process-gone', destroy)
    window.webContents.once('destroyed', destroy)
    window.once('closed', dispose)
    window.on('maximize', publishState)
    window.on('unmaximize', publishState)
    window.on('enter-full-screen', publishState)
    window.on('leave-full-screen', publishState)
    registration = registerMermaidViewerWindowIpc({
      ipcMain: options.ipcMain, window,
      getMermaidViewerSnapshot: () => options.snapshot,
      controlWindow, getWindowState: () => state,
      mermaidImageExport: new MermaidImageExportService({
        createNativeImage: dataUrl => nativeImage.createFromDataURL(dataUrl),
        writeClipboardImage: image => clipboard.writeImage(image as NativeImage),
        chooseTarget: async () => {
          if (disposed || window.isDestroyed()) return null
          const result = await dialog.showSaveDialog(window, {
            title: 'Mermaid 图形另存为',
            defaultPath: 'Mermaid 图形.png',
            filters: [{ name: 'PNG 图片', extensions: ['png'] }],
          })
          if (disposed || window.isDestroyed() || result.canceled || !result.filePath) return null
          return path.extname(result.filePath).toLowerCase() === '.png' ? result.filePath : `${result.filePath}.png`
        },
        writeFileAtomic: (targetPath, bytes) => writeFileAtomic(targetPath, bytes, { fsync: true }),
      }),
    })
  } catch (error) {
    destroy()
    throw error
  }
  return {
    window,
    dispose,
    load: async () => {
      try {
        if (disposed || window.isDestroyed()) throw appError('OPERATION_FAILED')
        if (options.rendererUrl) {
          const url = new URL(options.rendererUrl)
          url.search = ''
          url.hash = ''
          url.searchParams.set('surface', 'mermaid-viewer')
          await window.loadURL(url.toString())
        } else {
          await window.loadFile(options.rendererFile, { query: { surface: 'mermaid-viewer' } })
        }
      } catch (error) {
        destroy()
        throw error
      }
    },
  }
}
