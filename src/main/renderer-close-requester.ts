import { randomUUID } from 'node:crypto'
import { CLOSE_PREPARATION_CHANNELS, canTransitionClosePreparation, parseClosePreparationEvent, parseClosePreparationRequest,
  type ClosePreparationAttempt as StructuredAttempt, type ClosePreparationIdentity as StructuredIdentity,
  type ClosePreparationResult as StructuredResult, type ClosePreparationStage as StructuredStage } from '../shared/close-preparation'
import {
  CLOSE_CHANNELS,
  type ClosePreparationHeartbeat,
  type ClosePreparationRequest,
  type ClosePreparationResponse,
} from '../shared/contracts'

const DEFAULT_PREPARE_TIMEOUT_MS = 10_000

export interface StructuredClosePreparationObserver {
  enter(stage: StructuredStage): void
  heartbeat(): void
  unavailable?(reason: 'renderer-process-gone' | 'renderer-destroyed' | 'transport-unavailable'): void
}
/** Structured preparation is composed separately until the production close cutover. */
export function createStructuredRendererCloseRequester(options: {
  ipcMain: CloseIpcMain
  window: { webContents: CloseWebContents }
  createRequestId?: () => string
}): { prepare(attempt: StructuredAttempt, observer: StructuredClosePreparationObserver): Promise<StructuredResult>;
  isCurrent(attempt: StructuredAttempt): boolean; dispose(): void } {
  interface Request {
    identity: StructuredIdentity
    promise: Promise<StructuredResult>
    cleanup(): void
    frame: unknown
    lifetime: number
    unavailable(reason: Parameters<NonNullable<StructuredClosePreparationObserver['unavailable']>>[0]): void
  }
  let pending: Request | undefined, completed: Request | undefined
  let disposed = false
  let lifetime = 0
  const contents = options.window.webContents
  const onNavigation = (details?: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
    if (details?.isMainFrame === true && details.isSameDocument !== true) {
      lifetime += 1; pending?.unavailable('transport-unavailable')
    }
  }
  const onGone = () => { lifetime += 1; pending?.unavailable('renderer-process-gone') }
  const onDestroyed = () => { lifetime += 1; pending?.unavailable('renderer-destroyed') }
  contents.on('did-start-navigation', onNavigation)
  contents.on('render-process-gone', onGone)
  contents.on('destroyed', onDestroyed)
  const blocked = (unknown = false): Promise<StructuredResult> => Promise.resolve({ status: 'blocked',
    code: unknown ? 'document-result-unknown' : 'editor-unavailable' })
  const sameAttempt = (request: Request, attempt: StructuredAttempt) => request.identity.attemptId === attempt.attemptId
    && request.identity.generation === attempt.generation
  return {
    isCurrent(attempt) {
      const request = pending ?? completed
      return !disposed && !!request && sameAttempt(request, attempt)
        && request.frame === contents.mainFrame && request.lifetime === lifetime
    },
    prepare(attempt, observer) {
      if (disposed) return blocked()
      if (pending) return sameAttempt(pending, attempt) ? pending.promise : blocked(true)
      if (completed) {
        if (sameAttempt(completed, attempt)) return completed.promise
        if (attempt.generation <= completed.identity.generation) return blocked()
      }
      let identity: StructuredIdentity | undefined
      try { identity = parseClosePreparationRequest({ ...attempt, requestId: (options.createRequestId ?? randomUUID)() }) } catch { return blocked() }
      if (!identity) return blocked()
      const ownedIdentity = identity
      const webContents = options.window.webContents, frame = webContents.mainFrame
      const requestLifetime = lifetime
      let stage: StructuredStage = 'prepare-editor', sequence = 0
      let resolve!: (result: StructuredResult) => void
      const promise = new Promise<StructuredResult>(yes => { resolve = yes })
      const reported = new Set<string>()
      let request!: Request
      const owns = () => !disposed && pending === request
      const observe = (callback: () => void) => { try { callback() } catch { /* Feedback cannot change close authority. */ } }
      const unavailable = (reason: Parameters<NonNullable<StructuredClosePreparationObserver['unavailable']>>[0]) => {
        if (!owns() || reported.has(reason)) return
        reported.add(reason)
        observe(() => observer.unavailable?.(reason))
      }
      const onEvent = (event: CloseResponseEvent, input: unknown) => {
        if (!owns() || event.sender !== webContents || event.senderFrame !== frame
          || webContents.mainFrame !== frame || lifetime !== requestLifetime) return
        const value = parseClosePreparationEvent(input)
        if (!value || value.attemptId !== ownedIdentity.attemptId || value.generation !== ownedIdentity.generation
          || value.requestId !== ownedIdentity.requestId || value.sequence <= sequence) return
        if (value.type === 'stage' && !canTransitionClosePreparation(stage, value.stage)) return
        if (value.type === 'result' && value.result.status === 'ready' && stage !== 'settle-preferences') return
        sequence = value.sequence
        if (value.type === 'heartbeat') { observe(() => observer.heartbeat()); return }
        if (value.type === 'stage') {
          if (stage !== value.stage) { stage = value.stage; observe(() => observer.enter(value.stage)) }
          return
        }
        pending = undefined
        completed = request
        request.cleanup()
        resolve(value.result)
      }
      request = { identity, promise, frame, lifetime: requestLifetime, unavailable, cleanup() {
        observe(() => { options.ipcMain.removeListener(CLOSE_PREPARATION_CHANNELS.event, onEvent) })
      } }
      pending = request
      try {
        options.ipcMain.on(CLOSE_PREPARATION_CHANNELS.event, onEvent)
        webContents.send(CLOSE_PREPARATION_CHANNELS.request, identity)
      } catch { unavailable('transport-unavailable') }
      return promise
    },
    dispose() {
      if (disposed) return
      disposed = true
      pending?.cleanup()
      contents.removeListener('did-start-navigation', onNavigation)
      contents.removeListener('render-process-gone', onGone)
      contents.removeListener('destroyed', onDestroyed)
      // Disposal detaches observation; it never settles a write as cancelled/ready.
      pending = undefined
      completed = undefined
    },
  }
}

interface CloseResponseEvent {
  sender: unknown
  senderFrame: unknown
}

interface CloseIpcMain {
  on(
    channel: string,
    listener: (event: CloseResponseEvent, payload: unknown) => void,
  ): unknown
  removeListener(
    channel: string,
    listener: (event: CloseResponseEvent, payload: unknown) => void,
  ): unknown
}

interface CloseWebContents {
  mainFrame: unknown
  send(channel: string, payload: ClosePreparationRequest): void
  on(event: 'render-process-gone' | 'destroyed' | 'did-start-navigation', listener: (details?: { isMainFrame?: boolean; isSameDocument?: boolean }) => void): unknown
  removeListener(event: 'render-process-gone' | 'destroyed' | 'did-start-navigation', listener: (details?: { isMainFrame?: boolean; isSameDocument?: boolean }) => void): unknown
}

interface PendingRequest {
  requestId: string
  promise: Promise<boolean>
  resolve(ready: boolean): void
  reject(error: unknown): void
  cleanup(): void
}

function parseResponse(value: unknown): ClosePreparationResponse | null {
  if (typeof value !== 'object' || value === null) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== 2
    || !Object.prototype.hasOwnProperty.call(value, 'requestId')
    || !Object.prototype.hasOwnProperty.call(value, 'ok')
  ) return null
  const response = value as Record<string, unknown>
  if (typeof response.requestId !== 'string' || typeof response.ok !== 'boolean') return null
  return { requestId: response.requestId, ok: response.ok }
}

function parseHeartbeat(value: unknown): ClosePreparationHeartbeat | null {
  if (typeof value !== 'object' || value === null) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== 1
    || !Object.prototype.hasOwnProperty.call(value, 'requestId')
  ) return null
  const heartbeat = value as Record<string, unknown>
  if (typeof heartbeat.requestId !== 'string') return null
  return { requestId: heartbeat.requestId }
}

export function createRendererCloseRequester(options: {
  ipcMain: CloseIpcMain
  window: { webContents: CloseWebContents }
  createRequestId?: () => string
  timeoutMs?: number
}): {
  prepare(): Promise<boolean>
  dispose(): void
} {
  const createRequestId = options.createRequestId ?? randomUUID
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
    ? options.timeoutMs!
    : DEFAULT_PREPARE_TIMEOUT_MS
  let pending: PendingRequest | null = null
  let disposed = false

  const settle = (request: PendingRequest, ready: boolean) => {
    if (pending !== request) return
    pending = null
    request.cleanup()
    request.resolve(ready)
  }
  const reject = (request: PendingRequest, error: unknown) => {
    if (pending !== request) return
    pending = null
    request.cleanup()
    request.reject(error)
  }

  return {
    prepare(): Promise<boolean> {
      if (disposed) return Promise.resolve(false)
      if (pending) return pending.promise

      const requestId = createRequestId()
      let resolve!: (ready: boolean) => void
      let rejectPromise!: (error: unknown) => void
      const promise = new Promise<boolean>((resolvePreparation, rejectPreparation) => {
        resolve = resolvePreparation
        rejectPromise = rejectPreparation
      })
      let ipcListening = false
      let heartbeatListening = false
      let goneListening = false
      let destroyedListening = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let request!: PendingRequest
      const renewTimeout = () => {
        if (pending !== request) return
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => settle(request, false), timeoutMs)
      }
      const onResponse = (event: CloseResponseEvent, payload: unknown) => {
        const response = parseResponse(payload)
        if (
          event.sender !== options.window.webContents
          || event.senderFrame !== options.window.webContents.mainFrame
          || !response
          || response.requestId !== request.requestId
        ) return
        settle(request, response.ok)
      }
      const onHeartbeat = (event: CloseResponseEvent, payload: unknown) => {
        const heartbeat = parseHeartbeat(payload)
        if (
          event.sender !== options.window.webContents
          || event.senderFrame !== options.window.webContents.mainFrame
          || !heartbeat
          || heartbeat.requestId !== request.requestId
        ) return
        renewTimeout()
      }
      const onRendererUnavailable = () => settle(request, false)
      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        if (ipcListening) {
          options.ipcMain.removeListener(CLOSE_CHANNELS.response, onResponse)
          ipcListening = false
        }
        if (heartbeatListening) {
          options.ipcMain.removeListener(CLOSE_CHANNELS.heartbeat, onHeartbeat)
          heartbeatListening = false
        }
        if (goneListening) {
          options.window.webContents.removeListener('render-process-gone', onRendererUnavailable)
          goneListening = false
        }
        if (destroyedListening) {
          options.window.webContents.removeListener('destroyed', onRendererUnavailable)
          destroyedListening = false
        }
      }
      request = { requestId, promise, resolve, reject: rejectPromise, cleanup }
      pending = request

      try {
        options.ipcMain.on(CLOSE_CHANNELS.response, onResponse)
        ipcListening = true
        options.ipcMain.on(CLOSE_CHANNELS.heartbeat, onHeartbeat)
        heartbeatListening = true
        options.window.webContents.on('render-process-gone', onRendererUnavailable)
        goneListening = true
        options.window.webContents.on('destroyed', onRendererUnavailable)
        destroyedListening = true
        renewTimeout()
        options.window.webContents.send(CLOSE_CHANNELS.prepare, { requestId })
      } catch (error) {
        reject(request, error)
      }
      return promise
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (pending) settle(pending, false)
    },
  }
}
