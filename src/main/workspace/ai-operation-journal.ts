import type {
  AiOperationManifest,
  AiOperationState,
} from '../../shared/ai-conversation'

const TRANSITIONS: Readonly<Record<AiOperationState, readonly AiOperationState[]>> = {
  planned: ['awaitingApproval'],
  awaitingApproval: ['authorized', 'failed'],
  authorized: ['executing', 'failed'],
  executing: ['succeeded', 'failed', 'unknown'],
  succeeded: [],
  failed: [],
  unknown: [],
}

export interface AiOperationJournalEntry<Result = unknown> {
  readonly manifest: AiOperationManifest
  readonly state: AiOperationState
  readonly result?: Result
  readonly error?: unknown
}

export class AiOperationOutcomeUnknownError extends Error {
  readonly code = 'AI_OPERATION_OUTCOME_UNKNOWN'

  constructor() {
    super('The AI operation outcome is unknown')
    this.name = 'AiOperationOutcomeUnknownError'
  }
}

function immutableManifest(manifest: AiOperationManifest): AiOperationManifest {
  return Object.freeze({
    ...manifest,
    relativePaths: Object.freeze([...manifest.relativePaths]),
    expectedVersions: Object.freeze(manifest.expectedVersions.map((version) => Object.freeze({ ...version }))),
  })
}

function snapshot<Result>(entry: AiOperationJournalEntry<Result>): AiOperationJournalEntry<Result> {
  return Object.freeze({ ...entry })
}

function immutableResult<Result>(value: Result): Result {
  const freeze = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return Object.freeze(candidate.map(freeze))
    if (typeof candidate !== 'object' || candidate === null) return candidate
    const prototype = Object.getPrototypeOf(candidate)
    if (prototype !== Object.prototype && prototype !== null) return candidate
    return Object.freeze(Object.fromEntries(
      Object.entries(candidate).map(([key, nested]) => [key, freeze(nested)]),
    ))
  }
  return freeze(value) as Result
}

export class AiOperationJournal<Result = unknown> {
  private readonly entries = new Map<string, AiOperationJournalEntry<Result>>()
  private readonly idempotencyKeys = new Map<string, string>()
  private readonly consumedNonces = new Set<string>()

  plan(manifest: AiOperationManifest): AiOperationJournalEntry<Result> {
    const existingOperationId = this.idempotencyKeys.get(manifest.idempotencyKey)
    if (existingOperationId) return this.require(existingOperationId)
    if (this.entries.has(manifest.operationId)) {
      throw new Error('AI operation identifier is already in use')
    }
    const entry = snapshot<Result>({
      manifest: immutableManifest(manifest),
      state: 'planned',
    })
    this.entries.set(manifest.operationId, entry)
    this.idempotencyKeys.set(manifest.idempotencyKey, manifest.operationId)
    return entry
  }

  get(operationId: string): AiOperationJournalEntry<Result> | undefined {
    return this.entries.get(operationId)
  }

  getByIdempotencyKey(idempotencyKey: string): AiOperationJournalEntry<Result> | undefined {
    const operationId = this.idempotencyKeys.get(idempotencyKey)
    return operationId ? this.entries.get(operationId) : undefined
  }

  transition(
    operationId: string,
    next: AiOperationState,
    details: { result?: Result; error?: unknown } = {},
  ): AiOperationJournalEntry<Result> {
    const current = this.require(operationId)
    if (!TRANSITIONS[current.state].includes(next)) {
      throw new Error(`Invalid AI operation transition: ${current.state} -> ${next}`)
    }
    const entry = snapshot({
      ...current,
      state: next,
      ...details,
      ...(Object.prototype.hasOwnProperty.call(details, 'result')
        ? { result: immutableResult(details.result as Result) }
        : {}),
    })
    this.entries.set(operationId, entry)
    return entry
  }

  authorize(operationId: string, nonce: string): AiOperationJournalEntry<Result> {
    const current = this.require(operationId)
    if (this.consumedNonces.has(nonce)) {
      throw new Error('Authorization nonce has already been consumed')
    }
    if (current.state !== 'awaitingApproval' || nonce !== current.manifest.nonce) {
      throw new Error('Invalid AI operation authorization')
    }
    this.consumedNonces.add(nonce)
    return this.transition(operationId, 'authorized')
  }

  async execute(
    operationId: string,
    operation: () => Promise<Result>,
  ): Promise<AiOperationJournalEntry<Result>> {
    const current = this.require(operationId)
    if (current.state === 'succeeded' || current.state === 'failed' || current.state === 'unknown') {
      return current
    }
    if (current.state !== 'authorized') {
      throw new Error('AI operation is not authorized')
    }
    this.transition(operationId, 'executing')
    try {
      const result = await operation()
      const settled = this.require(operationId)
      if (settled.state === 'succeeded' || settled.state === 'failed' || settled.state === 'unknown') {
        return settled
      }
      return this.transition(operationId, 'succeeded', { result })
    } catch (error) {
      const settled = this.require(operationId)
      if (settled.state === 'succeeded' || settled.state === 'failed' || settled.state === 'unknown') {
        throw error
      }
      this.transition(
        operationId,
        error instanceof AiOperationOutcomeUnknownError ? 'unknown' : 'failed',
        { error },
      )
      throw error
    }
  }

  private require(operationId: string): AiOperationJournalEntry<Result> {
    const entry = this.entries.get(operationId)
    if (!entry) throw new Error('Unknown AI operation')
    return entry
  }
}
