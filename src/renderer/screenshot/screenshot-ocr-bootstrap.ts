import { parseScreenshotSessionId } from '../../shared/screenshot-translation'

interface BootstrapScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage(value: unknown): void
}

const runtimeUrl = 'arkdown-ocr://bundle/worker.js'

/** Only the audited protocol module owns OCR; the same-origin worker stays tiny. */
export async function initializeScreenshotOcrBootstrap(
  scope: BootstrapScope,
  loadRuntime: () => Promise<unknown> = () => import(/* @vite-ignore */ runtimeUrl),
): Promise<void> {
  let pending: MessageEvent<unknown> | undefined
  const unavailable = (event: MessageEvent<unknown>) => {
    const value = event.data
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const sessionId = parseScreenshotSessionId(record.sessionId)
    if (!sessionId || typeof record.requestId !== 'number' || !Number.isSafeInteger(record.requestId)
      || record.requestId <= 0 || typeof record.generation !== 'number'
      || !Number.isSafeInteger(record.generation) || record.generation <= 0) return
    try { scope.postMessage({ type: 'result', requestId: record.requestId, sessionId,
      generation: record.generation, ok: false, code: 'OCR_UNAVAILABLE' }) } catch { /* client owns transport */ }
  }
  const buffer = (event: MessageEvent<unknown>) => {
    if (pending) unavailable(event)
    else pending = event
  }
  scope.onmessage = buffer
  try {
    await loadRuntime()
    const handler = scope.onmessage
    if (!handler || handler === buffer) throw new Error('OCR_UNAVAILABLE')
    if (pending) handler(pending)
  } catch {
    scope.onmessage = unavailable
    if (pending) unavailable(pending)
  } finally {
    pending = undefined
  }
}
