import { normalizeShellIntegrationPreferences, parseObservedShellIntegrationUpdate, SHELL_INTEGRATION_FEATURES,
  type ShellIntegrationUpdate, type ShellIntegrationSnapshot, type ObservedShellIntegrationUpdate } from '../../shared/shell-integration-preferences'
import type { SettingsUpdater } from '../settings/settings-coordinator'
import type { ShellMenuRegistration } from './registration'
import type { SettingsAuthority } from '../settings/settings-authority'
import type { SettingsTransactionSnapshot } from '../settings/settings-transaction-types'
import { PublicError } from '../../shared/public-errors'

type ShellSettings = SettingsUpdater | { authority: Pick<SettingsAuthority, 'readFresh' | 'getDisplaySnapshot' | 'apply'> }

export class ShellIntegrationService {
  private failed = new Set<string>()
  private tail: Promise<unknown> = Promise.resolve()
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }
  async drain(): Promise<void> { await this.tail }
  constructor(private readonly registration: Pick<ShellMenuRegistration, 'setEnabled'>, private readonly settings: ShellSettings) {}
  get() {
    const value = normalizeShellIntegrationPreferences(('authority' in this.settings
      ? this.settings.authority.getDisplaySnapshot().settings : this.settings.get()).shellIntegration)
    for (const feature of SHELL_INTEGRATION_FEATURES) if (this.failed.has(feature)) value[feature] = false
    return value
  }
  async restoreEnabled() {
    return this.enqueue(async () => {
      const failures: Error[] = []
      for (const feature of SHELL_INTEGRATION_FEATURES) {
        const observed = 'authority' in this.settings ? this.observe(await this.settings.authority.readFresh()) : undefined
        if (!(observed?.values ?? normalizeShellIntegrationPreferences(('authority' in this.settings
          ? this.settings.authority.getDisplaySnapshot().settings : this.settings.get()).shellIntegration))[feature]) continue
        try {
          await this.registration.setEnabled(feature, true, observed
            ? async () => { await this.persistObserved({ feature, enabled: true, observed }) } : undefined)
          this.failed.delete(feature)
        }
        catch (error) { this.failed.add(feature); failures.push(new Error(`Could not restore ${feature}`, { cause: error })) }
      }
      if (failures.length) throw new AggregateError(failures, '无法恢复部分右键菜单')
    })
  }
  async update(input: ShellIntegrationUpdate) {
    if ('authority' in this.settings) throw new Error('SHELL_LEGACY_WRITER_DISABLED')
    const settings = this.settings
    return this.enqueue(async () => {
      try {
        await this.registration.setEnabled(input.feature, input.enabled, () => settings.update((current) => ({
          ...current, shellIntegration: { ...normalizeShellIntegrationPreferences(current.shellIntegration), [input.feature]: input.enabled },
        })), { explicitEnable: input.enabled })
        this.failed.delete(input.feature)
        return this.get()
      } catch (error) { if (input.enabled) this.failed.add(input.feature); throw error }
    })
  }

  readObserved(): Promise<ShellIntegrationSnapshot> {
    return this.enqueue(async () => {
      if (!('authority' in this.settings)) throw new Error('SHELL_AUTHORITY_UNAVAILABLE')
      return this.observe(await this.settings.authority.readFresh())
    })
  }

  updateObserved(input: ObservedShellIntegrationUpdate): Promise<ShellIntegrationSnapshot> {
    const submitted = parseObservedShellIntegrationUpdate(input)
    if (!submitted) return Promise.reject(new PublicError('INVALID_INPUT'))
    return this.enqueue(async () => {
      // Validate the original observation before starting any native mutation. The final
      // callback checks it again; the registry owner conditionally rolls back its own work.
      await this.persistObserved({ ...submitted, enabled: submitted.observed.values[submitted.feature] })
      let committed: SettingsTransactionSnapshot | undefined
      try {
        await this.registration.setEnabled(submitted.feature, submitted.enabled, async () => {
          committed = await this.persistObserved(submitted)
        }, { explicitEnable: submitted.enabled })
      } catch (error) {
        if (!committed) { if (submitted.enabled) this.failed.add(submitted.feature); throw error }
        // Registry connection teardown may fail after its persist callback. The acknowledged
        // settings/native commit remains successful and must never trigger a replay.
      }
      if (!committed) throw new Error('SHELL_PERSIST_CALLBACK_MISSING')
      this.failed.delete(submitted.feature)
      return this.observe(committed)
    })
  }

  private async persistObserved(input: ObservedShellIntegrationUpdate): Promise<SettingsTransactionSnapshot> {
    if (!('authority' in this.settings)) throw new Error('SHELL_AUTHORITY_UNAVAILABLE')
    const result = await this.settings.authority.apply({ baseRevision: input.observed.observation.revision,
      operations: [{ kind: 'shell-integration.set', feature: input.feature, value: input.enabled,
        expected: { value: input.observed.values[input.feature], revision: input.observed.observation.fields[input.feature] ?? 0 } }] })
    if (result.status === 'invalid') throw new PublicError('INVALID_INPUT')
    if (result.status === 'conflict') throw new PublicError('SHELL_INTEGRATION_CONFLICT')
    return result.snapshot
  }

  private observe(snapshot: SettingsTransactionSnapshot): ShellIntegrationSnapshot {
    return { values: normalizeShellIntegrationPreferences(snapshot.settings.shellIntegration),
      unavailable: SHELL_INTEGRATION_FEATURES.filter(feature => this.failed.has(feature)),
      observation: { version: 1, revision: snapshot.revision, minimumBaseRevision: snapshot.minimumBaseRevision,
        fields: Object.fromEntries(SHELL_INTEGRATION_FEATURES.filter(feature => Object.hasOwn(snapshot.fieldRevisions.fields, `shellIntegration.${feature}`))
          .map(feature => [feature, snapshot.fieldRevisions.fields[`shellIntegration.${feature}`]])) } }
  }
}
