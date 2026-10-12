import { createHash } from 'node:crypto'
import { isProxy } from 'node:util/types'
import type { CanonicalFileIdentity } from './document-identity'
import { OpenDocumentRegistry, type OpenDocumentLookup } from './open-document-registry'

const SHA256 = /^[0-9a-f]{64}$/u
const OPAQUE_TOKEN = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,511}$/u
const DEFAULT_PLANNING_TIMEOUT_MS = 15_000
const INTERRUPTED = Symbol('workspace-ai-editor-planning-interrupted')

export interface RegistryWorkspaceAiEditorBoundaryOptions {
  readonly planningTimeoutMs?: number
  readonly scheduleTimeout?: (callback: () => void, delayMs: number) => () => void
}

export interface WorkspaceAiEditorTarget {
  readonly windowId: number
  readonly workspaceId: string
  readonly generation: string
  readonly fileIdentity: CanonicalFileIdentity
}

export interface WorkspaceAiEditorBindingRef {
  readonly registrationToken: string
  readonly registrationRevision: number
  readonly bindingToken: string
  readonly bindingRevision: number
}

export type WorkspaceAiEditorLookupResult = OpenDocumentLookup

export interface WorkspaceAiEditorCapturePortInput extends WorkspaceAiEditorBindingRef {}

export type WorkspaceAiEditorCaptureResult =
  | Readonly<{
    status: 'captured'
    editorRevision: number
    contentHash: string
    markdown: string
    dirty: boolean
  } & WorkspaceAiEditorBindingRef>
  | Readonly<{ status: 'stale' }>
  | Readonly<{ status: 'unavailable' }>

export interface WorkspaceAiEditorPlanPortInput extends WorkspaceAiEditorBindingRef {
  readonly operationId: string
  readonly expectedEditorRevision: number
  readonly expectedContentHash: string
  readonly replacementMarkdown: string
}

export type WorkspaceAiEditorPlanResult =
  | Readonly<{
    status: 'planned'
    operationId: string
    editorRevision: number
    contentHash: string
  } & WorkspaceAiEditorBindingRef>
  | Readonly<{ status: 'stale' }>
  | Readonly<{ status: 'unavailable' }>

export interface WorkspaceAiEditorApplyInput extends WorkspaceAiEditorBindingRef {
  readonly operationId: string
  readonly expectedEditorRevision: number
  readonly expectedContentHash: string
  readonly replacementMarkdown: string
}

export type WorkspaceAiEditorApplyResult =
  | Readonly<{
    status: 'applied'
    operationId: string
    editorRevision: number
    contentHash: string
    dirty: boolean
  } & WorkspaceAiEditorBindingRef>
  | Readonly<{ status: 'stale' }>
  | Readonly<{ status: 'unknown' }>

export interface WorkspaceAiEditorQueryInput extends WorkspaceAiEditorBindingRef {
  readonly operationId: string
  readonly expectedEditorRevision: number
  readonly expectedContentHash: string
  readonly replacementContentHash: string
}

export type WorkspaceAiEditorQueryResult =
  | Extract<WorkspaceAiEditorApplyResult, { status: 'applied' }>
  | Readonly<{ status: 'not-applied' }>
  | Readonly<{ status: 'unknown' }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'stale' }>

export interface WorkspaceAiEditorBoundary {
  withIdentityLease<T>(target: WorkspaceAiEditorTarget, operation: () => T | Promise<T>): Promise<T>
  lookup(target: WorkspaceAiEditorTarget): Promise<WorkspaceAiEditorLookupResult>
  captureReadSnapshot(input: Readonly<{
    target: WorkspaceAiEditorTarget
  } & WorkspaceAiEditorBindingRef>, signal: AbortSignal): Promise<WorkspaceAiEditorCaptureResult>
  planReplacement(input: Readonly<{
    target: WorkspaceAiEditorTarget
    operationId: string
    expectedEditorRevision: number
    expectedContentHash: string
    replacementMarkdown: string
  } & WorkspaceAiEditorBindingRef>, signal: AbortSignal): Promise<WorkspaceAiEditorPlanResult>
  applyTransaction(input: Readonly<{
    target: WorkspaceAiEditorTarget
    plan: Extract<WorkspaceAiEditorPlanResult, { status: 'planned' }>
    replacementMarkdown: string
  }>): Promise<WorkspaceAiEditorApplyResult>
  queryOutcome(input: Readonly<{
    target: WorkspaceAiEditorTarget
    plan: Extract<WorkspaceAiEditorPlanResult, { status: 'planned' }>
    replacementMarkdown: string
  }>): Promise<WorkspaceAiEditorQueryResult>
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const own = Reflect.ownKeys(descriptors)
  return own.length === keys.length
    && own.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => {
      const descriptor = descriptors[key]
      return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    })
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_TOKEN.test(value)
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function bindingOf(value: WorkspaceAiEditorBindingRef): WorkspaceAiEditorBindingRef {
  return {
    registrationToken: value.registrationToken,
    registrationRevision: value.registrationRevision,
    bindingToken: value.bindingToken,
    bindingRevision: value.bindingRevision,
  }
}

function sameBinding(value: Record<string, unknown>, expected: WorkspaceAiEditorBindingRef): boolean {
  return value.registrationToken === expected.registrationToken
    && value.registrationRevision === expected.registrationRevision
    && value.bindingToken === expected.bindingToken
    && value.bindingRevision === expected.bindingRevision
}

function validBinding(value: Record<string, unknown>): boolean {
  return validToken(value.registrationToken) && validRevision(value.registrationRevision)
    && validToken(value.bindingToken) && validRevision(value.bindingRevision)
}

function unavailable(): Readonly<{ status: 'unavailable' }> { return Object.freeze({ status: 'unavailable' }) }
function stale(): Readonly<{ status: 'stale' }> { return Object.freeze({ status: 'stale' }) }
function unknown(): Readonly<{ status: 'unknown' }> { return Object.freeze({ status: 'unknown' }) }

const BINDING_KEYS = ['registrationToken', 'registrationRevision', 'bindingToken', 'bindingRevision'] as const

function parseCapture(value: unknown, binding: WorkspaceAiEditorBindingRef): WorkspaceAiEditorCaptureResult {
  if (exactRecord(value, ['status']) && value.status === 'stale') return stale()
  if (exactRecord(value, ['status']) && value.status === 'unavailable') return unavailable()
  if (!exactRecord(value, [
    'status', ...BINDING_KEYS, 'editorRevision', 'contentHash', 'markdown', 'dirty',
  ]) || value.status !== 'captured' || !validBinding(value) || !sameBinding(value, binding)
    || !validRevision(value.editorRevision) || typeof value.contentHash !== 'string'
    || !SHA256.test(value.contentHash) || typeof value.markdown !== 'string'
    || createHash('sha256').update(value.markdown).digest('hex') !== value.contentHash
    || typeof value.dirty !== 'boolean') return unavailable()
  return Object.freeze({
    status: 'captured', ...bindingOf(binding), editorRevision: value.editorRevision,
    contentHash: value.contentHash, markdown: value.markdown, dirty: value.dirty,
  })
}

function parsePlan(
  value: unknown,
  binding: WorkspaceAiEditorBindingRef,
  operationId: string,
  expectedEditorRevision: number,
  expectedContentHash: string,
): WorkspaceAiEditorPlanResult {
  if (exactRecord(value, ['status']) && value.status === 'stale') return stale()
  if (exactRecord(value, ['status']) && value.status === 'unavailable') return unavailable()
  if (!exactRecord(value, [
    'status', ...BINDING_KEYS, 'operationId', 'editorRevision', 'contentHash',
  ]) || value.status !== 'planned' || !validBinding(value) || !sameBinding(value, binding)
    || value.operationId !== operationId || value.editorRevision !== expectedEditorRevision
    || value.contentHash !== expectedContentHash) return unavailable()
  return Object.freeze({
    status: 'planned', ...bindingOf(binding), operationId,
    editorRevision: expectedEditorRevision, contentHash: expectedContentHash,
  })
}

function parseApplied(
  value: unknown,
  plan: Extract<WorkspaceAiEditorPlanResult, { status: 'planned' }>,
  replacementHash: string,
): Extract<WorkspaceAiEditorApplyResult, { status: 'applied' }> | undefined {
  if (!exactRecord(value, [
    'status', ...BINDING_KEYS, 'operationId', 'editorRevision', 'contentHash', 'dirty',
  ]) || value.status !== 'applied' || !validBinding(value) || !sameBinding(value, plan)
    || value.operationId !== plan.operationId || !validRevision(value.editorRevision)
    || value.editorRevision <= plan.editorRevision || value.contentHash !== replacementHash
    || typeof value.dirty !== 'boolean') return undefined
  return Object.freeze({
    status: 'applied', ...bindingOf(plan), operationId: plan.operationId,
    editorRevision: value.editorRevision, contentHash: replacementHash, dirty: value.dirty,
  })
}

export class RegistryWorkspaceAiEditorBoundary implements WorkspaceAiEditorBoundary {
  private readonly planningTimeoutMs: number
  private readonly scheduleTimeout: (callback: () => void, delayMs: number) => () => void

  constructor(
    private readonly registry: OpenDocumentRegistry,
    options: RegistryWorkspaceAiEditorBoundaryOptions = {},
  ) {
    const timeoutMs = options.planningTimeoutMs ?? DEFAULT_PLANNING_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('planningTimeoutMs must be a positive safe integer')
    }
    this.planningTimeoutMs = timeoutMs
    this.scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => { clearTimeout(timer) }
    })
  }

  private async awaitPlanningResponse<T>(
    signal: AbortSignal,
    invoke: (requestSignal: AbortSignal) => Promise<T>,
  ): Promise<T | typeof INTERRUPTED> {
    if (signal.aborted) return INTERRUPTED
    const requestController = new AbortController()
    let interrupt!: () => void
    const interrupted = new Promise<typeof INTERRUPTED>((resolve) => {
      interrupt = () => resolve(INTERRUPTED)
    })
    const onAbort = () => {
      requestController.abort(signal.reason)
      interrupt()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const cancelDeadline = this.scheduleTimeout(() => {
      requestController.abort(new DOMException('Editor planning request timed out', 'TimeoutError'))
      interrupt()
    }, this.planningTimeoutMs)
    const response = Promise.resolve().then(() => invoke(requestController.signal))
    void response.catch(() => undefined)
    try {
      return await Promise.race([response, interrupted])
    } finally {
      signal.removeEventListener('abort', onAbort)
      cancelDeadline()
    }
  }

  async withIdentityLease<T>(target: WorkspaceAiEditorTarget, operation: () => T | Promise<T>): Promise<T> {
    return await this.registry.withIdentityLease(target, operation)
  }

  async lookup(target: WorkspaceAiEditorTarget): Promise<WorkspaceAiEditorLookupResult> {
    return await this.withIdentityLease(target, () => this.registry.lookupLeased(target))
  }

  async captureReadSnapshot(input: Readonly<{
    target: WorkspaceAiEditorTarget
  } & WorkspaceAiEditorBindingRef>, signal: AbortSignal): Promise<WorkspaceAiEditorCaptureResult> {
    if (signal.aborted) return stale()
    return await this.withIdentityLease(input.target, async () => {
      if (signal.aborted) return stale()
      const binding = bindingOf(input)
      const port = this.registry.portLeased(input.target, binding)
      if (!port) return stale()
      try {
        const response = await this.awaitPlanningResponse(
          signal,
          async (requestSignal) => await port.captureReadSnapshot(Object.freeze(binding), requestSignal),
        )
        return response === INTERRUPTED ? stale() : parseCapture(response, binding)
      } catch {
        return unavailable()
      }
    })
  }

  async planReplacement(input: Readonly<{
    target: WorkspaceAiEditorTarget
    operationId: string
    expectedEditorRevision: number
    expectedContentHash: string
    replacementMarkdown: string
  } & WorkspaceAiEditorBindingRef>, signal: AbortSignal): Promise<WorkspaceAiEditorPlanResult> {
    if (signal.aborted) return stale()
    return await this.withIdentityLease(input.target, async () => {
      if (signal.aborted) return stale()
      const binding = bindingOf(input)
      const port = this.registry.portLeased(input.target, binding)
      if (!port) return stale()
      if (!validToken(input.operationId) || !validRevision(input.expectedEditorRevision)
        || !SHA256.test(input.expectedContentHash)) return unavailable()
      try {
        const response = await this.awaitPlanningResponse(
          signal,
          async (requestSignal) => await port.planReplacement(Object.freeze({
            ...binding,
            operationId: input.operationId,
            expectedEditorRevision: input.expectedEditorRevision,
            expectedContentHash: input.expectedContentHash,
            replacementMarkdown: input.replacementMarkdown,
          }), requestSignal),
        )
        return response === INTERRUPTED
          ? stale()
          : parsePlan(response, binding, input.operationId, input.expectedEditorRevision, input.expectedContentHash)
      } catch {
        return unavailable()
      }
    })
  }

  async applyTransaction(input: Readonly<{
    target: WorkspaceAiEditorTarget
    plan: Extract<WorkspaceAiEditorPlanResult, { status: 'planned' }>
    replacementMarkdown: string
  }>): Promise<WorkspaceAiEditorApplyResult> {
    return await this.withIdentityLease(input.target, async () => {
      const binding = bindingOf(input.plan)
      const port = this.registry.portLeased(input.target, binding)
      if (!port) return stale()
      try {
        const value = await port.applyTransaction(Object.freeze({
          ...binding,
          operationId: input.plan.operationId,
          expectedEditorRevision: input.plan.editorRevision,
          expectedContentHash: input.plan.contentHash,
          replacementMarkdown: input.replacementMarkdown,
        }))
        if (exactRecord(value, ['status']) && value.status === 'stale') return stale()
        if (exactRecord(value, ['status']) && value.status === 'unknown') return unknown()
        return parseApplied(value, input.plan, createHash('sha256').update(input.replacementMarkdown).digest('hex'))
          ?? unknown()
      } catch {
        return unknown()
      }
    })
  }

  async queryOutcome(input: Readonly<{
    target: WorkspaceAiEditorTarget
    plan: Extract<WorkspaceAiEditorPlanResult, { status: 'planned' }>
    replacementMarkdown: string
  }>): Promise<WorkspaceAiEditorQueryResult> {
    return await this.withIdentityLease(input.target, async () => {
      const binding = bindingOf(input.plan)
      const port = this.registry.portLeased(input.target, binding)
      if (!port) return stale()
      const replacementHash = createHash('sha256').update(input.replacementMarkdown).digest('hex')
      try {
        const value = await port.queryOutcome(Object.freeze({
          ...binding,
          operationId: input.plan.operationId,
          expectedEditorRevision: input.plan.editorRevision,
          expectedContentHash: input.plan.contentHash,
          replacementContentHash: replacementHash,
        }))
        const applied = parseApplied(value, input.plan, replacementHash)
        if (applied) return applied
        if (exactRecord(value, ['status'])
          && (value.status === 'not-applied' || value.status === 'unknown'
            || value.status === 'unavailable' || value.status === 'stale')) {
          return Object.freeze({ status: value.status })
        }
        return unknown()
      } catch {
        return unavailable()
      }
    })
  }
}
