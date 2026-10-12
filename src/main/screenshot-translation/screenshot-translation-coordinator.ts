import {
  parseScreenshotTranslationEvent,
  parseScreenshotOcrHostCommand,
  parseScreenshotOcrSubmission,
  type ScreenshotImage,
  type ScreenshotOcrBlock,
  type ScreenshotOcrSubmission,
  type ScreenshotRect,
  type ScreenshotTranslationEvent,
  type ScreenshotTranslationGenerationInput,
} from '../../shared/screenshot-translation'
import {
  SCREENSHOT_OCR_HOST_EVENT_CHANNEL,
  SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
} from '../../shared/contracts'
import type {
  ScreenshotCaptureCoordinator,
  ScreenshotCaptureResult,
} from './screenshot-capture-coordinator'
import {
  ScreenshotTranslationServiceError,
  type ScreenshotTranslationEventSink,
  type ScreenshotTranslationService,
} from './screenshot-translation-service'
import type { ScreenshotOcrTier } from '../../shared/screenshot-ocr-models'
import type { ScreenshotResultCloseLifecycle } from './screenshot-result-close-lifecycle'

export interface ScreenshotResultWindowLike {
  webContents: {
    mainFrame: unknown
    send(channel: string, value: unknown): void
    isDestroyed(): boolean
    once(event: 'did-finish-load' | 'did-fail-load', listener: () => void): void
  }
  once(event: 'closed', listener: () => void): void
  isDestroyed(): boolean
  destroy(): void
  minimize(): void
  isVisible(): boolean
  isMinimized(): boolean
  hide(): void
  showInactive(): void
}

export interface ScreenshotOwnerWindowLike {
  webContents: { isDestroyed(): boolean; send(channel: string, value: unknown): void }
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export interface ScreenshotResultRegistration {
  pauseAndDrain(): Promise<void>
  dispose(): void
}

export interface ScreenshotResultOperations {
  submit(input: ScreenshotOcrSubmission): boolean
  settleOcr(input: ScreenshotTranslationGenerationInput): boolean
  start(input: ScreenshotTranslationGenerationInput): Promise<ScreenshotTranslationGenerationInput | undefined>
  cancel(input: ScreenshotTranslationGenerationInput): boolean
  minimize(input: ScreenshotTranslationGenerationInput): boolean
  openSettings(input: ScreenshotTranslationGenerationInput): boolean
  canClose(input: ScreenshotTranslationGenerationInput): boolean
  close(input: ScreenshotTranslationGenerationInput): Promise<boolean>
}

export interface ScreenshotTranslationCoordinator {
  beginCapture(owner: ScreenshotOwnerWindowLike): Promise<void>
  submitOcrFor(sender: ScreenshotResultWindowLike, input: ScreenshotOcrSubmission): boolean
  settleOcrFor(sender: ScreenshotResultWindowLike, input: ScreenshotTranslationGenerationInput): boolean
  submitOcrForOwner(sender: ScreenshotOwnerWindowLike, input: ScreenshotOcrSubmission): boolean
  settleOcrForOwner(sender: ScreenshotOwnerWindowLike, input: ScreenshotTranslationGenerationInput): boolean
  startFor(sender: ScreenshotResultWindowLike, input: ScreenshotTranslationGenerationInput): Promise<ScreenshotTranslationGenerationInput | undefined>
  cancelFor(sender: ScreenshotResultWindowLike, input: ScreenshotTranslationGenerationInput): boolean
  minimizeFor(sender: ScreenshotResultWindowLike, input: ScreenshotTranslationGenerationInput): boolean
  openSettingsFor(sender: ScreenshotResultWindowLike, input: ScreenshotTranslationGenerationInput): boolean
  canCloseFor(sender: ScreenshotResultWindowLike, input: ScreenshotTranslationGenerationInput): boolean
  closeFor(sender: ScreenshotResultWindowLike, input: ScreenshotTranslationGenerationInput): Promise<boolean>
  closeOwner(owner: ScreenshotOwnerWindowLike): Promise<void>
  abortOwnerClose(owner: ScreenshotOwnerWindowLike): void
  dispose(): Promise<void>
}

export type ScreenshotCoordinatorDiagnosticCode =
  | 'CAPTURE_DELIVERY_FAILED'
  | 'RESULT_CREATE_FAILED'
  | 'RESULT_LOAD_FAILED'
  | 'RESULT_SEND_FAILED'

interface ScreenshotOcrTierLease {
  tier: ScreenshotOcrTier
  cacheKey?: string
  release(): void
}

export interface ScreenshotTranslationCoordinatorDependencies {
  prepareCapture?(owner: ScreenshotOwnerWindowLike): Promise<boolean>
  createCaptureCoordinator(hooks: {
    onCaptured(result: ScreenshotCaptureResult): void | Promise<void>
    onDeliveryFailed(code: 'CAPTURE_UNAVAILABLE'): void | Promise<void>
  }): ScreenshotCaptureCoordinator
  createResultWindow(
    input: { sessionId: string; imageSizePx: { width: number; height: number }; workAreaDip: ScreenshotRect },
    configure: (window: ScreenshotResultWindowLike) => void,
  ): ScreenshotResultWindowLike
  registerResultWindow(
    window: ScreenshotResultWindowLike,
    operations: ScreenshotResultOperations,
  ): ScreenshotResultRegistration
  createResultCloseLifecycle?(
    window: ScreenshotResultWindowLike,
    actions: { finalize(): Promise<void> },
  ): ScreenshotResultCloseLifecycle
  createTranslationService(events: ScreenshotTranslationEventSink): ScreenshotTranslationService
  workAreaFor(selectionDip: ScreenshotRect): ScreenshotRect
  sendSettingsCommand(owner: ScreenshotOwnerWindowLike): void
  scheduleOcrDeadline?(listener: () => void): { dispose(): void }
  reportDiagnostic?(code: ScreenshotCoordinatorDiagnosticCode): void
  acquireOcrTier?(forcedTier?: ScreenshotOcrTier): ScreenshotOcrTierLease | Promise<ScreenshotOcrTierLease>
  reportOcrTierUnavailable?(tier: ScreenshotOcrTier): void | Promise<void>
}

type ResultPhase = 'loading' | 'ocr' | 'ocr-stopping' | 'ready' | 'translation' | 'failed' | 'closing'

interface ResultSession {
  sessionId: string
  owner: ScreenshotOwnerWindowLike
  generation: number
  window: ScreenshotResultWindowLike
  registration?: ScreenshotResultRegistration
  closeLifecycle?: ScreenshotResultCloseLifecycle
  image: ScreenshotImage
  blocks: readonly ScreenshotOcrBlock[]
  blockIds: ReadonlySet<string>
  phase: ResultPhase
  ocrTier: ScreenshotOcrTier
  ocrDeadline?: { dispose(): void }
  ocrLease?: { tier: ScreenshotOcrTier; cacheKey?: string; release(): void }
  ocrSettlement?: { promise: Promise<void>; resolve(): void }
  pipeline?: Promise<void>
  pendingTranslationSettlements: Set<Promise<void>>
  closingPromise?: Promise<void>
  closing: boolean
  pendingSmallFallback: boolean
}

const OCR_DEADLINE_MS = 60_000

function completion() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function safeDiagnostic(
  dependencies: ScreenshotTranslationCoordinatorDependencies,
  code: ScreenshotCoordinatorDiagnosticCode,
): void {
  try { dependencies.reportDiagnostic?.(code) } catch { /* diagnostics never own lifecycle */ }
}

function canUseWindow(window: ScreenshotResultWindowLike): boolean {
  return !window.isDestroyed() && !window.webContents.isDestroyed()
}

export function screenshotCaptureOwner<T extends { isDestroyed(): boolean }>(
  focused: T | undefined,
  primary: T | null | undefined,
  arkdownWindows: ReadonlySet<T>,
): T | undefined {
  if (focused && arkdownWindows.has(focused) && !focused.isDestroyed()) return focused
  if (primary && arkdownWindows.has(primary) && !primary.isDestroyed()) return primary
  const candidates = [...arkdownWindows]
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]
    if (candidate && !candidate.isDestroyed()) return candidate
  }
  return undefined
}

export function createScreenshotTranslationCoordinator(
  dependencies: ScreenshotTranslationCoordinatorDependencies,
): ScreenshotTranslationCoordinator {
  const sessions = new Map<string, ResultSession>()
  const closingOwners = new WeakSet<ScreenshotOwnerWindowLike>()
  const ownerCloseEpochs = new WeakMap<ScreenshotOwnerWindowLike, number>()
  let captureOwner: { sessionId: string; owner: ScreenshotOwnerWindowLike } | undefined
  let disposed = false
  let disposePromise: Promise<void> | undefined
  const scheduleOcrDeadline = dependencies.scheduleOcrDeadline ?? ((listener: () => void) => {
    const timeout = setTimeout(listener, OCR_DEADLINE_MS)
    return { dispose: () => clearTimeout(timeout) }
  })

  const send = (session: ResultSession, event: ScreenshotTranslationEvent): boolean => {
    if (disposed || session.closing || sessions.get(session.sessionId) !== session || !canUseWindow(session.window)) return false
    const parsed = parseScreenshotTranslationEvent(event)
    if (!parsed || parsed.sessionId !== session.sessionId || parsed.generation !== session.generation) return false
    try {
      session.window.webContents.send(SCREENSHOT_TRANSLATION_EVENT_CHANNEL, parsed)
      return true
    } catch {
      safeDiagnostic(dependencies, 'RESULT_SEND_FAILED')
      return false
    }
  }

  const routeTranslationEvent = (candidate: ScreenshotTranslationEvent): void => {
    const event = parseScreenshotTranslationEvent(candidate)
    if (!event) return
    const session = sessions.get(event.sessionId)
    if (!session || session.closing || session.generation !== event.generation) return
    if (event.type === 'translation-completed') {
      if (session.phase !== 'translation') return
      const ids = new Set<string>()
      if (event.translations.some(({ id }) => ids.has(id) || !session.blockIds.has(id) || (ids.add(id), false))) return
      session.phase = 'ready'
    } else if (event.type === 'document-translation-completed') {
      if (session.phase !== 'translation') return
      session.phase = 'ready'
    } else if (event.type === 'document-translation-progress') {
      if (session.phase !== 'translation') return
    } else if (event.type === 'translation-started') {
      if (session.phase !== 'translation') return
      session.phase = 'translation'
    } else if (event.type === 'translation-cancelled') {
      if (session.phase !== 'translation') return
      session.phase = 'ready'
    } else if (event.type === 'failed' && event.stage === 'translation') {
      if (session.phase !== 'translation') return
      session.phase = 'failed'
    } else {
      return
    }
    send(session, event)
  }

  const translation = dependencies.createTranslationService({ emit: routeTranslationEvent })

  const startTranslation = async (session: ResultSession): Promise<void> => {
    if (disposed || session.closing || sessions.get(session.sessionId) !== session || session.blocks.length === 0) return
    session.phase = 'translation'
    try {
      await translation.start({
        sessionId: session.sessionId,
        generation: session.generation,
        blocks: session.blocks,
      })
      trackTranslationSettlement(session, translation.whenSettled({
        sessionId: session.sessionId,
        generation: session.generation,
      }))
    } catch (error) {
      if (disposed || session.closing || sessions.get(session.sessionId) !== session) return
      if (error instanceof ScreenshotTranslationServiceError) {
        // The reviewed service emits its fixed failure before rejecting.
        return
      }
      session.phase = 'failed'
      send(session, {
        sessionId: session.sessionId,
        generation: session.generation,
        type: 'failed',
        stage: 'translation',
        code: 'TRANSLATION_FAILED',
      })
    }
  }

  const clearOcrDeadline = (session: ResultSession): void => {
    const deadline = session.ocrDeadline
    session.ocrDeadline = undefined
    try { deadline?.dispose() } catch { /* deadline cleanup never owns the session */ }
  }

  const clearOcrLease = (session: ResultSession): void => {
    const lease = session.ocrLease
    session.ocrLease = undefined
    try { lease?.release() } catch { /* lease cleanup never owns the session */ }
    const settlement = session.ocrSettlement
    session.ocrSettlement = undefined
    settlement?.resolve()
  }

  const sendOcrHostCommand = (session: ResultSession, command: unknown): boolean => {
    const parsed = parseScreenshotOcrHostCommand(command)
    if (!parsed || session.owner.isDestroyed() || session.owner.webContents.isDestroyed()) return false
    try {
      session.owner.webContents.send(SCREENSHOT_OCR_HOST_EVENT_CHANNEL, parsed)
      return true
    } catch {
      return false
    }
  }

  const cancelOcrHost = (session: ResultSession): boolean => sendOcrHostCommand(session, {
    type: 'cancel', sessionId: session.sessionId, generation: session.generation,
  })

  const startAcquiredOcr = (session: ResultSession): void => {
    if (!session.ocrLease) return
    session.ocrTier = session.ocrLease.tier
    if (!send(session, {
      sessionId: session.sessionId,
      generation: session.generation,
      type: 'snapshot-ready',
      image: session.image,
      tier: session.ocrLease.tier,
    })) {
      clearOcrLease(session)
      return
    }
    session.phase = 'ocr'
    if (!send(session, { sessionId: session.sessionId, generation: session.generation, type: 'ocr-started', tier: session.ocrLease.tier })) {
      clearOcrLease(session)
      session.phase = 'failed'
      return
    }
    clearOcrDeadline(session)
    try {
      const deadline = scheduleOcrDeadline(() => {
        if (disposed || session.closing || sessions.get(session.sessionId) !== session || session.phase !== 'ocr') return
        clearOcrDeadline(session)
        session.phase = 'failed'
        send(session, {
          sessionId: session.sessionId,
          generation: session.generation,
          type: 'failed', stage: 'ocr', code: 'OCR_TIMEOUT',
        })
        if (!cancelOcrHost(session)) clearOcrLease(session)
      })
      if (session.phase === 'ocr') session.ocrDeadline = deadline
      else {
        try { deadline.dispose() } catch { /* a synchronous deadline already closed OCR */ }
      }
    } catch {
      if (disposed || session.closing || sessions.get(session.sessionId) !== session || session.phase !== 'ocr') return
      session.phase = 'failed'
      send(session, {
        sessionId: session.sessionId, generation: session.generation,
        type: 'failed', stage: 'ocr', code: 'OCR_FAILED',
      })
      clearOcrLease(session)
      return
    }
    const command = {
      type: 'recognize',
      sessionId: session.sessionId,
      generation: session.generation,
      image: session.image,
      tier: session.ocrLease.tier,
      cacheKey: session.ocrLease.cacheKey ?? `${session.ocrLease.tier}:bundled`,
    }
    if (!sendOcrHostCommand(session, command)) {
      clearOcrDeadline(session)
      clearOcrLease(session)
      session.phase = 'failed'
      send(session, {
        sessionId: session.sessionId, generation: session.generation,
        type: 'failed', stage: 'ocr', code: 'OCR_UNAVAILABLE',
      })
      return
    }
  }

  const beginOcr = (session: ResultSession, forcedTier?: ScreenshotOcrTier): void => {
    if (disposed || session.closing || sessions.get(session.sessionId) !== session) return
    clearOcrLease(session)
    const settlement = completion()
    const generation = session.generation
    session.ocrSettlement = settlement
    const accept = (lease: ScreenshotOcrTierLease): void => {
      if (disposed || session.closing || sessions.get(session.sessionId) !== session
        || session.generation !== generation || session.ocrSettlement !== settlement) {
        try { lease.release() } finally { settlement.resolve() }
        return
      }
      session.ocrLease = lease
      startAcquiredOcr(session)
    }
    const fail = (): void => {
      settlement.resolve()
      if (session.ocrSettlement !== settlement) return
      session.ocrSettlement = undefined
      if (disposed || session.closing || sessions.get(session.sessionId) !== session) return
      session.phase = 'failed'
      send(session, { sessionId: session.sessionId, generation: session.generation,
        type: 'failed', stage: 'ocr', code: 'OCR_UNAVAILABLE' })
    }
    try {
      const lease = dependencies.acquireOcrTier?.(forcedTier)
        ?? { tier: forcedTier ?? 'small', release: () => undefined }
      if ('then' in lease) void lease.then(accept, fail).catch(fail)
      else accept(lease)
    } catch { fail() }
  }

  const trackTranslationSettlement = (session: ResultSession, settlement: Promise<void>): void => {
    session.pendingTranslationSettlements.add(settlement)
    void settlement.then(
      () => session.pendingTranslationSettlements.delete(settlement),
      () => session.pendingTranslationSettlements.delete(settlement),
    )
  }

  const beginClose = (session: ResultSession, destroy: boolean): Promise<void> => {
    if (session.closing) {
      if ((session.owner.isDestroyed() || session.owner.webContents.isDestroyed())
        && session.ocrLease) clearOcrLease(session)
      return session.closingPromise ?? Promise.resolve()
    }
    session.closing = true
    session.phase = 'closing'
    clearOcrDeadline(session)
    const ocrSettlement = session.ocrSettlement?.promise ?? Promise.resolve()
    if (session.ocrLease && !cancelOcrHost(session)) clearOcrLease(session)
    const registration = session.registration
    session.registration = undefined
    const drain = registration?.pauseAndDrain() ?? Promise.resolve()
    const cancellation = translation.cancel({
      sessionId: session.sessionId,
      generation: session.generation,
    })
    trackTranslationSettlement(session, cancellation)
    const pipeline = session.pipeline?.then(() => undefined, () => undefined) ?? Promise.resolve()
    session.closingPromise = (async () => {
      await drain.catch(() => undefined)
      try { registration?.dispose() } catch { /* dispose remaining resources */ }
      if (destroy && !session.window.isDestroyed()) {
        try { session.window.destroy() } catch { /* the closed event still cannot resurrect state */ }
      }
      await ocrSettlement
      clearOcrLease(session)
      sessions.delete(session.sessionId)
      await pipeline
      await Promise.allSettled([...session.pendingTranslationSettlements])
      translation.releaseSession(session.sessionId)
    })()
    return session.closingPromise
  }

  let capture!: ScreenshotCaptureCoordinator

  const requestResultClose = async (session: ResultSession): Promise<boolean> => {
    // A renderer that has never loaded cannot own a user settings draft. Actual
    // owner/window destruction uses the existing unconditional resource cleanup.
    if (session.closeLifecycle && canUseWindow(session.window)
      && !session.owner.isDestroyed() && !session.owner.webContents.isDestroyed()) {
      return session.closeLifecycle.requestClose()
    }
    await beginClose(session, true)
    return true
  }

  const acceptCapture = (result: ScreenshotCaptureResult): void => {
    const owner = captureOwner?.sessionId === result.sessionId ? captureOwner.owner : undefined
    if (captureOwner?.sessionId === result.sessionId) captureOwner = undefined
    if (disposed || !owner || owner.isDestroyed() || owner.webContents.isDestroyed()
      || sessions.has(result.sessionId)) return
    let session: ResultSession | undefined
    try {
      const workAreaDip = dependencies.workAreaFor(result.selectionDip)
      const window = dependencies.createResultWindow({
        sessionId: result.sessionId,
        imageSizePx: { width: result.image.width, height: result.image.height },
        workAreaDip,
      }, (candidate) => {
        if (session || disposed || sessions.has(result.sessionId)) throw new Error('Invalid result lifecycle')
        session = {
          sessionId: result.sessionId,
          owner,
          generation: 1,
          window: candidate,
          image: result.image,
          blocks: [],
          blockIds: new Set(),
          phase: 'loading',
          ocrTier: 'small',
          pendingTranslationSettlements: new Set(),
          closing: false,
          pendingSmallFallback: false,
        }
        sessions.set(result.sessionId, session)
        candidate.webContents.once('did-finish-load', () => {
          if (!session || session.closing || sessions.get(session.sessionId) !== session) return
          const liveSession = session
          session.closeLifecycle = dependencies.createResultCloseLifecycle?.(candidate, {
            finalize: () => beginClose(liveSession, false),
          })
          beginOcr(session)
        })
        candidate.webContents.once('did-fail-load', () => {
          if (!session || session.closing) return
          safeDiagnostic(dependencies, 'RESULT_LOAD_FAILED')
          void beginClose(session, true)
        })
        candidate.once('closed', () => {
          if (session && !session.closing) void beginClose(session, false)
        })
        session.registration = dependencies.registerResultWindow(candidate, {
          submit: (input) => coordinator.submitOcrFor(candidate, input),
          settleOcr: (input) => coordinator.settleOcrFor(candidate, input),
          start: (input) => coordinator.startFor(candidate, input),
          cancel: (input) => coordinator.cancelFor(candidate, input),
          minimize: (input) => coordinator.minimizeFor(candidate, input),
          openSettings: (input) => coordinator.openSettingsFor(candidate, input),
          canClose: (input) => coordinator.canCloseFor(candidate, input),
          close: (input) => coordinator.closeFor(candidate, input),
        })
      })
      if (!session || window !== session.window) throw new Error('Invalid result lifecycle')
    } catch {
      safeDiagnostic(dependencies, 'RESULT_CREATE_FAILED')
      if (session) void beginClose(session, true)
    }
  }

  capture = dependencies.createCaptureCoordinator({
    onCaptured: acceptCapture,
    onDeliveryFailed: () => {
      captureOwner = undefined
      safeDiagnostic(dependencies, 'CAPTURE_DELIVERY_FAILED')
    },
  })

  const owns = (
    sender: ScreenshotResultWindowLike,
    input: ScreenshotTranslationGenerationInput,
  ): ResultSession | undefined => {
    const session = sessions.get(input.sessionId)
    return !disposed && session && !session.closing
      && session.window === sender && session.generation === input.generation
      ? session
      : undefined
  }

  const coordinator: ScreenshotTranslationCoordinator = {
    async beginCapture(owner) {
      if (disposed || closingOwners.has(owner)
        || owner.isDestroyed() || owner.webContents.isDestroyed()) return
      const ownerCloseEpoch = ownerCloseEpochs.get(owner) ?? 0
      if (dependencies.prepareCapture) {
        try { if (!await dependencies.prepareCapture(owner)) return } catch { return }
        if (disposed || closingOwners.has(owner)
          || (ownerCloseEpochs.get(owner) ?? 0) !== ownerCloseEpoch
          || owner.isDestroyed() || owner.webContents.isDestroyed()) return
      }
      const hidden: ScreenshotResultWindowLike[] = []
      for (const session of sessions.values()) {
        try {
          if (!session.window.isDestroyed() && session.window.isVisible() && !session.window.isMinimized()) {
            session.window.hide()
            hidden.push(session.window)
          }
        } catch { /* an unavailable result does not block capture */ }
      }
      try {
        let sessionId: string | null = null
        try { sessionId = await capture.begin(owner) } catch { /* menu remains a safe fallback */ }
        if (sessionId && (disposed || closingOwners.has(owner)
          || (ownerCloseEpochs.get(owner) ?? 0) !== ownerCloseEpoch
          || owner.isDestroyed() || owner.webContents.isDestroyed())) {
          await capture.cancel({ sessionId })
        } else if (sessionId && captureOwner?.sessionId !== sessionId) {
          captureOwner = { sessionId, owner }
        }
      } finally {
        for (const window of hidden) {
          try { if (!window.isDestroyed()) window.showInactive() } catch { /* restore remaining windows */ }
        }
      }
    },

    submitOcrFor() {
      return false
    },

    submitOcrForOwner(sender, input) {
      const submission = parseScreenshotOcrSubmission(input)
      if (!submission) return false
      const session = sessions.get(submission.sessionId)
      if (disposed || !session || session.closing || session.owner !== sender
        || session.generation !== submission.generation || session.phase !== 'ocr') return false
      if (submission.status === 'failure') {
        clearOcrDeadline(session)
        const failedTier = session.ocrLease?.tier
        if (failedTier === 'medium' && submission.code === 'OCR_UNAVAILABLE'
          && session.generation < Number.MAX_SAFE_INTEGER) {
          try {
            void Promise.resolve(dependencies.reportOcrTierUnavailable?.('medium')).catch(() => undefined)
          } catch { /* fallback remains available */ }
          session.pendingSmallFallback = true
          session.phase = 'ocr-stopping'
          return true
        }
        session.phase = 'failed'
        return send(session, {
          sessionId: session.sessionId, generation: session.generation,
          type: 'failed', stage: 'ocr', code: submission.code,
        })
      }
      if (submission.result.width !== session.image.width || submission.result.height !== session.image.height) return false
      clearOcrDeadline(session)
      session.blocks = submission.result.blocks
      session.blockIds = new Set(session.blocks.map(({ id }) => id))
      session.phase = 'ready'
      if (!send(session, {
        sessionId: session.sessionId, generation: session.generation,
        type: 'ocr-completed', blocks: session.blocks,
      })) return false
      if (session.blocks.length > 0) {
        session.pipeline = startTranslation(session)
        trackTranslationSettlement(session, session.pipeline)
      }
      return true
    },

    settleOcrFor() {
      return false
    },

    settleOcrForOwner(sender, input) {
      const session = sessions.get(input.sessionId)
      if (!session || session.owner !== sender
        || session.generation !== input.generation) return false
      if (!session || !session.ocrLease) return false
      clearOcrLease(session)
      if (!session.closing && session.pendingSmallFallback) {
        session.pendingSmallFallback = false
        session.generation += 1
        session.phase = 'loading'
        beginOcr(session, 'small')
      }
      return true
    },

    startFor(sender, input) {
      const session = owns(sender, input)
      if (!session || session.blocks.length === 0 || input.generation >= Number.MAX_SAFE_INTEGER) {
        return Promise.resolve(undefined)
      }
      const oldGeneration = session.generation
      session.generation += 1
      trackTranslationSettlement(session, translation.cancel({
        sessionId: session.sessionId,
        generation: oldGeneration,
      }))
      send(session, {
        sessionId: session.sessionId, generation: session.generation,
        type: 'snapshot-ready', image: session.image,
        tier: session.ocrTier,
      })
      send(session, {
        sessionId: session.sessionId, generation: session.generation,
        type: 'ocr-completed', blocks: session.blocks,
      })
      trackTranslationSettlement(session, startTranslation(session))
      return Promise.resolve({ sessionId: session.sessionId, generation: session.generation })
    },

    cancelFor(sender, input) {
      const session = owns(sender, input)
      if (!session) return false
      trackTranslationSettlement(session, translation.cancel({
        sessionId: session.sessionId,
        generation: session.generation,
      }))
      return true
    },

    minimizeFor(sender, input) {
      const session = owns(sender, input)
      if (!session || session.window.isDestroyed()) return false
      try { session.window.minimize() } catch { /* no cross-window fallback */ }
      return true
    },

    openSettingsFor(sender, input) {
      const session = owns(sender, input)
      if (!session || session.owner.isDestroyed() || session.owner.webContents.isDestroyed()) return false
      try {
        if (session.owner.isMinimized()) session.owner.restore()
        session.owner.show()
        session.owner.focus()
        dependencies.sendSettingsCommand(session.owner)
      } catch { /* no alternate owner is allowed */ }
      return true
    },

    canCloseFor(sender, input) {
      return owns(sender, input) !== undefined
    },

    async closeFor(sender, input) {
      const session = owns(sender, input)
      if (!session) return false
      return requestResultClose(session)
    },

    async closeOwner(owner) {
      if (!closingOwners.has(owner)) {
        closingOwners.add(owner)
        ownerCloseEpochs.set(owner, (ownerCloseEpochs.get(owner) ?? 0) + 1)
      }
      const cleanup: Promise<unknown>[] = []
      if (captureOwner?.owner === owner) {
        const { sessionId } = captureOwner
        captureOwner = undefined
        cleanup.push(capture.cancel({ sessionId }))
      }
      cleanup.push(...[...sessions.values()]
        .filter((session) => session.owner === owner)
        .map((session) => requestResultClose(session)))
      const outcomes = await Promise.allSettled(cleanup)
      if (outcomes.some(outcome => outcome.status === 'rejected'
        || outcome.status === 'fulfilled' && outcome.value === false)) {
        throw new Error('Failed to close screenshot owner resources')
      }
    },

    abortOwnerClose(owner) {
      if (owner.isDestroyed() || owner.webContents.isDestroyed()) return
      closingOwners.delete(owner)
    },

    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      captureOwner = undefined
      const closing = [...sessions.values()].map((session) => beginClose(session, true))
      disposePromise = (async () => {
        await Promise.allSettled([capture.dispose()])
        await Promise.allSettled(closing)
        await translation.dispose()
      })()
      return disposePromise
    },
  }
  return coordinator
}
