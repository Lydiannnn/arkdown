import type { LargeModelSettings } from '../../src/shared/large-model-settings'
import type { PublicModelSettingsSnapshot, PublicModelMutationResult } from '../../src/shared/settings-observation'

export function modelObservation(settings: LargeModelSettings, revision = 1): PublicModelSettingsSnapshot {
  return { settings: structuredClone(settings), observation: { version: 1, revision, minimumBaseRevision: 0, fields: {},
    connections: Object.fromEntries(settings.connections.map(connection => [connection.id, { entity: 0 }])) } }
}

export function modelCommit(settings: LargeModelSettings, revision = 2): PublicModelMutationResult {
  return { status: 'committed', snapshot: modelObservation(settings, revision) }
}
