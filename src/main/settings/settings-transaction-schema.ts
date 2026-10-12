import { isDeepStrictEqual } from 'node:util'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../shared/background-settings'
import { DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES, parseDesktopLifecyclePreferences } from '../../shared/desktop-lifecycle-preferences'
import { DEFAULT_EDITOR_APPEARANCE, parseCompleteEditorAppearancePreferences } from '../../shared/editor-appearance-preferences'
import { SHORTCUT_DEFINITIONS } from '../../shared/keyboard-shortcuts'
import { isCanonicalModelConnectionId, MODEL_CONNECTION_LIMIT } from '../../shared/large-model-settings'
import { DEFAULT_LAYOUT_PREFERENCES, parseCompleteLayoutPreferences } from '../../shared/layout-preferences'
import { DEFAULT_BROWSER_SEARCH, parseBrowserSearchPreferences } from '../../shared/search-preferences'
import { SHELL_INTEGRATION_FEATURES } from '../../shared/shell-integration-preferences'
import { DEFAULT_STICKY_NOTE_PREFERENCES, parseStickyNotePreferences } from '../../shared/sticky-note-preferences'
import type { AppSettings } from './settings-store'
import type {
  ConnectionRevisionField, SettingsFieldRevisions, SettingsPreferenceGroup,
  SettingsPreferenceGroups, SettingsTransactionMetadata, SettingsTransactionSnapshot,
} from './settings-transaction-types'

export const SETTINGS_TRANSACTION_TOMBSTONE_LIMIT = 1024
export const SETTINGS_TRANSACTION_OPERATION_LIMIT = 256
export const SETTINGS_TRANSACTION_VERSION = 1

export const CONNECTION_FIELDS = [
  'name', 'provider', 'accessType', 'protocol', 'baseUrl', 'modelId', 'apiKeyHint',
  'status', 'lastTestedAt', 'capabilityOverride',
] as const
export const CONNECTION_TEST_FIELDS = ['provider', 'accessType', 'protocol', 'baseUrl', 'modelId', 'capabilityOverride'] as const
export const CONNECTION_REVISION_FIELDS: readonly ConnectionRevisionField[] = [...CONNECTION_FIELDS, 'entity', 'credential']
export const MODEL_FEATURE_FIELDS = {
  selectionTranslation: ['connectionId', 'thinkingMode', 'reasoningEffort', 'targetLanguage'],
  screenshotTranslation: ['connectionId', 'thinkingMode', 'reasoningEffort', 'targetLanguage'],
  floatingTranslation: ['connectionId', 'thinkingMode', 'reasoningEffort', 'target'],
  aiConversation: ['connectionId', 'thinkingMode', 'reasoningEffort', 'writePolicy'],
} as const
export const PREFERENCE_FIELDS = {
  search: ['provider', 'customTemplate'],
  appearance: [
    'minimumContentMarginPx', 'maximumContentWidthPx', 'preserveSingleLineBreaks',
    'spellCheckEnabled', 'showEditIndicators', 'editorTheme', 'headingLatinFont',
    'headingCjkFont', 'bodyLatinFont', 'bodyCjkFont', 'themeColor', 'micaOpacityPercent',
  ],
  layout: ['leftSidebarWidth', 'rightSidebarWidth'],
  stickyNotes: ['defaultAppearance', 'defaultColor', 'colorPresets', 'texturePresets'],
  desktopLifecycle: ['launchAtLogin', 'closeBehavior', 'stickyNoteAutostartPrompted'],
} as const satisfies { [G in SettingsPreferenceGroup]: readonly (keyof SettingsPreferenceGroups[G])[] }
export const BACKGROUND_CONTROL_FIELDS = [
  'imageOpacityPercent', 'imageAlignment', 'maskType', 'maskOpacityPercent', 'maskTransitionPercent', 'maskStrengthPercent',
] as const
export const SHORTCUT_TRANSACTION_FIELDS = SHORTCUT_DEFINITIONS.map(({ id }) => id)

const allowedFields = new Set([
  'applicationUpdate',
  'windowBounds', 'lastWorkspace', 'lastFolderPickerPath', 'fontDefaultsVersion', 'workspaceIntroSeen',
  'defaultApplicationsPrompt', 'screenshotOcr.preferredTier', 'models.codexCli',
  'models.selectionTranslation.privacyNoticeAccepted',
  ...Object.entries(PREFERENCE_FIELDS).flatMap(([group, fields]) => fields.map(field => `${group}.${field}`)),
  ...Object.entries(MODEL_FEATURE_FIELDS).flatMap(([group, fields]) => fields.map(field => `models.${group}.${field}`)),
  ...Object.keys(DEFAULT_BACKGROUND_SETTINGS).map(field => `mainBackground.${field}`),
  ...SHELL_INTEGRATION_FEATURES.map(field => `shellIntegration.${field}`),
  ...SHORTCUT_TRANSACTION_FIELDS.map(field => `shortcuts.${field}`),
])

export class SettingsTransactionSchemaError extends Error {
  readonly code = 'SETTINGS_TRANSACTION_INVALID_METADATA'
  constructor() { super('Settings transaction metadata is invalid'); this.name = 'SettingsTransactionSchemaError' }
}

export function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  // Accessors are not data. Reject them before any inspection can invoke user code.
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && descriptor !== undefined && Object.hasOwn(descriptor, 'value')
  })
}

export function hasSettingsKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return isSettingsRecord(value) && required.every(key => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key)))
}

export function isSettingsRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isSettingsField(field: string): boolean { return allowedFields.has(field) }
export function settingsValuesEqual(left: unknown, right: unknown): boolean { return isDeepStrictEqual(left, right) }

export function emptySettingsTransactionMetadata(): SettingsTransactionMetadata {
  return { version: 1, revision: 0, minimumBaseRevision: 0, fieldRevisions: { fields: {}, connections: {}, tombstones: {} } }
}

/** Missing metadata denotes a legacy file. Malformed metadata must never reset to revision zero. */
export function parseSettingsTransactionMetadata(value: unknown, settings: AppSettings): SettingsTransactionMetadata {
  if (value === undefined) return emptySettingsTransactionMetadata()
  const invalid = (): never => { throw new SettingsTransactionSchemaError() }
  if (!hasSettingsKeys(value, ['version', 'revision', 'minimumBaseRevision', 'fieldRevisions'])
    || value.version !== 1 || !isSettingsRevision(value.revision)
    || !isSettingsRevision(value.minimumBaseRevision) || value.minimumBaseRevision > value.revision
    || !hasSettingsKeys(value.fieldRevisions, ['fields', 'connections', 'tombstones'])) return invalid()
  const revision = value.revision
  const { fields, connections, tombstones } = value.fieldRevisions
  if (!isSettingsRecord(fields) || !isSettingsRecord(connections) || !isSettingsRecord(tombstones)
    || Object.keys(fields).length > allowedFields.size
    || Object.keys(connections).length > MODEL_CONNECTION_LIMIT
    || Object.keys(tombstones).length > SETTINGS_TRANSACTION_TOMBSTONE_LIMIT) return invalid()
  const validRevision = (candidate: unknown): candidate is number => isSettingsRevision(candidate) && candidate <= revision
  for (const [field, fieldRevision] of Object.entries(fields)) {
    if (!allowedFields.has(field) || !validRevision(fieldRevision)) return invalid()
  }
  const activeIds = new Set(settings.models?.connections.map(connection => connection.id) ?? [])
  for (const [id, revisions] of Object.entries(connections)) {
    if (!isCanonicalModelConnectionId(id) || !activeIds.has(id) || !isSettingsRecord(revisions)
      || !Object.keys(revisions).length
      || Object.entries(revisions).some(([field, fieldRevision]) =>
        !CONNECTION_REVISION_FIELDS.includes(field as ConnectionRevisionField) || !validRevision(fieldRevision))
      || !validRevision(revisions.entity)
      || Object.values(revisions).some(fieldRevision => (fieldRevision as number) > (revisions.entity as number))) return invalid()
  }
  for (const [id, deletedRevision] of Object.entries(tombstones)) {
    if (!isCanonicalModelConnectionId(id) || activeIds.has(id) || !validRevision(deletedRevision) || deletedRevision === 0) return invalid()
  }
  return structuredClone(value) as unknown as SettingsTransactionMetadata
}

export function createSettingsTransactionSnapshot(settings: AppSettings, metadata?: unknown): SettingsTransactionSnapshot {
  const parsed = parseSettingsTransactionMetadata(metadata, settings)
  return { settings: structuredClone(settings), revision: parsed.revision,
    minimumBaseRevision: parsed.minimumBaseRevision, fieldRevisions: parsed.fieldRevisions }
}

export function settingsTransactionMetadata(snapshot: SettingsTransactionSnapshot): SettingsTransactionMetadata {
  return parseSettingsTransactionMetadata({ version: 1, revision: snapshot.revision,
    minimumBaseRevision: snapshot.minimumBaseRevision, fieldRevisions: snapshot.fieldRevisions }, snapshot.settings)
}

/** Reclamation and the watermark must be serialized in the same settings replacement. */
export function pruneSettingsTombstones(metadata: SettingsTransactionMetadata): void {
  const ordered = Object.entries(metadata.fieldRevisions.tombstones).sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
  for (const [id, revision] of ordered.slice(0, Math.max(0, ordered.length - SETTINGS_TRANSACTION_TOMBSTONE_LIMIT))) {
    delete metadata.fieldRevisions.tombstones[id]
    metadata.minimumBaseRevision = Math.max(metadata.minimumBaseRevision, revision)
  }
}

const preferenceDefaults: SettingsPreferenceGroups = {
  search: DEFAULT_BROWSER_SEARCH, appearance: DEFAULT_EDITOR_APPEARANCE,
  layout: DEFAULT_LAYOUT_PREFERENCES, stickyNotes: DEFAULT_STICKY_NOTE_PREFERENCES,
  desktopLifecycle: DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES,
}

export function preferenceValue<G extends SettingsPreferenceGroup>(settings: AppSettings, group: G): SettingsPreferenceGroups[G] {
  return structuredClone(settings[group] ?? preferenceDefaults[group]) as SettingsPreferenceGroups[G]
}

export function parseTransactionPreference(group: SettingsPreferenceGroup, value: unknown): unknown {
  switch (group) {
    case 'search': return parseBrowserSearchPreferences(value)
    case 'appearance': return parseCompleteEditorAppearancePreferences(value)
    case 'layout': return parseCompleteLayoutPreferences(value)
    case 'stickyNotes': return parseStickyNotePreferences(value)
    case 'desktopLifecycle': return parseDesktopLifecyclePreferences(value)
  }
}

export function connectionFieldRevision(revisions: SettingsFieldRevisions, id: string, field: ConnectionRevisionField): number {
  return revisions.connections[id]?.[field] ?? 0
}
