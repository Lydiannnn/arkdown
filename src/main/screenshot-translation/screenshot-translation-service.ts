import { featureModelConnections, isCodexCliConnection } from '../../shared/large-model-settings'
import type { ReasoningEffort, ThinkingMode, TargetLanguage, LargeModelSettings, ModelConnectionSummary } from '../../shared/large-model-settings'
import type { SettingsAuthority } from '../settings/settings-authority'
import type { PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import { SettingsStorageError } from '../settings/settings-transaction-files'
import {
  SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_BYTES,
  SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_LENGTH,
  parseScreenshotOcrBlocks,
  parseScreenshotSessionId,
  type ScreenshotPublicErrorCode,
  type ScreenshotOcrBlock,
  type ScreenshotTranslatedBlock,
  type ScreenshotTranslationEvent,
} from '../../shared/screenshot-translation'
import type { SettingsUpdater } from '../settings/settings-coordinator'
import { ModelProtocolError } from '../models/model-errors'
import type { ModelProtocolClient } from '../models/model-protocol-client'
import { MODEL_REQUEST_INITIAL_INACTIVITY_TIMEOUT_MS } from '../models/model-protocol-client'
import type { ModelSecretVault } from '../models/model-secret-vault'
import {
  SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES,
  batchScreenshotTranslationBlocks,
  buildScreenshotTranslationMessages,
  parseScreenshotTranslationResponse,
  resolveScreenshotTargetLanguage,
  type ScreenshotTranslationPromptBlock,
} from './screenshot-translation-prompts'

export interface ScreenshotTranslationEventSink {
  emit(event: ScreenshotTranslationEvent): void
}

export interface ScreenshotTranslationStartInput {
  sessionId: string
  generation: number
  blocks: readonly ScreenshotOcrBlock[]
}

export interface ScreenshotTranslationStarted {
  sessionId: string
  generation: number
  targetLanguage: Exclude<TargetLanguage, 'auto'>
  modelId: string
}

export interface ScreenshotTranslationService {
  start(input: ScreenshotTranslationStartInput): Promise<ScreenshotTranslationStarted>
  whenSettled(input: { sessionId: string; generation: number }): Promise<void>
  cancel(input: { sessionId: string; generation: number }): Promise<void>
  releaseSession(sessionId: string): void
  dispose(): Promise<void>
}

export type ScreenshotTranslationServiceDependencies = {
  client: Pick<ModelProtocolClient, 'streamChat'>
  events: ScreenshotTranslationEventSink
} & ({ authority: SettingsAuthority; settings?: never; secrets?: never }
  | { authority?: never; settings: Pick<SettingsUpdater, 'get'>; secrets: Pick<ModelSecretVault, 'get'> })

export class ScreenshotTranslationServiceError extends Error {
  constructor(readonly code: ScreenshotModelFailureCode) {
    super(code)
    this.name = 'ScreenshotTranslationServiceError'
  }
}

type ScreenshotModelFailureCode = Extract<ScreenshotPublicErrorCode, `MODEL_${string}` | 'TRANSLATION_FAILED'>

function translationFailureCode(error: unknown): ScreenshotModelFailureCode {
  if (error instanceof ScreenshotTranslationServiceError) return error.code
  if (error instanceof SettingsStorageError) {
    if (error.code === 'SETTINGS_TRANSACTION_CONNECTION_MISSING') return 'MODEL_NOT_CONFIGURED'
    if (error.code === 'SETTINGS_TRANSACTION_AUTHORITY_CHANGED') return 'MODEL_UNAVAILABLE'
    if (error.code === 'SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED') return 'MODEL_AUTHENTICATION_FAILED'
    return 'TRANSLATION_FAILED'
  }
  if (!(error instanceof ModelProtocolError)) return 'TRANSLATION_FAILED'
  switch (error.status) {
    case 'authentication-failed': return 'MODEL_AUTHENTICATION_FAILED'
    case 'model-not-found': return 'MODEL_NOT_FOUND'
    case 'invalid-endpoint': return 'MODEL_UNAVAILABLE'
    case 'rate-limited': return 'MODEL_RATE_LIMITED'
    case 'quota-exceeded': return 'MODEL_QUOTA_EXCEEDED'
    case 'incompatible-response': return 'MODEL_RESPONSE_INVALID'
    case 'timeout': return 'MODEL_TIMEOUT'
  }
}

interface ActiveTranslation {
  sessionId: string
  generation: number
  controller: AbortController
  cancelled: boolean
  settlement: Promise<void>
  settle(): void
}

function keyOf(sessionId: string, generation: number): string {
  return `${sessionId}\u0000${generation}`
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError'
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}

export interface BoundedUtf8Accumulator {
  readonly value: string
  readonly byteLength: number
  append(delta: string): boolean
}

export function createBoundedUtf8Accumulator(
  maxBytes = SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES,
): BoundedUtf8Accumulator {
  let value = ''
  let byteLength = 0
  return {
    get value() { return value },
    get byteLength() { return byteLength },
    append(delta) {
      if (delta.length === 0) return true
      const joinsSurrogatePair = value.length > 0
        && isHighSurrogate(value.charCodeAt(value.length - 1))
        && isLowSurrogate(delta.charCodeAt(0))
      const candidateBytes = byteLength + utf8Bytes(delta) - (joinsSurrogatePair ? 2 : 0)
      if (candidateBytes > maxBytes) return false
      value += delta
      byteLength = candidateBytes
      return true
    },
  }
}

class ScreenshotTranslationServiceImpl implements ScreenshotTranslationService {
  private readonly active = new Map<string, ActiveTranslation>()
  private readonly pending = new Set<Promise<void>>()
  private readonly settlements = new Map<string, Promise<void>>()
  private readonly latestGeneration = new Map<string, number>()
  private disposed = false

  constructor(private readonly dependencies: ScreenshotTranslationServiceDependencies) {}

  async start(input: ScreenshotTranslationStartInput): Promise<ScreenshotTranslationStarted> {
    if (this.disposed) throw new ScreenshotTranslationServiceError('TRANSLATION_FAILED')
    if (!parseScreenshotSessionId(input.sessionId)
      || !Number.isSafeInteger(input.generation)
      || input.generation <= 0) {
      this.emitFailure(input.sessionId, input.generation, 'TRANSLATION_FAILED')
      throw new ScreenshotTranslationServiceError('TRANSLATION_FAILED')
    }

    const latest = this.latestGeneration.get(input.sessionId)
    if (latest !== undefined && input.generation <= latest) {
      throw new ScreenshotTranslationServiceError('TRANSLATION_FAILED')
    }
    for (const [key, settlement] of this.settlements) {
      if (key.startsWith(`${input.sessionId}\u0000`) && !this.pending.has(settlement)) {
        this.settlements.delete(key)
      }
    }
    for (const active of [...this.active.values()]) {
      if (active.sessionId === input.sessionId && active.generation <= input.generation) {
        this.cancelActive(active)
      }
    }
    this.latestGeneration.set(input.sessionId, input.generation)
    if (parseScreenshotOcrBlocks(input.blocks) === undefined) {
      this.emitFailure(input.sessionId, input.generation, 'TRANSLATION_FAILED')
      throw new ScreenshotTranslationServiceError('TRANSLATION_FAILED')
    }

    let resolveSettlement!: () => void
    const settlement = new Promise<void>((resolve) => { resolveSettlement = resolve })
    let settled = false
    const active: ActiveTranslation = {
      sessionId: input.sessionId,
      generation: input.generation,
      controller: new AbortController(),
      cancelled: false,
      settlement,
      settle: () => {
        if (settled) return
        settled = true
        this.pending.delete(settlement)
        resolveSettlement()
      },
    }
    this.pending.add(settlement)
    const key = keyOf(input.sessionId, input.generation)
    this.settlements.set(key, settlement)
    this.active.set(key, active)

    let models: LargeModelSettings
    let connection: ModelConnectionSummary
    let observed: PublicModelSettingsSnapshot | undefined
    let apiKey: string | null
    try {
      if (this.dependencies.authority) {
        const paired = await this.dependencies.authority.readExecution({ feature: 'screenshotTranslation' })
        models = paired.observed.settings; observed = paired.observed; connection = paired.connection
        apiKey = isCodexCliConnection(connection) ? '' : paired.apiKey
      } else {
        // Transitional composition only; removed at the complete main-root switch.
        let current: LargeModelSettings | undefined
        try { current = this.dependencies.settings.get().models }
        catch { throw new ScreenshotTranslationServiceError('TRANSLATION_FAILED') }
        const selected = current && featureModelConnections(current).find(candidate => candidate.id === current.screenshotTranslation.connectionId)
        if (!current || !selected) throw new ScreenshotTranslationServiceError('MODEL_NOT_CONFIGURED')
        models = current; connection = selected
        try { apiKey = isCodexCliConnection(connection) ? '' : await this.dependencies.secrets.get(connection.id) }
        catch { throw new ScreenshotTranslationServiceError('MODEL_AUTHENTICATION_FAILED') }
      }
    } catch (error) {
      const code = translationFailureCode(error)
      if (this.owns(active)) this.failActive(active, code)
      active.settle()
      throw new ScreenshotTranslationServiceError(code)
    }
    const promptBlocks = input.blocks.map(({ id, text }) => ({ id, text }))
    const targetLanguage = resolveScreenshotTargetLanguage(promptBlocks, models.screenshotTranslation.targetLanguage)
    const started: ScreenshotTranslationStarted = { sessionId: input.sessionId, generation: input.generation, targetLanguage, modelId: connection.modelId }
    if (!this.owns(active)) {
      active.settle()
      return started
    }
    if (apiKey === null) {
      this.failActive(active, 'MODEL_AUTHENTICATION_FAILED')
      active.settle()
      throw new ScreenshotTranslationServiceError('MODEL_AUTHENTICATION_FAILED')
    }
    if (this.disposed) {
      active.settle()
      throw new ScreenshotTranslationServiceError('TRANSLATION_FAILED')
    }

    const { thinkingMode, reasoningEffort } = models.screenshotTranslation
    this.dependencies.events.emit({
      sessionId: input.sessionId,
      generation: input.generation,
      type: 'translation-started',
    })
    void this.run(active, promptBlocks, {
      provider: connection.provider,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      modelId: connection.modelId,
      capabilityOverride: connection.capabilityOverride,
      apiKey,
      thinkingMode,
      reasoningEffort,
      targetLanguage,
    }, observed).finally(active.settle)
    return started
  }

  cancel(input: { sessionId: string; generation: number }): Promise<void> {
    const active = this.active.get(keyOf(input.sessionId, input.generation))
    if (active !== undefined) this.cancelActive(active)
    return active?.settlement ?? Promise.resolve()
  }

  whenSettled(input: { sessionId: string; generation: number }): Promise<void> {
    return this.settlements.get(keyOf(input.sessionId, input.generation)) ?? Promise.resolve()
  }

  releaseSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const [key, settlement] of this.settlements) {
      if (key.startsWith(prefix) && this.pending.has(settlement)) return
    }
    for (const key of this.settlements.keys()) {
      if (key.startsWith(prefix)) this.settlements.delete(key)
    }
    this.latestGeneration.delete(sessionId)
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      const active = [...this.active.values()]
      this.active.clear()
      for (const item of active) item.controller.abort()
    }
    await Promise.allSettled([...this.pending])
    this.settlements.clear()
    this.latestGeneration.clear()
  }

  private owns(active: ActiveTranslation): boolean {
    return !this.disposed
      && this.active.get(keyOf(active.sessionId, active.generation)) === active
  }

  private cancelActive(active: ActiveTranslation): void {
    if (!this.owns(active)) return
    this.active.delete(keyOf(active.sessionId, active.generation))
    active.controller.abort()
    if (!active.cancelled) {
      active.cancelled = true
      this.dependencies.events.emit({
        sessionId: active.sessionId,
        generation: active.generation,
        type: 'translation-cancelled',
      })
    }
  }

  private failActive(active: ActiveTranslation, code: ScreenshotModelFailureCode): void {
    if (!this.owns(active)) return
    this.active.delete(keyOf(active.sessionId, active.generation))
    active.controller.abort()
    this.emitFailure(active.sessionId, active.generation, code)
  }

  private emitFailure(
    sessionId: string,
    generation: number,
    code: ScreenshotModelFailureCode,
  ): void {
    if (this.disposed) return
    this.dependencies.events.emit({
      sessionId,
      generation,
      type: 'failed',
      stage: 'translation',
      code,
    })
  }

  private async run(
    active: ActiveTranslation,
    blocks: readonly ScreenshotTranslationPromptBlock[],
    model: {
      provider: Parameters<ModelProtocolClient['streamChat']>[0]['provider']
      protocol: Parameters<ModelProtocolClient['streamChat']>[0]['protocol']
      baseUrl: string
      modelId: string
      capabilityOverride: Parameters<ModelProtocolClient['streamChat']>[0]['capabilityOverride']
      apiKey: string
      thinkingMode: ThinkingMode
      reasoningEffort: ReasoningEffort
      targetLanguage: ScreenshotTranslationStarted['targetLanguage']
    },
    observed?: PublicModelSettingsSnapshot,
  ): Promise<void> {
    try {
      // All new screenshot translations retain source block IDs and geometry.
      const batches = batchScreenshotTranslationBlocks(blocks)
      const merged = new Map<string, ScreenshotTranslatedBlock>()
      for (const batch of batches) {
        if (!this.owns(active)) return
        const translateBatch = async (): Promise<readonly ScreenshotTranslatedBlock[] | undefined> => {
          const response = createBoundedUtf8Accumulator()
          const request = {
            provider: model.provider,
            protocol: model.protocol,
            baseUrl: model.baseUrl,
            modelId: model.modelId,
            capabilityOverride: model.capabilityOverride,
            apiKey: model.apiKey,
            messages: buildScreenshotTranslationMessages({
              blocks: batch,
              targetLanguage: model.targetLanguage,
            }),
            thinkingMode: model.thinkingMode,
            reasoningEffort: model.reasoningEffort,
            initialInactivityTimeoutMs: MODEL_REQUEST_INITIAL_INACTIVITY_TIMEOUT_MS,
            signal: active.controller.signal,
            onDelta: (delta: string) => {
              if (!this.owns(active) || delta.length === 0) return
              if (!response.append(delta)) {
                throw new ScreenshotTranslationServiceError('MODEL_RESPONSE_INVALID')
              }
            },
          }
          const start = () => {
            if (!this.owns(active)) throw new DOMException('Translation canceled', 'AbortError')
            return { completion: this.dependencies.client.streamChat(request) }
          }
          const admitted = this.dependencies.authority && observed
            ? await this.dependencies.authority.admitExecution(observed, { feature: 'screenshotTranslation' }, start) : start()
          await admitted.completion
          if (!this.owns(active)) return undefined
          return parseScreenshotTranslationResponse(response.value, batch)
        }
        let translations = await translateBatch()
        if (translations === undefined && this.owns(active)) translations = await translateBatch()
        if (translations === undefined) throw new ScreenshotTranslationServiceError('MODEL_RESPONSE_INVALID')
        for (const translation of translations) merged.set(translation.id, translation)
      }

      const translations = blocks.flatMap(({ id }) => {
        const translation = merged.get(id)
        return translation === undefined ? [] : [translation]
      })
      let totalLength = 0
      let totalBytes = 0
      for (const translation of translations) {
        totalLength += translation.text.length
        totalBytes += utf8Bytes(translation.text)
        if (totalLength > SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_LENGTH
          || totalBytes > SCREENSHOT_TRANSLATED_TEXT_TOTAL_MAX_BYTES) {
          throw new ScreenshotTranslationServiceError('MODEL_RESPONSE_INVALID')
        }
      }
      if (!this.owns(active)) return
      this.active.delete(keyOf(active.sessionId, active.generation))
      this.dependencies.events.emit({
        sessionId: active.sessionId,
        generation: active.generation,
        type: 'translation-completed',
        translations,
      })
    } catch (error) {
      if (!this.owns(active)) return
      if (active.controller.signal.aborted || isAbortError(error)) {
        this.cancelActive(active)
        return
      }
      this.failActive(
        active,
        translationFailureCode(error),
      )
    }
  }

}

export function createScreenshotTranslationService(
  dependencies: ScreenshotTranslationServiceDependencies,
): ScreenshotTranslationService {
  return new ScreenshotTranslationServiceImpl(dependencies)
}
