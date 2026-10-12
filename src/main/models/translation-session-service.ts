import { featureModelConnections, isCodexCliConnection } from '../../shared/large-model-settings'
import { randomUUID } from 'node:crypto'
import {
  PUBLIC_ERROR_MESSAGES,
  PublicError,
  type PublicErrorCode,
} from '../../shared/public-errors'
import type {
  StartTranslationInput,
  TranslationEvent,
  TranslationStarted,
} from '../../shared/selection-translation'
import { TRANSLATION_DELTA_CHUNK_MAX_BYTES } from '../../shared/selection-translation'
import type { SettingsUpdater } from '../settings/settings-coordinator'
import type { SettingsAuthority } from '../settings/settings-authority'
import type { PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import type { LargeModelSettings, ModelConnectionSummary } from '../../shared/large-model-settings'
import { SettingsStorageError } from '../settings/settings-transaction-files'
import { ModelProtocolError } from './model-errors'
import type {
  ModelChatInput,
  ModelProtocolClient,
} from './model-protocol-client'
import { MODEL_REQUEST_INITIAL_INACTIVITY_TIMEOUT_MS } from './model-protocol-client'
import {
  ModelSecretVaultError,
  type ModelSecretVault,
} from './model-secret-vault'
import {
  buildTranslationMessages,
  resolveAutomaticTargetLanguage,
} from './translation-prompts'

export interface TranslationEventSink {
  emit(event: TranslationEvent): void
}

interface ActiveTranslation {
  requestId: string
  controller: AbortController
}

const MODEL_PROTOCOL_PUBLIC_CODES = {
  'authentication-failed': 'MODEL_AUTHENTICATION_FAILED',
  'model-not-found': 'MODEL_NOT_FOUND',
  'invalid-endpoint': 'MODEL_INVALID_ENDPOINT',
  timeout: 'MODEL_TIMEOUT',
  'rate-limited': 'MODEL_RATE_LIMITED',
  'quota-exceeded': 'MODEL_QUOTA_EXCEEDED',
  'incompatible-response': 'MODEL_INCOMPATIBLE_RESPONSE',
} as const satisfies Record<ModelProtocolError['status'], PublicErrorCode>

function modelPublicErrorCode(error: unknown): PublicErrorCode | undefined {
  if (error instanceof SettingsStorageError) {
    if (error.code === 'SETTINGS_TRANSACTION_CONNECTION_MISSING') return 'MODEL_NOT_CONFIGURED'
    if (error.code === 'SETTINGS_TRANSACTION_CREDENTIAL_REQUIRED') return 'MODEL_SECRET_UNAVAILABLE'
    if (error.code === 'SETTINGS_TRANSACTION_AUTHORITY_CHANGED') return 'OPERATION_FAILED'
    return 'MODEL_SECRET_STORAGE_FAILED'
  }
  if (error instanceof ModelProtocolError) {
    return MODEL_PROTOCOL_PUBLIC_CODES[error.status]
  }
  if (!(error instanceof ModelSecretVaultError)) return undefined

  switch (error.code) {
    case 'INVALID_CONNECTION_ID':
      return 'INVALID_INPUT'
    case 'ENCRYPTION_UNAVAILABLE':
      return 'MODEL_ENCRYPTION_UNAVAILABLE'
    case 'DECRYPTION_FAILED':
      return 'MODEL_SECRET_UNAVAILABLE'
    case 'VAULT_MALFORMED':
    case 'VAULT_READ_FAILED':
    case 'VAULT_WRITE_FAILED':
      return 'MODEL_SECRET_STORAGE_FAILED'
  }
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError'
  )
}
function translationDeltaChunks(delta: string): string[] {
  if (
    new TextEncoder().encode(delta).byteLength
    <= TRANSLATION_DELTA_CHUNK_MAX_BYTES
  ) return [delta]

  const chunks: string[] = []
  let chunkStart = 0
  let chunkBytes = 0
  let index = 0
  while (index < delta.length) {
    const first = delta.charCodeAt(index)
    let codeUnits = 1
    let byteLength: number
    if (first <= 0x7f) {
      byteLength = 1
    } else if (first <= 0x7ff) {
      byteLength = 2
    } else if (
      first >= 0xd800
      && first <= 0xdbff
      && index + 1 < delta.length
      && delta.charCodeAt(index + 1) >= 0xdc00
      && delta.charCodeAt(index + 1) <= 0xdfff
    ) {
      codeUnits = 2
      byteLength = 4
    } else {
      byteLength = 3
    }

    if (chunkBytes + byteLength > TRANSLATION_DELTA_CHUNK_MAX_BYTES) {
      chunks.push(delta.slice(chunkStart, index))
      chunkStart = index
      chunkBytes = 0
    }
    chunkBytes += byteLength
    index += codeUnits
  }
  if (chunkStart < delta.length) chunks.push(delta.slice(chunkStart))
  return chunks
}


export class TranslationSessionService {
  private active: ActiveTranslation | undefined
  private disposed = false

  constructor(private readonly options: {
    client: ModelProtocolClient
    events: TranslationEventSink
  } & ({ authority: SettingsAuthority; settings?: never; secrets?: never }
    | { authority?: never; settings: SettingsUpdater; secrets: ModelSecretVault })) {}

  async start(input: StartTranslationInput): Promise<TranslationStarted> {
    this.assertUsable()

    let settings: LargeModelSettings
    let connection: ModelConnectionSummary
    let observed: PublicModelSettingsSnapshot | undefined
    let apiKey: string | null
    try {
      if (this.options.authority) {
        const paired = await this.options.authority.readExecution({ feature: 'selectionTranslation' })
        settings = paired.observed.settings
        observed = paired.observed
        connection = paired.connection
        apiKey = isCodexCliConnection(connection) ? '' : paired.apiKey
      } else {
        // Transitional composition only; removed when all main-root writers switch together.
        const models = this.options.settings.get().models
        const selected = models && featureModelConnections(models).find(candidate => candidate.id === models.selectionTranslation.connectionId)
        if (!models || !selected) throw new PublicError('MODEL_NOT_CONFIGURED')
        settings = models; connection = selected
        apiKey = isCodexCliConnection(connection) ? '' : await this.options.secrets.get(connection.id)
      }
    } catch (error) {
      if (error instanceof PublicError) throw error
      throw new PublicError(modelPublicErrorCode(error) ?? 'OPERATION_FAILED')
    }
    this.assertUsable()
    if (apiKey === null) throw new PublicError('MODEL_SECRET_UNAVAILABLE')

    const configuredTarget = settings.selectionTranslation.targetLanguage
    const targetLanguage = configuredTarget === 'auto'
      ? resolveAutomaticTargetLanguage(input.content.markdown)
      : configuredTarget
    const { thinkingMode, reasoningEffort } = settings.selectionTranslation
    const messages = buildTranslationMessages({
      content: input.content.markdown,
      mode: input.mode,
      targetLanguage,
    })
    const requestId = randomUUID()
    const controller = new AbortController()

    const chatInput: ModelChatInput = {
      provider: connection.provider,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      modelId: connection.modelId,
      capabilityOverride: connection.capabilityOverride,
      apiKey,
      messages,
      thinkingMode,
      reasoningEffort,
      initialInactivityTimeoutMs: MODEL_REQUEST_INITIAL_INACTIVITY_TIMEOUT_MS,
      signal: controller.signal,
      onDelta: (delta) => {
        for (const chunk of translationDeltaChunks(delta)) {
          this.emitIfOwned({ requestId, type: 'delta', delta: chunk })
        }
      },
    }
    const start = () => {
      this.assertUsable()
      this.stopActive()
      this.active = { requestId, controller }
      this.emitIfOwned({ requestId, type: 'started' })
      return { completion: this.runStream(requestId, controller, chatInput) }
    }
    try {
      if (this.options.authority && observed) await this.options.authority.admitExecution(observed, { feature: 'selectionTranslation' }, start)
      else start()
    } catch (error) {
      if (error instanceof PublicError) throw error
      throw new PublicError(modelPublicErrorCode(error) ?? 'OPERATION_FAILED')
    }

    return { requestId, targetLanguage, modelId: connection.modelId }
  }

  async cancel(requestId: string): Promise<void> {
    if (this.active?.requestId !== requestId) return
    this.stopActive()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const active = this.active
    this.active = undefined
    active?.controller.abort()
  }

  private assertUsable(): void {
    if (this.disposed) throw new PublicError('OPERATION_FAILED')
  }

  private stopActive(): void {
    const active = this.active
    if (active === undefined) return

    active.controller.abort()
    this.emitIfOwned({ requestId: active.requestId, type: 'stopped' })
    if (this.active?.requestId === active.requestId) {
      this.active = undefined
    }
  }

  private emitIfOwned(event: TranslationEvent): void {
    if (
      !this.disposed
      && this.active?.requestId === event.requestId
    ) {
      this.options.events.emit(event)
    }
  }

  private async runStream(
    requestId: string,
    controller: AbortController,
    input: ModelChatInput,
  ): Promise<void> {
    try {
      await this.options.client.streamChat(input)
      this.emitIfOwned({ requestId, type: 'completed' })
    } catch (error) {
      if (this.active?.requestId !== requestId || this.disposed) return
      if (controller.signal.aborted || isAbortError(error)) {
        this.emitIfOwned({ requestId, type: 'stopped' })
      } else {
        const code = modelPublicErrorCode(error) ?? 'OPERATION_FAILED'
        this.emitIfOwned({
          requestId,
          type: 'failed',
          code,
          message: PUBLIC_ERROR_MESSAGES[code],
        })
      }
    } finally {
      if (this.active?.requestId === requestId) {
        this.active = undefined
      }
    }
  }
}
