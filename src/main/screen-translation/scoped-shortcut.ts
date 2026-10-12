import type { ScreenshotGlobalShortcutAdapter, ScreenshotShortcutRegistration } from '../screenshot-translation/screenshot-shortcut'

/** Global only while this tool is open. Recording suspension is a separate state. */
export class ScreenScopedShortcut implements ScreenshotShortcutRegistration {
  private active = false
  private suspended = false
  private owned: string | null = null
  private disposed = false
  constructor(private readonly adapter: ScreenshotGlobalShortcutAdapter, private accelerator: string | null,
    private readonly invoke: () => void, private readonly report: () => void) {}
  get registered(): boolean { return this.owned !== null }
  activate(): boolean { this.active = true; return this.acquire() }
  deactivate(): void { this.active = false; this.release() }
  private release(): void { if (this.owned !== null) { this.adapter.unregister(this.owned); this.owned = null } }
  private acquire(reserveWhileSuspended = false): boolean {
    if (!this.active || (this.suspended && !reserveWhileSuspended) || this.disposed || this.accelerator === null) return true
    if (this.owned === this.accelerator) return true
    const accelerator = this.accelerator
    try {
      if (!this.adapter.register(accelerator, () => {
        if (this.active && !this.suspended && !this.disposed && this.accelerator === accelerator) this.invoke()
      })) { this.report(); return false }
      this.owned = accelerator
      if (!this.adapter.isRegistered(accelerator)) { this.release(); this.report(); return false }
      return true
    } catch { this.report(); return false }
  }
  async replace(next: string | null, persist: () => Promise<void>): Promise<boolean> {
    if (this.disposed) return false
    const previous = this.accelerator
    this.release(); this.accelerator = next
    if (!this.acquire(true)) { this.accelerator = previous; this.acquire(); return false }
    try { await persist(); if (this.suspended) this.release(); return true }
    catch (error) { this.release(); this.accelerator = previous; this.acquire(); throw error }
  }
  suspend(): boolean { if (this.suspended) return true; this.suspended = true; this.release(); return true }
  resume(): boolean { this.suspended = false; return this.acquire() }
  dispose(): void { this.deactivate(); this.disposed = true }
}
