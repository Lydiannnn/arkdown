import { describe, expect, it } from 'vitest'
import { DEFAULT_LARGE_MODEL_SETTINGS, type ModelConnectionSummary } from '../../src/shared/large-model-settings'
import { createSettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-schema'
import { reduceSettingsTransaction } from '../../src/main/settings/settings-transaction-reducer'
import type { SettingsTransactionRequest, SettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-types'
import * as adapter from '../../src/main/settings/settings-command-adapter'

const id = '550e8400-e29b-41d4-a716-446655440000'
const connection: ModelConnectionSummary = { id, name: 'Original', provider: 'other', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://example.com/v1', modelId: 'synthetic', apiKeyHint: '••••test', status: 'untested', lastTestedAt: null, capabilityOverride: null }
const initial = () => createSettingsTransactionSnapshot({ lastWorkspace: null, models: { ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), connections: [{ ...connection }] } })
function observe(source = initial()) {
  return adapter.observeModelSettings(source)
}
function committed(source: SettingsTransactionSnapshot, request: SettingsTransactionRequest) {
  const result = reduceSettingsTransaction(source, request)
  expect(result.status).toBe('prepared')
  if (result.status !== 'prepared') throw new Error('Fixture transaction failed')
  return result.snapshot
}

describe('model commands retain the actual edited observation', () => {
  it('exports only finite model observations, including zero-revision legacy connection rows', () => {
    const source = initial()
    source.fieldRevisions.fields.lastWorkspace = 0
    const observed = observe(source)
    expect(observed.settings.connections).toEqual([connection])
    expect(observed.observation.connections[id]).toEqual({ entity: 0 })
    expect(observed.observation.fields).toEqual({})
  })

  it('preserves a concurrent name edit when the retained form only changed its endpoint', () => {
    const original = initial()
    const observed = observe(original)
    const latest = committed(original, { baseRevision: 0, operations: [{ kind: 'model-connection.patch', id, changes: { name: { value: 'Remote name', expected: { value: 'Original', revision: 0 } } } }] })
    const request = adapter.connectionEditRequest(observed, { ...connection, baseUrl: 'https://candidate.example/v1', status: 'connected', lastTestedAt: '2026-10-04T00:00:00.000Z' })
    const result = committed(latest, request)
    expect(result.settings.models!.connections[0]).toMatchObject({ name: 'Remote name', baseUrl: 'https://candidate.example/v1' })
    const operation = request.operations[0]
    if (operation?.kind !== 'model-connection.patch') throw new Error('Expected finite connection patch')
    expect(operation.changes).not.toHaveProperty('name')
  })

  it('conflicts after endpoint ABA even when a later main snapshot was read', () => {
    const original = initial()
    const observed = observe(original)
    const changed = committed(original, adapter.connectionEditRequest(observed, { ...connection, baseUrl: 'https://remote.example/v1' }))
    const restored = committed(changed, adapter.connectionEditRequest(observe(changed), connection))
    observe(restored)
    const retainedEdit = adapter.connectionEditRequest(observed, { ...connection, name: 'Retained draft' })
    expect(reduceSettingsTransaction(restored, retainedEdit)).toMatchObject({ status: 'conflict', fields: [{ kind: 'connection', id, field: 'baseUrl' }] })
  })

  it('records only test status/time and guards the exact credential generation that was tested', () => {
    const original = initial()
    const observed = observe(original)
    const latest = committed(original, adapter.connectionEditRequest(observed, connection, true))
    const request = adapter.connectionTestRequest(observed, id, 'connected', '2026-10-04T00:00:00.000Z')
    const operation = request.operations[0]
    if (operation?.kind !== 'model-connection.record-test') throw new Error('Expected finite test record')
    expect(Object.keys(operation.changes)).toEqual(['status', 'lastTestedAt'])
    expect(reduceSettingsTransaction(latest, request)).toMatchObject({ status: 'conflict', fields: [{ kind: 'connection', id, field: 'credential' }] })
  })

  it('does not rebase a retained feature patch over a remote change to that field', () => {
    const original = initial()
    const observed = observe(original)
    const latest = committed(original, adapter.modelFeatureRequest(observed, 'aiConversation', { writePolicy: 'workspace-grant' }))
    expect(reduceSettingsTransaction(latest, adapter.modelFeatureRequest(observed, 'aiConversation', { writePolicy: 'document-grant' }))).toMatchObject({ status: 'conflict' })
    expect(committed(latest, adapter.modelFeatureRequest(observed, 'selectionTranslation', { targetLanguage: 'en' })).settings.models!.aiConversation.writePolicy).toBe('workspace-grant')
  })

  it('requires the observed stable ID for removal and never turns a missing edit into add', () => {
    const original = initial()
    const observed = observe(original)
    const removed = committed(original, adapter.connectionRemoveRequest(observed, id))
    expect(reduceSettingsTransaction(removed, adapter.connectionEditRequest(observed, { ...connection, name: 'Late' }))).toMatchObject({ status: 'conflict', reason: 'connection-missing' })
    expect(() => adapter.connectionEditRequest(observe(removed), connection)).toThrow('SETTINGS_OBSERVATION_CONNECTION_MISSING')
  })
})
