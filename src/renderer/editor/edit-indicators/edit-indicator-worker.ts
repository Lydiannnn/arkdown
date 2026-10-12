import { computeLineEditIndicators } from './line-diff'
import type {
  EditIndicatorWorkerRequest,
  EditIndicatorWorkerResponse,
} from './edit-indicator-worker-protocol'
import { isEditIndicatorWorkerRequest } from './edit-indicator-worker-protocol'

interface WorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  postMessage(message: EditIndicatorWorkerResponse): void
}

const scope = self as unknown as WorkerScope

function requestIdentity(value: unknown): Pick<EditIndicatorWorkerRequest, 'requestId' | 'documentKey'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<EditIndicatorWorkerRequest>
  return Number.isSafeInteger(candidate.requestId)
    && (candidate.requestId ?? 0) > 0
    && typeof candidate.documentKey === 'string'
      ? { requestId: candidate.requestId!, documentKey: candidate.documentKey }
      : null
}

scope.addEventListener('message', (event) => {
  const value = event.data
  if (!isEditIndicatorWorkerRequest(value)) {
    const identity = requestIdentity(value)
    if (identity) scope.postMessage({
      ...identity,
      ok: false,
      message: 'Invalid edit indicator worker request',
    })
    return
  }
  const request = value
  try {
    scope.postMessage({
      requestId: request.requestId,
      documentKey: request.documentKey,
      ok: true,
      snapshot: computeLineEditIndicators(request),
    })
  } catch (error) {
    scope.postMessage({
      requestId: request.requestId,
      documentKey: request.documentKey,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    })
  }
})
