import { parseCompleteEditorAppearancePreferences, type EditorAppearancePreferences } from './editor-appearance-preferences'
import { parseCompleteLayoutPreferences, type LayoutPreferences } from './layout-preferences'
import { parseBrowserSearchPreferences, type BrowserSearchPreferences } from './search-preferences'
import { parseStickyNotePreferences, type StickyNotePreferences } from './sticky-note-preferences'
import { parseDesktopLifecyclePreferences, type DesktopLifecyclePreferences } from './desktop-lifecycle-preferences'
import { hasObservationKeys, isObservationRecord, isObservationRevision } from './settings-observation'

export interface PreferenceValues {
  search: BrowserSearchPreferences
  appearance: EditorAppearancePreferences
  layout: LayoutPreferences
  stickyNotes: StickyNotePreferences
  desktopLifecycle: DesktopLifecyclePreferences
}
export type PreferenceGroup = keyof PreferenceValues
export const PREFERENCE_GROUPS = ['search', 'appearance', 'layout', 'stickyNotes', 'desktopLifecycle'] as const satisfies readonly PreferenceGroup[]
export const OBSERVED_PREFERENCE_FIELDS = {
  search: ['provider', 'customTemplate'],
  appearance: ['minimumContentMarginPx', 'maximumContentWidthPx', 'preserveSingleLineBreaks', 'spellCheckEnabled',
    'showEditIndicators', 'editorTheme', 'headingLatinFont', 'headingCjkFont', 'bodyLatinFont', 'bodyCjkFont', 'themeColor', 'micaOpacityPercent'],
  layout: ['leftSidebarWidth', 'rightSidebarWidth'],
  stickyNotes: ['defaultAppearance', 'defaultColor', 'colorPresets', 'texturePresets'],
  desktopLifecycle: ['launchAtLogin', 'closeBehavior', 'stickyNoteAutostartPrompted'],
} as const satisfies { [G in PreferenceGroup]: readonly (keyof PreferenceValues[G])[] }

/** The opening/edited values and their main-issued revisions remain one observation. */
export type PublicPreferenceSnapshot<G extends PreferenceGroup = PreferenceGroup> = G extends PreferenceGroup ? {
  group: G
  values: PreferenceValues[G]
  observation: {
    version: 1
    revision: number
    minimumBaseRevision: number
    fields: Partial<Record<keyof PreferenceValues[G], number>>
  }
} : never
export type PreferenceConflictReason = 'future-revision' | 'snapshot-too-old' | 'field-changed'
export type PublicPreferenceMutation<G extends PreferenceGroup = PreferenceGroup> = G extends PreferenceGroup ? (
  | { status: 'committed' | 'unchanged'; snapshot: PublicPreferenceSnapshot<G> }
  | { status: 'conflict'; snapshot: PublicPreferenceSnapshot<G>; reason: PreferenceConflictReason; fields: readonly (keyof PreferenceValues[G])[] }
) : never
export type PreferencePatchInput = { [G in PreferenceGroup]: {
  observed: PublicPreferenceSnapshot<G>; changes: Partial<PreferenceValues[G]>
} }[PreferenceGroup]

function isGroup(value: unknown): value is PreferenceGroup {
  return typeof value === 'string' && Object.hasOwn(OBSERVED_PREFERENCE_FIELDS, value)
}
function isData(value: unknown, depth = 0, budget = { remaining: 512 }): boolean {
  if (--budget.remaining < 0 || depth > 8) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return value.length <= 32_767
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64 || Reflect.ownKeys(value).length !== value.length + 1) return false
    for (let index = 0; index < value.length; index++) {
      const item = Object.getOwnPropertyDescriptor(value, String(index))
      if (!item || !Object.hasOwn(item, 'value') || !isData(item.value, depth + 1, budget)) return false
    }
    return true
  }
  return isObservationRecord(value) && Object.values(value).every(item => isData(item, depth + 1, budget))
}
function equalData(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key)
    && equalData((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}
function parseValues(group: PreferenceGroup, value: unknown): unknown {
  if (!isData(value) || !hasObservationKeys(value, OBSERVED_PREFERENCE_FIELDS[group])) return undefined
  if (group === 'search' && (typeof value.customTemplate !== 'string' || value.customTemplate.length > 2000)) return undefined
  const parsed = group === 'search' ? parseBrowserSearchPreferences(value)
    : group === 'appearance' ? parseCompleteEditorAppearancePreferences(value)
      : group === 'layout' ? parseCompleteLayoutPreferences(value)
        : group === 'stickyNotes' ? parseStickyNotePreferences(value) : parseDesktopLifecyclePreferences(value)
  return parsed && equalData(parsed, value) ? parsed : undefined
}

export function parsePublicPreferenceSnapshot(value: unknown): PublicPreferenceSnapshot | undefined {
  try {
    if (!hasObservationKeys(value, ['group', 'values', 'observation']) || !isGroup(value.group)) return undefined
    const values = parseValues(value.group, value.values), observed = value.observation
    if (!values || !hasObservationKeys(observed, ['version', 'revision', 'minimumBaseRevision', 'fields'])
      || observed.version !== 1 || !isObservationRevision(observed.revision)
      || !isObservationRevision(observed.minimumBaseRevision, observed.revision)
      || !hasObservationKeys(observed.fields, [], OBSERVED_PREFERENCE_FIELDS[value.group])
      || Object.values(observed.fields).some(revision => !isObservationRevision(revision, observed.revision as number))) return undefined
    return structuredClone({ group: value.group, values, observation: observed }) as PublicPreferenceSnapshot
  } catch { return undefined }
}

/** Undefined is omission; fields are finite and validation may not normalize unmentioned fields. */
export function parsePreferenceChanges<G extends PreferenceGroup>(observed: PublicPreferenceSnapshot<G>, value: unknown): Partial<PreferenceValues[G]> | undefined {
  try {
    const snapshot = parsePublicPreferenceSnapshot(observed)
    if (!snapshot || !hasObservationKeys(value, [], OBSERVED_PREFERENCE_FIELDS[snapshot.group])) return undefined
    const changes = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
    if (!isData(changes) || !parseValues(snapshot.group, { ...snapshot.values, ...changes })) return undefined
    return structuredClone(changes) as Partial<PreferenceValues[G]>
  } catch { return undefined }
}

export function parsePublicPreferenceMutation(value: unknown): PublicPreferenceMutation | undefined {
  try {
    if (!isObservationRecord(value)) return undefined
    const conflict = value.status === 'conflict'
    if (!hasObservationKeys(value, conflict ? ['status', 'snapshot', 'reason', 'fields'] : ['status', 'snapshot'])
      || !(conflict || value.status === 'committed' || value.status === 'unchanged')) return undefined
    const snapshot = parsePublicPreferenceSnapshot(value.snapshot)
    if (!snapshot) return undefined
    if (!conflict) return { status: value.status as 'committed' | 'unchanged', snapshot } as PublicPreferenceMutation
    const allowed: readonly string[] = OBSERVED_PREFERENCE_FIELDS[snapshot.group]
    if (!['future-revision', 'snapshot-too-old', 'field-changed'].includes(value.reason as string)
      || !Array.isArray(value.fields) || !isData(value.fields) || new Set(value.fields).size !== value.fields.length
      || value.fields.some(field => typeof field !== 'string' || !allowed.includes(field))) return undefined
    return { status: 'conflict', snapshot, reason: value.reason as PreferenceConflictReason, fields: [...value.fields] } as PublicPreferenceMutation
  } catch { return undefined }
}

export function parsePreferencePatchInput(value: unknown): PreferencePatchInput | undefined {
  try {
    if (!hasObservationKeys(value, ['observed', 'changes'])) return undefined
    const observed = parsePublicPreferenceSnapshot(value.observed)
    if (!observed) return undefined
    const changes = parsePreferenceChanges(observed, value.changes)
    return changes ? { observed, changes } as PreferencePatchInput : undefined
  } catch { return undefined }
}
