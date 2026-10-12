import type { ApiResult, ArkdownApi } from '../../shared/contracts'
import type { ModelThinkingCapability } from '../../shared/model-capability-rules'
import type { LargeModelSettings, ModelConnectionSummary, ModelProtocol, ModelProviderId } from '../../shared/large-model-settings'
import type { ModelFeatureName, ModelFeaturePatches } from '../../shared/model-settings-commands'
import { parsePublicModelSettingsSnapshot, type PublicModelMutationResult, type PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import type { PreferencePersistence } from './preference-update-queue'

export interface ModelDialogFields {
  name: string; nameSource: 'automatic' | 'manual'; provider: ModelProviderId; protocol: ModelProtocol
  baseUrl: string; baseUrlSource: 'preset' | 'manual'; modelId: string; apiKey: string
  accessType: 'standard-api' | 'codex-cli'; contextWindowTokens: string; maxInputTokens: string; maxOutputTokens: string
  manualThinking?: ModelThinkingCapability; modelEntryMode: 'manual' | 'catalog'; modelOptions: string[]
}
export interface ModelDialogDraft {
  key: string; connection?: ModelConnectionSummary; observed: PublicModelSettingsSnapshot; fields: Partial<ModelDialogFields>
  codexObserved?: PublicModelSettingsSnapshot
}
export type ModelMutationKey = `feature.${ModelFeatureName}.${string}` | `connect.${string}` | `delete.${string}` | `test.${string}`
  | 'codex.test' | 'codex.login' | 'codex.remove' | 'privacy'
interface FeatureIntent { feature: ModelFeatureName; patch: ModelFeaturePatches[ModelFeatureName] }
type FeatureMutation = (original: PublicModelSettingsSnapshot) => Promise<ApiResult<PublicModelMutationResult>>
export interface ModelPreferenceView {
  observed?: PublicModelSettingsSnapshot; settings?: LargeModelSettings; dialog?: ModelDialogDraft
  pendingKeys: readonly ModelMutationKey[]; failedKeys: readonly ModelMutationKey[]; loading: boolean; error: string | null
}
type ModelReadApi = Pick<ArkdownApi, 'getModelSettingsSnapshot'>
const conflictMessage = '大模型设置已在其他窗口更改。你的修改仍保留，可以重试保存，或打开设置重新加载。'

/** App-lifetime intent only. All close admission remains owned by PreferencePersistence. */
export class ModelPreferenceDraft {
  private confirmed?: PublicModelSettingsSnapshot
  private readonly failures = new Map<ModelMutationKey, { observed: PublicModelSettingsSnapshot; message: string }>()
  private readonly features = new Map<ModelMutationKey, FeatureIntent>()
  private readonly featureWrites = new Map<ModelMutationKey, FeatureMutation>()
  private readonly forms = new Map<string, ModelDialogDraft>()
  private dialogKey?: string
  private readonly pending = new Set<ModelMutationKey>()
  private loading = false
  private notice: string | null = null
  private wave?: { resolve(): void; reject(error: Error): void }
  private readonly listeners = new Set<() => void>()
  private view: ModelPreferenceView = { pendingKeys: [], failedKeys: [], loading: false, error: null }
  constructor(private readonly persistence: PreferencePersistence) {}
  getSnapshot = (): ModelPreferenceView => this.view
  hasUnsettledFeature(feature: ModelFeatureName): boolean {
    const prefix = `feature.${feature}.`
    return [...this.features.values()].some(intent => intent.feature === feature)
      || [...this.pending, ...this.failures.keys()].some(key => key.startsWith(prefix))
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  accept(value: PublicModelSettingsSnapshot): void {
    const snapshot = parsePublicModelSettingsSnapshot(value)
    if (!snapshot || this.confirmed && snapshot.observation.revision <= this.confirmed.observation.revision) return
    this.confirmed = snapshot
    this.publish()
  }
  openDialog(connectionId?: string): void {
    if (!this.confirmed) return
    const key = connectionId ?? 'new'
    if (!this.forms.has(key)) {
      const connection = this.confirmed.settings.connections.find(item => item.id === connectionId)
      if (connectionId && !connection) return
      this.forms.set(key, { key, ...(connection ? { connection: structuredClone(connection) } : {}),
        observed: structuredClone(this.confirmed), fields: {} })
    }
    this.dialogKey = key; this.publish()
  }
  updateDialogFields(fields: Partial<ModelDialogFields>): void {
    const dialog = this.dialogKey ? this.forms.get(this.dialogKey) : undefined
    if (!dialog) return
    const next = { ...dialog.fields, ...fields }
    if (JSON.stringify(next) === JSON.stringify(dialog.fields)) return
    dialog.fields = structuredClone(next); this.publish()
  }
  updateDialogCodexObservation(snapshot: PublicModelSettingsSnapshot): void {
    const dialog = this.dialogKey ? this.forms.get(this.dialogKey) : undefined
    if (!dialog) return
    dialog.codexObserved = structuredClone(snapshot); this.publish()
  }
  hideDialog(): void { this.dialogKey = undefined; this.publish() }
  finishDialog(): void { if (this.dialogKey) this.forms.delete(this.dialogKey); this.hideDialog() }

  mutate(key: ModelMutationKey, observed: PublicModelSettingsSnapshot,
    run: (original: PublicModelSettingsSnapshot) => Promise<ApiResult<PublicModelMutationResult>>, intent?: FeatureIntent): Promise<ApiResult<PublicModelMutationResult>> {
    if (this.pending.has(key) || this.loading) return Promise.resolve({ ok: false, error: { code: 'OPERATION_FAILED', message: '设置操作尚未完成，请稍后重试。' } })
    if (intent && !Object.hasOwn(intent.patch, 'connectionId')
      && (Object.hasOwn(intent.patch, 'thinkingMode') || Object.hasOwn(intent.patch, 'reasoningEffort'))
      && [...this.features.values()].some(draft => draft.feature === intent.feature && Object.hasOwn(draft.patch, 'connectionId'))) {
      return Promise.resolve({ ok: false, error: { code: 'OPERATION_FAILED', message: '模型选择尚未保存，请先重试该选择或重新加载设置。' } })
    }
    if (intent) { this.features.set(key, structuredClone(intent)); this.featureWrites.set(key, run) }
    return this.perform(key, observed, run, value => value)
  }

  /** Only an explicit retry may rebase retained feature choices onto a newer observation. */
  async retryFeature(feature: ModelFeatureName): Promise<boolean> {
    if (!this.confirmed || this.loading || this.pending.size > 0) return false
    const entries = [...this.features].filter(([key, intent]) => intent.feature === feature && this.failures.has(key))
      .sort(([, a], [, b]) => Number(Object.hasOwn(b.patch, 'connectionId')) - Number(Object.hasOwn(a.patch, 'connectionId')))
    if (!entries.length) return false
    this.loading = true; this.notice = null; this.publish()
    try {
      for (const [key, intent] of entries) {
        const original = this.failures.get(key)?.observed
        const observed = this.confirmed
        const run = this.featureWrites.get(key)
        if (!run || !original) return false
        if (!Object.hasOwn(intent.patch, 'connectionId')
          && (Object.hasOwn(intent.patch, 'thinkingMode') || Object.hasOwn(intent.patch, 'reasoningEffort'))
          && original.settings[feature]?.connectionId !== observed.settings[feature]?.connectionId) {
          this.notice = '所选模型已在其他窗口更改。你的修改仍保留，请打开设置重新选择模型。'
          return false
        }
        const result = await this.execute(key, structuredClone(observed), run, value => value)
        if (!result.ok || result.value.status === 'conflict') return false
      }
      return true
    } finally { this.loading = false; this.publish() }
  }

  async perform<T>(key: ModelMutationKey, observed: PublicModelSettingsSnapshot,
    run: (original: PublicModelSettingsSnapshot) => Promise<ApiResult<T>>,
    mutationOf: (value: T) => PublicModelMutationResult | undefined): Promise<ApiResult<T>> {
    if (this.pending.has(key) || this.loading) return { ok: false, error: { code: 'OPERATION_FAILED', message: '设置操作尚未完成，请稍后重试。' } }
    const original = structuredClone(this.failures.get(key)?.observed ?? observed)
    return this.execute(key, original, run, mutationOf)
  }

  private async execute<T>(key: ModelMutationKey, original: PublicModelSettingsSnapshot,
    run: (original: PublicModelSettingsSnapshot) => Promise<ApiResult<T>>,
    mutationOf: (value: T) => PublicModelMutationResult | undefined): Promise<ApiResult<T>> {
    this.beginWave(); this.pending.add(key); this.notice = null; this.publish()
    try {
      const result = await Promise.resolve().then(() => run(original))
      if (!result.ok) {
        this.failures.set(key, { observed: original, message: result.error.message })
        return result
      }
      const mutation = mutationOf(result.value)
      if (mutation) this.accept(mutation.snapshot)
      if (mutation?.status === 'conflict') this.failures.set(key, { observed: original, message: conflictMessage })
      else if (mutation) { this.failures.delete(key); this.features.delete(key); this.featureWrites.delete(key) }
      return result
    } catch {
      const error = { code: 'OPERATION_FAILED', message: '大模型设置操作未能完成，请重试。' }
      this.failures.set(key, { observed: original, message: error.message })
      return { ok: false, error }
    } finally {
      this.pending.delete(key); this.finishWave(); this.publish()
    }
  }

  async refresh(api: ModelReadApi): Promise<void> {
    if (this.loading) return
    this.loading = true; this.publish()
    try { this.accept(await this.read(api)); this.notice = null }
    catch (error) { this.notice = error instanceof Error ? error.message : '大模型设置读取失败。' }
    finally { this.loading = false; this.publish() }
  }
  async reload(api: ModelReadApi): Promise<void> {
    if (this.loading || this.pending.size > 0) return
    this.loading = true; this.publish()
    try {
      await this.persistence.runExternal('models', async () => {
        const snapshot = await this.read(api)
        if (this.confirmed && snapshot.observation.revision < this.confirmed.observation.revision) throw new Error('读取结果已过期，请重试。')
        this.accept(snapshot)
        this.failures.clear(); this.features.clear(); this.featureWrites.clear(); this.forms.clear(); this.dialogKey = undefined; this.notice = null
      })
    } catch (error) { this.notice = error instanceof Error ? error.message : '大模型设置读取失败。' }
    finally { this.loading = false; this.publish() }
  }

  private async read(api: ModelReadApi): Promise<PublicModelSettingsSnapshot> {
    const result = await api.getModelSettingsSnapshot()
    if (!result.ok) throw new Error(result.error.message)
    const snapshot = parsePublicModelSettingsSnapshot(result.value)
    if (!snapshot) throw new Error('大模型设置响应无效。')
    return snapshot
  }
  private beginWave(): void {
    if (this.wave) return
    const completion = new Promise<void>((resolve, reject) => { this.wave = { resolve, reject } })
    // Concurrent operations share one registered completion; later unrelated success cannot mask an older failure.
    void this.persistence.runExternal('models', () => completion).catch(() => undefined)
  }
  private finishWave(): void {
    if (this.pending.size > 0 || !this.wave) return
    const wave = this.wave; this.wave = undefined
    const errors = [...this.failures.values()].map(value => value.message)
    if (errors.length) wave.reject(new Error(errors.join(' ')))
    else wave.resolve()
  }
  private publish(): void {
    const settings = this.confirmed ? structuredClone(this.confirmed.settings) : undefined
    if (settings) for (const intent of this.features.values()) {
      Object.assign(settings[intent.feature] ?? (settings.floatingTranslation = { connectionId: null, thinkingMode: 'disabled', reasoningEffort: 'low' }), intent.patch)
    }
    this.view = { observed: this.confirmed, settings, dialog: this.dialogKey ? this.forms.get(this.dialogKey) : undefined,
      pendingKeys: [...this.pending], failedKeys: [...this.failures.keys()], loading: this.loading,
      error: [...new Set([this.notice, ...[...this.failures.values()].map(value => value.message)].filter(Boolean))].join(' ') || null }
    for (const listener of this.listeners) { try { listener() } catch { /* UI observers cannot undo a saved mutation. */ } }
  }
}
