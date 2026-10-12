import { OBSERVED_PREFERENCE_FIELDS, parsePreferenceChanges, parsePublicPreferenceSnapshot, parsePublicPreferenceMutation,
  type PreferenceGroup, type PublicPreferenceMutation, type PublicPreferenceSnapshot } from '../../shared/preference-observation'
import type { SettingsAuthority } from './settings-authority'
import { preferenceValue } from './settings-transaction-schema'
import type { SettingsTransactionOperation, SettingsTransactionSnapshot } from './settings-transaction-types'

export function observePreferences<G extends PreferenceGroup>(snapshot: SettingsTransactionSnapshot, group: G): PublicPreferenceSnapshot<G> {
  const observed = parsePublicPreferenceSnapshot({ group, values: preferenceValue(snapshot.settings, group), observation: {
    version: 1, revision: snapshot.revision, minimumBaseRevision: snapshot.minimumBaseRevision,
    fields: Object.fromEntries(OBSERVED_PREFERENCE_FIELDS[group].filter(field => Object.hasOwn(snapshot.fieldRevisions.fields, `${group}.${field}`))
      .map(field => [field, snapshot.fieldRevisions.fields[`${group}.${field}`]])),
  } })
  if (!observed) throw new Error('SETTINGS_PREFERENCE_OBSERVATION_INVALID')
  return observed as PublicPreferenceSnapshot<G>
}

/** Thin finite command owner; all serialization, recovery and persistence stays in SettingsAuthority. */
export class SettingsPreferenceService {
  constructor(private readonly authority: Pick<SettingsAuthority, 'readFresh' | 'apply'>) {}

  async read<G extends PreferenceGroup>(group: G): Promise<PublicPreferenceSnapshot<G>> {
    if (!Object.hasOwn(OBSERVED_PREFERENCE_FIELDS, group)) throw new Error('SETTINGS_PREFERENCE_COMMAND_INVALID')
    return observePreferences(await this.authority.readFresh(), group)
  }

  patch<G extends PreferenceGroup>(observation: PublicPreferenceSnapshot<G> & { group: G }, proposed: unknown): Promise<PublicPreferenceMutation<G>>
  async patch(observation: PublicPreferenceSnapshot, proposed: unknown): Promise<PublicPreferenceMutation> {
    const observed = parsePublicPreferenceSnapshot(observation)
    if (!observed) throw new Error('SETTINGS_PREFERENCE_OBSERVATION_INVALID')
    const patch = parsePreferenceChanges(observed, proposed)
    if (!patch) throw new Error('SETTINGS_PREFERENCE_COMMAND_INVALID')
    // Validation/cloning precedes the first await, retaining the actual edited UI snapshot.
    const original: Record<string, unknown> = Object.fromEntries(Object.entries(observed.values))
    const revisions = observed.observation.fields as Record<string, number | undefined>
    const changes = Object.fromEntries(Object.entries(patch).map(([field, value]) => [field,
      { value, expected: { value: original[field], revision: revisions[field] ?? 0 } }]))
    const group = observed.group
    const kind = group === 'stickyNotes' ? 'sticky-notes.patch' : group === 'desktopLifecycle' ? 'desktop-lifecycle.patch' : `${group}.patch`
    // The exact group/field/value schema above establishes this finite operation union.
    const operation = { kind, changes } as SettingsTransactionOperation
    const result = await this.authority.apply({ baseRevision: observed.observation.revision, operations: [operation] })
    if (result.status === 'invalid') throw new Error('SETTINGS_PREFERENCE_COMMAND_INVALID')
    const snapshot = observePreferences(result.snapshot, group)
    const fields = result.status !== 'conflict' ? undefined : result.fields.map(field => {
      if (field.kind !== 'field' || !field.field.startsWith(`${group}.`)) throw new Error('SETTINGS_PREFERENCE_COMMAND_INVALID')
      return field.field.slice(group.length + 1)
    })
    const publicResult = parsePublicPreferenceMutation(result.status === 'conflict'
      ? { status: result.status, reason: result.reason, fields, snapshot }
      : { status: result.status, snapshot })
    if (!publicResult) throw new Error('SETTINGS_PREFERENCE_COMMAND_INVALID')
    return publicResult
  }
}
