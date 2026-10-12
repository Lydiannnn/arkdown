export function liveStartupMaintenanceWindow<T extends { isDestroyed(): boolean }>(windows: Iterable<T>, preferred?: T): T | undefined {
  if (preferred && !preferred.isDestroyed()) return preferred
  for (const window of windows) if (!window.isDestroyed()) return window
  return undefined
}

/** Run optional startup work once, after the first window has actually been shown. */
export class DeferredStartupMaintenance {
  private scheduled = false
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> = Promise.resolve()

  constructor(private readonly options: { run(): Promise<void>; report(error: unknown): void }) {}

  schedule(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed) return
      this.running = Promise.resolve().then(() => this.options.run()).catch(error => {
        try { this.options.report(error) } catch { /* diagnostics never own shutdown */ }
      })
    }, 500)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    await this.running
  }
}
