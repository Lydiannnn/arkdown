export interface DesktopAiTransportLifecycle {
  pauseAndDrain(): void | Promise<void>
  unregister(): void | Promise<void>
}

export interface DesktopAiWindowLifecycleOptions {
  disposeConversations(): void | Promise<void>
  disposeCurrentDocument(): void | Promise<void>
  disposeOrdinary(): void | Promise<void>
}

/** Main-only irreversible cleanup coordinator for one Arkdown editor window. */
export class DesktopAiWindowLifecycle {
  private readonly transports = new Set<DesktopAiTransportLifecycle>()
  private acceptingTransports = true
  private disposePromise: Promise<void> | undefined

  constructor(private readonly options: DesktopAiWindowLifecycleOptions) {}

  registerTransportLifecycle(lifecycle: DesktopAiTransportLifecycle): () => void {
    if (!this.acceptingTransports) {
      throw new Error('Desktop AI transport registration is closed')
    }
    if (!lifecycle || typeof lifecycle.pauseAndDrain !== 'function'
      || typeof lifecycle.unregister !== 'function') {
      throw new Error('Invalid desktop AI transport lifecycle')
    }
    this.transports.add(lifecycle)
    return () => {
      if (this.acceptingTransports) this.transports.delete(lifecycle)
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.acceptingTransports = false
    const transports = [...this.transports]
    this.transports.clear()
    this.disposePromise = (async () => {
      let failed = false
      const run = async (operation: () => void | Promise<void>): Promise<void> => {
        try { await operation() } catch { failed = true }
      }
      await Promise.all(transports.map(async (transport) => {
        await run(() => transport.pauseAndDrain())
      }))
      await run(() => this.options.disposeConversations())
      await run(() => this.options.disposeCurrentDocument())
      await Promise.all(transports.map(async (transport) => {
        await run(() => transport.unregister())
      }))
      await run(() => this.options.disposeOrdinary())
      if (failed) throw new Error('Desktop AI window cleanup failed')
    })()
    return this.disposePromise
  }
}
