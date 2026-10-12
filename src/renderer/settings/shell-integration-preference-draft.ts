import type { ArkdownApi } from '../../shared/contracts'
import { DEFAULT_SHELL_INTEGRATION_PREFERENCES, SHELL_INTEGRATION_FEATURES,
  type ShellIntegrationFeature, type ShellIntegrationPreferences, type ShellIntegrationSnapshot } from '../../shared/shell-integration-preferences'
import type { PreferencePersistence } from './preference-update-queue'

type ShellApi = Pick<ArkdownApi, 'getShellIntegrationPreferences' | 'updateShellIntegrationPreference'>
export interface ShellPreferenceView {
  values: ShellIntegrationPreferences
  loaded: boolean
  loading: boolean
  pending: Partial<Record<ShellIntegrationFeature, boolean>>
  errors: Partial<Record<ShellIntegrationFeature | 'load', string>>
}
export const EMPTY_SHELL_PREFERENCE_VIEW: ShellPreferenceView = {
  values: { ...DEFAULT_SHELL_INTEGRATION_PREFERENCES }, loaded: false, loading: false, pending: {}, errors: {},
}

/** App-lifetime UI state only. The existing persistence owner remains the sole close result owner. */
export class ShellIntegrationPreferenceDraft {
  private confirmed?: ShellIntegrationSnapshot
  private readonly dirty = new Map<ShellIntegrationFeature, { value: boolean; observed: ShellIntegrationSnapshot }>()
  private readonly pending = new Set<ShellIntegrationFeature>()
  private errors: ShellPreferenceView['errors'] = {}
  private loading = false
  private readGeneration = 0
  private view: ShellPreferenceView = EMPTY_SHELL_PREFERENCE_VIEW
  private readonly listeners = new Set<() => void>()

  constructor(private readonly persistence: PreferencePersistence) {}
  getSnapshot = (): ShellPreferenceView => this.view
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  async refresh(api: ShellApi): Promise<void> {
    if (this.loading) return
    const generation = ++this.readGeneration
    this.loading = true; this.publish()
    try {
      const snapshot = await this.read(api)
      if (generation !== this.readGeneration) return
      this.adopt(snapshot)
      delete this.errors.load
    } catch (error) {
      if (generation === this.readGeneration) this.errors.load = this.message(error)
    } finally {
      if (generation === this.readGeneration) { this.loading = false; this.publish() }
    }
  }

  async change(feature: ShellIntegrationFeature, value: boolean, api: ShellApi): Promise<void> {
    if (this.pending.has(feature) || this.loading || !this.confirmed) return
    const observed = structuredClone(this.dirty.get(feature)?.observed ?? this.confirmed)
    this.dirty.set(feature, { value, observed })
    this.pending.add(feature); delete this.errors[feature]; this.publish()
    try {
      const snapshot = await this.persistence.runExternal(`shell.${feature}`, async () => {
        const result = await api.updateShellIntegrationPreference?.({ feature, enabled: value, observed })
        if (!result) throw new Error('右键菜单设置不可用')
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      })
      this.adopt(snapshot)
      this.dirty.delete(feature)
    } catch (error) { this.errors[feature] = this.message(error) }
    finally { this.pending.delete(feature); this.publish() }
  }

  async reload(api: ShellApi): Promise<void> {
    if (this.loading || this.pending.size) return
    const generation = ++this.readGeneration
    const discarded = [...this.dirty.keys()]
    this.loading = true; this.publish()
    try {
      // This explicit discard verifies saved authority. Ordinary reopening/refresh never
      // acknowledges a failed intent, and discarding never replays native registration.
      const reading = Promise.resolve().then(() => this.read(api)).then(snapshot => {
        if (this.confirmed && snapshot.observation.revision < this.confirmed.observation.revision) throw new Error('右键菜单设置读取已过期')
        return snapshot
      })
      const acknowledgements = discarded.map(feature => this.persistence.runExternal(`shell.${feature}`, () => reading))
      const [snapshot] = await Promise.all([reading, ...acknowledgements])
      if (generation !== this.readGeneration) return
      this.adopt(snapshot)
      this.dirty.clear(); this.errors = {}
    } catch (error) { if (generation === this.readGeneration) this.errors.load = this.message(error) }
    finally { if (generation === this.readGeneration) { this.loading = false; this.publish() } }
  }

  private async read(api: ShellApi): Promise<ShellIntegrationSnapshot> {
    const result = await api.getShellIntegrationPreferences?.()
    if (!result) throw new Error('右键菜单设置不可用')
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  private adopt(snapshot: ShellIntegrationSnapshot): void {
    if (!this.confirmed || snapshot.observation.revision >= this.confirmed.observation.revision) this.confirmed = structuredClone(snapshot)
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : '右键菜单设置失败，请重试。' }
  private publish(): void {
    const values = { ...(this.confirmed?.values ?? DEFAULT_SHELL_INTEGRATION_PREFERENCES) }
    for (const feature of this.confirmed?.unavailable ?? []) values[feature] = false
    for (const [feature, draft] of this.dirty) values[feature] = draft.value
    this.view = { values, loaded: this.confirmed !== undefined, loading: this.loading,
      pending: Object.fromEntries(SHELL_INTEGRATION_FEATURES.filter(feature => this.pending.has(feature)).map(feature => [feature, true])),
      errors: { ...this.errors } }
    for (const listener of this.listeners) { try { listener() } catch { /* UI observer cannot change a persistence result. */ } }
  }
}
