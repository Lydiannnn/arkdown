import { createThreadedRegistryWorker } from './registry-worker-client'

interface RegistryWorkerTransport {
  execute(payload: object): Promise<unknown>
  close(): Promise<void>
}

export interface RegistryTransactionScheduler {
  acquire(): Promise<() => void>
}

/** Reserve in call order; ownership ends only when the transaction closes. */
export function createRegistryTransactionScheduler(): RegistryTransactionScheduler {
  let tail = Promise.resolve()
  return {
    acquire() {
      const previous = tail
      let release!: () => void
      tail = new Promise<void>(resolve => { release = resolve })
      return previous.then(() => release)
    },
  }
}

const processScheduler = createRegistryTransactionScheduler()

function createTransaction(create: () => RegistryWorkerTransport, scheduler: RegistryTransactionScheduler) {
  let transport: RegistryWorkerTransport | undefined
  let release: (() => void) | undefined
  let closing: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  const ready = scheduler.acquire().then(unlock => {
    release = unlock
    transport = create()
    return transport
  })
  return {
    get closing() { return closing !== undefined },
    execute(payload: object): Promise<unknown> {
      const operation = ready.then(worker => worker.execute(payload))
      pending.add(operation)
      void operation.then(() => pending.delete(operation), () => pending.delete(operation))
      return operation
    },
    close(): Promise<void> {
      closing ??= (async () => {
        // Include requests accepted before close, even if the lane is not ours yet.
        await Promise.allSettled([...pending])
        await transport?.close()
        // A rejected close does not confirm worker exit. Never overlap it with
        // another transaction or retry writes whose outcome is uncertain.
        release?.()
      })()
      return closing
    },
  }
}

/** Serialize complete registry transactions without changing the raw worker protocol. */
export function createSerializedRegistryWorker(
  create: () => RegistryWorkerTransport = createThreadedRegistryWorker,
  scheduler: RegistryTransactionScheduler = processScheduler,
): RegistryWorkerTransport {
  let transaction: ReturnType<typeof createTransaction> | undefined
  return {
    execute(payload) {
      if (!transaction || transaction.closing) transaction = createTransaction(create, scheduler)
      return transaction.execute(payload)
    },
    close() { return transaction?.close() ?? Promise.resolve() },
  }
}
