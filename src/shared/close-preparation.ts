/** Dedicated close-preparation wire data; recovery commands remain main-owned. */
export const CLOSE_PREPARATION_CHANNELS = Object.freeze({
  request: 'arkdown:close-preparation:request', event: 'arkdown:close-preparation:event',
  released: 'arkdown:close-preparation:released',
})
export type ClosePreparationStage = 'prepare-editor' | 'await-user' | 'settle-document' | 'settle-preferences' | 'await-preferences'
export interface ClosePreparationAttempt { readonly attemptId: string; readonly generation: number }
export interface ClosePreparationIdentity extends ClosePreparationAttempt { readonly requestId: string }
export interface ClosePreparationHandlerContext extends ClosePreparationIdentity { enter(stage: ClosePreparationStage): void }
export type ClosePreparationHandler = (context: ClosePreparationHandlerContext) => Promise<ClosePreparationResult>
export type ClosePreparationFailure = 'editor-unavailable' | 'document-save-failed' | 'draft-end-failed'
  | 'document-result-unknown' | 'preferences-save-failed'
export type ClosePreparationResult = { readonly status: 'ready' | 'cancelled' }
  | { readonly status: 'failed'; readonly code: Exclude<ClosePreparationFailure, 'document-result-unknown'> }
  | { readonly status: 'blocked'; readonly code: ClosePreparationFailure }
export type ClosePreparationEvent = ClosePreparationIdentity & { readonly sequence: number } & (
  { readonly type: 'heartbeat' } | { readonly type: 'stage'; readonly stage: ClosePreparationStage }
  | { readonly type: 'result'; readonly result: ClosePreparationResult })

const IDENTITY_KEYS = ['attemptId', 'generation', 'requestId']
const EVENT_KEYS = [...IDENTITY_KEYS, 'sequence', 'type']
const STAGES: readonly ClosePreparationStage[] = ['prepare-editor', 'await-user', 'settle-document', 'settle-preferences', 'await-preferences']
const FAILURES: readonly ClosePreparationFailure[] = ['editor-unavailable', 'document-save-failed', 'draft-end-failed',
  'document-result-unknown', 'preferences-save-failed']
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** Fixed data descriptors only. Never evaluate accessors or serialize renderer objects. */
function ownData(input: unknown, allowed: readonly string[]): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const keys = Reflect.ownKeys(input)
  if (keys.length > allowed.length) return undefined
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined
    result[key] = descriptor.value
  }
  return result
}

function identityOf(value: Record<string, unknown>): ClosePreparationIdentity | undefined {
  if (!uuid(value.attemptId) || !positiveInteger(value.generation) || !uuid(value.requestId)) return undefined
  return { attemptId: value.attemptId, generation: value.generation, requestId: value.requestId }
}

export function parseClosePreparationRequest(input: unknown): Readonly<ClosePreparationIdentity> | undefined {
  try {
    const value = ownData(input, IDENTITY_KEYS)
    const identity = value && identityOf(value)
    return identity ? Object.freeze(identity) : undefined
  } catch { return undefined }
}

export function parseClosePreparationAttempt(input: unknown): Readonly<ClosePreparationAttempt> | undefined {
  try {
    const value = ownData(input, ['attemptId', 'generation'])
    return value && uuid(value.attemptId) && positiveInteger(value.generation)
      ? Object.freeze({ attemptId: value.attemptId, generation: value.generation }) : undefined
  } catch { return undefined }
}

export function parseClosePreparationResult(input: unknown): Readonly<ClosePreparationResult> | undefined {
  try {
    const value = ownData(input, ['status', 'code'])
    if (!value) return undefined
    if ((value.status === 'ready' || value.status === 'cancelled') && Object.keys(value).length === 1) {
      return Object.freeze({ status: value.status })
    }
    if ((value.status !== 'failed' && value.status !== 'blocked') || Object.keys(value).length !== 2
      || !FAILURES.includes(value.code as ClosePreparationFailure)
      || (value.status === 'failed' && value.code === 'document-result-unknown')) return undefined
    return Object.freeze({ status: value.status, code: value.code }) as Readonly<ClosePreparationResult>
  } catch { return undefined }
}

export function parseClosePreparationEvent(input: unknown): Readonly<ClosePreparationEvent> | undefined {
  try {
    const value = ownData(input, [...EVENT_KEYS, 'stage', 'result'])
    const identity = value && identityOf(value)
    if (!value || !identity || !positiveInteger(value.sequence)) return undefined
    const base = { ...identity, sequence: value.sequence }
    const size = Object.keys(value).length
    if (value.type === 'heartbeat' && size === EVENT_KEYS.length) return Object.freeze({ ...base, type: 'heartbeat' })
    if (value.type === 'stage' && size === EVENT_KEYS.length + 1 && STAGES.includes(value.stage as ClosePreparationStage)) {
      return Object.freeze({ ...base, type: 'stage', stage: value.stage as ClosePreparationStage })
    }
    if (value.type === 'result' && size === EVENT_KEYS.length + 1) {
      const result = parseClosePreparationResult(value.result)
      if (result) return Object.freeze({ ...base, type: 'result', result })
    }
    return undefined
  } catch { return undefined }
}

/** A fresh editor checkpoint is required before restarting document work after preferences. */
export function canTransitionClosePreparation(from: ClosePreparationStage, to: ClosePreparationStage): boolean {
  if (to === 'await-preferences') return from === 'settle-preferences' || from === to
  if (from === 'await-preferences') return to === 'settle-preferences' || to === 'prepare-editor'
  return STAGES.includes(from) && STAGES.includes(to)
    && (from !== 'settle-preferences' || to === from || to === 'prepare-editor')
}
