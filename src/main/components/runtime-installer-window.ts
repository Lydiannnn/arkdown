import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RuntimeInstallPresentation, RuntimeInstallPresenter } from './runtime-install-broker'
import type { RuntimeInstallSnapshot } from '../../shared/runtime-component'

export function createRuntimeInstallerWindow(input: RuntimeInstallPresentation, appearance: { dark: boolean; themeColor: string }): RuntimeInstallPresenter {
  const token = randomUUID()
  const channel = `runtime-installer:${token}`
  const focused = BrowserWindow.getFocusedWindow()
  const window = new BrowserWindow({
    width: 440, height: 280, resizable: false, minimizable: false, maximizable: false,
    show: false, frame: false, roundedCorners: true, hasShadow: true,
    title: '安装组件 — Arkdown', backgroundColor: appearance.dark ? '#181818' : '#ffffff',
    ...(focused && !focused.isDestroyed() ? { parent: focused, modal: true } : {}),
    webPreferences: { preload: path.join(__dirname, 'runtime-installer-preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
      additionalArguments: [`--arkdown-runtime-installer=${token}`] },
  })
  let closed = false
  let snapshot = input.snapshot
  const authorized = (event: IpcMainInvokeEvent) => !closed && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
  ipcMain.handle(`${channel}:state`, event => {
    if (!authorized(event)) throw new Error('Invalid component window')
    return snapshot
  })
  ipcMain.handle(`${channel}:retry`, event => { if (authorized(event)) input.retry() })
  ipcMain.handle(`${channel}:cancel`, event => { if (authorized(event)) input.cancel() })
  const clean = () => {
    for (const suffix of ['state', 'retry', 'cancel']) ipcMain.removeHandler(`${channel}:${suffix}`)
  }
  window.on('close', event => { if (!closed) { event.preventDefault(); input.cancel() } })
  window.once('closed', () => { if (!closed) input.cancel(); closed = true; clean() })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.once('ready-to-show', () => { if (!closed) window.show() })
  const query = { surface: 'runtime-installer', theme: appearance.dark ? 'dark' : 'light', themeColor: appearance.themeColor }
  const fail = () => { input.cancel() }
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
    url.search = new URLSearchParams(query).toString()
    void window.loadURL(url.toString()).catch(fail)
  } else void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), { query }).catch(fail)
  return {
    update(next: RuntimeInstallSnapshot) {
      snapshot = next
      if (!closed && !window.webContents.isDestroyed()) window.webContents.send(`${channel}:changed`, snapshot)
    },
    close() { if (closed) return; closed = true; clean(); window.close() },
  }
}
