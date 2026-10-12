import {
  clipRectToBounds,
  parseScreenshotCaptureEvent,
  type ScreenshotCaptureCommitInput,
  type ScreenshotCapturePointerInput,
  type ScreenshotCaptureReadyInput,
  type ScreenshotImage,
  type ScreenshotPoint,
  type ScreenshotRect,
  type ScreenshotSessionInput,
  type ScreenshotWindowHighlight,
} from '../../shared/screenshot-translation'
import { SCREENSHOT_CAPTURE_EVENT_CHANNEL } from '../../shared/contracts'
import {
  DisplayCaptureError,
  type CaptureFailureCode,
  type CapturedDisplay,
  type DisplayCaptureService,
  type NativeImageLike,
} from './display-capture'
import type { WindowHit, WindowHitTestService } from './window-hit-test'
import { isWindowHandle, nativeWindowHandleString } from './window-exclusions'
import { PublicError } from '../../shared/public-errors'

export interface ScreenshotCaptureResult {
  sessionId: string
  displayId: string
  selectionDip: ScreenshotRect
  image: ScreenshotImage
}

export interface ScreenshotCaptureCoordinator {
  begin(owner?: unknown): Promise<string | null>
  updatePointer(input: ScreenshotCapturePointerInput): Promise<ScreenshotWindowHighlight | null>
  ready(input: ScreenshotCaptureReadyInput): Promise<void>
  commit(input: ScreenshotCaptureCommitInput): Promise<void>
  cancel(input?: ScreenshotSessionInput): Promise<void>
  dispose(): Promise<void>
}

export interface OverlayWindowLike {
  getNativeWindowHandle(): Buffer
  webContents: { send(channel: string, value: unknown): void; isDestroyed?(): boolean }
  on(event: 'ready-to-show' | 'enter-full-screen' | 'closed' | 'blur', listener: () => void): void
  removeListener(event: 'enter-full-screen', listener: () => void): void
  isDestroyed?(): boolean
  isFocused(): boolean
  setBounds(bounds: ScreenshotRect, animate?: boolean): void
  setFullScreen(value: boolean): void
  getContentBounds(): ScreenshotRect
  show(): void
  showInactive?(): void
  focus(): void
  destroy(): void
}

export interface ScreenshotCaptureCoordinatorDependencies {
  capture: DisplayCaptureService
  hitTest: WindowHitTestService
  createWindow(input: { sessionId: string; display: CapturedDisplay['snapshot'] }): OverlayWindowLike
  screen: {
    dipToScreenPoint(point: { x: number; y: number }): { x: number; y: number }
    screenToDipRect(display: null, rect: ScreenshotRect): ScreenshotRect
  }
  createSessionId(): string
  excludedWindowHandles(): ReadonlySet<string>
  onCaptured(result: ScreenshotCaptureResult): void | Promise<void>
  onDeliveryFailed(code: 'CAPTURE_UNAVAILABLE'): void | Promise<void>
  onCaptureFailed(owner: unknown, code: CaptureFailureCode): void | Promise<void>
  registerOverlay(
    window: OverlayWindowLike,
    displayId: string,
    operations: Pick<ScreenshotCaptureCoordinator, 'updatePointer' | 'ready' | 'commit' | 'cancel'>,
  ): { dispose(): void }
}

interface ActiveSession {
  id: string
  owner: unknown
  displays: ReadonlyMap<string, CapturedDisplay>
  windows: Map<string, OverlayWindowLike>
  registrations: { dispose(): void }[]
  hits: Map<string, { processId: number; rectDip: ScreenshotRect }>
  nativeHits: Map<string, { hit: WindowHit; pointPx: ScreenshotPoint }>
  visibleHighlightDisplayIds: Set<string>
  pointerGeneration: number
  committing: boolean
  boundsReadyDisplayIds: Set<string>
  boundsWaitStartedDisplayIds: Set<string>
  rendererReadyDisplayIds: Set<string>
  focusDisplayId: string
  constructionFinished: boolean
  shown: boolean
  closed: boolean
  blurTimer?: NodeJS.Timeout
  boundsWaitTimers: Set<NodeJS.Timeout>
  boundsWaitCleanups: Set<() => void>
  readinessTimers: Set<NodeJS.Timeout>
  failureReported: boolean
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const OVERLAY_BOUNDS_POLL_INTERVAL_MS = 25
const OVERLAY_BOUNDS_TIMEOUT_MS = 500
const OVERLAY_LOAD_TIMEOUT_MS = 3_000
const OVERLAY_RENDERER_TIMEOUT_MS = 3_000

function validImage(image: NativeImageLike): ScreenshotImage | undefined {
  try {
    const size = image.getSize()
    const dataUrl = image.toDataURL()
    const event = parseScreenshotCaptureEvent({
      sessionId: '123e4567-e89b-42d3-a456-426614174000',
      type: 'selection-ready',
      display: {
        displayId: 'result',
        boundsDip: { x: 0, y: 0, width: 1, height: 1 },
        scaleFactor: 1,
        imageSizePx: size,
        dataUrl,
      },
    })
    return event?.type === 'selection-ready'
      ? { width: size.width, height: size.height, dataUrl }
      : undefined
  } catch {
    return undefined
  }
}

function canSend(window: OverlayWindowLike): boolean {
  return window.isDestroyed?.() !== true && window.webContents.isDestroyed?.() !== true
}

function sameBounds(left: ScreenshotRect, right: ScreenshotRect): boolean {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height
}

function captureFailureCode(error: unknown): CaptureFailureCode {
  return error instanceof DisplayCaptureError && error.code === 'CAPTURE_EMPTY'
    ? 'CAPTURE_EMPTY'
    : 'CAPTURE_UNAVAILABLE'
}

function ownerPoint(owner: unknown): { x: number; y: number } | undefined {
  const bounds = (owner as { getBounds?(): Partial<ScreenshotRect> } | undefined)?.getBounds?.()
  if (!bounds || typeof bounds.x !== 'number' || !Number.isFinite(bounds.x)
    || typeof bounds.y !== 'number' || !Number.isFinite(bounds.y)) return undefined
  const width = typeof bounds.width === 'number' && Number.isFinite(bounds.width) ? bounds.width : 0
  const height = typeof bounds.height === 'number' && Number.isFinite(bounds.height) ? bounds.height : 0
  return { x: bounds.x + Math.max(0, width) / 2, y: bounds.y + Math.max(0, height) / 2 }
}

function distanceToRectSquared(point: { x: number; y: number }, rect: ScreenshotRect): number {
  const dx = point.x < rect.x ? rect.x - point.x : point.x > rect.x + rect.width ? point.x - rect.x - rect.width : 0
  const dy = point.y < rect.y ? rect.y - point.y : point.y > rect.y + rect.height ? point.y - rect.y - rect.height : 0
  return dx * dx + dy * dy
}

function nearestDisplayId(owner: unknown, displays: Iterable<CapturedDisplay>, fallback: string): string {
  const point = ownerPoint(owner)
  if (!point) return fallback
  let nearest = fallback
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const display of displays) {
    const distance = distanceToRectSquared(point, display.snapshot.boundsDip)
    if (distance < nearestDistance) {
      nearest = display.snapshot.displayId
      nearestDistance = distance
    }
  }
  return nearest
}

function containsPoint(bounds: ScreenshotRect, point: { x: number; y: number }): boolean {
  return point.x >= bounds.x && point.y >= bounds.y
    && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height
}

export function createScreenshotCaptureCoordinator(
  deps: ScreenshotCaptureCoordinatorDependencies,
): ScreenshotCaptureCoordinator {
  let active: ActiveSession | undefined
  let beginning: Promise<string | null> | undefined
  let disposed = false
  let disposePromise: Promise<void> | undefined
  const deliveries = new Set<Promise<void>>()

  const reportCaptureFailure = async (owner: unknown, code: CaptureFailureCode): Promise<void> => {
    try { await deps.onCaptureFailed(owner, code) } catch { /* the native failure UI is best effort */ }
  }

  const send = (session: ActiveSession, displayId: string, event: unknown): boolean => {
    const window = session.windows.get(displayId)
    if (!window || !canSend(window)) return false
    try {
      window.webContents.send(SCREENSHOT_CAPTURE_EVENT_CHANNEL, event)
      return true
    } catch { return false }
  }

  const teardown = (session: ActiveSession, event?: 'cancelled') => {
    if (session.closed) return
    session.closed = true
    if (active === session) active = undefined
    if (session.blurTimer) clearTimeout(session.blurTimer)
    for (const timer of session.boundsWaitTimers) clearTimeout(timer)
    session.boundsWaitTimers.clear()
    for (const cleanup of session.boundsWaitCleanups) {
      try { cleanup() } catch { /* remove remaining fullscreen listeners */ }
    }
    session.boundsWaitCleanups.clear()
    for (const timer of session.readinessTimers) clearTimeout(timer)
    session.readinessTimers.clear()
    session.pointerGeneration += 1
    if (event) {
      for (const displayId of session.windows.keys()) {
        send(session, displayId, { sessionId: session.id, type: event })
      }
    }
    for (const registration of session.registrations) {
      try { registration.dispose() } catch { /* dispose remaining registrations */ }
    }
    session.registrations.length = 0
    for (const window of session.windows.values()) {
      try { if (!window.isDestroyed?.()) window.destroy() } catch { /* best effort */ }
    }
    session.windows.clear()
    session.hits.clear()
    session.nativeHits.clear()
    session.visibleHighlightDisplayIds.clear()
  }

  const failReadiness = (session: ActiveSession) => {
    if (session.closed || active !== session) return
    for (const displayId of session.windows.keys()) {
      send(session, displayId, { sessionId: session.id, type: 'failed', code: 'CAPTURE_UNAVAILABLE' })
    }
    const shouldReport = !session.failureReported
    session.failureReported = true
    teardown(session)
    if (shouldReport) void reportCaptureFailure(session.owner, 'CAPTURE_UNAVAILABLE')
  }

  const replaceHighlight = (
    session: ActiveSession,
    displayId: string,
    hit: { processId: number; rectDip: ScreenshotRect } | null,
  ) => {
    if (hit) {
      session.hits.set(displayId, hit)
      session.visibleHighlightDisplayIds.add(displayId)
      send(session, displayId, {
        sessionId: session.id,
        type: 'window-highlight',
        displayId,
        hit,
      })
      return
    }
    session.hits.delete(displayId)
    session.nativeHits.delete(displayId)
    if (!session.visibleHighlightDisplayIds.delete(displayId)) return
    send(session, displayId, {
      sessionId: session.id,
      type: 'window-highlight',
      displayId,
      hit: null,
    })
  }

  const clearOtherHighlights = (session: ActiveSession, displayId: string) => {
    for (const otherDisplayId of [...session.visibleHighlightDisplayIds]) {
      if (otherDisplayId !== displayId) replaceHighlight(session, otherDisplayId, null)
    }
  }

  const excludedWindows = (session: ActiveSession): ReadonlySet<string> => {
    const excluded = new Set(deps.excludedWindowHandles())
    for (const window of session.windows.values()) {
      if (window.isDestroyed?.()) continue
      excluded.add(nativeWindowHandleString(window.getNativeWindowHandle()))
    }
    if (excluded.size > 256 || [...excluded].some((value) => !isWindowHandle(value))) throw new PublicError('OPERATION_FAILED')
    return excluded
  }

  const showReadyOverlays = (session: ActiveSession) => {
    if (session.closed || session.shown || !session.constructionFinished
      || session.boundsReadyDisplayIds.size !== session.windows.size
      || session.rendererReadyDisplayIds.size !== session.windows.size) return
    session.shown = true
    try {
      for (const window of session.windows.values()) {
        if (window.showInactive) window.showInactive()
        else window.show()
      }
      session.windows.get(session.focusDisplayId)?.focus()
    } catch { failReadiness(session) }
  }

  const waitForFullDisplayBounds = (
    session: ActiveSession,
    display: CapturedDisplay['snapshot'],
    window: OverlayWindowLike,
  ) => {
    const deadline = Date.now() + OVERLAY_BOUNDS_TIMEOUT_MS
    let completed = false
    let retry: NodeJS.Timeout | undefined
    let detachListener = () => undefined
    const stopRetry = () => {
      if (!retry) return
      clearTimeout(retry)
      session.boundsWaitTimers.delete(retry)
      retry = undefined
    }
    const complete = () => {
      if (completed) return
      completed = true
      stopRetry()
      detachListener()
    }
    const canActivate = () => active === session && !session.closed
      && session.windows.get(display.displayId) === window
      && !session.boundsReadyDisplayIds.has(display.displayId)
      && canSend(window)
    const checkBounds = () => {
      if (completed) return
      stopRetry()
      if (!canActivate()) {
        complete()
        return
      }
      let contentBounds: ScreenshotRect | undefined
      try { contentBounds = window.getContentBounds() } catch { contentBounds = undefined }
      if (contentBounds && sameBounds(contentBounds, display.boundsDip)) {
        complete()
        session.boundsReadyDisplayIds.add(display.displayId)
        showReadyOverlays(session)
        return
      }
      if (Date.now() >= deadline) {
        complete()
        failReadiness(session)
        return
      }
      const timer = setTimeout(() => {
        session.boundsWaitTimers.delete(timer)
        if (retry === timer) retry = undefined
        checkBounds()
      }, OVERLAY_BOUNDS_POLL_INTERVAL_MS)
      retry = timer
      session.boundsWaitTimers.add(timer)
    }
    detachListener = () => {
      window.removeListener('enter-full-screen', checkBounds)
      session.boundsWaitCleanups.delete(detachListener)
    }
    session.boundsWaitCleanups.add(detachListener)
    window.on('enter-full-screen', checkBounds)
    try {
      window.setBounds(display.boundsDip, false)
      window.setFullScreen(true)
      checkBounds()
    } catch {
      complete()
      failReadiness(session)
    }
  }

  const coordinator: ScreenshotCaptureCoordinator = {
    begin(owner) {
      if (disposed) return Promise.resolve(null)
      if (active) {
        const displayId = nearestDisplayId(owner, active.displays.values(), active.focusDisplayId)
        active.focusDisplayId = displayId
        active.windows.get(displayId)?.focus()
        return Promise.resolve(active.id)
      }
      if (beginning) return beginning
      beginning = (async () => {
        let displays: readonly CapturedDisplay[]
        try {
          displays = await deps.capture.captureAll()
        } catch (error) {
          if (!disposed) await reportCaptureFailure(owner, captureFailureCode(error))
          return null
        }
        if (disposed) return null
        if (!displays.length) {
          await reportCaptureFailure(owner, 'CAPTURE_UNAVAILABLE')
          return null
        }
        const id = deps.createSessionId()
        if (!SESSION_ID_PATTERN.test(id)) return null
        const fallback = displays[0].snapshot.displayId
        const session: ActiveSession = {
          id,
          owner,
          displays: new Map(displays.map((captured) => [captured.snapshot.displayId, captured])),
          windows: new Map(),
          registrations: [],
          hits: new Map(),
          nativeHits: new Map(),
          visibleHighlightDisplayIds: new Set(),
          pointerGeneration: 0,
          committing: false,
          boundsReadyDisplayIds: new Set(),
          boundsWaitStartedDisplayIds: new Set(),
          rendererReadyDisplayIds: new Set(),
          focusDisplayId: nearestDisplayId(owner, displays, fallback),
          constructionFinished: false,
          shown: false,
          closed: false,
          boundsWaitTimers: new Set(),
          boundsWaitCleanups: new Set(),
          readinessTimers: new Set(),
          failureReported: false,
        }
        active = session
        try {
          for (const captured of displays) {
            const window = deps.createWindow({ sessionId: id, display: captured.snapshot })
            session.windows.set(captured.snapshot.displayId, window)
            const trustedDisplayId = captured.snapshot.displayId
            let loadTimer: NodeJS.Timeout | undefined
            const registration = deps.registerOverlay(window, trustedDisplayId, {
              updatePointer: (input) => input.displayId === trustedDisplayId
                ? coordinator.updatePointer(input)
                : Promise.resolve(null),
              ready: (input) => input.displayId === trustedDisplayId
                ? coordinator.ready(input)
                : Promise.resolve(),
              commit: (input) => input.displayId === trustedDisplayId
                ? coordinator.commit(input)
                : Promise.resolve(),
              cancel: (input) => coordinator.cancel(input),
            })
            if (!registration || typeof registration.dispose !== 'function') throw new Error('Overlay registration failed')
            session.registrations.push(registration)
            window.on('ready-to-show', () => {
              if (active !== session || session.closed || !canSend(window)) return
              if (session.boundsReadyDisplayIds.has(captured.snapshot.displayId)
                || session.boundsWaitStartedDisplayIds.has(captured.snapshot.displayId)) return
              if (loadTimer) {
                clearTimeout(loadTimer)
                session.readinessTimers.delete(loadTimer)
                loadTimer = undefined
              }
              session.boundsWaitStartedDisplayIds.add(captured.snapshot.displayId)
              waitForFullDisplayBounds(session, captured.snapshot, window)
              if (!session.closed && canSend(window)) {
                const delivered = send(session, captured.snapshot.displayId, {
                  sessionId: session.id,
                  type: 'selection-ready',
                  display: captured.snapshot,
                })
                if (!delivered) {
                  failReadiness(session)
                } else {
                  const rendererTimer = setTimeout(() => {
                    session.readinessTimers.delete(rendererTimer)
                    if (!session.rendererReadyDisplayIds.has(captured.snapshot.displayId)) failReadiness(session)
                  }, OVERLAY_RENDERER_TIMEOUT_MS)
                  session.readinessTimers.add(rendererTimer)
                }
              }
            })
            window.on('closed', () => {
              if (active === session && !session.committing) failReadiness(session)
            })
            window.on('blur', () => {
              if (active !== session || session.committing) return
              if (session.blurTimer) clearTimeout(session.blurTimer)
              session.blurTimer = setTimeout(() => {
                if (active !== session || session.committing) return
                if ([...session.windows.values()].every((candidate) => !candidate.isFocused())) {
                  teardown(session, 'cancelled')
                }
              }, 100)
            })
            loadTimer = setTimeout(() => {
              session.readinessTimers.delete(loadTimer!)
              loadTimer = undefined
              if (!session.boundsWaitStartedDisplayIds.has(captured.snapshot.displayId)) failReadiness(session)
            }, OVERLAY_LOAD_TIMEOUT_MS)
            session.readinessTimers.add(loadTimer)
          }
          session.constructionFinished = true
          showReadyOverlays(session)
          return id
        } catch {
          teardown(session)
          return null
        }
      })().finally(() => { beginning = undefined })
      return beginning
    },

    async ready(input) {
      const session = active
      if (!session || session.closed || session.id !== input.sessionId
        || !session.windows.has(input.displayId)) return
      session.rendererReadyDisplayIds.add(input.displayId)
      showReadyOverlays(session)
    },

    async updatePointer(input) {
      const session = active
      if (!session || session.id !== input.sessionId || session.committing) return null
      const display = session.displays.get(input.displayId)
      if (!display) return null
      const generation = ++session.pointerGeneration
      if (!containsPoint(display.snapshot.boundsDip, input.screenPointDip)) {
        replaceHighlight(session, input.displayId, null)
        return null
      }
      let excluded: ReadonlySet<string>
      try {
        excluded = excludedWindows(session)
      } catch {
        return null
      }
      let hit: Awaited<ReturnType<WindowHitTestService['hitTest']>>
      let physicalPoint: ScreenshotPoint
      try {
        physicalPoint = deps.screen.dipToScreenPoint(input.screenPointDip)
        hit = await deps.hitTest.hitTest(physicalPoint, excluded)
      } catch {
        if (active === session && !session.closed && generation === session.pointerGeneration && !session.committing) {
          session.hits.delete(input.displayId)
          session.nativeHits.delete(input.displayId)
        }
        return null
      }
      if (active !== session || session.closed || generation !== session.pointerGeneration || session.committing) return null

      let next: { processId: number; rectDip: ScreenshotRect } | null = null
      if (hit && Number.isSafeInteger(hit.processId) && hit.processId > 0 && isWindowHandle(hit.hwnd) && !excluded.has(hit.hwnd)) {
        try {
          const rectDip = clipRectToBounds(
            deps.screen.screenToDipRect(null, hit.boundsPx),
            display.snapshot.boundsDip,
          )
          if (rectDip) next = { processId: hit.processId, rectDip }
        } catch {
          session.hits.delete(input.displayId)
          session.nativeHits.delete(input.displayId)
          return null
        }
      }
      clearOtherHighlights(session, input.displayId)
      if (next && hit) session.nativeHits.set(input.displayId, { hit, pointPx: physicalPoint })
      replaceHighlight(session, input.displayId, next)
      return next
    },

    async commit(input) {
      const session = active
      if (!session || session.id !== input.sessionId || session.committing) return
      const display = session.displays.get(input.displayId)
      if (!display) return
      const selection = input.kind === 'region'
        ? clipRectToBounds(input.rectDip, display.snapshot.boundsDip)
        : (() => {
            const hit = session.hits.get(input.displayId)
            return hit && hit.processId === input.processId
              && hit.rectDip.x === input.rectDip.x && hit.rectDip.y === input.rectDip.y
              && hit.rectDip.width === input.rectDip.width && hit.rectDip.height === input.rectDip.height
              ? hit.rectDip
              : undefined
          })()
      if (!selection) {
        if (input.kind === 'window') throw new PublicError('OPERATION_FAILED')
        return
      }

      session.committing = true
      session.pointerGeneration += 1
      if (input.kind === 'window') {
        try {
          const expected = session.nativeHits.get(input.displayId)
          if (!expected) throw new PublicError('OPERATION_FAILED')
          const exclusions = excludedWindows(session)
          const current = await deps.hitTest.hitTest(expected.pointPx, exclusions)
          if (active !== session || session.closed || !current || exclusions.has(current.hwnd)
            || current.hwnd !== expected.hit.hwnd || current.processId !== expected.hit.processId
            || current.processCreationIdentity !== expected.hit.processCreationIdentity
            || !sameBounds(current.boundsPx, expected.hit.boundsPx)) throw new PublicError('OPERATION_FAILED')
        } catch {
          if (active === session && !session.closed) {
            session.committing = false
            replaceHighlight(session, input.displayId, null)
          }
          // Existing IPC converts PublicError into ok:false; the renderer can retry.
          throw new PublicError('OPERATION_FAILED')
        }
      }
      for (const displayId of session.windows.keys()) {
        send(session, displayId, { sessionId: session.id, type: 'committing' })
      }

      let image: ScreenshotImage | undefined
      try {
        image = validImage(deps.capture.crop(display, selection))
        if (!image) throw new DisplayCaptureError('CAPTURE_EMPTY')
      } catch (error) {
        const code = error instanceof DisplayCaptureError
          ? error.code
          : 'CAPTURE_EMPTY'
        for (const displayId of session.windows.keys()) {
          send(session, displayId, { sessionId: session.id, type: 'failed', code })
        }
        teardown(session)
        await reportCaptureFailure(session.owner, code)
        return
      }

      const result = { sessionId: session.id, displayId: input.displayId, selectionDip: selection, image }
      teardown(session)
      const delivery = Promise.resolve()
        .then(() => deps.onCaptured(result))
        .catch(() => deps.onDeliveryFailed('CAPTURE_UNAVAILABLE'))
        .then(() => undefined, () => undefined)
      deliveries.add(delivery)
      try {
        await delivery
      } finally {
        deliveries.delete(delivery)
      }
    },

    async cancel(input) {
      const session = active
      if (session && (!input || input.sessionId === session.id)) teardown(session, 'cancelled')
    },

    dispose() {
      if (disposePromise) return disposePromise
      disposed = true
      const session = active
      if (session) teardown(session, 'cancelled')
      disposePromise = (async () => {
        if (beginning) await beginning.catch(() => null)
        if (deliveries.size) await Promise.allSettled([...deliveries])
        await deps.hitTest.dispose()
      })()
      return disposePromise
    },
  }
  return coordinator
}
