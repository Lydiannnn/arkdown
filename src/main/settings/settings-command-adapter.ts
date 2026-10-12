import { DEFAULT_FLOATING_TRANSLATION_SETTINGS, DEFAULT_LARGE_MODEL_SETTINGS, featureModelConnections, parseModelConnectionSummary, type ModelConnectionStatus, type ModelConnectionSummary } from '../../shared/large-model-settings'
import { OBSERVED_MODEL_FIELDS, parsePublicModelSettingsSnapshot, type ObservedModelField, type PublicModelSettingsSnapshot, type PublicModelMutationResult, type PublicModelSettingsConflict } from '../../shared/settings-observation'
import { CONNECTION_FIELDS, CONNECTION_TEST_FIELDS, hasSettingsKeys, MODEL_FEATURE_FIELDS, settingsValuesEqual } from './settings-transaction-schema'
import type { CheckedSettingsPatch, ExpectedModelTestInputs, ModelFeature, ModelFeatureGroups, SettingsTransactionOperation, SettingsTransactionRequest, SettingsTransactionSnapshot } from './settings-transaction-types'
import type { SettingsStorageResult } from './settings-transaction-store'

/** Model IPC carries only its finite public fields, never the storage snapshot or cleanup paths. */
export function publicModelMutation(result: SettingsStorageResult): PublicModelMutationResult {
  if (result.status === 'invalid') throw new Error('SETTINGS_COMMAND_INVALID')
  const snapshot = observeModelSettings(result.snapshot)
  if (result.status !== 'conflict') return { status: result.status, snapshot }
  const conflicts: PublicModelSettingsConflict[] = result.fields.map(field => {
    if (field.kind === 'connection') return { ...field }
    if (!OBSERVED_MODEL_FIELDS.includes(field.field as ObservedModelField)) throw new Error('SETTINGS_COMMAND_INVALID')
    return { kind: 'field', field: field.field as ObservedModelField }
  })
  return { status: 'conflict', snapshot, reason: result.reason, conflicts }
}

/** Publish only model values and their finite revisions, never a storage snapshot or credential. */
export function observeModelSettings(snapshot: SettingsTransactionSnapshot): PublicModelSettingsSnapshot {
  const settings = structuredClone(snapshot.settings.models ?? DEFAULT_LARGE_MODEL_SETTINGS)
  const value = {
    settings,
    observation: {
      version: 1, revision: snapshot.revision, minimumBaseRevision: snapshot.minimumBaseRevision,
      fields: Object.fromEntries(OBSERVED_MODEL_FIELDS.filter(field => Object.hasOwn(snapshot.fieldRevisions.fields, field))
        .map(field => [field, snapshot.fieldRevisions.fields[field]])),
      connections: Object.fromEntries(settings.connections.map(connection => [connection.id,
        structuredClone(snapshot.fieldRevisions.connections[connection.id] ?? { entity: 0 })])),
    },
  }
  return requireModelObservation(value)
}

export function requireModelObservation(value: unknown): PublicModelSettingsSnapshot {
  const parsed = parsePublicModelSettingsSnapshot(value)
  if (!parsed) throw new Error('SETTINGS_OBSERVATION_INVALID')
  return parsed
}

function observedConnection(observed: PublicModelSettingsSnapshot, id: string): ModelConnectionSummary {
  const connection = observed.settings.connections.find(item => item.id === id)
  if (!connection) throw new Error('SETTINGS_OBSERVATION_CONNECTION_MISSING')
  return connection
}

export function observedModelTestInputs(observed: PublicModelSettingsSnapshot, id: string): ExpectedModelTestInputs {
  const connection = observedConnection(observed, id)
  const revisions = observed.observation.connections[id]!
  return {
    ...Object.fromEntries(CONNECTION_TEST_FIELDS.map(field => [field, { value: structuredClone(connection[field]), revision: revisions[field] ?? 0 }])),
    credentialRevision: revisions.credential ?? 0,
  } as ExpectedModelTestInputs
}

/** Candidate is the explicitly edited/probed summary. Unchanged form fields are never written back. */
export function connectionEditRequest(observation: PublicModelSettingsSnapshot, candidate: ModelConnectionSummary,
  replaceCredential = false): SettingsTransactionRequest {
  const observed = requireModelObservation(observation)
  const parsed = parseModelConnectionSummary(candidate)
  if (!parsed || !settingsValuesEqual(parsed, candidate)) throw new Error('SETTINGS_COMMAND_INVALID')
  const original = observedConnection(observed, parsed.id)
  const revisions = observed.observation.connections[parsed.id]!
  const changes = Object.fromEntries(CONNECTION_FIELDS.filter(field => !settingsValuesEqual(parsed[field], original[field]))
    .map(field => [field, { value: parsed[field], expected: { value: original[field], revision: revisions[field] ?? 0 } }])) as CheckedSettingsPatch<Omit<ModelConnectionSummary, 'id'>>
  return {
    baseRevision: observed.observation.revision,
    operations: [{ kind: 'model-connection.patch', id: parsed.id, changes,
      testedInputs: observedModelTestInputs(observed, parsed.id),
      ...(replaceCredential ? { credential: { kind: 'replace' as const, expectedRevision: revisions.credential ?? 0 } } : {}),
    }],
  }
}

export function connectionTestRequest(observation: PublicModelSettingsSnapshot, id: string,
  status: ModelConnectionStatus, testedAt: string): SettingsTransactionRequest {
  const observed = requireModelObservation(observation)
  const original = observedConnection(observed, id)
  const revisions = observed.observation.connections[id]!
  return { baseRevision: observed.observation.revision, operations: [{ kind: 'model-connection.record-test', id,
    testedInputs: observedModelTestInputs(observed, id),
    changes: {
      status: { value: status, expected: { value: original.status, revision: revisions.status ?? 0 } },
      lastTestedAt: { value: testedAt, expected: { value: original.lastTestedAt, revision: revisions.lastTestedAt ?? 0 } },
    },
  }] }
}

export function connectionRemoveRequest(observation: PublicModelSettingsSnapshot, id: string): SettingsTransactionRequest {
  const observed = requireModelObservation(observation)
  const connection = observedConnection(observed, id)
  const revisions = observed.observation.connections[id]!
  return { baseRevision: observed.observation.revision, operations: [{ kind: 'model-connection.remove', id,
    expected: { value: connection, revision: revisions.entity }, expectedCredentialRevision: revisions.credential ?? 0,
  }] }
}

export function modelFeatureRequest<F extends ModelFeature>(observation: PublicModelSettingsSnapshot,
  feature: F, patch: Partial<ModelFeatureGroups[F]>): SettingsTransactionRequest {
  const observed = requireModelObservation(observation)
  if (!Object.hasOwn(MODEL_FEATURE_FIELDS, feature) || !hasSettingsKeys(patch, [], MODEL_FEATURE_FIELDS[feature])) throw new Error('SETTINGS_COMMAND_INVALID')
  const original = (observed.settings[feature] ?? DEFAULT_FLOATING_TRANSLATION_SETTINGS) as unknown as Record<string, unknown>
  const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined).map(([field, value]) => [field, {
    value: structuredClone(value), expected: { value: structuredClone(original[field]),
      revision: observed.observation.fields[`models.${feature}.${field}` as ObservedModelField] ?? 0 },
  }]))
  // The feature and every key were checked against their specific fixed schema above.
  const operation = { kind: 'model-feature.patch', feature, changes } as SettingsTransactionOperation
  return { baseRevision: observed.observation.revision, operations: [operation] }
}

export type ModelExecutionTarget = { connectionId: string } | { feature: ModelFeature }

/** Read-only reduction guards. A successful check must be unchanged; it never commits a test result. */
export function modelExecutionGuardRequest(observation: PublicModelSettingsSnapshot, target: ModelExecutionTarget): SettingsTransactionRequest {
  const observed = requireModelObservation(observation)
  const operations: SettingsTransactionOperation[] = []
  let id: string | null
  if (hasSettingsKeys(target, ['feature']) && 'feature' in target && Object.hasOwn(MODEL_FEATURE_FIELDS, target.feature)) {
    const original = (observed.settings[target.feature] ?? DEFAULT_FLOATING_TRANSLATION_SETTINGS) as unknown as Record<string, unknown>
    id = original.connectionId as string | null
    const fields = Object.fromEntries(MODEL_FEATURE_FIELDS[target.feature].map(field => [field, original[field]]))
    operations.push(...modelFeatureRequest(observed, target.feature, fields).operations)
  } else if (hasSettingsKeys(target, ['connectionId']) && 'connectionId' in target && typeof target.connectionId === 'string') id = target.connectionId
  else throw new Error('SETTINGS_COMMAND_INVALID')
  const connection = featureModelConnections(observed.settings).find(item => item.id === id)
  if (!connection) throw new Error('SETTINGS_OBSERVATION_CONNECTION_MISSING')
  if (connection.accessType === 'codex-cli') {
    if (!observed.settings.codexCli) throw new Error('SETTINGS_OBSERVATION_CONNECTION_MISSING')
    operations.push({ kind: 'codex-cli.record-test', value: observed.settings.codexCli,
      expected: { value: observed.settings.codexCli, revision: observed.observation.fields['models.codexCli'] ?? 0 } })
  } else operations.push({ kind: 'model-connection.record-test', id: connection.id, changes: {}, testedInputs: observedModelTestInputs(observed, connection.id) })
  return { baseRevision: observed.observation.revision, operations }
}
