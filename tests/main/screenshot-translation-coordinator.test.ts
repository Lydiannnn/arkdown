import { describe, expect, it, vi } from 'vitest'
import {
  createScreenshotTranslationCoordinator,
  screenshotCaptureOwner,
  type ScreenshotResultOperations,
  type ScreenshotTranslationCoordinatorDependencies,
} from '../../src/main/screenshot-translation/screenshot-translation-coordinator'
import type {
  ScreenshotCaptureResult,
  ScreenshotCaptureCoordinator,
} from '../../src/main/screenshot-translation/screenshot-capture-coordinator'
import type { ScreenshotTranslationEvent } from '../../src/shared/screenshot-translation'
import {
  SCREENSHOT_OCR_HOST_EVENT_CHANNEL,
  SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
} from '../../src/shared/contracts'
import { ScreenshotTranslationServiceError } from '../../src/main/screenshot-translation/screenshot-translation-service'
import { createScreenshotResultCloseLifecycle } from '../../src/main/screenshot-translation/screenshot-result-close-lifecycle'
import type { ClosePreparationResult } from '../../src/shared/close-preparation'

const SESSION_1 = '123e4567-e89b-42d3-a456-426614174000'
const SESSION_2 = '223e4567-e89b-42d3-a456-426614174000'
const SESSION_3 = '323e4567-e89b-42d3-a456-426614174000'

function pngDataUrl(width = 4, height = 3): string {
  const bytes = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  Buffer.from('IHDR').copy(bytes, 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return `data:image/png;base64,${bytes.toString('base64')}`
}

function block(id = 'line-1') {
  return {
    id,
    text: 'hello',
    rectPx: { x: 0, y: 0, width: 4, height: 2 },
    words: [{ text: 'hello', rectPx: { x: 0, y: 0, width: 4, height: 2 } }],
  }
}

class FakeWindow {
  readonly listeners = new Map<string, Array<(...args: never[]) => void>>()
  readonly webListeners = new Map<string, Array<(...args: never[]) => void>>()
  destroyed = false
  visible = true
  minimized = false
  readonly webContents = {
    mainFrame: {},
    destroyed: false,
    send: vi.fn(),
    isDestroyed: () => this.webContents.destroyed,
    on: (event: string, listener: (...args: never[]) => void) => {
      const listeners = this.webListeners.get(event) ?? []
      listeners.push(listener)
      this.webListeners.set(event, listeners)
    },
    once: (event: string, listener: (...args: never[]) => void) => {
      this.webContents.on(event, listener)
    },
    emit: (event: string) => {
      for (const listener of this.webListeners.get(event) ?? []) listener()
    },
  }
  on(event: string, listener: (...args: never[]) => void): void {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
  }
  once(event: string, listener: (...args: never[]) => void): void { this.on(event, listener) }
  emit(event: string): void { for (const listener of this.listeners.get(event) ?? []) listener() }
  isDestroyed(): boolean { return this.destroyed }
  destroy = vi.fn(() => { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } })
  close = vi.fn(() => this.destroy())
  minimize = vi.fn(() => { this.minimized = true })
  isVisible = vi.fn(() => this.visible)
  isMinimized = vi.fn(() => this.minimized)
  hide = vi.fn(() => { this.visible = false })
  showInactive = vi.fn(() => { this.visible = true })
  restore = vi.fn(() => { this.minimized = false })
  show = vi.fn(() => { this.visible = true })
  focus = vi.fn()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(options: { deadlineThrows?: boolean; tier?: 'small' | 'medium'; prepareCapture?: () => Promise<boolean>;
  createResultCloseLifecycle?: ScreenshotTranslationCoordinatorDependencies['createResultCloseLifecycle'] } = {}) {
  let captureHooks!: {
    onCaptured(result: ScreenshotCaptureResult): void | Promise<void>
    onDeliveryFailed(code: 'CAPTURE_UNAVAILABLE'): void | Promise<void>
  }
  const capture: ScreenshotCaptureCoordinator = {
    begin: vi.fn(async () => SESSION_1),
    updatePointer: vi.fn(),
    ready: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(async () => undefined),
  }
  const resultWindows: FakeWindow[] = []
  const registrations: Array<{
    dispose: ReturnType<typeof vi.fn>
    pauseAndDrain: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
  }> = []
  const events: { emit(event: ScreenshotTranslationEvent): void } = { emit: () => undefined }
  const translation = {
    start: vi.fn(async (input: { sessionId: string; generation: number }) => {
      events.emit({ ...input, type: 'translation-started' })
      return { ...input, targetLanguage: 'zh-CN' as const, modelId: 'model' }
    }),
    whenSettled: vi.fn(async () => undefined),
    releaseSession: vi.fn(),
    cancel: vi.fn(async (input: { sessionId: string; generation: number }) => {
      events.emit({ ...input, type: 'translation-cancelled' })
    }),
    dispose: vi.fn(async () => undefined),
  }
  const resultOperations: ScreenshotResultOperations[] = []
  const sendSettingsCommand = vi.fn()
  const reportDiagnostic = vi.fn()
  const releases: Array<ReturnType<typeof vi.fn>> = []
  const acquireOcrTier = vi.fn((forced?: 'small' | 'medium') => {
    const release = vi.fn()
    releases.push(release)
    return { tier: forced ?? options.tier ?? 'small', release }
  })
  const reportOcrTierUnavailable = vi.fn()
  let ocrDeadline: (() => void) | undefined
  const clearOcrDeadline = vi.fn(() => { ocrDeadline = undefined })
  const createResultWindow = vi.fn((_input: unknown, configure: (window: never) => void) => {
    const window = new FakeWindow()
    resultWindows.push(window)
    configure(window as never)
    return window as never
  })
  const registerResultWindow = vi.fn((_window: unknown, operations: ScreenshotResultOperations) => {
    resultOperations.push(operations)
    const registration = { dispose: vi.fn(), pauseAndDrain: vi.fn(), resume: vi.fn() }
    registrations.push(registration)
    return registration
  })
  const coordinator = createScreenshotTranslationCoordinator({
    prepareCapture: options.prepareCapture,
    createCaptureCoordinator(hooks) { captureHooks = hooks; return capture },
    createResultWindow: createResultWindow as never,
    registerResultWindow: registerResultWindow as never,
    createResultCloseLifecycle: options.createResultCloseLifecycle,
    createTranslationService(sink) { events.emit = sink.emit; return translation },
    workAreaFor: () => ({ x: -100, y: 0, width: 1600, height: 1000 }),
    sendSettingsCommand,
    reportDiagnostic,
    acquireOcrTier,
    reportOcrTierUnavailable,
    scheduleOcrDeadline: (listener) => {
      if (options.deadlineThrows) throw new Error('private scheduler detail')
      ocrDeadline = listener
      return { dispose: clearOcrDeadline }
    },
  })
  const owner = new FakeWindow()
  owner.webContents.send.mockImplementation((channel: string, value: unknown) => {
    if (channel === SCREENSHOT_OCR_HOST_EVENT_CHANNEL
      && typeof value === 'object' && value !== null
      && (value as { type?: unknown }).type === 'cancel') {
      const input = value as { sessionId: string; generation: number }
      queueMicrotask(() => coordinator.settleOcrForOwner(owner as never, input))
    }
  })
  const captured = (sessionId = SESSION_1): ScreenshotCaptureResult => ({
    sessionId,
    displayId: '1',
    selectionDip: { x: -50, y: 20, width: 400, height: 300 },
    image: { width: 4, height: 3, dataUrl: pngDataUrl() },
  })
  return {
    coordinator, capture, captureHooks, resultWindows, registrations, translation, resultOperations,
    owner, captured, events, sendSettingsCommand, createResultWindow, registerResultWindow,
    reportDiagnostic,
    fireOcrDeadline: () => ocrDeadline?.(),
    clearOcrDeadline, acquireOcrTier, releases, reportOcrTierUnavailable,
    submitOcr: (index = 0, blocks = [block()]) => {
      const token = {
        sessionId: index === 0 ? SESSION_1 : index === 1 ? SESSION_2 : SESSION_3,
        generation: 1,
      }
      const accepted = coordinator.submitOcrForOwner(owner as never, {
        ...token,
        status: 'success',
        result: { width: 4, height: 3, language: 'mul', blocks },
      })
      if (accepted) queueMicrotask(() => coordinator.settleOcrForOwner(owner as never, token))
      return accepted
    },
  }
}

describe('ScreenshotTranslationCoordinator', () => {
  it('joins child preference preparation with actual OCR settlement before destroying the result', async () => {
    const prepared = deferred<ClosePreparationResult>()
    const requester = { prepare: vi.fn(() => prepared.promise), isCurrent: () => true, dispose: vi.fn() }
    const h = harness({ createResultCloseLifecycle: (window, { finalize }) => createScreenshotResultCloseLifecycle({
      window: window as never, requester, finalize,
      feedback: { bind() {}, notify() {}, dispose() {} },
    }) })
    h.owner.webContents.send.mockImplementation(() => undefined)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    const closing = h.coordinator.closeOwner(h.owner as never)
    expect(requester.prepare).toHaveBeenCalledOnce()
    expect(h.registrations[0]!.pauseAndDrain).not.toHaveBeenCalled()
    prepared.resolve({ status: 'ready' })
    await vi.waitFor(() => expect(h.registrations[0]!.pauseAndDrain).toHaveBeenCalledOnce())
    expect(result.destroy).not.toHaveBeenCalled()
    expect(h.releases[0]).not.toHaveBeenCalled()
    expect(h.coordinator.settleOcrForOwner(h.owner as never, { sessionId: SESSION_1, generation: 1 })).toBe(true)
    await closing
    expect(result.destroy).toHaveBeenCalledOnce()
    expect(h.releases[0]).toHaveBeenCalledOnce()
    expect(requester.dispose).toHaveBeenCalledOnce()
    await h.coordinator.dispose()
  })

  it('closes a result before renderer load without waiting for an uninstalled handler', async () => {
    const createResultCloseLifecycle = vi.fn(() => ({ requestClose: vi.fn(async () => true) }))
    const h = harness({ createResultCloseLifecycle })
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    await h.coordinator.closeOwner(h.owner as never)
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    expect(h.resultWindows[0]!.destroy).toHaveBeenCalledOnce()
    expect(createResultCloseLifecycle).not.toHaveBeenCalled()
    await h.coordinator.dispose()
  })

  it('asks the live result to settle its settings before direct or parent close', async () => {
    const requestClose = vi.fn(async () => false)
    const h = harness({ createResultCloseLifecycle: () => ({ requestClose }) })
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    expect(await h.coordinator.closeFor(result as never, { sessionId: SESSION_1, generation: 1 })).toBe(false)
    expect(result.destroy).not.toHaveBeenCalled()
    await expect(h.coordinator.closeOwner(h.owner as never)).rejects.toThrow('Failed to close screenshot owner resources')
    expect(requestClose).toHaveBeenCalledTimes(2)
    expect(h.registrations[0]!.dispose).not.toHaveBeenCalled()
    h.coordinator.abortOwnerClose(h.owner as never)
    await h.coordinator.dispose()
  })

  it('waits for every result close outcome before reporting a failed child preparation', async () => {
    const remaining = deferred<boolean>()
    let created = 0
    const h = harness({ createResultCloseLifecycle: () => ({
      requestClose: ++created === 1 ? async () => false : () => remaining.promise,
    }) })
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    vi.mocked(h.capture.begin).mockResolvedValueOnce(SESSION_2)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured(SESSION_2))
    h.resultWindows[1]!.webContents.emit('did-finish-load')
    let settled = false
    const closing = h.coordinator.closeOwner(h.owner as never).catch(() => { settled = true })
    await Promise.resolve(); await Promise.resolve()
    expect(settled).toBe(false)
    remaining.resolve(true)
    await closing
    expect(settled).toBe(true)
    await h.coordinator.dispose()
  })

  it('waits for asynchronous OCR initialization before publishing the acquired tier', async () => {
    const ready = deferred<{ tier: 'medium'; release(): void }>()
    const h = harness()
    h.acquireOcrTier.mockImplementationOnce(() => ready.promise as never)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    expect(h.owner.webContents.send).not.toHaveBeenCalledWith(SCREENSHOT_OCR_HOST_EVENT_CHANNEL,
      expect.objectContaining({ type: 'recognize' }))
    ready.resolve({ tier: 'medium', release() {} })
    await vi.waitFor(() => expect(h.owner.webContents.send).toHaveBeenCalledWith(SCREENSHOT_OCR_HOST_EVENT_CHANNEL,
      expect.objectContaining({ type: 'recognize', tier: 'medium' })))
    await h.coordinator.dispose()
  })

  it('waits for pending OCR acquisition on close and releases its late lease without recognizing', async () => {
    const ready = deferred<{ tier: 'medium'; release(): void }>()
    const release = vi.fn()
    const h = harness()
    h.acquireOcrTier.mockImplementationOnce(() => ready.promise as never)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    let settled = false
    const closing = h.coordinator.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    ready.resolve({ tier: 'medium', release })
    await closing
    expect(release).toHaveBeenCalledOnce()
    expect(h.owner.webContents.send).not.toHaveBeenCalledWith(SCREENSHOT_OCR_HOST_EVENT_CHANNEL,
      expect.objectContaining({ type: 'recognize' }))
  })

  it('reports acquisition failure and permits clean shutdown', async () => {
    const ready = deferred<{ tier: 'medium'; release(): void }>()
    const h = harness()
    h.acquireOcrTier.mockImplementationOnce(() => ready.promise as never)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    ready.reject(new Error('private model initialization detail'))
    await vi.waitFor(() => expect(h.resultWindows[0]!.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL, expect.objectContaining({ type: 'failed', stage: 'ocr', code: 'OCR_UNAVAILABLE' })))
    await h.coordinator.dispose()
  })

  it('waits for the component installer before beginning capture and respects cancellation', async () => {
    const ready = deferred<boolean>()
    const h = harness({ prepareCapture: () => ready.promise })
    const pending = h.coordinator.beginCapture(h.owner as never)
    expect(h.capture.begin).not.toHaveBeenCalled()
    ready.resolve(false)
    await pending
    expect(h.capture.begin).not.toHaveBeenCalled()
  })

  it('starts after a verified component is ready but never after owner destruction', async () => {
    const ready = deferred<boolean>()
    const h = harness({ prepareCapture: () => ready.promise })
    const pending = h.coordinator.beginCapture(h.owner as never)
    h.owner.destroy()
    ready.resolve(true)
    await pending
    expect(h.capture.begin).not.toHaveBeenCalled()
    const full = harness({ prepareCapture: async () => true })
    await full.coordinator.beginCapture(full.owner as never)
    expect(full.capture.begin).toHaveBeenCalledOnce()
  })

  it('publishes the snapshot before starting OCR and automatically translates non-empty OCR', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    expect(h.translation.start).not.toHaveBeenCalled()
    expect(h.submitOcr()).toBe(true)
    await vi.waitFor(() => expect(h.translation.start).toHaveBeenCalledTimes(1))
    expect(result.webContents.send.mock.calls[0]).toEqual([
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'snapshot-ready', sessionId: SESSION_1, generation: 1 }),
    ])
    expect(result.webContents.send.mock.calls[1]).toEqual([
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'ocr-started' }),
    ])
    expect(result.webContents.send.mock.calls[2]).toEqual([
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'ocr-completed', blocks: [block()] }),
    ])
  })

  it('dispatches OCR to the exact owner window and accepts completion only from that owner', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')

    expect(h.owner.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_OCR_HOST_EVENT_CHANNEL,
      expect.objectContaining({
        type: 'recognize', sessionId: SESSION_1, generation: 1,
        tier: 'small', cacheKey: expect.stringMatching(/^small:/u),
      }),
    )
    const submission = {
      sessionId: SESSION_1, generation: 1, status: 'success' as const,
      result: { width: 4, height: 3, language: 'mul', blocks: [block()] },
    }
    expect(h.coordinator.submitOcrForOwner(new FakeWindow() as never, submission)).toBe(false)
    expect(h.coordinator.submitOcrForOwner(h.owner as never, submission)).toBe(true)
    expect(h.coordinator.settleOcrForOwner(h.owner as never, {
      sessionId: SESSION_1, generation: 1,
    })).toBe(true)
    await vi.waitFor(() => expect(h.translation.start).toHaveBeenCalledOnce())
  })

  it('publishes the acquired Medium tier and performs one main-authoritative Small fallback generation on Medium unavailable', async () => {
    const h = harness({ tier: 'medium' })
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    expect(h.resultWindows[0]!.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'snapshot-ready', generation: 1, tier: 'medium' }),
    )
    expect(h.coordinator.submitOcrForOwner(h.owner as never, { sessionId: SESSION_1, generation: 1, status: 'failure', code: 'OCR_UNAVAILABLE' })).toBe(true)
    expect(h.acquireOcrTier.mock.calls).toEqual([[undefined]])
    expect(h.releases[0]).not.toHaveBeenCalled()
    expect(h.coordinator.settleOcrForOwner(h.owner as never, { sessionId: SESSION_1, generation: 1 })).toBe(true)
    expect(h.acquireOcrTier.mock.calls).toEqual([[undefined], ['small']])
    expect(h.reportOcrTierUnavailable).toHaveBeenCalledWith('medium')
    expect(h.releases[0]).toHaveBeenCalledOnce()
    expect(h.resultWindows[0]!.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'snapshot-ready', generation: 2, tier: 'small' }),
    )
    expect(h.coordinator.submitOcrForOwner(h.owner as never, { sessionId: SESSION_1, generation: 1, status: 'failure', code: 'OCR_UNAVAILABLE' })).toBe(false)
    expect(h.coordinator.submitOcrForOwner(h.owner as never, { sessionId: SESSION_1, generation: 2, status: 'failure', code: 'OCR_UNAVAILABLE' })).toBe(true)
    expect(h.acquireOcrTier).toHaveBeenCalledTimes(2)
  })

  it('releases an acquired OCR tier lease when snapshot delivery fails before OCR starts', async () => {
    const h = harness({ tier: 'medium' })
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.send.mockImplementationOnce(() => { throw new Error('private send') })
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    expect(h.releases[0]).toHaveBeenCalledOnce()
    expect(h.reportDiagnostic).toHaveBeenCalledWith('RESULT_SEND_FAILED')
  })

  it('stops after OCR empty without invoking the model', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    expect(h.submitOcr(0, [])).toBe(true)
    await Promise.resolve()
    expect(h.translation.start).not.toHaveBeenCalled()
    expect(h.resultWindows[0]!.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'ocr-completed', blocks: [] }),
    )
  })

  it('preserves OCR blocks and forwards model-unconfigured guidance', async () => {
    const h = harness({ tier: 'medium' })
    h.translation.start.mockImplementationOnce(async (input) => {
      h.events.emit({
        sessionId: input.sessionId,
        generation: input.generation,
        type: 'failed', stage: 'translation', code: 'MODEL_NOT_CONFIGURED',
      })
      throw new ScreenshotTranslationServiceError('MODEL_NOT_CONFIGURED')
    })
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    expect(h.submitOcr()).toBe(true)
    await vi.waitFor(() => expect(h.resultWindows[0]!.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'failed', stage: 'translation', code: 'MODEL_NOT_CONFIGURED' }),
    ))
    expect(h.resultWindows[0]!.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'ocr-completed', blocks: [block()] }),
    )

    await expect(h.coordinator.startFor(
      h.resultWindows[0]! as never,
      { sessionId: SESSION_1, generation: 1 },
    )).resolves.toEqual({ sessionId: SESSION_1, generation: 2 })
    expect(h.resultWindows[0]!.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'snapshot-ready', generation: 2, tier: 'medium' }),
    )
    expect(h.translation.start).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: SESSION_1,
      generation: 2,
      blocks: [block()],
    }))
  })

  it.each([
    'OCR_UNAVAILABLE',
    'OCR_TIMEOUT',
    'OCR_FAILED',
  ] as const)('accepts fixed renderer OCR failure %s without starting translation', async (code) => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    expect(h.coordinator.submitOcrForOwner(h.owner as never, { sessionId: SESSION_1, generation: 1, status: 'failure', code })).toBe(true)
    await vi.waitFor(() => expect(h.resultWindows[0]!.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'failed', stage: 'ocr', code }),
    ))
    expect(h.translation.start).not.toHaveBeenCalled()
  })

  it('does not start OCR when the result closes before load readiness', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.emit('closed')
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    await Promise.resolve()
    expect(h.submitOcr()).toBe(false)
    await vi.waitFor(() => expect(h.registrations[0]!.dispose).toHaveBeenCalledTimes(1))
  })

  it('cleans result registration and window load failures exactly once', async () => {
    const registrationFailure = harness()
    registrationFailure.registerResultWindow.mockImplementationOnce(() => { throw new Error('register') })
    await registrationFailure.coordinator.beginCapture(registrationFailure.owner as never)
    await registrationFailure.captureHooks.onCaptured(registrationFailure.captured())
    await vi.waitFor(() => expect(registrationFailure.resultWindows[0]!.destroy).toHaveBeenCalledOnce())

    const loadFailure = harness()
    await loadFailure.coordinator.beginCapture(loadFailure.owner as never)
    await loadFailure.captureHooks.onCaptured(loadFailure.captured())
    loadFailure.resultWindows[0]!.webContents.emit('did-fail-load')
    await vi.waitFor(() => expect(loadFailure.resultWindows[0]!.destroy).toHaveBeenCalledOnce())
    expect(loadFailure.registrations[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('contains result construction failures to a fixed diagnostic without retaining native details', async () => {
    const h = harness()
    h.createResultWindow.mockImplementationOnce(() => { throw new Error('C:\\private\\capture.png') })
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    expect(h.resultWindows).toHaveLength(0)
    expect(h.reportDiagnostic).toHaveBeenCalledWith('RESULT_CREATE_FAILED')
    expect(JSON.stringify(h.reportDiagnostic.mock.calls)).not.toContain('private')
  })

  it('invalidates OCR ownership on close and rejects a late renderer result', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    const close = h.coordinator.closeFor(result as never, { sessionId: SESSION_1, generation: 1 })
    await close
    expect(h.releases[0]).toHaveBeenCalledOnce()
    expect(h.submitOcr()).toBe(false)
    expect(result.webContents.send).not.toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'ocr-completed' }),
    )
  })

  it('keeps the model lease until the owner host confirms cancellation during result close', async () => {
    const h = harness({ tier: 'medium' })
    h.owner.webContents.send.mockImplementation(() => undefined)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')

    let closed = false
    const closing = h.coordinator.closeFor(result as never, { sessionId: SESSION_1, generation: 1 })
      .then(() => { closed = true })
    await Promise.resolve()
    expect(h.owner.webContents.send).toHaveBeenLastCalledWith(
      SCREENSHOT_OCR_HOST_EVENT_CHANNEL,
      { type: 'cancel', sessionId: SESSION_1, generation: 1 },
    )
    expect(h.releases[0]).not.toHaveBeenCalled()
    expect(closed).toBe(false)

    expect(h.coordinator.settleOcrForOwner(h.owner as never, {
      sessionId: SESSION_1, generation: 1,
    })).toBe(true)
    await closing
    expect(h.releases[0]).toHaveBeenCalledOnce()
    expect(closed).toBe(true)
  })

  it('cancels and exactly settles active Medium OCR while the closing owner is still alive', async () => {
    const h = harness({ tier: 'medium' })
    h.owner.webContents.send.mockImplementation(() => undefined)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')

    let closed = false
    const closing = h.coordinator.closeOwner(h.owner as never).then(() => { closed = true })
    await Promise.resolve()
    expect(h.owner.isDestroyed()).toBe(false)
    expect(h.owner.webContents.send).toHaveBeenLastCalledWith(
      SCREENSHOT_OCR_HOST_EVENT_CHANNEL,
      { type: 'cancel', sessionId: SESSION_1, generation: 1 },
    )
    expect(h.releases[0]).not.toHaveBeenCalled()
    expect(closed).toBe(false)

    expect(h.coordinator.settleOcrForOwner(h.owner as never, {
      sessionId: SESSION_1, generation: 1,
    })).toBe(true)
    await closing
    expect(h.releases[0]).toHaveBeenCalledOnce()
    expect(closed).toBe(true)
  })

  it('synchronously rejects new captures while owner close is pending and keeps a completed close terminal', async () => {
    const h = harness({ tier: 'medium' })
    h.owner.webContents.send.mockImplementation(() => undefined)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    ;(h.capture.begin as ReturnType<typeof vi.fn>).mockClear()

    const closing = h.coordinator.closeOwner(h.owner as never)
    await h.coordinator.beginCapture(h.owner as never)
    expect(h.capture.begin).not.toHaveBeenCalled()

    expect(h.coordinator.settleOcrForOwner(h.owner as never, {
      sessionId: SESSION_1, generation: 1,
    })).toBe(true)
    await closing
    await h.coordinator.beginCapture(h.owner as never)
    expect(h.capture.begin).not.toHaveBeenCalled()
  })

  it('invalidates an in-flight pre-close capture and permits a fresh capture after aborting a live owner close', async () => {
    const h = harness()
    const pending = deferred<string | null>()
    ;(h.capture.begin as ReturnType<typeof vi.fn>).mockReturnValueOnce(pending.promise)

    const beginning = h.coordinator.beginCapture(h.owner as never)
    await h.coordinator.closeOwner(h.owner as never)
    h.coordinator.abortOwnerClose(h.owner as never)
    pending.resolve(SESSION_1)
    await beginning
    expect(h.capture.cancel).toHaveBeenCalledWith({ sessionId: SESSION_1 })

    ;(h.capture.begin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(SESSION_2)
    await h.coordinator.beginCapture(h.owner as never)
    expect(h.capture.begin).toHaveBeenCalledTimes(2)
  })

  it('falls back exactly once when an owner is destroyed during an already-started OCR close', async () => {
    const h = harness({ tier: 'medium' })
    h.owner.webContents.send.mockImplementation(() => undefined)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')

    const liveClose = h.coordinator.closeOwner(h.owner as never)
    await Promise.resolve()
    expect(h.releases[0]).not.toHaveBeenCalled()

    h.owner.destroyed = true
    h.owner.webContents.destroyed = true
    const destroyedFallback = h.coordinator.closeOwner(h.owner as never)
    await Promise.resolve()
    expect(h.releases[0]).toHaveBeenCalledOnce()

    await Promise.all([liveClose, destroyedFallback])
    expect(h.releases[0]).toHaveBeenCalledOnce()
  })

  it('accepts OCR only from the exact live window/session/generation/phase with matching bounded geometry', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    const other = new FakeWindow()
    const submission = {
      sessionId: SESSION_1, generation: 1, status: 'success' as const,
      result: { width: 4, height: 3, language: 'mul', blocks: [block()] },
    }
    expect(h.coordinator.submitOcrForOwner(h.owner as never, submission)).toBe(false)
    result.webContents.emit('did-finish-load')
    expect(h.coordinator.submitOcrForOwner(other as never, submission)).toBe(false)
    expect(h.coordinator.submitOcrForOwner(h.owner as never, { ...submission, sessionId: SESSION_2 })).toBe(false)
    expect(h.coordinator.submitOcrForOwner(h.owner as never, { ...submission, generation: 2 })).toBe(false)
    expect(h.coordinator.submitOcrForOwner(h.owner as never, {
      ...submission, result: { ...submission.result, width: 5 },
    })).toBe(false)
    expect(h.coordinator.submitOcrForOwner(h.owner as never, {
      ...submission,
      result: { ...submission.result, blocks: [{ ...block(), rectPx: { x: 3, y: 0, width: 2, height: 2 } }] },
    } as never)).toBe(false)
    expect(h.coordinator.submitOcrFor(result as never, submission)).toBe(false)
    expect(h.coordinator.submitOcrForOwner(h.owner as never, submission)).toBe(true)
    expect(h.coordinator.submitOcrForOwner(h.owner as never, submission)).toBe(false)
    await vi.waitFor(() => expect(h.translation.start).toHaveBeenCalledOnce())
  })

  it('fails a bounded OCR deadline and rejects the late renderer submission', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    h.fireOcrDeadline()
    expect(h.releases[0]).not.toHaveBeenCalled()
    expect(h.resultWindows[0]!.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'failed', stage: 'ocr', code: 'OCR_TIMEOUT' }),
    )
    expect(h.releases[0]).not.toHaveBeenCalled()
    expect(h.submitOcr()).toBe(false)
    expect(h.coordinator.settleOcrForOwner(h.owner as never, { sessionId: SESSION_1, generation: 1 })).toBe(true)
    expect(h.releases[0]).toHaveBeenCalledOnce()
    expect(h.translation.start).not.toHaveBeenCalled()
  })

  it('fails closed when deadline scheduling throws and cannot be revived by a later submission', async () => {
    const h = harness({ deadlineThrows: true })
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    expect(() => h.resultWindows[0]!.webContents.emit('did-finish-load')).not.toThrow()
    expect(h.resultWindows[0]!.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'failed', stage: 'ocr', code: 'OCR_FAILED' }),
    )
    expect(h.releases[0]).toHaveBeenCalledOnce()
    expect(h.submitOcr()).toBe(false)
    expect(h.coordinator.settleOcrForOwner(h.owner as never, { sessionId: SESSION_1, generation: 1 })).toBe(false)
    expect(h.releases[0]).toHaveBeenCalledOnce()
    expect(h.translation.start).not.toHaveBeenCalled()
  })

  it('pauses result IPC and waits for both inflight commands and model settlement before closing', async () => {
    const h = harness()
    const drain = deferred<void>()
    const model = deferred<void>()
    h.registrations.length = 0
    h.registerResultWindow.mockImplementationOnce((_window, operations) => {
      h.resultOperations.push(operations)
      const registration = {
        dispose: vi.fn(),
        pauseAndDrain: vi.fn(() => drain.promise),
        resume: vi.fn(),
      }
      h.registrations.push(registration)
      return registration
    })
    h.translation.cancel.mockImplementationOnce(async (input) => {
      h.events.emit({ ...input, type: 'translation-cancelled' })
      await model.promise
    })
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    h.submitOcr()
    await vi.waitFor(() => expect(h.translation.start).toHaveBeenCalledTimes(1))

    const closing = h.coordinator.closeFor(result as never, { sessionId: SESSION_1, generation: 1 })
    let settled = false
    void closing.then(() => { settled = true })
    await Promise.resolve()

    expect(h.registrations[0]!.pauseAndDrain).toHaveBeenCalledOnce()
    expect(h.registrations[0]!.dispose).not.toHaveBeenCalled()
    expect(result.destroy).not.toHaveBeenCalled()
    expect(settled).toBe(false)
    drain.resolve()
    await vi.waitFor(() => expect(result.destroy).toHaveBeenCalledOnce())
    expect(h.releases[0]).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    model.resolve()
    await closing
    expect(h.registrations[0]!.dispose).toHaveBeenCalledOnce()
  })

  it('validates sender and generation, returns the accepted retry token, and never reruns OCR', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    h.submitOcr()
    await vi.waitFor(() => expect(h.translation.start).toHaveBeenCalledTimes(1))
    const other = new FakeWindow()
    await expect(h.coordinator.startFor(other as never, { sessionId: SESSION_1, generation: 1 }))
      .resolves.toBeUndefined()
    await expect(h.coordinator.startFor(result as never, { sessionId: SESSION_1, generation: 9 }))
      .resolves.toBeUndefined()
    expect(h.translation.start).toHaveBeenCalledTimes(1)
    await expect(h.coordinator.startFor(result as never, { sessionId: SESSION_1, generation: 1 }))
      .resolves.toEqual({ sessionId: SESSION_1, generation: 2 })
    expect(h.translation.start).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 2 }))
    expect(result.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'snapshot-ready', generation: 2 }),
    )
    expect(result.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'ocr-completed', generation: 2 }),
    )
  })

  it('accepts a retry generation before deferred model setup but closes only after it settles', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    h.submitOcr()
    await vi.waitFor(() => expect(h.translation.start).toHaveBeenCalledTimes(1))
    const modelSetup = deferred<void>()
    h.translation.start.mockImplementationOnce(async (input) => {
      await modelSetup.promise
      return { ...input, targetLanguage: 'zh-CN' as const, modelId: 'model' }
    })

    await expect(h.coordinator.startFor(result as never, { sessionId: SESSION_1, generation: 1 }))
      .resolves.toEqual({ sessionId: SESSION_1, generation: 2 })
    const closing = h.coordinator.closeFor(result as never, { sessionId: SESSION_1, generation: 2 })
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()

    expect(closed).toBe(false)
    modelSetup.resolve()
    await closing
    expect(closed).toBe(true)
  })

  it('validates the token before minimizing or opening settings on the exact owner', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    const wrong = new FakeWindow()
    h.coordinator.minimizeFor(wrong as never, { sessionId: SESSION_1, generation: 1 })
    h.coordinator.openSettingsFor(result as never, { sessionId: SESSION_1, generation: 2 })
    expect(result.minimize).not.toHaveBeenCalled()
    expect(h.owner.focus).not.toHaveBeenCalled()
    h.owner.minimized = true
    h.coordinator.minimizeFor(result as never, { sessionId: SESSION_1, generation: 1 })
    h.coordinator.openSettingsFor(result as never, { sessionId: SESSION_1, generation: 1 })
    expect(result.minimize).toHaveBeenCalledOnce()
    expect(h.owner.restore).toHaveBeenCalledOnce()
    expect(h.owner.show).toHaveBeenCalledOnce()
    expect(h.owner.focus).toHaveBeenCalledOnce()
    expect(h.sendSettingsCommand).toHaveBeenCalledWith(h.owner)
  })

  it('routes only live known translation IDs and permits a valid partial subset', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    h.submitOcr()
    await vi.waitFor(() => expect(h.translation.start).toHaveBeenCalledTimes(1))
    h.events.emit({ sessionId: SESSION_1, generation: 1, type: 'translation-completed', translations: [{ id: 'line-2', text: 'bad' }] })
    h.events.emit({
      sessionId: SESSION_1, generation: 1, type: 'translation-completed',
      translations: [{ id: 'line-1', text: 'one' }, { id: 'line-1', text: 'two' }],
    } as never)
    h.events.emit({
      sessionId: SESSION_1, generation: 1, type: 'translation-completed',
      translations: [{ text: 'missing' }],
    } as never)
    expect(result.webContents.send).not.toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'translation-completed', translations: [{ id: 'line-2', text: 'bad' }] }),
    )
    h.events.emit({ sessionId: SESSION_1, generation: 1, type: 'translation-completed', translations: [] })
    expect(result.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'translation-completed', translations: [] }),
    )
  })

  it('routes live document progress and completion to the result window', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    h.submitOcr()
    await vi.waitFor(() => expect(h.translation.start).toHaveBeenCalledTimes(1))
    result.webContents.send.mockClear()

    h.events.emit({
      sessionId: SESSION_1,
      generation: 1,
      type: 'document-translation-progress',
      text: 'Bonjour',
      completedChunks: 0,
      totalChunks: 2,
    })
    h.events.emit({
      sessionId: SESSION_1,
      generation: 1,
      type: 'document-translation-completed',
      text: 'Bonjour\nmonde',
    })

    expect(result.webContents.send.mock.calls).toEqual([
      [SCREENSHOT_TRANSLATION_EVENT_CHANNEL, {
        sessionId: SESSION_1,
        generation: 1,
        type: 'document-translation-progress',
        text: 'Bonjour',
        completedChunks: 0,
        totalChunks: 2,
      }],
      [SCREENSHOT_TRANSLATION_EVENT_CHANNEL, {
        sessionId: SESSION_1,
        generation: 1,
        type: 'document-translation-completed',
        text: 'Bonjour\nmonde',
      }],
    ])
  })

  it('rejects out-of-phase and stale document events and returns to ready after completion', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    result.webContents.send.mockClear()

    h.events.emit({
      sessionId: SESSION_1,
      generation: 1,
      type: 'document-translation-progress',
      text: 'too early',
      completedChunks: 0,
      totalChunks: 2,
    })
    expect(result.webContents.send).not.toHaveBeenCalled()

    h.submitOcr()
    await vi.waitFor(() => expect(h.translation.start).toHaveBeenCalledTimes(1))
    result.webContents.send.mockClear()
    h.events.emit({
      sessionId: SESSION_1,
      generation: 2,
      type: 'document-translation-progress',
      text: 'stale',
      completedChunks: 0,
      totalChunks: 2,
    })
    expect(result.webContents.send).not.toHaveBeenCalled()

    h.events.emit({
      sessionId: SESSION_1,
      generation: 1,
      type: 'document-translation-completed',
      text: 'complete',
    })
    expect(result.webContents.send).toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'document-translation-completed', text: 'complete' }),
    )

    result.webContents.send.mockClear()
    expect(h.coordinator.cancelFor(result as never, { sessionId: SESSION_1, generation: 1 })).toBe(true)
    h.events.emit({
      sessionId: SESSION_1,
      generation: 1,
      type: 'document-translation-progress',
      text: 'too late',
      completedChunks: 1,
      totalChunks: 2,
    })
    expect(result.webContents.send).not.toHaveBeenCalled()
  })

  it('cancels only the exact active generation and ignores late completion', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    h.submitOcr()
    await vi.waitFor(() => expect(h.translation.start).toHaveBeenCalledTimes(1))
    h.coordinator.cancelFor(result as never, { sessionId: SESSION_1, generation: 1 })
    expect(h.translation.cancel).toHaveBeenCalledWith({ sessionId: SESSION_1, generation: 1 })
    h.events.emit({
      sessionId: SESSION_1, generation: 1, type: 'translation-completed',
      translations: [{ id: 'line-1', text: 'late' }],
    })
    expect(result.webContents.send).not.toHaveBeenCalledWith(
      SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
      expect.objectContaining({ type: 'translation-completed' }),
    )
  })

  it('keeps multiple owners isolated and refuses duplicate live session IDs', async () => {
    const h = harness()
    const secondOwner = new FakeWindow()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    ;(h.capture.begin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(SESSION_2)
    await h.coordinator.beginCapture(secondOwner as never)
    await h.captureHooks.onCaptured(h.captured(SESSION_2))
    expect(h.resultWindows).toHaveLength(2)
    await h.coordinator.closeOwner(h.owner as never)
    expect(h.resultWindows[0]!.destroyed).toBe(true)
    expect(h.resultWindows[1]!.destroyed).toBe(false)

    ;(h.capture.begin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(SESSION_2)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured(SESSION_2))
    expect(h.resultWindows).toHaveLength(2)
  })

  it('does not finish owner cleanup before its model cancellation settles', async () => {
    const h = harness()
    const model = deferred<void>()
    h.translation.cancel.mockImplementationOnce(async (input) => {
      h.events.emit({ ...input, type: 'translation-cancelled' })
      await model.promise
    })
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const result = h.resultWindows[0]!
    result.webContents.emit('did-finish-load')
    h.submitOcr()
    await vi.waitFor(() => expect(h.translation.start).toHaveBeenCalledOnce())

    const cleanup = h.coordinator.closeOwner(h.owner as never)
    let settled = false
    void cleanup.then(() => { settled = true })
    await Promise.resolve()

    expect(settled).toBe(false)
    model.resolve()
    await cleanup
    expect(settled).toBe(true)
    expect(result.destroy).toHaveBeenCalledOnce()
  })

  it('cancels a capture that resolves after its owner closes or disposal starts', async () => {
    const closedOwner = harness()
    const pendingOwner = deferred<string | null>()
    ;(closedOwner.capture.begin as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingOwner.promise)
    const beginning = closedOwner.coordinator.beginCapture(closedOwner.owner as never)
    closedOwner.owner.destroyed = true
    await closedOwner.coordinator.closeOwner(closedOwner.owner as never)
    pendingOwner.resolve(SESSION_1)
    await beginning
    expect(closedOwner.capture.cancel).toHaveBeenCalledWith({ sessionId: SESSION_1 })

    const disposing = harness()
    const pendingDispose = deferred<string | null>()
    ;(disposing.capture.begin as ReturnType<typeof vi.fn>).mockReturnValueOnce(pendingDispose.promise)
    const racingBegin = disposing.coordinator.beginCapture(disposing.owner as never)
    const disposal = disposing.coordinator.dispose()
    pendingDispose.resolve(SESSION_1)
    await Promise.all([racingBegin, disposal])
    expect(disposing.capture.cancel).toHaveBeenCalledWith({ sessionId: SESSION_1 })
  })

  it('hides only visible non-minimized results during static capture and restores them on failure', async () => {
    const h = harness()
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    const visible = h.resultWindows[0]!
    ;(h.capture.begin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(SESSION_2)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured(SESSION_2))
    const hidden = h.resultWindows[1]!; hidden.visible = false
    ;(h.capture.begin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(SESSION_3)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured(SESSION_3))
    const minimized = h.resultWindows[2]!; minimized.minimized = true
    for (const window of h.resultWindows) {
      window.hide.mockClear()
      window.showInactive.mockClear()
    }
    ;(h.capture.begin as ReturnType<typeof vi.fn>).mockResolvedValueOnce(SESSION_1)
    await h.coordinator.beginCapture(h.owner as never)
    expect(visible.hide).toHaveBeenCalledOnce()
    expect(visible.showInactive).toHaveBeenCalledOnce()
    expect(hidden.hide).not.toHaveBeenCalled()
    expect(minimized.hide).not.toHaveBeenCalled()
    visible.hide.mockClear()
    visible.showInactive.mockClear()
    ;(h.capture.begin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('capture'))
    await h.coordinator.beginCapture(h.owner as never)
    expect(visible.hide).toHaveBeenCalledTimes(1)
    expect(visible.showInactive).toHaveBeenCalledTimes(1)
    expect(hidden.hide).not.toHaveBeenCalled()
    expect(minimized.hide).not.toHaveBeenCalled()
  })

  it('disposes capture, all sessions, and translation exactly once', async () => {
    const h = harness()
    const translationDisposal = deferred<undefined>()
    h.translation.dispose.mockImplementationOnce(() => translationDisposal.promise)
    await h.coordinator.beginCapture(h.owner as never)
    await h.captureHooks.onCaptured(h.captured())
    h.resultWindows[0]!.webContents.emit('did-finish-load')
    const first = h.coordinator.dispose()
    const second = h.coordinator.dispose()
    let settled = false
    void first.then(() => { settled = true })
    await vi.waitFor(() => expect(h.translation.dispose).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    translationDisposal.resolve(undefined)
    await Promise.all([first, second])
    expect(h.capture.dispose).toHaveBeenCalledTimes(1)
    expect(h.translation.dispose).toHaveBeenCalledTimes(1)
    expect(h.registrations[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(h.releases[0]).toHaveBeenCalledOnce()
  })
})

it('falls back through live Arkdown windows from most to next-most recently active', () => {
  const primary = new FakeWindow()
  const secondary = new FakeWindow()
  const mostRecent = new FakeWindow()
  const result = new FakeWindow()
  const owners = new Set([primary, secondary, mostRecent])
  expect(screenshotCaptureOwner(secondary as never, mostRecent as never, owners as never)).toBe(secondary)
  expect(screenshotCaptureOwner(result as never, mostRecent as never, owners as never)).toBe(mostRecent)
  mostRecent.destroyed = true
  owners.delete(mostRecent)
  expect(screenshotCaptureOwner(result as never, mostRecent as never, owners as never)).toBe(secondary)
  secondary.destroyed = true
  owners.delete(secondary)
  expect(screenshotCaptureOwner(result as never, mostRecent as never, owners as never)).toBe(primary)
  primary.destroyed = true
  expect(screenshotCaptureOwner(result as never, mostRecent as never, owners as never)).toBeUndefined()
})
