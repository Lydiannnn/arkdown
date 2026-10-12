import { DEFAULT_FLOATING_TRANSLATION_SETTINGS, featureModelConnections, parseModelConnectionSummary, type ModelConnectionSummary } from '../../shared/large-model-settings'
import type { PublicModelMutationResult, PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import { normalizeReasoningEffort } from '../../shared/model-provider-presets'
import { resolveModelThinkingCapability, translationThinkingPreference } from '../../shared/model-thinking'
import type { SettingsAuthority } from '../settings/settings-authority'
import { connectionEditRequest, connectionRemoveRequest, connectionTestRequest, modelExecutionGuardRequest, modelFeatureRequest, observeModelSettings, publicModelMutation, requireModelObservation } from '../settings/settings-command-adapter'
import { reduceSettingsTransaction } from '../settings/settings-transaction-reducer'
import type { ModelFeature, ModelFeatureGroups, SettingsTransactionRequest, SettingsTransactionSnapshot } from '../settings/settings-transaction-types'
import { SettingsStorageError } from '../settings/settings-transaction-files'
import type { ConnectModelInput, ListModelsInput } from './model-connection-service'
import type { ModelCatalog, ModelCatalogClient } from './model-catalog-client'
import type { ModelProtocolClient } from './model-protocol-client'
import { ModelProtocolError } from './model-errors'

type Conflict = Extract<PublicModelMutationResult, { status: 'conflict' }>
export interface ModelTestMutation { mutation: PublicModelMutationResult; failure?: ModelProtocolError }
export type ModelCatalogRead = { status: 'catalog'; catalog: ModelCatalog } | Conflict
interface Dependencies { nowIso(): string; createId(): string }

function keyHint(key: string): string {
  return `••••${Array.from(key).filter(character => character >= ' ' && character <= '~').slice(-4).join('')}`
}
function suppliedKey(input: { apiKey?: string }): string | undefined {
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey === '')) throw new Error('API key is required')
  return input.apiKey
}
function requireSummary(value: ModelConnectionSummary): ModelConnectionSummary {
  const parsed = parseModelConnectionSummary(value)
  if (!parsed || !parsed.name || !parsed.baseUrl || !parsed.modelId || parsed.accessType !== 'standard-api') throw new Error('Invalid model connection')
  return parsed
}

/** Production model mutations use the shared settings authority and its credential journal. */
export class TransactionalModelConnectionService {
  constructor(private readonly authority: SettingsAuthority,
    private readonly protocol: Pick<ModelProtocolClient, 'testConnection'>,
    private readonly catalog: ModelCatalogClient, private readonly dependencies: Dependencies) {}

  async getSettings(): Promise<PublicModelSettingsSnapshot> { return observeModelSettings(await this.authority.readFresh()) }

  async connect(observation: PublicModelSettingsSnapshot, input: ConnectModelInput): Promise<PublicModelMutationResult> {
    const observed = requireModelObservation(observation)
    const submitted = structuredClone(input)
    const existing = submitted.id === undefined ? undefined : this.connection(observed, submitted.id)
    const id = existing?.id ?? this.dependencies.createId()
    const replacement = suppliedKey(submitted)
    if (!existing && replacement === undefined) throw new Error('API key is required')
    const ciphertext = replacement === undefined ? undefined : this.authority.encryptCredential(replacement)
    const source = await this.source(observed, existing?.id, replacement)
    if ('status' in source) return source
    const candidate = requireSummary({ id, name: typeof submitted.name === 'string' ? submitted.name.trim() : '',
      provider: submitted.provider, accessType: submitted.accessType, protocol: submitted.protocol,
      baseUrl: typeof submitted.baseUrl === 'string' ? submitted.baseUrl.trim() : '',
      modelId: typeof submitted.modelId === 'string' ? submitted.modelId.trim() : '',
      apiKeyHint: keyHint(source.apiKey), status: 'connected', lastTestedAt: this.dependencies.nowIso(),
      capabilityOverride: submitted.capabilityOverride === undefined ? existing?.capabilityOverride ?? null : submitted.capabilityOverride })
    const request: SettingsTransactionRequest = existing ? connectionEditRequest(observed, candidate, ciphertext !== undefined)
      : { baseRevision: observed.observation.revision, operations: [{ kind: 'model-connection.add', connection: candidate, expectedAbsentRevision: 0 }] }
    const conflict = this.preflight(source.snapshot, request)
    if (conflict) return conflict
    const started = await this.startProbe(observed, existing?.id, () => this.testProtocol(candidate, source.apiKey))
    if ('status' in started) return started
    await started.completion
    return publicModelMutation(await this.authority.apply(request, ciphertext === undefined ? undefined : { id, ciphertext }))
  }

  async test(observation: PublicModelSettingsSnapshot, id: string): Promise<ModelTestMutation> {
    const observed = requireModelObservation(observation)
    const original = this.connection(observed, id)
    const source = await this.source(observed, id)
    if ('status' in source) return { mutation: source }
    let failure: ModelProtocolError | undefined
    try {
      const started = await this.startProbe(observed, id, () => this.testProtocol(original, source.apiKey))
      if ('status' in started) return { mutation: started }
      await started.completion
    } catch (error) {
      if (!(error instanceof ModelProtocolError)) throw error
      failure = error
    }
    const mutation = publicModelMutation(await this.authority.apply(connectionTestRequest(observed, id, failure?.status ?? 'connected', this.dependencies.nowIso())))
    return { mutation, ...(failure ? { failure } : {}) }
  }

  async delete(observation: PublicModelSettingsSnapshot, id: string): Promise<PublicModelMutationResult> {
    const observed = requireModelObservation(observation)
    return publicModelMutation(await this.authority.apply(connectionRemoveRequest(observed, id), { id, ciphertext: null }))
  }

  async setFeature<F extends ModelFeature>(observation: PublicModelSettingsSnapshot, feature: F,
    patch: Partial<ModelFeatureGroups[F]>): Promise<PublicModelMutationResult> {
    const observed = requireModelObservation(observation)
    // Validate the original partial command before deriving its normalized dependent preference.
    modelFeatureRequest(observed, feature, patch)
    const submitted = structuredClone(patch)
    // Match the finite builder's omission semantics before deriving any dependent preference.
    for (const [field, value] of Object.entries(submitted)) {
      if (value === undefined) Reflect.deleteProperty(submitted, field)
    }
    const original = observed.settings[feature] ?? DEFAULT_FLOATING_TRANSLATION_SETTINGS
    const candidate = { ...original, ...submitted }
    const normalizing = Object.hasOwn(submitted, 'connectionId') || Object.hasOwn(submitted, 'reasoningEffort')
    const guardedBinding = normalizing || Object.hasOwn(submitted, 'thinkingMode')
    const selected = guardedBinding && candidate.connectionId !== null
      ? featureModelConnections(observed.settings).find(item => item.id === candidate.connectionId) : undefined
    if (guardedBinding && candidate.connectionId !== null && !selected) throw new Error('Unknown model connection')
    const normalized = normalizing ? { ...submitted, connectionId: candidate.connectionId,
      reasoningEffort: selected ? normalizeReasoningEffort(selected, candidate.reasoningEffort) : candidate.reasoningEffort }
      : guardedBinding ? { ...submitted, connectionId: candidate.connectionId } : submitted
    const request = modelFeatureRequest(observed, feature, normalized)
    const operations = [...request.operations, ...(selected ? modelExecutionGuardRequest(observed, { connectionId: selected.id }).operations : [])]
    return publicModelMutation(await this.authority.apply({ ...request, operations }))
  }

  async acceptTranslationPrivacyNotice(observation: PublicModelSettingsSnapshot): Promise<PublicModelMutationResult> {
    const observed = requireModelObservation(observation)
    return publicModelMutation(await this.authority.apply({ baseRevision: observed.observation.revision, operations: [{ kind: 'translation-privacy.accept' }] }))
  }

  async listModels(observation: PublicModelSettingsSnapshot, input: ListModelsInput): Promise<ModelCatalogRead> {
    const observed = requireModelObservation(observation)
    const submitted = structuredClone(input)
    if (submitted.id !== undefined) this.connection(observed, submitted.id)
    const replacement = suppliedKey(submitted)
    // Reuse the same strict provider/endpoint parser before any external call.
    const candidate = requireSummary({ id: submitted.id ?? this.dependencies.createId(), name: 'Catalog', accessType: 'standard-api',
      provider: submitted.provider, protocol: submitted.protocol, baseUrl: typeof submitted.baseUrl === 'string' ? submitted.baseUrl.trim() : '',
      modelId: 'catalog', apiKeyHint: '••••', status: 'untested', lastTestedAt: null, capabilityOverride: null })
    const source = await this.source(observed, submitted.id, replacement)
    if ('status' in source) return source
    const started = await this.startProbe(observed, submitted.id, () => this.catalog.listModels({ provider: candidate.provider,
      protocol: candidate.protocol, baseUrl: candidate.baseUrl, apiKey: source.apiKey, signal: new AbortController().signal }))
    if ('status' in started) return started
    const catalog = await started.completion
    if (submitted.id !== undefined) {
      const conflict = this.preflight(await this.authority.readFresh(), modelExecutionGuardRequest(observed, { connectionId: submitted.id }))
      if (conflict) return conflict
    }
    return { status: 'catalog', catalog: structuredClone(catalog) }
  }

  private connection(observed: PublicModelSettingsSnapshot, id: string): ModelConnectionSummary {
    const connection = observed.settings.connections.find(item => item.id === id)
    if (!connection) throw new Error('SETTINGS_OBSERVATION_CONNECTION_MISSING')
    return connection
  }

  private preflight(snapshot: SettingsTransactionSnapshot, request: SettingsTransactionRequest): Conflict | undefined {
    const result = reduceSettingsTransaction(snapshot, request)
    if (result.status === 'invalid') throw new Error('SETTINGS_COMMAND_INVALID')
    if (result.status === 'conflict') return publicModelMutation(result) as Conflict
    return undefined
  }

  private async source(observed: PublicModelSettingsSnapshot, id: string | undefined, replacement?: string): Promise<
    { snapshot: SettingsTransactionSnapshot; apiKey: string } | Conflict> {
    const snapshot = await this.authority.readFresh()
    if (id !== undefined) {
      const conflict = this.preflight(snapshot, modelExecutionGuardRequest(observed, { connectionId: id }))
      if (conflict) return conflict
    }
    if (replacement !== undefined) return { snapshot, apiKey: replacement }
    if (id === undefined) throw new Error('API key is required')
    try {
      const paired = await this.authority.readExecution({ connectionId: id })
      const conflict = this.preflight(paired.snapshot, modelExecutionGuardRequest(observed, { connectionId: id }))
      if (conflict) return conflict
      if (paired.apiKey === null) throw new Error('API key is required')
      return { snapshot: paired.snapshot, apiKey: paired.apiKey }
    } catch (error) {
      if (error instanceof SettingsStorageError && error.code === 'SETTINGS_TRANSACTION_CONNECTION_MISSING') {
        const conflict = this.preflight(await this.authority.readFresh(), modelExecutionGuardRequest(observed, { connectionId: id }))
        if (conflict) return conflict
      }
      throw error
    }
  }

  private async startProbe<T>(observed: PublicModelSettingsSnapshot, id: string | undefined,
    start: () => Promise<T>): Promise<{ completion: Promise<T> } | Conflict> {
    if (id === undefined) return { completion: start() }
    try { return await this.authority.admitExecution(observed, { connectionId: id }, () => ({ completion: start() })) }
    catch (error) {
      if (error instanceof SettingsStorageError && error.code === 'SETTINGS_TRANSACTION_AUTHORITY_CHANGED') {
        const conflict = this.preflight(await this.authority.readFresh(), modelExecutionGuardRequest(observed, { connectionId: id }))
        if (conflict) return conflict
      }
      throw error
    }
  }

  private testProtocol(connection: ModelConnectionSummary, apiKey: string): Promise<void> {
    const preference = resolveModelThinkingCapability(connection).thinking === 'unknown'
      ? { thinkingMode: 'default' as const, reasoningEffort: 'default' as const } : translationThinkingPreference(connection)
    return this.protocol.testConnection({ provider: connection.provider, protocol: connection.protocol, baseUrl: connection.baseUrl,
      modelId: connection.modelId, apiKey, ...(connection.capabilityOverride ? { capabilityOverride: connection.capabilityOverride } : {}),
      ...preference, signal: new AbortController().signal })
  }
}
