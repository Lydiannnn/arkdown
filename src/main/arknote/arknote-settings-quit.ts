import { createRendererCloseRequester } from '../renderer-close-requester'

type RequestOptions = Parameters<typeof createRendererCloseRequester>[0]
type SettingsWindow = RequestOptions['window'] & {
  isDestroyed(): boolean
  setEnabled(enabled: boolean): void
  focus(): void
  once(event: 'closed', listener: () => void): unknown
}

/** Drain the settings renderer before the service stops accepting mutations.
 * A hard deadline is separate from the requester's heartbeat lease: a responsive
 * renderer waiting on a stuck write must not keep service exit pending forever.
 */
export class ArknoteSettingsQuitBarrier {
  private pending: Promise<boolean> | null = null
  private requester: ReturnType<typeof createRendererCloseRequester> | null = null
  private disposed = false
  constructor(private readonly options: { ipcMain: RequestOptions['ipcMain']; window: SettingsWindow; timeoutMs?: number }) {
    options.window.once('closed', () => this.dispose())
  }
  prepare(): Promise<boolean> {
    if (this.options.window.isDestroyed()) return Promise.resolve(true)
    if (this.disposed) return Promise.resolve(false)
    if (this.pending) return this.pending
    this.options.window.setEnabled(false)
    const requester = createRendererCloseRequester(this.options)
    this.requester = requester
    const timeoutMs = Number.isFinite(this.options.timeoutMs) && this.options.timeoutMs! > 0 ? this.options.timeoutMs! : 15_000
    const deadline = setTimeout(() => requester.dispose(), timeoutMs)
    const operation = requester.prepare().catch(() => false).then(ready => {
      if (!ready) this.restoreWindow()
      return ready
    }).finally(() => {
      clearTimeout(deadline)
      requester.dispose()
      if (this.requester === requester) this.requester = null
      if (this.pending === operation) this.pending = null
    })
    this.pending = operation
    return operation
  }
  cancel(): void {
    this.requester?.dispose()
    this.restoreWindow()
  }
  dispose(): void {
    this.disposed = true
    this.requester?.dispose()
    this.requester = null
  }
  private restoreWindow(): void {
    if (this.options.window.isDestroyed()) return
    this.options.window.setEnabled(true)
    this.options.window.focus()
  }
}
