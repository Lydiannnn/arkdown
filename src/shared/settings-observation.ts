import { isCanonicalModelConnectionId, MODEL_CONNECTION_LIMIT, parseLargeModelSettings, type LargeModelSettings, type ModelConnectionSummary } from './large-model-settings'

export const OBSERVED_CONNECTION_FIELDS = [
  'name', 'provider', 'accessType', 'protocol', 'baseUrl', 'modelId', 'apiKeyHint',
  'status', 'lastTestedAt', 'capabilityOverride',
] as const satisfies readonly (keyof ModelConnectionSummary)[]
export type ObservedConnectionField = typeof OBSERVED_CONNECTION_FIELDS[number] | 'entity' | 'credential'
export const OBSERVED_MODEL_FIELDS = [
  'models.codexCli', 'models.selectionTranslation.privacyNoticeAccepted',
  'models.selectionTranslation.connectionId', 'models.selectionTranslation.thinkingMode', 'models.selectionTranslation.reasoningEffort', 'models.selectionTranslation.targetLanguage',
  'models.screenshotTranslation.connectionId', 'models.screenshotTranslation.thinkingMode', 'models.screenshotTranslation.reasoningEffort', 'models.screenshotTranslation.targetLanguage',
  'models.floatingTranslation.connectionId', 'models.floatingTranslation.thinkingMode', 'models.floatingTranslation.reasoningEffort', 'models.floatingTranslation.target',
  'models.aiConversation.connectionId', 'models.aiConversation.thinkingMode', 'models.aiConversation.reasoningEffort', 'models.aiConversation.writePolicy',
] as const
export type ObservedModelField = typeof OBSERVED_MODEL_FIELDS[number]

/** Values and revisions are one immutable UI observation; submit this complete pair with an edit. */
export interface PublicModelSettingsSnapshot {
  settings: LargeModelSettings
  observation: {
    version: 1
    revision: number
    minimumBaseRevision: number
    fields: Partial<Record<ObservedModelField, number>>
    connections: Record<string, Partial<Record<ObservedConnectionField, number>> & { entity: number }>
  }
}
export type PublicSettingsConflictReason = 'future-revision' | 'snapshot-too-old' | 'field-changed' | 'connection-exists' | 'connection-missing'
export type PublicModelSettingsConflict = { kind: 'field'; field: ObservedModelField }
  | { kind: 'connection'; id: string; field: ObservedConnectionField | 'presence' }
export type PublicModelMutationResult = { status: 'committed' | 'unchanged'; snapshot: PublicModelSettingsSnapshot }
  | { status: 'conflict'; snapshot: PublicModelSettingsSnapshot; reason: PublicSettingsConflictReason; conflicts: PublicModelSettingsConflict[] }

export function isObservationRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string' && descriptor !== undefined && Object.hasOwn(descriptor, 'value')
  })
}
export function hasObservationKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return isObservationRecord(value) && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
export function isObservationRevision(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

export function parsePublicModelSettingsSnapshot(value: unknown): PublicModelSettingsSnapshot | undefined {
  if (!hasObservationKeys(value, ['settings', 'observation'])) return undefined
  const settings = parseLargeModelSettings(value.settings)
  const observed = value.observation
  if (!settings || !hasObservationKeys(observed, ['version', 'revision', 'minimumBaseRevision', 'fields', 'connections'])
    || observed.version !== 1 || !isObservationRevision(observed.revision)
    || !isObservationRevision(observed.minimumBaseRevision, observed.revision)
    || !isObservationRecord(observed.fields) || !isObservationRecord(observed.connections)) return undefined
  const revision = observed.revision
  if (Object.keys(observed.fields).length > OBSERVED_MODEL_FIELDS.length
    || Object.entries(observed.fields).some(([key, entry]) => !OBSERVED_MODEL_FIELDS.includes(key as ObservedModelField) || !isObservationRevision(entry, revision))) return undefined
  const ids = new Set(settings.connections.map(connection => connection.id))
  const rows = Object.entries(observed.connections)
  if (rows.length > MODEL_CONNECTION_LIMIT || rows.length !== ids.size) return undefined
  for (const [id, fields] of rows) {
    if (!isCanonicalModelConnectionId(id) || !ids.has(id)
      || !hasObservationKeys(fields, ['entity'], [...OBSERVED_CONNECTION_FIELDS, 'credential'])
      || !isObservationRevision(fields.entity, revision)
      || Object.values(fields).some(entry => !isObservationRevision(entry, fields.entity as number))) return undefined
  }
  return structuredClone({ settings, observation: observed }) as unknown as PublicModelSettingsSnapshot
}
