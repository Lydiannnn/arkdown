import { DEFAULT_FLOATING_TRANSLATION_SETTINGS, featureModelConnections, isCodexCliConnection, parseFloatingTranslationPatch } from '../../shared/large-model-settings'
import { randomUUID } from 'node:crypto'
import type {
  LargeModelSettings,
  ModelCapabilityOverride,
  ModelConnectionStatus,
  ModelConnectionSummary,
  ModelProtocol,
  ModelProviderId,
  ReasoningEffort,
  ThinkingMode,
  AiWritePolicy,
  TargetLanguage,
  FloatingTranslationSettings,
} from '../../shared/large-model-settings'
import {
  DEFAULT_AI_CONVERSATION_SETTINGS,
  DEFAULT_LARGE_MODEL_SETTINGS,
  isCanonicalModelConnectionId,
  normalizeLargeModelSettings,
  parseLargeModelSettings,
} from '../../shared/large-model-settings'
import { normalizeReasoningEffort } from '../../shared/model-provider-presets'
import { resolveModelThinkingCapability, translationThinkingPreference } from '../../shared/model-thinking'
import type { SettingsUpdater } from '../settings/settings-coordinator'
import {
  createModelCatalogClient,
  type ModelCatalog,
  type ModelCatalogClient,
} from './model-catalog-client'
import { ModelProtocolError } from './model-errors'
import type { ModelProtocolClient } from './model-protocol-client'
import type {
  ModelSecretSnapshot,
  ModelSecretVault,
} from './model-secret-vault'

export interface ConnectModelInput {
  id?: string
  name: string
  provider: ModelProviderId
  accessType: 'standard-api'
  protocol: ModelProtocol
  baseUrl: string
  modelId: string
  apiKey?: string
  capabilityOverride?: ModelCapabilityOverride | null
}

export interface ListModelsInput {
  id?: string
  provider: ModelProviderId
  protocol: ModelProtocol
  baseUrl: string
  apiKey?: string
}

export interface FeatureSettingsInput {
  connectionId: string | null
  thinkingMode: ThinkingMode
  reasoningEffort: ReasoningEffort
  targetLanguage: TargetLanguage
}

export interface AiConversationSettingsInput {
  connectionId: string | null
  thinkingMode: ThinkingMode
  reasoningEffort: ReasoningEffort
  writePolicy: AiWritePolicy
}

export interface ModelConnectionServiceDependencies {
  nowIso(): string
  createId(): string
  catalogClient: ModelCatalogClient
}

export interface ModelConnectionCredentialSnapshot {
  connection: ModelConnectionSummary
  apiKey: string | null
}

type SecretVault = Pick<
  ModelSecretVault, 'get' | 'set' | 'delete' | 'snapshot' | 'restore'
>

function defaultDependencies(): ModelConnectionServiceDependencies {
  return {
    nowIso: () => new Date().toISOString(),
    createId: randomUUID,
    catalogClient: createModelCatalogClient(),
  }
}

function copyModelSettings(settings: LargeModelSettings): LargeModelSettings {
  return {
    ...(settings.floatingTranslation ? { floatingTranslation: { ...settings.floatingTranslation } } : {}),
    version: 6,
    codexCli: settings.codexCli ? structuredClone(settings.codexCli) : null,
    connections: settings.connections.map((connection) => ({
      ...connection,
      capabilityOverride: connection.capabilityOverride === null
        ? null
        : structuredClone(connection.capabilityOverride),
    })),
    selectionTranslation: { ...settings.selectionTranslation },
    screenshotTranslation: { ...settings.screenshotTranslation },
    aiConversation: { ...settings.aiConversation },
  }
}

function publicSettings(value: unknown): LargeModelSettings {
  return copyModelSettings(normalizeLargeModelSettings(value))
}

function apiKeyHint(apiKey: string): string {
  const printableSuffix = Array.from(apiKey)
    .filter((character) => character >= ' ' && character <= '~')
    .slice(-4)
    .join('')
  return `••••${printableSuffix}`
}

function fixedError(message: string): Error {
  return new Error(message)
}

export class ModelConnectionService {
  private readonly dependencies: ModelConnectionServiceDependencies
  private readonly connectionTransactions = new Map<string, Promise<void>>()

  constructor(
    private readonly settings: SettingsUpdater,
    private readonly vault: SecretVault,
    private readonly protocolClient: ModelProtocolClient,
    dependencies: Partial<ModelConnectionServiceDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies(), ...dependencies }
  }

  getSettings(): LargeModelSettings {
    return publicSettings(this.settings.get().models)
  }

  async getCredentialSnapshot(
    connectionId: string,
  ): Promise<ModelConnectionCredentialSnapshot> {
    return this.runConnectionTransaction(connectionId, async () => {
      const connection = featureModelConnections(this.getSettings()).find(item => item.id === connectionId)
      if (!connection) throw fixedError('Unknown model connection')
      const apiKey = isCodexCliConnection(connection) ? '' : await this.vault.get(connectionId)
      return {
        connection: { ...connection },
        apiKey,
      }
    })
  }

  async listModels(input: ListModelsInput): Promise<ModelCatalog> {
    const existing = input.id === undefined
      ? undefined
      : this.requireConnection(input.id)
    const suppliedSecret = input.apiKey
    if (
      suppliedSecret !== undefined
      && (typeof suppliedSecret !== 'string' || suppliedSecret === '')
    ) {
      throw fixedError('API key is required')
    }
    const secret = suppliedSecret ?? (
      existing === undefined ? null : await this.vault.get(existing.id)
    )
    if (secret === null) throw fixedError('API key is required')

    const catalog = await this.dependencies.catalogClient.listModels({
      provider: input.provider,
      protocol: input.protocol,
      baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '',
      apiKey: secret,
      signal: new AbortController().signal,
    })
    return {
      models: [...catalog.models],
      recommendedModelId: catalog.recommendedModelId,
    }
  }

  async connect(input: ConnectModelInput): Promise<LargeModelSettings> {
    const connectionId = input.id ?? this.dependencies.createId()
    return this.runConnectionTransaction(
      connectionId,
      () => this.connectTransaction(input, connectionId),
    )
  }

  private async connectTransaction(input: ConnectModelInput, id: string): Promise<LargeModelSettings> {
    const current = this.getSettings()
    const existing = input.id === undefined
      ? undefined
      : current.connections.find((connection) => connection.id === input.id)
    if (input.id !== undefined && existing === undefined) {
      throw fixedError('Unknown model connection')
    }

    if (!isCanonicalModelConnectionId(id)) throw fixedError('Invalid model connection ID')
    if (input.id === undefined && current.connections.some((connection) => connection.id === id)) {
      throw fixedError('Model connection ID already exists')
    }

    const suppliedSecret = input.apiKey
    if (suppliedSecret !== undefined && (typeof suppliedSecret !== 'string' || suppliedSecret === '')) {
      throw fixedError('API key is required')
    }
    const secret = suppliedSecret ?? (
      existing === undefined ? null : await this.vault.get(id)
    )
    if (secret === null) throw fixedError('API key is required')

    const testedAt = this.dependencies.nowIso()
    const summary = this.validateSummary({
      id,
      name: typeof input.name === 'string' ? input.name.trim() : '',
      provider: input.provider,
      accessType: input.accessType,
      protocol: input.protocol,
      baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '',
      modelId: typeof input.modelId === 'string' ? input.modelId.trim() : '',
      apiKeyHint: apiKeyHint(secret),
      status: 'connected',
      lastTestedAt: testedAt,
      capabilityOverride: input.capabilityOverride === undefined
        ? (existing?.capabilityOverride ?? null)
        : input.capabilityOverride,
    })

    await this.testProtocol(summary, secret)

    const replacedSecret = suppliedSecret !== undefined
    const previousSnapshot = replacedSecret ? await this.vault.snapshot(id) : undefined
    if (previousSnapshot !== undefined) await this.vault.set(id, secret)
    let authoritativeModels: LargeModelSettings | undefined
    try {
      await this.settings.update((appSettings) => {
        const models = publicSettings(appSettings.models)
        const connectionIndex = models.connections.findIndex((connection) => connection.id === id)
        if (existing === undefined) {
          if (connectionIndex !== -1) throw fixedError('Model connection ID already exists')
          models.connections.push({ ...summary })
        } else {
          if (connectionIndex === -1) throw fixedError('Unknown model connection')
          models.connections[connectionIndex] = { ...summary }
          const editedConnection = models.connections[connectionIndex]!
          if (models.floatingTranslation?.connectionId === id) {
            models.floatingTranslation.reasoningEffort = normalizeReasoningEffort(editedConnection, models.floatingTranslation.reasoningEffort)
          }
          if (models.selectionTranslation.connectionId === id) {
            models.selectionTranslation.reasoningEffort = normalizeReasoningEffort(
              editedConnection,
              models.selectionTranslation.reasoningEffort,
            )
          }
          if (models.screenshotTranslation.connectionId === id) {
            models.screenshotTranslation.reasoningEffort = normalizeReasoningEffort(
              editedConnection,
              models.screenshotTranslation.reasoningEffort,
            )
          }
          if (models.aiConversation.connectionId === id) {
            models.aiConversation.reasoningEffort = normalizeReasoningEffort(
              editedConnection,
              models.aiConversation.reasoningEffort,
            )
          }
        }
        authoritativeModels = copyModelSettings(models)
        return { ...appSettings, models: authoritativeModels }
      })
    } catch (error) {
      if (previousSnapshot !== undefined) await this.restoreSnapshot(previousSnapshot)
      throw error
    }
    if (authoritativeModels === undefined) {
      throw fixedError('Could not persist model settings')
    }
    return copyModelSettings(authoritativeModels)
  }

  async test(connectionId: string): Promise<ModelConnectionSummary> {
    return this.runConnectionTransaction(
      connectionId,
      () => this.testTransaction(connectionId),
    )
  }

  private async testTransaction(connectionId: string): Promise<ModelConnectionSummary> {
    const connection = this.requireConnection(connectionId)
    const secret = await this.vault.get(connectionId)
    if (secret === null) throw fixedError('Model connection secret is missing')

    let status: ModelConnectionStatus = 'connected'
    try {
      await this.testProtocol(connection, secret)
    } catch (error) {
      if (!(error instanceof ModelProtocolError)) throw error
      status = error.status
    }

    const summary: ModelConnectionSummary = {
      ...connection,
      status,
      lastTestedAt: this.dependencies.nowIso(),
    }
    await this.settings.update((appSettings) => {
      const models = publicSettings(appSettings.models)
      const connectionIndex = models.connections.findIndex(
        (candidate) => candidate.id === connectionId,
      )
      if (connectionIndex === -1) throw fixedError('Unknown model connection')
      models.connections[connectionIndex] = { ...summary }
      return { ...appSettings, models }
    })
    return { ...summary }
  }

  async delete(connectionId: string): Promise<LargeModelSettings> {
    return this.runConnectionTransaction(
      connectionId,
      () => this.deleteTransaction(connectionId),
    )
  }

  private async deleteTransaction(connectionId: string): Promise<LargeModelSettings> {
    this.requireConnection(connectionId)
    const previousSnapshot = await this.vault.snapshot(connectionId)
    await this.vault.delete(connectionId)
    try {
      await this.settings.update((appSettings) => {
        const models = publicSettings(appSettings.models)
        const connectionIndex = models.connections.findIndex(
          (connection) => connection.id === connectionId,
        )
        if (connectionIndex === -1) throw fixedError('Unknown model connection')
        models.connections.splice(connectionIndex, 1)
        if (models.floatingTranslation?.connectionId === connectionId) {
          models.floatingTranslation = { ...models.floatingTranslation, connectionId: null, thinkingMode: 'disabled', reasoningEffort: 'low' }
        }
        if (models.selectionTranslation.connectionId === connectionId) {
          models.selectionTranslation.connectionId = null
          models.selectionTranslation.thinkingMode = 'disabled'
          models.selectionTranslation.reasoningEffort = 'low'
        }
        if (models.screenshotTranslation.connectionId === connectionId) {
          models.screenshotTranslation.connectionId = null
          models.screenshotTranslation.thinkingMode = 'disabled'
          models.screenshotTranslation.reasoningEffort = 'low'
        }
        if (models.aiConversation.connectionId === connectionId) {
          models.aiConversation.connectionId = null
          models.aiConversation.thinkingMode = 'default'
          models.aiConversation.reasoningEffort = 'default'
        }
        return { ...appSettings, models }
      })
    } catch (error) {
      await this.restoreSnapshot(previousSnapshot)
      throw error
    }
    return this.getSettings()
  }

  async setSelectionTranslation(input: FeatureSettingsInput): Promise<LargeModelSettings> {
    const selected = input.connectionId === null
      ? undefined
      : featureModelConnections(this.getSettings()).find(
        (connection) => connection.id === input.connectionId,
      )
    if (input.connectionId !== null && selected === undefined) {
      throw fixedError('Unknown model connection')
    }
    const reasoningEffort = selected === undefined
      ? input.reasoningEffort
      : normalizeReasoningEffort(selected, input.reasoningEffort)

    await this.settings.update((appSettings) => {
      const models = publicSettings(appSettings.models)
      const currentSelection = input.connectionId === null
        ? undefined
        : featureModelConnections(models).find((connection) => connection.id === input.connectionId)
      if (input.connectionId !== null && currentSelection === undefined) {
        throw fixedError('Unknown model connection')
      }
      const candidate: LargeModelSettings = {
        ...models,
        selectionTranslation: {
          connectionId: input.connectionId,
          thinkingMode: input.thinkingMode,
          reasoningEffort: currentSelection === undefined
            ? reasoningEffort
            : normalizeReasoningEffort(currentSelection, reasoningEffort),
          targetLanguage: input.targetLanguage,
          privacyNoticeAccepted: models.selectionTranslation.privacyNoticeAccepted,
        },
      }
      const parsed = parseLargeModelSettings(candidate)
      if (parsed === undefined) throw fixedError('Invalid model feature settings')
      return { ...appSettings, models: parsed }
    })
    return this.getSettings()
  }

  async setScreenshotTranslation(input: FeatureSettingsInput): Promise<LargeModelSettings> {
    const selected = input.connectionId === null
      ? undefined
      : featureModelConnections(this.getSettings()).find(
        (connection) => connection.id === input.connectionId,
      )
    if (input.connectionId !== null && selected === undefined) {
      throw fixedError('Unknown model connection')
    }
    const reasoningEffort = selected === undefined
      ? input.reasoningEffort
      : normalizeReasoningEffort(selected, input.reasoningEffort)

    await this.settings.update((appSettings) => {
      const models = publicSettings(appSettings.models)
      const currentSelection = input.connectionId === null
        ? undefined
        : featureModelConnections(models).find((connection) => connection.id === input.connectionId)
      if (input.connectionId !== null && currentSelection === undefined) {
        throw fixedError('Unknown model connection')
      }
      const candidate: LargeModelSettings = {
        ...models,
        screenshotTranslation: {
          connectionId: input.connectionId,
          thinkingMode: input.thinkingMode,
          reasoningEffort: currentSelection === undefined
            ? reasoningEffort
            : normalizeReasoningEffort(currentSelection, reasoningEffort),
          targetLanguage: input.targetLanguage,
        },
      }
      const parsed = parseLargeModelSettings(candidate)
      if (parsed === undefined) throw fixedError('Invalid model feature settings')
      return { ...appSettings, models: parsed }
    })
    return this.getSettings()
  }

  async setFloatingTranslation(input: Partial<FloatingTranslationSettings>): Promise<LargeModelSettings> {
    const patch = parseFloatingTranslationPatch(input)
    if (!patch) throw fixedError('Invalid model feature settings')
    await this.settings.update((appSettings) => {
      const models = publicSettings(appSettings.models)
      const binding = { ...DEFAULT_FLOATING_TRANSLATION_SETTINGS, ...models.floatingTranslation, ...patch }
      const selected = featureModelConnections(models).find(item => item.id === binding.connectionId)
      if (binding.connectionId !== null && !selected) throw fixedError('Unknown model connection')
      const parsed = parseLargeModelSettings({ ...models, floatingTranslation: {
        ...binding,
        reasoningEffort: selected ? normalizeReasoningEffort(selected, binding.reasoningEffort) : binding.reasoningEffort,
      } })
      if (!parsed) throw fixedError('Invalid model feature settings')
      return { ...appSettings, models: parsed }
    })
    return this.getSettings()
  }

  async setAiConversation(input: AiConversationSettingsInput): Promise<LargeModelSettings> {
    const selected = input.connectionId === null
      ? undefined
      : featureModelConnections(this.getSettings()).find(
        (connection) => connection.id === input.connectionId,
      )
    if (input.connectionId !== null && selected === undefined) {
      throw fixedError('Unknown model connection')
    }
    const reasoningEffort = selected === undefined
      ? input.reasoningEffort
      : normalizeReasoningEffort(selected, input.reasoningEffort)

    await this.settings.update((appSettings) => {
      const models = publicSettings(appSettings.models)
      const currentSelection = input.connectionId === null
        ? undefined
        : featureModelConnections(models).find((connection) => connection.id === input.connectionId)
      if (input.connectionId !== null && currentSelection === undefined) {
        throw fixedError('Unknown model connection')
      }
      const candidate: LargeModelSettings = {
        ...models,
        aiConversation: {
          connectionId: input.connectionId,
          thinkingMode: input.thinkingMode,
          reasoningEffort: currentSelection === undefined
            ? reasoningEffort
            : normalizeReasoningEffort(currentSelection, reasoningEffort),
          writePolicy: input.writePolicy,
        },
      }
      const parsed = parseLargeModelSettings(candidate)
      if (parsed === undefined) throw fixedError('Invalid model feature settings')
      return { ...appSettings, models: parsed }
    })
    return this.getSettings()
  }

  async acceptTranslationPrivacyNotice(): Promise<LargeModelSettings> {
    await this.settings.update((appSettings) => {
      const models = publicSettings(appSettings.models)
      return {
        ...appSettings,
        models: {
          ...models,
          selectionTranslation: {
            ...models.selectionTranslation,
            privacyNoticeAccepted: true,
          },
        },
      }
    })
    return this.getSettings()
  }

  private requireConnection(connectionId: string): ModelConnectionSummary {
    const connection = this.getSettings().connections.find(
      (candidate) => candidate.id === connectionId,
    )
    if (connection === undefined) throw fixedError('Unknown model connection')
    return connection
  }

  private validateSummary(summary: ModelConnectionSummary): ModelConnectionSummary {
    if (summary.name === '' || summary.baseUrl === '' || summary.modelId === '') {
      throw fixedError('Invalid model connection')
    }
    const parsed = parseLargeModelSettings({
      version: 6,
      codexCli: null,
      connections: [summary],
      selectionTranslation: DEFAULT_LARGE_MODEL_SETTINGS.selectionTranslation,
      screenshotTranslation: DEFAULT_LARGE_MODEL_SETTINGS.screenshotTranslation,
      aiConversation: DEFAULT_AI_CONVERSATION_SETTINGS,
    })
    if (parsed === undefined) throw fixedError('Invalid model connection')
    return parsed.connections[0]!
  }

  private testProtocol(
    connection: Pick<ModelConnectionSummary, 'provider' | 'protocol' | 'baseUrl' | 'modelId' | 'capabilityOverride'>,
    apiKey: string,
  ): Promise<void> {
    const probePreference = resolveModelThinkingCapability(connection).thinking === 'unknown'
      ? { thinkingMode: 'default' as const, reasoningEffort: 'default' as const }
      : translationThinkingPreference(connection)
    return this.protocolClient.testConnection({
      provider: connection.provider,
      protocol: connection.protocol,
      baseUrl: connection.baseUrl,
      modelId: connection.modelId,
      apiKey,
      ...(connection.capabilityOverride ? { capabilityOverride: connection.capabilityOverride } : {}),
      ...probePreference,
      signal: new AbortController().signal,
    })
  }

  private async restoreSnapshot(snapshot: ModelSecretSnapshot): Promise<void> {
    try {
      await this.vault.restore(snapshot)
    } catch {
      throw fixedError('Could not roll back model secret after settings failure')
    }
  }

  private runConnectionTransaction<T>(
    connectionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.connectionTransactions.get(connectionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.connectionTransactions.set(connectionId, tail)
    void tail.then(() => {
      if (this.connectionTransactions.get(connectionId) === tail) {
        this.connectionTransactions.delete(connectionId)
      }
    })
    return result
  }
}
