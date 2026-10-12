import type { EditIndicatorSnapshot } from './line-diff'
import {
  isEditIndicatorWorkerResponse,
  type EditIndicatorWorkerRequest,
} from './edit-indicator-worker-protocol'

export interface EditIndicatorWorkerLike {
  postMessage(message: EditIndicatorWorkerRequest): void
  terminate(): void
  addEventListener(type: 'message' | 'messageerror' | 'error', listener: EventListener): void
  removeEventListener(type: 'message' | 'messageerror' | 'error', listener: EventListener): void
}

export interface EditIndicatorClient {
  compute(
    input: Omit<EditIndicatorWorkerRequest, 'requestId'>,
  ): Promise<EditIndicatorSnapshot | null>
  dispose(): void
}

interface PendingRequest {
  documentKey: string
  resolve(value: EditIndicatorSnapshot | null): void
  reject(reason: unknown): void
}

function defaultWorkerFactory(): EditIndicatorWorkerLike {
  return new Worker(new URL('./edit-indicator-worker.ts', import.meta.url), {
    type: 'module',
  })
}

export function createEditIndicatorClient(
  workerFactory: () => EditIndicatorWorkerLike = defaultWorkerFactory,
): EditIndicatorClient {
  let worker: EditIndicatorWorkerLike | null = null
  let nextRequestId = 0
  let disposed = false
  const pending = new Map<number, PendingRequest>()

  const settlePending = (settle: (request: PendingRequest) => void) => {
    for (const request of pending.values()) settle(request)
    pending.clear()
  }

  const detachWorker = () => {
    if (!worker) return
    worker.removeEventListener('message', onMessage)
    worker.removeEventListener('error', onError)
    worker.removeEventListener('messageerror', onMessageError)
    worker.terminate()
    worker = null
  }

  const invalidateWorker = (reason: Error) => {
    detachWorker()
    settlePending((request) => request.reject(reason))
  }

  const onMessage: EventListener = (rawEvent) => {
    const value = (rawEvent as MessageEvent<unknown>).data
    if (!isEditIndicatorWorkerResponse(value)) {
      invalidateWorker(new Error('Malformed edit indicator worker response'))
      return
    }
    const request = pending.get(value.requestId)
    if (!request) return
    pending.delete(value.requestId)
    if (request.documentKey !== value.documentKey) {
      request.resolve(null)
      return
    }
    if (!value.ok) {
      request.reject(new Error(value.message))
      return
    }
    request.resolve(value.snapshot)
  }

  const onError: EventListener = (rawEvent) => {
    const event = rawEvent as ErrorEvent
    invalidateWorker(new Error(event.message || 'Edit indicator worker failed'))
  }

  const onMessageError: EventListener = () => {
    invalidateWorker(new Error('Edit indicator worker message could not be decoded'))
  }

  const ensureWorker = (): EditIndicatorWorkerLike => {
    if (worker) return worker
    const created = workerFactory()
    created.addEventListener('message', onMessage)
    created.addEventListener('error', onError)
    created.addEventListener('messageerror', onMessageError)
    worker = created
    return created
  }

  return {
    compute(input) {
      if (disposed) return Promise.resolve(null)
      settlePending((request) => request.resolve(null))
      const requestId = ++nextRequestId
      return new Promise<EditIndicatorSnapshot | null>((resolve, reject) => {
        pending.set(requestId, { documentKey: input.documentKey, resolve, reject })
        let currentWorker: EditIndicatorWorkerLike
        try {
          currentWorker = ensureWorker()
        } catch (error) {
          pending.delete(requestId)
          reject(error)
          return
        }
        try {
          currentWorker.postMessage({ requestId, ...input })
        } catch (error) {
          invalidateWorker(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      detachWorker()
      settlePending((request) => request.resolve(null))
    },
  }
}
