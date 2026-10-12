import {
  parseScreenshotOcrHostCommand,
  type ScreenshotOcrHostCommand,
  type ScreenshotOcrSubmission,
  type ScreenshotTranslationGenerationInput,
} from '../../shared/screenshot-translation'
import {
  createScreenshotOcrClient,
  ScreenshotOcrClientError,
  type ScreenshotOcrClient,
} from './screenshot-ocr-client'
import type { ScreenshotOcrModelState } from '../../shared/screenshot-ocr-models'

const OCR_HOST_IDLE_MS = 60_000
const COMPLETED_TOKEN_LIMIT = 128

interface ApiResultLike { ok: boolean }

export interface ScreenshotOcrHostControllerDependencies {
  subscribe(listener: (command: ScreenshotOcrHostCommand) => void): () => void
  subscribeModelState(listener: (state: ScreenshotOcrModelState) => void): () => void
  createClient?: () => ScreenshotOcrClient
  submit(input: ScreenshotOcrSubmission): Promise<ApiResultLike>
  settle(input: ScreenshotTranslationGenerationInput): Promise<ApiResultLike>
  scheduleIdle?(listener: () => void): { dispose(): void }
}

export interface ScreenshotOcrHostController {
  start(): void
  dispose(): void
}

function tokenOf(input: ScreenshotTranslationGenerationInput): string {
  return `${input.sessionId}:${input.generation}`
}

export function createScreenshotOcrHostController(
  dependencies: ScreenshotOcrHostControllerDependencies,
): ScreenshotOcrHostController {
  const createClient = dependencies.createClient ?? (() => createScreenshotOcrClient())
  const scheduleIdle = dependencies.scheduleIdle ?? ((listener: () => void) => {
    const timeout = setTimeout(listener, OCR_HOST_IDLE_MS)
    return { dispose: () => clearTimeout(timeout) }
  })
  const queue: Array<Extract<ScreenshotOcrHostCommand, { type: 'recognize' }>> = []
  const completedTokens = new Set<string>()
  const settlements = new Map<string, Promise<void>>()
  let unsubscribe: (() => void) | undefined
  let unsubscribeModelState: (() => void) | undefined
  let client: ScreenshotOcrClient | undefined
  let cacheKey: string | undefined
  let active: { token: string; controller: AbortController } | undefined
  let idle: { dispose(): void } | undefined
  let invalidateAfterActive = false
  let running = false
  let disposed = false

  const remember = (token: string): void => {
    completedTokens.add(token)
    while (completedTokens.size > COMPLETED_TOKEN_LIMIT) {
      const oldest = completedTokens.values().next().value as string | undefined
      if (!oldest) break
      completedTokens.delete(oldest)
    }
  }

  const settleOnce = (input: ScreenshotTranslationGenerationInput): Promise<void> => {
    const token = tokenOf(input)
    if (completedTokens.has(token)) return Promise.resolve()
    const pending = settlements.get(token)
    if (pending) return pending
    const settlement = (async () => {
      try { await dependencies.settle(input) } catch { /* main destruction is the final fallback */ }
      finally {
        remember(token)
        settlements.delete(token)
      }
    })()
    settlements.set(token, settlement)
    return settlement
  }

  const stopRetainedClient = (): void => {
    try { idle?.dispose() } catch { /* retained-client invalidation is still authoritative */ }
    idle = undefined
    try { client?.stop() } catch { /* the next request creates a clean client */ }
    client = undefined
    cacheKey = undefined
    invalidateAfterActive = false
  }

  const invalidateRetainedModel = (): void => {
    if (!client) return
    if (active) {
      invalidateAfterActive = true
      return
    }
    stopRetainedClient()
  }

  const armIdle = (): void => {
    try { idle?.dispose() } catch { /* idle cleanup cannot own the Worker */ }
    idle = scheduleIdle(() => {
      idle = undefined
      if (disposed || running || queue.length > 0) return
      stopRetainedClient()
    })
  }

  const ensureClient = (nextCacheKey: string): ScreenshotOcrClient => {
    if (client && (invalidateAfterActive || cacheKey !== nextCacheKey)) stopRetainedClient()
    if (!client) client = createClient()
    cacheKey = nextCacheKey
    return client
  }

  const drain = async (): Promise<void> => {
    if (running || disposed) return
    running = true
    try {
      while (!disposed && queue.length > 0) {
        const job = queue.shift()!
        const token = tokenOf(job)
        if (completedTokens.has(token)) continue
        try { idle?.dispose() } catch { /* active work supersedes idle cleanup */ }
        idle = undefined
        const controller = new AbortController()
        active = { token, controller }
        let submission: ScreenshotOcrSubmission | undefined
        try {
          const result = await ensureClient(job.cacheKey).recognize({
            sessionId: job.sessionId,
            generation: job.generation,
            image: job.image,
            tier: job.tier,
            signal: controller.signal,
          })
          submission = { sessionId: job.sessionId, generation: job.generation, status: 'success', result }
        } catch (error) {
          if (!(error instanceof ScreenshotOcrClientError && error.code === 'OCR_CANCELLED')) {
            const code = error instanceof ScreenshotOcrClientError
              && (error.code === 'OCR_UNAVAILABLE' || error.code === 'OCR_TIMEOUT')
              ? error.code
              : 'OCR_FAILED'
            submission = { sessionId: job.sessionId, generation: job.generation, status: 'failure', code }
          }
        }
        if (submission) {
          try { await dependencies.submit(submission) } catch { /* settle remains authoritative */ }
        }
        await settleOnce({ sessionId: job.sessionId, generation: job.generation })
        if (active?.token === token) active = undefined
        if (invalidateAfterActive) stopRetainedClient()
      }
    } finally {
      running = false
      if (!disposed && queue.length > 0) void drain()
      else if (!disposed) armIdle()
    }
  }

  const accept = (candidate: ScreenshotOcrHostCommand): void => {
    if (disposed) return
    const command = parseScreenshotOcrHostCommand(candidate)
    if (!command) return
    const token = tokenOf(command)
    if (command.type === 'cancel') {
      if (active?.token === token) active.controller.abort()
      const queued = queue.findIndex((job) => tokenOf(job) === token)
      if (queued >= 0) {
        queue.splice(queued, 1)
        void settleOnce({ sessionId: command.sessionId, generation: command.generation })
      } else if (active?.token !== token) {
        void settleOnce({ sessionId: command.sessionId, generation: command.generation })
      }
      return
    }
    if (completedTokens.has(token) || settlements.has(token)
      || active?.token === token || queue.some((job) => tokenOf(job) === token)) return
    queue.push(command)
    void drain()
  }

  return {
    start() {
      if (disposed || unsubscribe) return
      unsubscribeModelState = dependencies.subscribeModelState(invalidateRetainedModel)
      unsubscribe = dependencies.subscribe(accept)
    },
    dispose() {
      if (disposed) return
      disposed = true
      try { unsubscribe?.() } catch { /* dispose remaining resources */ }
      unsubscribe = undefined
      try { unsubscribeModelState?.() } catch { /* dispose remaining resources */ }
      unsubscribeModelState = undefined
      try { idle?.dispose() } catch { /* dispose remaining resources */ }
      idle = undefined
      active?.controller.abort()
      const queued = queue.splice(0)
      for (const job of queued) {
        void settleOnce({ sessionId: job.sessionId, generation: job.generation })
      }
      try { client?.dispose() } catch { /* process teardown is authoritative */ }
      client = undefined
      cacheKey = undefined
    },
  }
}
