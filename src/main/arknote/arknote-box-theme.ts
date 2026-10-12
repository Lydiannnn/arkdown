import type { BrowserWindow, IpcMain } from 'electron'
import { ARKNOTE_BOX_THEME_CHANNEL, ARKNOTE_BOX_THEME_EVENT, parseArknoteBoxTheme, type ArknoteBoxTheme } from '../../shared/arknote-box-theme'

/** A read-only renderer boundary. Only the trusted Arkdown pipe can change this theme. */
export class ArknoteBoxThemeController {
  private readonly windows = new Set<BrowserWindow>()
  private tail = Promise.resolve()
  constructor(private readonly ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
    private theme: ArknoteBoxTheme, private readonly persist: (theme: ArknoteBoxTheme) => Promise<void>) {
    ipc.handle(ARKNOTE_BOX_THEME_CHANNEL, event => {
      const owner = [...this.windows].find(window => !window.isDestroyed() && event.sender === window.webContents)
      if (!owner || event.senderFrame !== owner.webContents.mainFrame) throw new Error('此窗口无权读取便签盒子主题。')
      return { ...this.theme }
    })
  }
  register(window: BrowserWindow): void {
    this.windows.add(window)
    this.applyWindowTheme(window)
    window.once('closed', () => this.windows.delete(window))
  }
  private applyWindowTheme(window: BrowserWindow): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    try {
      window.setBackgroundColor(this.theme.mode === 'dark' ? '#181818' : '#FFFFFF')
      window.setTitleBarOverlay({ color: '#00000000', symbolColor: this.theme.mode === 'dark' ? '#E3E3E3' : '#303030', height: 40 })
    } catch { /* The box can close independently while its theme is changing. */ }
  }
  set(input: unknown): Promise<void> {
    const theme = parseArknoteBoxTheme(input)
    if (!theme) return Promise.reject(new Error('便签盒子主题无效。'))
    const operation = this.tail.then(async () => {
      await this.persist(theme)
      this.theme = theme
      for (const window of this.windows) {
        if (window.isDestroyed() || window.webContents.isDestroyed()) continue
        try {
          this.applyWindowTheme(window)
          window.webContents.send(ARKNOTE_BOX_THEME_EVENT, theme)
        } catch { /* An independently closing box cannot block other windows. */ }
      }
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }
  dispose(): void { this.windows.clear(); this.ipc.removeHandler(ARKNOTE_BOX_THEME_CHANNEL) }
}
