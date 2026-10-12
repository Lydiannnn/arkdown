import {
  codexCliModelConnectionId, DEFAULT_FLOATING_TRANSLATION_SETTINGS, DEFAULT_LARGE_MODEL_SETTINGS,
  isCanonicalModelConnectionId, isCodexCliConnectionId, parseCodexCliConnectionSummary,
  parseFloatingTranslationSettings, parseLargeModelSettings, parseModelConnectionSummary,
  type LargeModelSettings, type ModelConnectionSummary,
} from '../../shared/large-model-settings'
import { SettingsTransactionDraft } from './settings-transaction-draft'
import {
  CONNECTION_FIELDS, CONNECTION_TEST_FIELDS, hasSettingsKeys, isSettingsRevision,
  MODEL_FEATURE_FIELDS, settingsValuesEqual,
} from './settings-transaction-schema'
import type { ConnectionField, ModelFeature } from './settings-transaction-types'
import { normalizeReasoningEffort } from '../../shared/model-provider-presets'

function models(draft: SettingsTransactionDraft, original = false): LargeModelSettings {
  const value = (original ? draft.latest : draft.next).settings.models
  const parsed = value === undefined ? structuredClone(DEFAULT_LARGE_MODEL_SETTINGS) : parseLargeModelSettings(value)
  if (!parsed) draft.invalid('invalid-value')
  return parsed
}

function saveModels(draft: SettingsTransactionDraft, value: LargeModelSettings): void {
  const parsed = parseLargeModelSettings(value)
  if (!parsed || !settingsValuesEqual(parsed, value)) draft.invalid('invalid-value')
  if (!settingsValuesEqual(value, models(draft))) draft.next.settings.models = parsed
}

function requireConnection(draft: SettingsTransactionDraft, id: unknown): ModelConnectionSummary {
  if (typeof id !== 'string' || !isCanonicalModelConnectionId(id)) draft.invalid()
  draft.beginConnectionOperation(id)
  const connection = models(draft, true).connections.find(item => item.id === id)
  if (!connection) draft.conflict([{ kind: 'connection', id, field: 'presence' }], 'connection-missing')
  return connection
}

function checkTestInputs(draft: SettingsTransactionDraft, connection: ModelConnectionSummary, expected: unknown): void {
  if (!hasSettingsKeys(expected, [...CONNECTION_TEST_FIELDS, 'credentialRevision'])) draft.invalid()
  for (const field of CONNECTION_TEST_FIELDS) draft.checkConnectionField(connection.id, field, expected[field], connection[field])
  draft.checkCredential(connection.id, expected.credentialRevision)
}

function clearBindings(draft: SettingsTransactionDraft, value: LargeModelSettings, matches: (id: string) => boolean): void {
  for (const feature of Object.keys(MODEL_FEATURE_FIELDS) as ModelFeature[]) {
    const binding = value[feature]
    if (binding?.connectionId && matches(binding.connectionId)) {
      draft.writeField(`models.${feature}.connectionId`, binding.connectionId, null, () => { binding.connectionId = null })
    }
  }
}

function addConnection(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  if (!hasSettingsKeys(operation, ['kind', 'connection', 'expectedAbsentRevision'])) draft.invalid()
  const connection = parseModelConnectionSummary(operation.connection)
  if (!connection || !settingsValuesEqual(connection, operation.connection)
    || !isSettingsRevision(operation.expectedAbsentRevision) || operation.expectedAbsentRevision > draft.baseRevision) draft.invalid()
  const { id } = connection
  draft.beginConnectionOperation(id)
  const value = models(draft)
  if (value.connections.some(item => item.id === id)) draft.conflict([{ kind: 'connection', id, field: 'presence' }], 'connection-exists')
  if ((draft.latest.fieldRevisions.tombstones[id] ?? 0) !== operation.expectedAbsentRevision) {
    draft.conflict([{ kind: 'connection', id, field: 'presence' }])
  }
  draft.changeCredential({ id, kind: 'add' })
  for (const field of CONNECTION_FIELDS) draft.touchConnection(id, field)
  value.connections.push(connection)
  saveModels(draft, value)
}

function patchConnection(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  const recordTest = operation.kind === 'model-connection.record-test'
  if (!hasSettingsKeys(operation, ['kind', 'id', 'changes', ...(recordTest ? ['testedInputs'] : [])],
    recordTest ? [] : ['testedInputs', 'credential'])) draft.invalid()
  const connection = requireConnection(draft, operation.id)
  const id = connection.id
  if (Object.hasOwn(operation, 'testedInputs') && operation.testedInputs !== undefined) checkTestInputs(draft, connection, operation.testedInputs)
  if (recordTest && operation.testedInputs === undefined) draft.invalid()
  if (operation.credential !== undefined) {
    if (!hasSettingsKeys(operation.credential, ['kind', 'expectedRevision']) || operation.credential.kind !== 'replace') draft.invalid()
    draft.checkCredential(id, operation.credential.expectedRevision)
    draft.changeCredential({ id, kind: 'replace' })
  }
  const allowed = recordTest ? ['status', 'lastTestedAt'] : CONNECTION_FIELDS.filter(field => field !== 'accessType')
  const value = models(draft)
  const current = value.connections.find(item => item.id === id)!
  const next = draft.patch(operation.changes, allowed, current as unknown as Record<string, unknown>,
    (field, expected) => draft.checkConnectionField(id, field as ConnectionField, expected, connection[field as ConnectionField]),
    (field, before, after, apply) => {
      draft.claim(`connection:${id}:${field}`)
      if (settingsValuesEqual(before, after)) return
      if (field === 'apiKeyHint' && operation.credential === undefined) draft.invalid('invalid-value')
      // Test state and execution inputs must remain paired with the credential generation read before testing.
      if ((recordTest || CONNECTION_TEST_FIELDS.includes(field as typeof CONNECTION_TEST_FIELDS[number])
        || field === 'status' || field === 'lastTestedAt') && operation.testedInputs === undefined) draft.invalid()
      apply()
      draft.touchConnection(id, field as ConnectionField)
    })
  if (operation.credential !== undefined && operation.testedInputs === undefined) draft.invalid()
  const parsed = parseModelConnectionSummary(next)
  if (!parsed || !settingsValuesEqual(next, parsed)) draft.invalid('invalid-value')
  value.connections = value.connections.map(item => item.id === id ? parsed : item)
  // Derived model compatibility follows the latest bindings, including bindings added during a probe.
  // Only an actual execution-input change may rewrite this dependent preference.
  if (!recordTest && CONNECTION_TEST_FIELDS.some(field => !settingsValuesEqual(connection[field], parsed[field]))) {
    for (const feature of Object.keys(MODEL_FEATURE_FIELDS) as ModelFeature[]) {
      const binding = value[feature]
      if (binding?.connectionId !== id) continue
      const effort = normalizeReasoningEffort(parsed, binding.reasoningEffort)
      if (effort !== binding.reasoningEffort) draft.writeField(`models.${feature}.reasoningEffort`, binding.reasoningEffort, effort,
        () => { binding.reasoningEffort = effort })
    }
  }
  saveModels(draft, value)
}

function removeConnection(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  if (!hasSettingsKeys(operation, ['kind', 'id', 'expected', 'expectedCredentialRevision'])) draft.invalid()
  const connection = requireConnection(draft, operation.id)
  const id = connection.id
  draft.checkConnectionField(id, 'entity', operation.expected, connection)
  draft.checkCredential(id, operation.expectedCredentialRevision)
  draft.changeCredential({ id, kind: 'remove' })
  draft.removedConnections.add(id)
  const value = models(draft)
  value.connections = value.connections.filter(item => item.id !== id)
  clearBindings(draft, value, candidate => candidate === id)
  saveModels(draft, value)
}

function patchFeature(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  if (!hasSettingsKeys(operation, ['kind', 'feature', 'changes']) || typeof operation.feature !== 'string'
    || !Object.hasOwn(MODEL_FEATURE_FIELDS, operation.feature)) draft.invalid()
  const feature = operation.feature as ModelFeature
  const value = models(draft)
  const current = value[feature] ?? structuredClone(DEFAULT_FLOATING_TRANSLATION_SETTINGS)
  const original = models(draft, true)[feature] ?? DEFAULT_FLOATING_TRANSLATION_SETTINGS
  const next = draft.patch(operation.changes, MODEL_FEATURE_FIELDS[feature], current as unknown as Record<string, unknown>,
    (field, expected) => draft.checkField(`models.${feature}.${field}`, expected, (original as unknown as Record<string, unknown>)[field]),
    (field, before, after, apply) => draft.writeField(`models.${feature}.${field}`, before, after, apply))
  if (settingsValuesEqual(current, next)) return
  // The whole candidate schema also checks that the selected stable ID exists in the latest catalog.
  const candidate = { ...value, [feature]: next }
  saveModels(draft, candidate as LargeModelSettings)
}

function updateCodex(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  const removing = operation.kind === 'codex-cli.remove'
  if (!hasSettingsKeys(operation, ['kind', 'expected', ...(removing ? [] : ['value'])])) draft.invalid()
  const value = models(draft)
  draft.checkField('models.codexCli', operation.expected, models(draft, true).codexCli)
  let next = removing ? null : parseCodexCliConnectionSummary(operation.value)
  if (next === undefined || (!removing && !settingsValuesEqual(next, operation.value))) draft.invalid('invalid-value')
  if (next?.models) {
    const referenced = new Set(Object.keys(MODEL_FEATURE_FIELDS).map(feature => value[feature as ModelFeature]?.connectionId))
    next = { ...next, models: [...next.models, ...(value.codexCli?.models ?? [])
      .filter(previous => !next!.models!.some(item => item.modelId === previous.modelId)
        && referenced.has(codexCliModelConnectionId(previous.modelId)))
      .map(previous => ({ ...previous, isDefault: false, unavailable: true as const }))] }
  } else if (next && value.codexCli?.models) {
    next = { ...next, models: structuredClone(value.codexCli.models) }
  }
  draft.writeField('models.codexCli', value.codexCli, next, () => { value.codexCli = next! })
  if (removing) clearBindings(draft, value, isCodexCliConnectionId)
  saveModels(draft, value)
}

function migrateFloating(draft: SettingsTransactionDraft, operation: Record<string, unknown>): void {
  if (!hasSettingsKeys(operation, ['kind'], ['legacy'])) draft.invalid()
  const legacy = operation.legacy === undefined ? undefined : parseFloatingTranslationSettings(operation.legacy)
  if (operation.legacy !== undefined && (!legacy || !settingsValuesEqual(legacy, operation.legacy))) draft.invalid('invalid-value')
  if (draft.next.settings.models === undefined && legacy === undefined) return
  const value = models(draft)
  const current = value.floatingTranslation
  if (current && Object.hasOwn(current, 'target')) return
  let next = { ...(current ?? legacy ?? DEFAULT_FLOATING_TRANSLATION_SETTINGS), target: legacy?.target ?? 'auto' }
  // Invalid legacy bindings cannot overwrite a valid current catalog; retain only its safe default/target.
  if (!current && !parseLargeModelSettings({ ...value, floatingTranslation: next })) {
    next = { ...DEFAULT_FLOATING_TRANSLATION_SETTINGS, target: legacy?.target ?? 'auto' }
  }
  for (const field of MODEL_FEATURE_FIELDS.floatingTranslation) {
    draft.writeField(`models.floatingTranslation.${field}`, current?.[field], next[field], () => undefined)
  }
  value.floatingTranslation = next
  saveModels(draft, value)
}

/** Returns false for operations belonging to the ordinary preference reducer. */
export function reduceModelSettingsOperation(draft: SettingsTransactionDraft, operation: Record<string, unknown>): boolean {
  switch (operation.kind) {
    case 'model-connection.add': addConnection(draft, operation); return true
    case 'model-connection.patch':
    case 'model-connection.record-test': patchConnection(draft, operation); return true
    case 'model-connection.remove': removeConnection(draft, operation); return true
    case 'model-feature.patch': patchFeature(draft, operation); return true
    case 'codex-cli.record-test':
    case 'codex-cli.remove': updateCodex(draft, operation); return true
    case 'migration.floating-translation': migrateFloating(draft, operation); return true
    case 'translation-privacy.accept': {
      if (!hasSettingsKeys(operation, ['kind'])) draft.invalid()
      const value = models(draft)
      draft.writeField('models.selectionTranslation.privacyNoticeAccepted', value.selectionTranslation.privacyNoticeAccepted, true,
        () => { value.selectionTranslation.privacyNoticeAccepted = true })
      saveModels(draft, value)
      return true
    }
    default: return false
  }
}
