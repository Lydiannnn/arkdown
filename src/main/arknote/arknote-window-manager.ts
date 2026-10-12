import type { StickyNoteWindowBounds } from '../../shared/sticky-notes'
import type { ArknoteSettingsSection } from '../create-arknote-settings-window'

interface CloseEventLike {
  preventDefault(): void
}

interface ManagedWindow {
  show(): void
  hide(): void
  focus(): void
  close(): void
  isDestroyed(): boolean
  getBounds(): StickyNoteWindowBounds
  on(event: 'close', listener: (event: CloseEventLike) => void): void
  once(event: 'closed', listener: () => void): void
}

export interface ArknoteWindowManagerOptions {
  initialBoxBounds: StickyNoteWindowBounds | null
  createBoxWindow(bounds: StickyNoteWindowBounds | null): ManagedWindow
  createSettingsWindow(section?: ArknoteSettingsSection): ManagedWindow
  persistBoxBounds(bounds: StickyNoteWindowBounds): Promise<void>
  reportError(error: unknown): void
}

export class ArknoteWindowManager {
  private box: ManagedWindow | null = null
  private settings: ManagedWindow | null = null
  private closingAll = false
  private boxBounds: StickyNoteWindowBounds | null

  constructor(private readonly options: ArknoteWindowManagerOptions) {
    this.boxBounds = options.initialBoxBounds
  }

  async openBox(): Promise<void> {
    if (!this.box || this.box.isDestroyed()) this.box = this.createBox()
    this.box.show()
    this.box.focus()
  }

  async openSettings(section?: ArknoteSettingsSection): Promise<void> {
    if (!this.settings || this.settings.isDestroyed()) this.settings = this.createSettings(section)
    this.settings.show()
    this.settings.focus()
  }

  async closeAll(): Promise<void> {
    this.closingAll = true
    try {
      const box = this.box
      if (box && !box.isDestroyed()) {
        await this.persistBoxBounds(box.getBounds())
        box.close()
      }
      const settings = this.settings
      if (settings && !settings.isDestroyed()) settings.close()
    } finally {
      this.closingAll = false
    }
  }

  private createBox(): ManagedWindow {
    const window = this.options.createBoxWindow(this.boxBounds)
    window.on('close', (event) => {
      if (this.closingAll) return
      event.preventDefault()
      window.hide()
      void this.persistBoxBounds(window.getBounds()).catch((error) => {
        this.options.reportError(error)
      })
    })
    window.once('closed', () => {
      if (this.box === window) this.box = null
    })
    return window
  }

  private async persistBoxBounds(bounds: StickyNoteWindowBounds): Promise<void> {
    this.boxBounds = { ...bounds }
    await this.options.persistBoxBounds(bounds)
  }

  private createSettings(section?: ArknoteSettingsSection): ManagedWindow {
    const window = this.options.createSettingsWindow(section)
    window.once('closed', () => {
      if (this.settings === window) this.settings = null
    })
    return window
  }
}
