import { describe, expect, it, vi } from 'vitest'
import {
  createScreenshotOcrHostController,
  type ScreenshotOcrHostControllerDependencies,
} from '../../src/renderer/screenshot/screenshot-ocr-host'
import type { ScreenshotOcrHostCommand } from '../../src/shared/screenshot-translation'
import { ScreenshotOcrClientError } from '../../src/renderer/screenshot/screenshot-ocr-client'
import type { ScreenshotOcrModelState } from '../../src/shared/screenshot-ocr-models'

const SESSION = '123e4567-e89b-42d3-a456-426614174000'
const NEXT_SESSION = '223e4567-e89b-42d3-a456-426614174000'
const image = { width: 4, height: 3, dataUrl: 'data:image/png;base64,AAAA' }
const result = { width: 4, height: 3, language: 'mul', blocks: [] }

function recognize(
  sessionId = SESSION,
  generation = 1,
  tier: 'small' | 'medium' = 'small',
  cacheKey = `${tier}:6.0.0`,
): ScreenshotOcrHostCommand {
  return { type: 'recognize', sessionId, generation, image, tier, cacheKey }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(options: {
  recognize?: (input: { signal?: AbortSignal }) => Promise<typeof result>
  replayCommand?: ScreenshotOcrHostCommand
  replayModelState?: ScreenshotOcrModelState
} = {}) {
  let listener: ((command: ScreenshotOcrHostCommand) => void) | undefined
  let modelStateListener: ((state: ScreenshotOcrModelState) => void) | undefined
  const clients: Array<{
    recognize: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }> = []
  const createClient = vi.fn(() => {
    const client = {
      recognize: vi.fn(options.recognize ?? (async () => result)),
      stop: vi.fn(),
      dispose: vi.fn(),
    }
    clients.push(client)
    return client
  })
  const idleListeners: Array<() => void> = []
  const submit = vi.fn(async () => ({ ok: true as const, value: null }))
  const settle = vi.fn(async () => ({ ok: true as const, value: null }))
  const dependencies: ScreenshotOcrHostControllerDependencies = {
    subscribe(next) {
      listener = next
      if (options.replayCommand) next(options.replayCommand)
      return () => { if (listener === next) listener = undefined }
    },
    subscribeModelState(next) {
      modelStateListener = next
      if (options.replayModelState) next(options.replayModelState)
      return () => { if (modelStateListener === next) modelStateListener = undefined }
    },
    createClient,
    submit,
    settle,
    scheduleIdle(next) {
      idleListeners.push(next)
      return { dispose: vi.fn() }
    },
  }
  const controller = createScreenshotOcrHostController(dependencies)
  controller.start()
  return {
    controller, clients, createClient, submit, settle, idleListeners,
    emit(command: ScreenshotOcrHostCommand) { listener?.(command) },
    emitModelState(state: ScreenshotOcrModelState) { modelStateListener?.(state) },
  }
}

describe('screenshot OCR host', () => {
  it('keeps one Worker client warm for sequential screenshots and stops it only after 60 seconds idle', async () => {
    const h = harness()
    h.emit(recognize())
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(1))
    h.emit(recognize(NEXT_SESSION, 1))
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(2))

    expect(h.createClient).toHaveBeenCalledOnce()
    expect(h.clients[0]!.recognize).toHaveBeenCalledTimes(2)
    expect(h.clients[0]!.stop).not.toHaveBeenCalled()
    expect(h.idleListeners).toHaveLength(2)

    h.idleListeners.at(-1)!()
    expect(h.clients[0]!.stop).toHaveBeenCalledOnce()
  })

  it('restarts the cached pipeline when the exact model identity changes', async () => {
    const h = harness()
    h.emit(recognize())
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(1))
    h.emit(recognize(NEXT_SESSION, 1, 'medium', 'medium:6.0.0'))
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(2))

    expect(h.clients[0]!.stop).toHaveBeenCalledOnce()
    expect(h.createClient).toHaveBeenCalledTimes(2)
    expect(h.clients[1]!.recognize).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: NEXT_SESSION, tier: 'medium',
    }))
  })

  it('invalidates an idle Medium client immediately on removal and never reuses it after same-version reinstall', async () => {
    const h = harness()
    h.emit(recognize(SESSION, 1, 'medium', 'medium:6.0.0'))
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(1))

    h.emitModelState({
      activeTier: 'small', bundledVersion: '6.0.0', mediumVersion: null,
      availableMediumVersion: '6.0.0', status: 'medium-absent', progress: null, errorCode: null,
    })
    expect(h.clients[0]!.stop).toHaveBeenCalledOnce()

    h.emitModelState({
      activeTier: 'medium', bundledVersion: '6.0.0', mediumVersion: '6.0.0',
      availableMediumVersion: null, status: 'medium-installed', progress: null, errorCode: null,
    })
    h.emit(recognize(NEXT_SESSION, 1, 'medium', 'medium:6.0.0'))
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(2))
    expect(h.createClient).toHaveBeenCalledTimes(2)
  })

  it('invalidates an idle Medium client as soon as a same-version update starts', async () => {
    const h = harness()
    h.emit(recognize(SESSION, 1, 'medium', 'medium:6.0.0'))
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(1))

    h.emitModelState({
      activeTier: 'medium', bundledVersion: '6.0.0', mediumVersion: '6.0.0',
      availableMediumVersion: '6.0.0', status: 'medium-downloading',
      progress: { receivedBytes: 1, totalBytes: 2 }, errorCode: null,
    })
    expect(h.clients[0]!.stop).toHaveBeenCalledOnce()
  })

  it('lets active OCR settle before applying a concurrent model-state invalidation', async () => {
    const pending = deferred<typeof result>()
    const h = harness({ recognize: () => pending.promise })
    h.emit(recognize())
    await vi.waitFor(() => expect(h.clients[0]!.recognize).toHaveBeenCalledOnce())

    h.emitModelState({
      activeTier: 'small', bundledVersion: '6.0.0', mediumVersion: null,
      availableMediumVersion: '6.0.0', status: 'medium-downloading',
      progress: { receivedBytes: 1, totalBytes: 2 }, errorCode: null,
    })
    expect(h.clients[0]!.stop).not.toHaveBeenCalled()
    pending.resolve(result)

    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledOnce())
    expect(h.submit).toHaveBeenCalledWith({
      sessionId: SESSION, generation: 1, status: 'success', result,
    })
    expect(h.clients[0]!.stop).toHaveBeenCalledOnce()
    h.emit(recognize(NEXT_SESSION, 1))
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(2))
    expect(h.createClient).toHaveBeenCalledTimes(2)
  })

  it('replays buffered model state before a buffered recognize so current state cannot invalidate fresh work', async () => {
    const h = harness({
      replayModelState: {
        activeTier: 'medium', bundledVersion: '6.0.0', mediumVersion: '6.0.0',
        availableMediumVersion: null, status: 'medium-installed', progress: null, errorCode: null,
      },
      replayCommand: recognize(SESSION, 1, 'medium', 'medium:6.0.0'),
    })

    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledOnce())
    expect(h.clients[0]!.stop).not.toHaveBeenCalled()
  })

  it('submits one exact terminal result before settling the main-owned tier lease', async () => {
    const h = harness()
    h.emit(recognize())
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledOnce())

    expect(h.submit).toHaveBeenCalledWith({
      sessionId: SESSION, generation: 1, status: 'success', result,
    })
    expect(h.submit.mock.invocationCallOrder[0]).toBeLessThan(h.settle.mock.invocationCallOrder[0]!)
    expect(h.settle).toHaveBeenCalledWith({ sessionId: SESSION, generation: 1 })
  })

  it('cancels the exact active job, sends no synthetic failure, and still settles ownership', async () => {
    const h = harness()
    const pending = deferred<typeof result>()
    h.emit(recognize())
    await vi.waitFor(() => expect(h.clients[0]).toBeDefined())
    h.clients[0]!.recognize.mockReturnValueOnce(pending.promise)
    h.emit(recognize(NEXT_SESSION, 1))
    await vi.waitFor(() => expect(h.clients[0]!.recognize).toHaveBeenCalledTimes(2))

    h.emit({ type: 'cancel', sessionId: NEXT_SESSION, generation: 1 })
    pending.reject(new ScreenshotOcrClientError('OCR_CANCELLED'))
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledWith({ sessionId: NEXT_SESSION, generation: 1 }))
    expect(h.submit).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: NEXT_SESSION, status: 'failure',
    }))
  })

  it('settles an unknown exact cancel so a startup replay gap cannot retain main ownership', async () => {
    const h = harness()
    h.emit({ type: 'cancel', sessionId: SESSION, generation: 7 })

    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledWith({
      sessionId: SESSION, generation: 7,
    }))
    expect(h.submit).not.toHaveBeenCalled()
  })

  it('settles both active and queued recognizes when disposal races a StrictMode-style startup remount', async () => {
    const pending = deferred<typeof result>()
    const h = harness({
      recognize: (input) => {
        input.signal?.addEventListener('abort', () => {
          pending.reject(new ScreenshotOcrClientError('OCR_CANCELLED'))
        }, { once: true })
        return pending.promise
      },
    })
    h.emit(recognize(SESSION, 1))
    h.emit(recognize(NEXT_SESSION, 1))
    await vi.waitFor(() => expect(h.clients[0]!.recognize).toHaveBeenCalledOnce())

    h.controller.dispose()

    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledTimes(2))
    expect(h.settle).toHaveBeenCalledWith({ sessionId: SESSION, generation: 1 })
    expect(h.settle).toHaveBeenCalledWith({ sessionId: NEXT_SESSION, generation: 1 })
  })

  it('deduplicates replayed jobs and disposes its retained client exactly once', async () => {
    const h = harness()
    const command = recognize()
    h.emit(command)
    h.emit(command)
    await vi.waitFor(() => expect(h.settle).toHaveBeenCalledOnce())
    expect(h.clients[0]!.recognize).toHaveBeenCalledOnce()

    h.controller.dispose()
    h.controller.dispose()
    expect(h.clients[0]!.dispose).toHaveBeenCalledOnce()
  })
})
