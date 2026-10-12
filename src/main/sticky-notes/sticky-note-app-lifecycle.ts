import type { CloseBehavior } from '../../shared/desktop-lifecycle-preferences'

interface CloseEvent {
  preventDefault(): void
}

export interface StickyNoteMainWindow {
  hide(): void
  close(): void
  isDestroyed(): boolean
  on(event: 'close', listener: (event: CloseEvent) => void): unknown
}

export interface StickyNoteAppLifecycleOptions {
  getCloseBehavior(): CloseBehavior
  prepareMainWindows(): Promise<boolean>
  flushStickyNotes(): Promise<void>
  destroyTray(): void
  closeStickyWindows(): Promise<void>
  quitApp(): void
  reportError(error: unknown): void
}

export class StickyNoteAppLifecycle {
  private readonly mainWindows = new Set<StickyNoteMainWindow>()
  private quitting = false
  private quitPromise: Promise<boolean> | null = null

  constructor(private readonly options: StickyNoteAppLifecycleOptions) {}

  registerMainWindow(window: StickyNoteMainWindow): void {
    this.mainWindows.add(window)
    window.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      if (this.options.getCloseBehavior() === 'tray') {
        window.hide()
        return
      }
      void this.requestQuit()
    })
  }

  isQuitting(): boolean {
    return this.quitting
  }

  pendingQuit(): Promise<boolean> {
    return this.quitPromise ?? Promise.resolve(false)
  }

  requestQuit(): Promise<boolean> {
    if (this.quitPromise) return this.quitPromise
    const operation = (async () => {
      try {
        if (!await this.options.prepareMainWindows()) return false
        await this.options.flushStickyNotes()
        this.quitting = true
        this.options.destroyTray()
        await this.options.closeStickyWindows()
        for (const window of this.mainWindows) {
          if (!window.isDestroyed()) window.close()
        }
        this.options.quitApp()
        return true
      } catch (error) {
        this.quitting = false
        this.options.reportError(error)
        return false
      } finally {
        if (!this.quitting) this.quitPromise = null
      }
    })()
    this.quitPromise = operation
    return operation
  }

  handleWindowAllClosed(): void {
    if (this.quitting) this.options.quitApp()
  }
}
