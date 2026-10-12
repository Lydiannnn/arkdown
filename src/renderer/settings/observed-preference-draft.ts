import type { PreferenceValues, PublicPreferenceSnapshot } from '../../shared/preference-observation'

type EditableGroup = 'search' | 'appearance' | 'layout'
type Field<G extends EditableGroup> = keyof PreferenceValues[G]
type Snapshot<G extends EditableGroup> = {
  group: G
  values: PreferenceValues[G]
  observation: { version: 1; revision: number; minimumBaseRevision: number; fields: Partial<Record<Field<G>, number>> }
}
export interface PreferenceDraftAttempt<G extends EditableGroup> {
  observed: Snapshot<G>
  changes: Partial<PreferenceValues[G]>
  generations: Partial<Record<Field<G>, number>>
}
type Mutation<G extends EditableGroup> = { status: 'committed' | 'unchanged'; snapshot: Snapshot<G> }
  | { status: 'conflict'; snapshot: Snapshot<G>; reason: string; fields: readonly Field<G>[] }

/** Local dirty-field ownership only. Persistence remains in the App queue and main authority. */
export class ObservedPreferenceDraft<G extends EditableGroup> {
  private current: Snapshot<G> | undefined
  private generation = 0
  private readonly edits = new Map<Field<G>, {
    value: PreferenceValues[G][Field<G>]; observed: Snapshot<G>; generation: number; failed: boolean
  }>()

  constructor(readonly group: G) {}

  adopt(snapshot: Snapshot<G>): boolean {
    if (snapshot.group !== this.group) throw new Error('PREFERENCE_GROUP_MISMATCH')
    if (this.current && snapshot.observation.revision <= this.current.observation.revision) return false
    this.current = structuredClone(snapshot)
    return true
  }

  snapshot(): Snapshot<G> {
    if (!this.current) throw new Error('PREFERENCE_NOT_LOADED')
    return structuredClone(this.current)
  }

  ready(): boolean { return this.current !== undefined }
  editGeneration(): number { return this.generation }
  hasFailures(): boolean { return [...this.edits.values()].some(edit => edit.failed) }

  dirty(): Partial<PreferenceValues[G]> {
    return Object.fromEntries([...this.edits].map(([field, edit]) => [field, structuredClone(edit.value)])) as Partial<PreferenceValues[G]>
  }

  view(): PreferenceValues[G] { return { ...this.snapshot().values, ...this.dirty() } }

  edit(changes: Partial<PreferenceValues[G]>, origin = this.snapshot()): void {
    for (const field of Object.keys(changes) as Field<G>[]) {
      const value = changes[field]
      if (value === undefined) continue
      const previous = this.edits.get(field)
      this.edits.set(field, { value: structuredClone(value), observed: previous?.observed ?? structuredClone(origin),
        generation: ++this.generation, failed: previous?.failed ?? false })
    }
  }

  begin(changes: Partial<PreferenceValues[G]>): PreferenceDraftAttempt<G>[] {
    const buckets = new Map<number, PreferenceDraftAttempt<G>>()
    for (const field of Object.keys(changes) as Field<G>[]) {
      if (changes[field] === undefined) continue
      const edit = this.edits.get(field)
      if (!edit) throw new Error('PREFERENCE_EDIT_MISSING')
      const revision = edit.observed.observation.revision
      let bucket = buckets.get(revision)
      if (!bucket) {
        bucket = { observed: structuredClone(edit.observed), changes: {}, generations: {} }
        buckets.set(revision, bucket)
      }
      bucket.changes[field] = structuredClone(changes[field])
      bucket.generations[field] = edit.generation
    }
    return [...buckets.values()]
  }

  fail(attempt: PreferenceDraftAttempt<G>): void {
    for (const field of Object.keys(attempt.changes) as Field<G>[]) {
      const edit = this.edits.get(field)
      if (edit) edit.failed = true
    }
  }

  finish(attempt: PreferenceDraftAttempt<G>, result: Mutation<G>): void {
    this.adopt(result.snapshot)
    if (result.status === 'conflict') { this.fail(attempt); return }
    for (const field of Object.keys(attempt.changes) as Field<G>[]) {
      const edit = this.edits.get(field)
      if (!edit) continue
      if (edit.generation === attempt.generations[field]) this.edits.delete(field)
      else if (edit.observed.observation.revision === attempt.observed.observation.revision) {
        // This newer local edit descends from the acknowledged in-flight edit.
        // Advance only its written fields, never another draft or a refresh.
        edit.observed = structuredClone(result.snapshot)
        edit.failed = false
      }
    }
  }

  /** Explicit user discard. Confirm these saved values through the normal queue before clearing failure. */
  reload(snapshot: Snapshot<G>): Partial<PreferenceValues[G]> {
    const fields = [...this.edits.keys()]
    this.adopt(snapshot)
    const current = this.snapshot()
    this.edits.clear()
    const changes = Object.fromEntries(fields.map(field => [field, current.values[field]])) as Partial<PreferenceValues[G]>
    this.edit(changes)
    return changes
  }
}

// Concrete instances retain the public transport's exact group/value relationship.
export function createObservedPreferenceDrafts() {
  return { search: new ObservedPreferenceDraft('search'), appearance: new ObservedPreferenceDraft('appearance'),
    layout: new ObservedPreferenceDraft('layout'), menuAppearanceFields: new Set<keyof PreferenceValues['appearance']>() }
}
export type ObservedPreferenceDrafts = ReturnType<typeof createObservedPreferenceDrafts>
export type ObservedPreferenceSnapshot = PublicPreferenceSnapshot<EditableGroup>
