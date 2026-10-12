import { createHash, randomUUID } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type { AiCurrentDocumentSource } from '../models/ai-conversation-session-service'

const MAX_IDENTIFIER_LENGTH = 512
const MAX_TOOL_CALL_ID_LENGTH = 256
const MAX_DISPLAY_NAME_LENGTH = 255
const MAX_SOURCE_FORMAT_LENGTH = 64
const CAPTURE_PAGE_CHARS = 48_000
const DEFAULT_MAX_CAPTURE_CHARS = 16 * 1024 * 1024
const HARD_MAX_CAPTURE_CHARS = 32 * 1024 * 1024
const DEFAULT_MAX_CAPTURE_BYTES = 64 * 1024 * 1024
const HARD_MAX_CAPTURE_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_CAPTURE_CALLS = 512
const HARD_MAX_CAPTURE_CALLS = 1_024
const DEFAULT_MAX_SNAPSHOTS = 8
const HARD_MAX_SNAPSHOTS = 32
const DEFAULT_MAX_PENDING_CALLS = 16
const HARD_MAX_PENDING_CALLS = 64
const DEFAULT_MAX_OPEN_CALLS = 4_096
const HARD_MAX_OPEN_CALLS = 4_096
const DEFAULT_MAX_READ_CALLS = 64
const HARD_MAX_READ_CALLS = 128
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000
const HARD_MAX_DRAIN_TIMEOUT_MS = 30_000
const OPAQUE_IDENTIFIER = /^[0-9A-Za-z][0-9A-Za-z._:-]*$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const TOOL_CALL_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]*$/u

type SourceOpenInput = Parameters<AiCurrentDocumentSource['openSnapshot']>[0]
type SourceSnapshot = NonNullable<Awaited<ReturnType<AiCurrentDocumentSource['openSnapshot']>>>
type SourceReadInput = Parameters<SourceSnapshot['readPage']>[0]
type SourceReadResult = Awaited<ReturnType<SourceSnapshot['readPage']>>

export interface WindowAiWorkspaceAuthority {
  readonly workspaceId: string
  readonly workspaceGeneration: string
}

export interface RendererCurrentDocumentBinding {
  readonly ownerId: number
  readonly requestId: string
  readonly conversationId: string
  readonly workspaceId: string
  readonly workspaceGeneration: string
  readonly toolCallId: string
  readonly brokerRequestId: string
}

export interface RendererCurrentDocumentOpenRequest extends RendererCurrentDocumentBinding {
  readonly expectedDocumentId?: string
  readonly cursor: 0
  readonly maxChars: number
}

export interface RendererCurrentDocumentReadRequest extends RendererCurrentDocumentBinding {
  readonly snapshotId: string
  readonly cursor: number
  readonly maxChars: number
}

export type RendererCurrentDocumentCaptureRequest =
  | RendererCurrentDocumentOpenRequest
  | RendererCurrentDocumentReadRequest

interface RendererCapturedFields {
  readonly snapshotId: string
  readonly displayName: string
  readonly sourceFormat: string
  readonly dirty: boolean
  readonly content: string
  readonly nextCursor: number | null
  readonly hasMore: boolean
  readonly totalChars: number
}

export type RendererCurrentDocumentOpenResult =
  | Readonly<{ status: 'unavailable' } & RendererCurrentDocumentOpenRequest>
  | Readonly<{ status: 'captured' } & RendererCurrentDocumentOpenRequest & RendererCapturedFields>

export type RendererCurrentDocumentReadResult =
  | Readonly<{ status: 'unavailable' } & RendererCurrentDocumentReadRequest>
  | Readonly<{ status: 'captured' } & RendererCurrentDocumentReadRequest & RendererCapturedFields>

export interface RendererCurrentDocumentReleaseRequest extends RendererCurrentDocumentBinding {
  readonly snapshotId: string
}

/**
 * Main-process adapter over sender-bound IPC. Implementations must return native
 * promises whose values are frozen, plain structured-clone data records.
 */
export interface RendererCurrentDocumentPort {
  openSnapshot(request: RendererCurrentDocumentOpenRequest, signal: AbortSignal): Promise<unknown>
  readPage(request: RendererCurrentDocumentReadRequest, signal: AbortSignal): Promise<unknown>
  release(request: RendererCurrentDocumentReleaseRequest): void | Promise<void>
}

export interface RendererCurrentDocumentPortRegistration {
  readonly portGeneration: number
  unregister(): Promise<void>
}

export interface WindowAiCurrentDocumentBrokerLimits {
  readonly maxSnapshots?: number
  readonly maxPendingCalls?: number
  readonly maxOpenCalls?: number
  readonly maxReadCallsPerSnapshot?: number
  readonly maxCaptureCalls?: number
  readonly maxCaptureChars?: number
  readonly maxCaptureBytes?: number
  readonly drainTimeoutMs?: number
}

export interface WindowAiCurrentDocumentCaptureHasher {
  update(value: string): void
  digestHex(): string
}

export interface WindowAiCurrentDocumentCapturePrimitives {
  utf8ByteLength(value: string): number
  createSha256(): WindowAiCurrentDocumentCaptureHasher
}

export interface WindowAiCurrentDocumentDrainTimer {
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

export interface WindowAiCurrentDocumentBrokerOptions {
  readonly ownerId: number
  readonly getWorkspaceAuthority: () => WindowAiWorkspaceAuthority | null
    | Promise<WindowAiWorkspaceAuthority | null>
  readonly createBrokerRequestId?: () => string
  readonly limits?: WindowAiCurrentDocumentBrokerLimits
  readonly capturePrimitives?: WindowAiCurrentDocumentCapturePrimitives
  readonly drainTimer?: WindowAiCurrentDocumentDrainTimer
}

interface BrokerLimits {
  readonly maxSnapshots: number
  readonly maxPendingCalls: number
  readonly maxOpenCalls: number
  readonly maxReadCallsPerSnapshot: number
  readonly maxCaptureCalls: number
  readonly maxCaptureChars: number
  readonly maxCaptureBytes: number
  readonly drainTimeoutMs: number
}

interface CapturedMetadata {
  readonly displayName: string
  readonly sourceFormat: string
  readonly dirty: boolean
  readonly totalChars: number
}

interface MainSnapshotVersion {
  readonly fileId: string
  readonly revision: string
  readonly size: number
  readonly mtimeMs: number
}

interface SnapshotState {
  readonly portState: PortState
  readonly binding: RendererCurrentDocumentBinding
  readonly snapshotId: string
  readonly metadata: CapturedMetadata
  content: string
  version: MainSnapshotVersion | null
  released: boolean
  readCalls: number
}

interface PendingOperation {
  readonly controller: AbortController
  readonly done: Promise<void>
  live(): boolean
  waitFor<T>(
    promise: Promise<T>,
    onLateFulfilled?: (value: T) => void | Promise<void>,
  ): Promise<RendererOperationOutcome<T>>
  finish(): void
  detach(): void
}

interface PendingRelease {
  readonly snapshotId: string
  readonly promise: Promise<void>
  detach(): void
}

interface PortState {
  readonly port: RendererCurrentDocumentPort
  readonly generation: number
  readonly operations: Set<PendingOperation>
  readonly snapshots: Map<string, SnapshotState>
  readonly seenSnapshotIds: Set<string>
  readonly releasedSnapshotIds: Set<string>
  readonly releaseBySnapshotId: Map<string, PendingRelease>
  readonly releasePromises: Set<PendingRelease>
  terminalDetached: boolean
}

interface ParsedCapturePage {
  readonly snapshotId: string
  readonly metadata: CapturedMetadata
  readonly content: string
  readonly nextCursor: number | null
  readonly hasMore: boolean
}

interface CaptureAccumulator {
  readonly chunks: string[]
  readonly hasher: WindowAiCurrentDocumentCaptureHasher
  charCount: number
  byteCount: number
}

type RendererOperationOutcome<T> =
  | Readonly<{ kind: 'fulfilled'; value: T }>
  | Readonly<{ kind: 'rejected' }>
  | Readonly<{ kind: 'detached' }>

const UNAVAILABLE = Object.freeze({ kind: 'unavailable' as const })
const RENDERER_REJECTED = Object.freeze({ kind: 'rejected' as const })
const RENDERER_DETACHED = Object.freeze({ kind: 'detached' as const })
const BINDING_KEYS = [
  'ownerId', 'requestId', 'conversationId', 'workspaceId', 'workspaceGeneration',
  'toolCallId', 'brokerRequestId',
] as const
const OPEN_REQUEST_KEYS = [...BINDING_KEYS, 'cursor', 'maxChars'] as const
const READ_REQUEST_KEYS = [...BINDING_KEYS, 'snapshotId', 'cursor', 'maxChars'] as const
const OPEN_UNAVAILABLE_KEYS = ['status', ...OPEN_REQUEST_KEYS] as const
const READ_UNAVAILABLE_KEYS = ['status', ...READ_REQUEST_KEYS] as const
const OPEN_CAPTURE_KEYS = [
  'status', ...OPEN_REQUEST_KEYS, 'snapshotId', 'displayName', 'sourceFormat', 'dirty',
  'content', 'nextCursor', 'hasMore', 'totalChars',
] as const
const READ_CAPTURE_KEYS = [
  'status', ...READ_REQUEST_KEYS, 'displayName', 'sourceFormat', 'dirty',
  'content', 'nextCursor', 'hasMore', 'totalChars',
] as const
const PORT_KEYS = ['openSnapshot', 'readPage', 'release'] as const

function exactDataRecord(value: unknown, keys: readonly string[], requireFrozen: boolean): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || (requireFrozen && !Object.isFrozen(value))) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(descriptors)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => {
      const descriptor = descriptors[key]
      return descriptor?.enumerable === true
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    })
}

function dataString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || isProxy(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && typeof descriptor.value === 'string' ? descriptor.value : undefined
}

function nativePromise(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' && value !== null && !isProxy(value)
    && Object.getPrototypeOf(value) === Promise.prototype && Reflect.ownKeys(value).length === 0
}

function operationTerminalGate<T>(
  rendererPromise: Promise<T>,
  onLateFulfilled?: (value: T) => void | Promise<void>,
): { readonly outcome: Promise<RendererOperationOutcome<T>>; detach(): void } {
  let terminal = false
  let resolveOutcome!: (outcome: RendererOperationOutcome<T>) => void
  const outcome = new Promise<RendererOperationOutcome<T>>((resolve) => { resolveOutcome = resolve })
  rendererPromise.then((value) => {
    if (!terminal) {
      terminal = true
      resolveOutcome(Object.freeze({ kind: 'fulfilled' as const, value }))
      return
    }
    if (onLateFulfilled === undefined) return
    let cleanup: unknown
    try {
      cleanup = onLateFulfilled(value)
    } catch {
      return
    }
    if (nativePromise(cleanup)) cleanup.then(() => undefined, () => undefined)
  }, () => {
    if (!terminal) {
      terminal = true
      resolveOutcome(RENDERER_REJECTED)
    }
  })
  return {
    outcome,
    detach: () => {
      if (terminal) return
      terminal = true
      resolveOutcome(RENDERER_DETACHED)
    },
  }
}

function validOpaqueIdentifier(value: unknown, maximumLength = MAX_IDENTIFIER_LENGTH): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
    && OPAQUE_IDENTIFIER.test(value)
}

function validToolCallId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TOOL_CALL_ID_LENGTH && TOOL_CALL_ID.test(value)
}

function validNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validDisplayName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DISPLAY_NAME_LENGTH
    || value !== value.trim() || /[\u0000\\/:<>"|?*]/u.test(value) || /[. ]$/u.test(value)) return false
  const stem = value.split('.', 1)[0]?.toUpperCase()
  return !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem ?? '')
}

function validUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const trailing = value.charCodeAt(index + 1)
      if (!(trailing >= 0xDC00 && trailing <= 0xDFFF)) return false
      index += 1
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return false
  }
  return true
}

function sameAuthority(first: WindowAiWorkspaceAuthority, second: WindowAiWorkspaceAuthority | null): boolean {
  return second !== null && first.workspaceId === second.workspaceId
    && first.workspaceGeneration === second.workspaceGeneration
}

function sameBinding(value: Record<string, unknown>, binding: RendererCurrentDocumentBinding): boolean {
  return value.ownerId === binding.ownerId && value.requestId === binding.requestId
    && value.conversationId === binding.conversationId && value.workspaceId === binding.workspaceId
    && value.workspaceGeneration === binding.workspaceGeneration && value.toolCallId === binding.toolCallId
    && value.brokerRequestId === binding.brokerRequestId
}

function sameMetadata(first: CapturedMetadata, second: CapturedMetadata): boolean {
  return first.displayName === second.displayName && first.sourceFormat === second.sourceFormat
    && first.dirty === second.dirty && first.totalChars === second.totalChars
}

function validAuthority(value: unknown): value is WindowAiWorkspaceAuthority {
  return exactDataRecord(value, ['workspaceId', 'workspaceGeneration'], false)
    && validOpaqueIdentifier(value.workspaceId) && validOpaqueIdentifier(value.workspaceGeneration)
}

function validOpenInput(value: unknown): value is SourceOpenInput {
  const optionalKeys = typeof value === 'object' && value !== null && 'expectedDocumentId' in value
    ? ['expectedDocumentId'] : []
  return exactDataRecord(value, [
    'requestId', 'conversationId', 'workspaceId', 'workspaceGeneration', 'toolCallId', 'signal',
    ...optionalKeys,
  ], false) && typeof value.requestId === 'string' && UUID.test(value.requestId)
    && typeof value.conversationId === 'string' && UUID.test(value.conversationId)
    && validOpaqueIdentifier(value.workspaceId) && validOpaqueIdentifier(value.workspaceGeneration)
    && validToolCallId(value.toolCallId) && value.signal instanceof AbortSignal
    && (!optionalKeys.length || (typeof value.expectedDocumentId === 'string' && UUID.test(value.expectedDocumentId)))
}

function validReadInput(value: unknown): value is SourceReadInput {
  return exactDataRecord(value, ['cursor', 'maxChars'], false) && validNonNegativeInteger(value.cursor)
    && validNonNegativeInteger(value.maxChars) && value.maxChars > 0 && value.maxChars <= CAPTURE_PAGE_CHARS
}

function validPort(value: unknown): value is RendererCurrentDocumentPort {
  return exactDataRecord(value, PORT_KEYS, false) && PORT_KEYS.every((key) => typeof value[key] === 'function')
}

function parseLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`Invalid current-document broker limit: ${name}`)
  }
  return value
}

function parseLimits(value: WindowAiCurrentDocumentBrokerLimits | undefined): BrokerLimits {
  return Object.freeze({
    maxSnapshots: parseLimit(value?.maxSnapshots, DEFAULT_MAX_SNAPSHOTS, HARD_MAX_SNAPSHOTS, 'maxSnapshots'),
    maxPendingCalls: parseLimit(value?.maxPendingCalls, DEFAULT_MAX_PENDING_CALLS, HARD_MAX_PENDING_CALLS, 'maxPendingCalls'),
    maxOpenCalls: parseLimit(value?.maxOpenCalls, DEFAULT_MAX_OPEN_CALLS, HARD_MAX_OPEN_CALLS, 'maxOpenCalls'),
    maxReadCallsPerSnapshot: parseLimit(
      value?.maxReadCallsPerSnapshot, DEFAULT_MAX_READ_CALLS, HARD_MAX_READ_CALLS, 'maxReadCallsPerSnapshot',
    ),
    maxCaptureCalls: parseLimit(value?.maxCaptureCalls, DEFAULT_MAX_CAPTURE_CALLS, HARD_MAX_CAPTURE_CALLS, 'maxCaptureCalls'),
    maxCaptureChars: parseLimit(value?.maxCaptureChars, DEFAULT_MAX_CAPTURE_CHARS, HARD_MAX_CAPTURE_CHARS, 'maxCaptureChars'),
    maxCaptureBytes: parseLimit(value?.maxCaptureBytes, DEFAULT_MAX_CAPTURE_BYTES, HARD_MAX_CAPTURE_BYTES, 'maxCaptureBytes'),
    drainTimeoutMs: parseLimit(
      value?.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS, HARD_MAX_DRAIN_TIMEOUT_MS, 'drainTimeoutMs',
    ),
  })
}

const DEFAULT_CAPTURE_PRIMITIVES: WindowAiCurrentDocumentCapturePrimitives = Object.freeze({
  utf8ByteLength: (value: string) => Buffer.byteLength(value, 'utf8'),
  createSha256: () => {
    const hash = createHash('sha256')
    return Object.freeze({
      update(value: string): void { hash.update(value, 'utf8') },
      digestHex(): string { return hash.digest('hex') },
    })
  },
})

const DEFAULT_DRAIN_TIMER: WindowAiCurrentDocumentDrainTimer = Object.freeze({
  schedule: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
})

function copyAuthority(value: WindowAiWorkspaceAuthority): WindowAiWorkspaceAuthority {
  return Object.freeze({ workspaceId: value.workspaceId, workspaceGeneration: value.workspaceGeneration })
}

function copyBinding(binding: RendererCurrentDocumentBinding): RendererCurrentDocumentBinding {
  return {
    ownerId: binding.ownerId,
    requestId: binding.requestId,
    conversationId: binding.conversationId,
    workspaceId: binding.workspaceId,
    workspaceGeneration: binding.workspaceGeneration,
    toolCallId: binding.toolCallId,
    brokerRequestId: binding.brokerRequestId,
  }
}

function createPortState(port: RendererCurrentDocumentPort, generation: number): PortState {
  return {
    port,
    generation,
    operations: new Set(),
    snapshots: new Map(),
    seenSnapshotIds: new Set(),
    releasedSnapshotIds: new Set(),
    releaseBySnapshotId: new Map(),
    releasePromises: new Set(),
    terminalDetached: false,
  }
}

function unavailableResult(value: unknown, request: RendererCurrentDocumentCaptureRequest): boolean {
  const keys = 'snapshotId' in request ? READ_UNAVAILABLE_KEYS
    : [...OPEN_UNAVAILABLE_KEYS, ...('expectedDocumentId' in request ? ['expectedDocumentId'] : [])]
  return exactDataRecord(value, keys, true) && value.status === 'unavailable'
    && sameBinding(value, request) && value.cursor === request.cursor && value.maxChars === request.maxChars
    && (!('expectedDocumentId' in request) || value.expectedDocumentId === request.expectedDocumentId)
    && (!('snapshotId' in request) || value.snapshotId === request.snapshotId)
}

function parseCapturePage(
  value: unknown,
  request: RendererCurrentDocumentCaptureRequest,
  expectedSnapshotId: string | null,
  expectedMetadata: CapturedMetadata | null,
  limits: BrokerLimits,
): ParsedCapturePage | undefined {
  const keys = 'snapshotId' in request ? READ_CAPTURE_KEYS
    : [...OPEN_CAPTURE_KEYS, ...('expectedDocumentId' in request ? ['expectedDocumentId'] : [])]
  if (!exactDataRecord(value, keys, true) || value.status !== 'captured'
    || !sameBinding(value, request) || value.cursor !== request.cursor || value.maxChars !== request.maxChars
    || ('expectedDocumentId' in request && value.expectedDocumentId !== request.expectedDocumentId)
    || !validOpaqueIdentifier(value.snapshotId) || (expectedSnapshotId !== null && value.snapshotId !== expectedSnapshotId)
    || ('snapshotId' in request && value.snapshotId !== request.snapshotId)
    || !validDisplayName(value.displayName) || !validOpaqueIdentifier(value.sourceFormat, MAX_SOURCE_FORMAT_LENGTH)
    || typeof value.dirty !== 'boolean' || typeof value.content !== 'string'
    || value.content.length > request.maxChars || !validUtf16(value.content)
    || !(value.nextCursor === null || validNonNegativeInteger(value.nextCursor))
    || typeof value.hasMore !== 'boolean' || !validNonNegativeInteger(value.totalChars)
    || value.totalChars > limits.maxCaptureChars) return undefined
  const consumed = request.cursor + value.content.length
  if (!Number.isSafeInteger(consumed) || request.cursor > value.totalChars || consumed > value.totalChars
    || (value.hasMore && (value.content.length === 0 || value.nextCursor !== consumed || consumed >= value.totalChars))
    || (!value.hasMore && (value.nextCursor !== null || consumed !== value.totalChars))) return undefined
  const metadata: CapturedMetadata = Object.freeze({
    displayName: value.displayName,
    sourceFormat: value.sourceFormat,
    dirty: value.dirty,
    totalChars: value.totalChars,
  })
  if (expectedMetadata !== null && !sameMetadata(metadata, expectedMetadata)) return undefined
  return Object.freeze({
    snapshotId: value.snapshotId,
    metadata: expectedMetadata ?? metadata,
    content: value.content,
    nextCursor: value.nextCursor,
    hasMore: value.hasMore,
  })
}

function safePageEnd(content: string, cursor: number, maxChars: number): number | null {
  if (cursor > content.length) return null
  if (cursor < content.length) {
    const unit = content.charCodeAt(cursor)
    if (unit >= 0xDC00 && unit <= 0xDFFF) return null
  }
  let end = Math.min(content.length, cursor + maxChars)
  if (end < content.length) {
    const preceding = content.charCodeAt(end - 1)
    const following = content.charCodeAt(end)
    if (preceding >= 0xD800 && preceding <= 0xDBFF && following >= 0xDC00 && following <= 0xDFFF) end -= 1
  }
  return end === cursor && cursor < content.length ? null : end
}

export class WindowAiCurrentDocumentBroker implements AiCurrentDocumentSource {
  readonly ownerId: number
  private readonly getWorkspaceAuthority: () => WindowAiWorkspaceAuthority | null
    | Promise<WindowAiWorkspaceAuthority | null>
  private readonly createBrokerRequestId: () => string
  private readonly limits: BrokerLimits
  private readonly capturePrimitives: WindowAiCurrentDocumentCapturePrimitives
  private readonly drainTimer: WindowAiCurrentDocumentDrainTimer
  private readonly seenBrokerRequestIds = new Set<string>()
  private currentPort: PortState | null = null
  private portGeneration = 0
  private transitionRevision = 0
  private cleanupBarrier: Promise<void> = Promise.resolve()
  private captureRevision = 0
  private pendingCalls = 0
  private openCalls = 0
  private disposed = false
  private disposePromise: Promise<void> | null = null

  constructor(options: WindowAiCurrentDocumentBrokerOptions) {
    if (!Number.isSafeInteger(options.ownerId) || options.ownerId <= 0) {
      throw new Error('Invalid current-document broker owner')
    }
    this.ownerId = options.ownerId
    this.getWorkspaceAuthority = options.getWorkspaceAuthority
    this.createBrokerRequestId = options.createBrokerRequestId ?? randomUUID
    this.limits = parseLimits(options.limits)
    this.capturePrimitives = options.capturePrimitives ?? DEFAULT_CAPTURE_PRIMITIVES
    this.drainTimer = options.drainTimer ?? DEFAULT_DRAIN_TIMER
  }

  async registerPort(port: RendererCurrentDocumentPort): Promise<RendererCurrentDocumentPortRegistration> {
    if (this.disposed) throw new Error('Current-document broker is disposed')
    if (!validPort(port)) throw new Error('Invalid current-document renderer port')
    const state = await this.transitionTo(port)
    if (state === null) throw new Error('Current-document renderer port registration was replaced')
    let unregisterPromise: Promise<void> | null = null
    return Object.freeze({
      portGeneration: state.generation,
      unregister: () => {
        if (unregisterPromise !== null) return unregisterPromise
        unregisterPromise = this.currentPort === state
          ? this.transitionTo(null).then(() => undefined)
          : this.cleanupBarrier
        return unregisterPromise
      },
    })
  }

  async replacePort(port: RendererCurrentDocumentPort | null): Promise<void> {
    if (port !== null && !validPort(port)) throw new Error('Invalid current-document renderer port')
    if (this.disposed) return
    await this.transitionTo(port)
  }

  async openSnapshot(input: SourceOpenInput): Promise<SourceSnapshot | null> {
    if (this.disposed || !validOpenInput(input) || input.signal.aborted) return null
    const portState = this.currentPort
    if (portState === null || this.pendingCalls >= this.limits.maxPendingCalls
      || this.openCalls >= this.limits.maxOpenCalls
      || this.captureRevision >= Number.MAX_SAFE_INTEGER) return null
    const operation = this.beginOperation(portState, input.signal)
    if (operation === null) return null
    try {
      const authorityOutcome = await operation.waitFor(this.authority())
      if (authorityOutcome.kind !== 'fulfilled') return null
      const authority = authorityOutcome.value
      if (!operation.live() || this.disposed || input.signal.aborted || this.currentPort !== portState
        || this.currentPort.generation !== portState.generation || authority === null
        || input.workspaceId !== authority.workspaceId || input.workspaceGeneration !== authority.workspaceGeneration
        || this.openCalls >= this.limits.maxOpenCalls
        || this.captureRevision >= Number.MAX_SAFE_INTEGER) return null
      this.openCalls += 1
      const brokerRequestId = this.nextBrokerRequestId()
      if (brokerRequestId === null) return null
      const binding: RendererCurrentDocumentBinding = Object.freeze({
        ownerId: this.ownerId,
        requestId: input.requestId,
        conversationId: input.conversationId,
        workspaceId: authority.workspaceId,
        workspaceGeneration: authority.workspaceGeneration,
        toolCallId: input.toolCallId,
        brokerRequestId,
      })
      const openRequest: RendererCurrentDocumentOpenRequest = Object.freeze({
        ...copyBinding(binding), cursor: 0, maxChars: CAPTURE_PAGE_CHARS,
        ...(input.expectedDocumentId !== undefined ? { expectedDocumentId: input.expectedDocumentId } : {}),
      })
      let returned: unknown
      try {
        returned = portState.port.openSnapshot(openRequest, operation.controller.signal)
      } catch {
        return null
      }
      if (!nativePromise(returned)) return null
      const openOutcome = await operation.waitFor(returned, (lateValue) => {
        const lateSnapshotId = dataString(lateValue, 'snapshotId')
        return lateSnapshotId !== undefined && validOpaqueIdentifier(lateSnapshotId)
          ? this.releaseSnapshotId(portState, binding, lateSnapshotId)
          : undefined
      })
      if (openOutcome.kind !== 'fulfilled') return null
      const raw = openOutcome.value
      if (unavailableResult(raw, openRequest)) return null
      const snapshotId = dataString(raw, 'snapshotId')
      const parsed = parseCapturePage(raw, openRequest, null, null, this.limits)
      if (!operation.live() || parsed === undefined) {
        if (snapshotId !== undefined && validOpaqueIdentifier(snapshotId)) {
          await this.releaseDuringOpen(operation, this.releaseSnapshotId(portState, binding, snapshotId))
        }
        return null
      }
      if (!await this.authorityStillLive(portState, authority, input.signal, operation)) {
        await this.releaseDuringOpen(operation, this.releaseSnapshotId(portState, binding, parsed.snapshotId))
        return null
      }
      if (portState.seenSnapshotIds.has(parsed.snapshotId)
        || portState.releaseBySnapshotId.has(parsed.snapshotId)
        || portState.releasedSnapshotIds.has(parsed.snapshotId)
        || portState.snapshots.size >= this.limits.maxSnapshots) {
        await this.releaseDuringOpen(operation, this.releaseSnapshotId(portState, binding, parsed.snapshotId))
        return null
      }
      portState.seenSnapshotIds.add(parsed.snapshotId)
      const state: SnapshotState = {
        portState,
        binding,
        snapshotId: parsed.snapshotId,
        metadata: parsed.metadata,
        content: '',
        version: null,
        released: false,
        readCalls: 0,
      }
      portState.snapshots.set(parsed.snapshotId, state)
      let accumulator: CaptureAccumulator
      try {
        accumulator = {
          chunks: [],
          hasher: this.capturePrimitives.createSha256(),
          charCount: 0,
          byteCount: 0,
        }
      } catch {
        await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
        return null
      }
      if (!this.appendCaptureChunk(accumulator, parsed.content)) {
        await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
        return null
      }
      let captureCalls = 1
      let nextCursor = parsed.nextCursor
      let hasMore = parsed.hasMore
      while (hasMore) {
        if (nextCursor === null || nextCursor !== accumulator.charCount
          || captureCalls >= this.limits.maxCaptureCalls
          || !await this.authorityStillLive(portState, authority, input.signal, operation)) {
          await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
          return null
        }
        const request: RendererCurrentDocumentReadRequest = Object.freeze({
          ...copyBinding(binding), snapshotId: state.snapshotId,
          cursor: nextCursor, maxChars: CAPTURE_PAGE_CHARS,
        })
        if (!operation.live()) {
          await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
          return null
        }
        let pageReturned: unknown
        try {
          pageReturned = portState.port.readPage(request, operation.controller.signal)
        } catch {
          await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
          return null
        }
        if (!nativePromise(pageReturned)) {
          await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
          return null
        }
        const pageOutcome = await operation.waitFor(pageReturned)
        if (pageOutcome.kind !== 'fulfilled' || !operation.live()) {
          await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
          return null
        }
        const pageRaw = pageOutcome.value
        if (unavailableResult(pageRaw, request)) {
          await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
          return null
        }
        const page = parseCapturePage(pageRaw, request, state.snapshotId, state.metadata, this.limits)
        if (page === undefined
          || !await this.authorityStillLive(portState, authority, input.signal, operation)) {
          await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
          return null
        }
        if (accumulator.charCount !== request.cursor || !this.appendCaptureChunk(accumulator, page.content)
          || accumulator.charCount !== request.cursor + page.content.length) {
          await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
          return null
        }
        captureCalls += 1
        nextCursor = page.nextCursor
        hasMore = page.hasMore
      }
      if (accumulator.charCount !== state.metadata.totalChars
        || !await this.authorityStillLive(portState, authority, input.signal, operation)) {
        await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
        return null
      }
      let content: string
      let revision: string
      try {
        content = accumulator.chunks.join('')
        revision = accumulator.hasher.digestHex()
      } catch {
        await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
        return null
      }
      if (content.length !== accumulator.charCount || !validUtf16(content)
        || !/^[0-9a-f]{64}$/u.test(revision) || !operation.live()
        || this.disposed || input.signal.aborted || this.currentPort !== portState) {
        await this.releaseDuringOpen(operation, this.releaseSnapshot(state))
        return null
      }
      state.content = content
      this.captureRevision += 1
      state.version = Object.freeze({
        fileId: `current-document.${this.captureRevision}`,
        revision,
        size: accumulator.byteCount,
        mtimeMs: this.captureRevision,
      })
      return Object.freeze({
        readPage: (request: SourceReadInput, signal: AbortSignal) => this.readBufferedPage(state, request, signal),
        release: () => this.releaseSnapshot(state),
      })
    } finally {
      operation.finish()
    }
  }

  private async releaseDuringOpen(operation: PendingOperation, release: Promise<void>): Promise<void> {
    await operation.waitFor(release)
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise
    this.disposed = true
    this.transitionRevision += 1
    const previous = this.currentPort
    this.currentPort = null
    const cleanup = previous === null ? Promise.resolve() : this.invalidatePort(previous)
    const prior = this.cleanupBarrier
    this.cleanupBarrier = Promise.allSettled([prior, cleanup]).then(() => undefined)
    this.disposePromise = this.cleanupBarrier
    return this.disposePromise
  }

  private async transitionTo(port: RendererCurrentDocumentPort | null): Promise<PortState | null> {
    if (this.disposed) return null
    this.transitionRevision += 1
    const revision = this.transitionRevision
    const previous = this.currentPort
    this.currentPort = null
    const cleanup = previous === null ? Promise.resolve() : this.invalidatePort(previous)
    const prior = this.cleanupBarrier
    const barrier = Promise.allSettled([prior, cleanup]).then(() => undefined)
    this.cleanupBarrier = barrier
    await barrier
    if (this.disposed || revision !== this.transitionRevision || port === null) return null
    if (this.portGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Current-document port generation exhausted')
    }
    this.portGeneration += 1
    const state = createPortState(port, this.portGeneration)
    this.currentPort = state
    return state
  }

  private async invalidatePort(state: PortState): Promise<void> {
    const operations = [...state.operations]
    for (const operation of operations) operation.controller.abort()
    for (const snapshot of [...state.snapshots.values()]) void this.releaseSnapshot(snapshot)
    const operationsSettled = await this.drainWithinDeadline(
      operations.map((operation) => operation.done),
    )
    state.terminalDetached = true
    if (!operationsSettled) {
      for (const operation of [...state.operations]) operation.detach()
    }
    await Promise.allSettled([...state.releasePromises].map((release) => release.promise))
  }

  private async drainWithinDeadline(waiters: readonly Promise<unknown>[]): Promise<boolean> {
    if (waiters.length === 0) return true
    const settled = Promise.allSettled(waiters).then(() => undefined)
    let resolveDeadline!: () => void
    const deadline = new Promise<void>((resolve) => { resolveDeadline = resolve })
    let timedOut = false
    let handle: unknown
    let scheduled = false
    try {
      try {
        handle = this.drainTimer.schedule(() => {
          timedOut = true
          resolveDeadline()
        }, this.limits.drainTimeoutMs)
        scheduled = true
      } catch {
        timedOut = true
        resolveDeadline()
      }
      await Promise.race([settled, deadline])
      return !timedOut
    } finally {
      if (scheduled) {
        try {
          this.drainTimer.cancel(handle)
        } catch {
          // The old port is already isolated; timer cleanup is best effort.
        }
      }
    }
  }

  private authority(): Promise<WindowAiWorkspaceAuthority | null> {
    let returned: WindowAiWorkspaceAuthority | null | Promise<WindowAiWorkspaceAuthority | null>
    try {
      returned = this.getWorkspaceAuthority()
    } catch {
      return Promise.resolve(null)
    }
    return Promise.resolve(returned).then(
      (value: unknown) => validAuthority(value) ? copyAuthority(value) : null,
      () => null,
    )
  }

  private async authorityStillLive(
    state: PortState,
    authority: WindowAiWorkspaceAuthority,
    signal: AbortSignal,
    operation: PendingOperation,
  ): Promise<boolean> {
    if (!operation.live() || this.disposed || signal.aborted || this.currentPort !== state
      || this.currentPort.generation !== state.generation) return false
    const outcome = await operation.waitFor(this.authority())
    return outcome.kind === 'fulfilled' && operation.live() && !this.disposed
      && !signal.aborted && this.currentPort === state
      && this.currentPort.generation === state.generation && sameAuthority(authority, outcome.value)
  }

  private nextBrokerRequestId(): string | null {
    let value: unknown
    try {
      value = this.createBrokerRequestId()
    } catch {
      return null
    }
    if (!validOpaqueIdentifier(value) || this.seenBrokerRequestIds.has(value)) return null
    this.seenBrokerRequestIds.add(value)
    return value
  }

  private beginOperation(state: PortState, signal: AbortSignal): PendingOperation | null {
    if (this.pendingCalls >= this.limits.maxPendingCalls || signal.aborted) return null
    const controller = new AbortController()
    let operation!: PendingOperation
    const abort = () => operation.detach()
    let finishDone!: () => void
    const done = new Promise<void>((resolve) => { finishDone = resolve })
    let finished = false
    let activeGate: { readonly detach: () => void } | null = null
    const close = () => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      state.operations.delete(operation)
      this.pendingCalls -= 1
      finishDone()
    }
    const detachActiveGate = () => {
      const gate = activeGate
      activeGate = null
      gate?.detach()
    }
    operation = {
      controller,
      done,
      live: () => !finished,
      waitFor: <T>(promise: Promise<T>, onLateFulfilled?: (value: T) => void | Promise<void>) => {
        const gate = operationTerminalGate(promise, onLateFulfilled)
        if (finished || activeGate !== null) {
          gate.detach()
          return gate.outcome
        }
        activeGate = gate
        void gate.outcome.then(() => {
          if (activeGate === gate) activeGate = null
        })
        return gate.outcome
      },
      finish: () => {
        detachActiveGate()
        close()
      },
      detach: () => {
        if (finished) return
        controller.abort()
        detachActiveGate()
        close()
      },
    }
    state.operations.add(operation)
    this.pendingCalls += 1
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      operation.detach()
      return null
    }
    return operation
  }

  private appendCaptureChunk(accumulator: CaptureAccumulator, content: string): boolean {
    const charCount = accumulator.charCount + content.length
    if (!Number.isSafeInteger(charCount) || charCount > this.limits.maxCaptureChars) return false
    let byteLength: number
    try {
      byteLength = this.capturePrimitives.utf8ByteLength(content)
    } catch {
      return false
    }
    const byteCount = accumulator.byteCount + byteLength
    if (!validNonNegativeInteger(byteLength) || !Number.isSafeInteger(byteCount)
      || byteCount > this.limits.maxCaptureBytes) return false
    try {
      accumulator.hasher.update(content)
    } catch {
      return false
    }
    accumulator.chunks.push(content)
    accumulator.charCount = charCount
    accumulator.byteCount = byteCount
    return true
  }

  private async readBufferedPage(
    state: SnapshotState,
    input: SourceReadInput,
    signal: AbortSignal,
  ): Promise<SourceReadResult> {
    if (state.released || !validReadInput(input) || !(signal instanceof AbortSignal) || signal.aborted
      || this.currentPort !== state.portState || state.version === null
      || state.readCalls >= this.limits.maxReadCallsPerSnapshot) {
      await this.releaseSnapshot(state)
      return UNAVAILABLE
    }
    const operation = this.beginOperation(state.portState, signal)
    if (operation === null) {
      await this.releaseSnapshot(state)
      return UNAVAILABLE
    }
    try {
      const outcome = await operation.waitFor(this.readBufferedPageWhileAttached(state, input, signal))
      if (outcome.kind !== 'fulfilled' || state.released || signal.aborted
        || this.currentPort !== state.portState) {
        void this.releaseSnapshot(state)
        return UNAVAILABLE
      }
      return outcome.value
    } finally {
      operation.finish()
    }
  }

  private async readBufferedPageWhileAttached(
    state: SnapshotState,
    input: SourceReadInput,
    signal: AbortSignal,
  ): Promise<SourceReadResult> {
    const authority = await this.authority()
    const snapshotVersion = state.version
    if (!sameAuthority({
      workspaceId: state.binding.workspaceId,
      workspaceGeneration: state.binding.workspaceGeneration,
    }, authority) || snapshotVersion === null || state.released || signal.aborted
      || this.currentPort !== state.portState) {
      await this.releaseSnapshot(state)
      return UNAVAILABLE
    }
    state.readCalls += 1
    const end = safePageEnd(state.content, input.cursor, input.maxChars)
    if (end === null) {
      await this.releaseSnapshot(state)
      return UNAVAILABLE
    }
    const content = state.content.slice(input.cursor, end)
    const nextCursor = end < state.content.length ? end : null
    const version = Object.freeze({ ...snapshotVersion })
    const result: SourceReadResult = Object.freeze({
      kind: 'document' as const,
      displayName: state.metadata.displayName,
      sourceFormat: state.metadata.sourceFormat,
      dirty: state.metadata.dirty,
      cursor: input.cursor,
      content,
      nextCursor,
      hasMore: nextCursor !== null,
      totalChars: state.content.length,
      version,
    })
    const finalAuthority = await this.authority()
    if (!sameAuthority(authority!, finalAuthority) || state.released || signal.aborted
      || this.currentPort !== state.portState) {
      await this.releaseSnapshot(state)
      return UNAVAILABLE
    }
    return result
  }

  private releaseSnapshot(state: SnapshotState): Promise<void> {
    return this.releaseSnapshotId(state.portState, state.binding, state.snapshotId)
  }

  private releaseSnapshotId(
    portState: PortState,
    candidateBinding: RendererCurrentDocumentBinding,
    snapshotId: string,
  ): Promise<void> {
    const existing = portState.releaseBySnapshotId.get(snapshotId)
    if (existing !== undefined) return existing.promise
    if (portState.releasedSnapshotIds.has(snapshotId)) return Promise.resolve()
    const accepted = portState.snapshots.get(snapshotId)
    const binding = accepted?.binding ?? candidateBinding
    if (accepted !== undefined) accepted.released = true
    portState.snapshots.delete(snapshotId)
    let resolvePromise!: () => void
    let settled = false
    let deadlineHandle: unknown
    let deadlineScheduled = false
    let release!: PendingRelease
    const promise = new Promise<void>((resolve) => { resolvePromise = resolve })
    const cancelDeadline = () => {
      if (!deadlineScheduled) return
      deadlineScheduled = false
      try {
        this.drainTimer.cancel(deadlineHandle)
      } catch {
        // The release is already terminal; timer cleanup is best effort.
      }
    }
    const settle = () => {
      if (settled) return
      settled = true
      cancelDeadline()
      if (portState.releaseBySnapshotId.get(snapshotId) === release) {
        portState.releaseBySnapshotId.delete(snapshotId)
      }
      portState.releasePromises.delete(release)
      portState.releasedSnapshotIds.add(snapshotId)
      resolvePromise()
    }
    release = { snapshotId, promise, detach: settle }
    portState.releaseBySnapshotId.set(snapshotId, release)
    portState.releasePromises.add(release)
    const request: RendererCurrentDocumentReleaseRequest = Object.freeze({
      ...copyBinding(binding), snapshotId,
    })
    let returned: unknown
    try {
      returned = portState.port.release(request)
    } catch {
      settle()
    }
    if (returned === undefined) {
      settle()
    } else if (nativePromise(returned)) {
      returned.then(settle, settle)
      if (!settled) {
        try {
          deadlineHandle = this.drainTimer.schedule(settle, this.limits.drainTimeoutMs)
          deadlineScheduled = true
          if (settled) cancelDeadline()
        } catch {
          settle()
        }
      }
    } else {
      settle()
    }
    if (portState.terminalDetached) {
      release.detach()
    }
    return promise
  }
}
