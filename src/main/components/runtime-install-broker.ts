import type { RuntimeComponentManager } from './runtime-component-manager'
import type { RuntimeInstallSnapshot } from '../../shared/runtime-component'

export interface RuntimeInstallPresenter {
  update(snapshot: RuntimeInstallSnapshot): void
  close(): void
}
export interface RuntimeInstallPresentation {
  snapshot: RuntimeInstallSnapshot
  retry(): void
  cancel(): void
}

/** Joins concurrent requests; cancellation never removes a completed installation. */
export function createRuntimeInstallBroker(options: {
  present(input: RuntimeInstallPresentation): RuntimeInstallPresenter
}) {
  const flights = new Map<RuntimeComponentManager, { promise: Promise<string | undefined>; waiters: Set<symbol>; cancelling: boolean; cancel(): void }>()
  let disposed = false
  const broker = {
    async ensure(manager: RuntimeComponentManager, label: string, signal?: AbortSignal): Promise<string | undefined> {
      if (disposed || signal?.aborted) return undefined
      const installed = await manager.ensureRuntime()
      if (disposed || signal?.aborted) return undefined
      if (installed) return installed
      let flight = flights.get(manager)
      if (flight?.cancelling) {
        await flight.promise
        return broker.ensure(manager, label, signal)
      }
      if (!flight) {
        let settle!: (entry: string | undefined) => void
        const promise = new Promise<string | undefined>(resolve => { settle = resolve })
        let done = false
        let cancelling = false
        let busy = false
        let presenter: RuntimeInstallPresenter | undefined
        let unsubscribe = () => undefined as void
        const finish = (entry?: string) => {
          if (done) return
          done = true
          unsubscribe()
          flights.delete(manager)
          try { presenter?.close() } finally { settle(entry) }
        }
        const cancel = () => {
          cancelling = true
          if (flight) flight.cancelling = true
          void manager.cancel().catch(() => undefined).finally(() => finish())
        }
        const retry = () => {
          if (done || busy || cancelling) return
          busy = true
          void manager.install().then(() => manager.ensureRuntime()).then(entry => {
            if (entry && !cancelling) finish(entry)
          }).catch(() => undefined).finally(() => { busy = false })
        }
        flight = { promise, cancel, waiters: new Set(), cancelling: false }
        flights.set(manager, flight)
        unsubscribe = manager.subscribe(state => presenter?.update({ label, state }))
        try {
          presenter = options.present({ snapshot: { label, state: manager.getState() }, retry, cancel })
          retry()
        } catch { cancel() }
      }
      // One caller leaving cannot cancel another caller's operation.
      const waiter = Symbol('component-waiter')
      flight.waiters.add(waiter)
      if (!signal) return flight.promise.finally(() => { flight!.waiters.delete(waiter) })
      return new Promise(resolve => {
        const abort = () => {
          flight!.waiters.delete(waiter)
          if (!flight!.waiters.size) flight!.cancel()
          resolve(undefined)
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        void flight!.promise.then(value => {
          flight!.waiters.delete(waiter)
          signal.removeEventListener('abort', abort)
          resolve(signal.aborted ? undefined : value)
        })
      })
    },
    dispose() {
      disposed = true
      const pending = [...flights.values()]
      for (const flight of pending) flight.cancel()
      return Promise.all(pending.map(flight => flight.promise)).then(() => undefined)
    },
  }
  return broker
}
