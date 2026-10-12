import { describe, expect, it } from 'vitest'
import { DEFAULT_LARGE_MODEL_SETTINGS, type ModelConnectionSummary } from '../../src/shared/large-model-settings'
import {
  createSettingsTransactionSnapshot, emptySettingsTransactionMetadata,
  parseSettingsTransactionMetadata, SETTINGS_TRANSACTION_TOMBSTONE_LIMIT,
  settingsTransactionMetadata, SettingsTransactionSchemaError,
} from '../../src/main/settings/settings-transaction-schema'
import { reduceSettingsTransaction } from '../../src/main/settings/settings-transaction-reducer'
import type { SettingsTransactionRequest } from '../../src/main/settings/settings-transaction-types'

const id = (index = 0) => `550e8400-e29b-41d4-a716-${index.toString(16).padStart(12, '0')}`
const connection: ModelConnectionSummary = {
  id: id(), name: 'Synthetic', provider: 'other', accessType: 'standard-api', protocol: 'openai',
  baseUrl: 'https://api.example.com', modelId: 'synthetic', apiKeyHint: '••••test',
  status: 'untested', lastTestedAt: null, capabilityOverride: null,
}
const settings = { lastWorkspace: null, models: { ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), connections: [connection] } }

describe('settings transaction metadata', () => {
  it('accepts missing legacy metadata only as revision zero and clones the supplied settings', () => {
    const initial = createSettingsTransactionSnapshot(settings)
    expect(initial.revision).toBe(0)
    expect(initial.minimumBaseRevision).toBe(0)
    expect(initial.fieldRevisions).toEqual({ fields: {}, connections: {}, tombstones: {} })
    initial.settings.models!.connections[0]!.name = 'Changed copy'
    expect(settings.models.connections[0]!.name).toBe('Synthetic')
  })

  it('preserves valid revisions through a JSON envelope round trip', () => {
    const metadata = emptySettingsTransactionMetadata()
    metadata.revision = 5
    metadata.minimumBaseRevision = 2
    metadata.fieldRevisions.fields['appearance.editorTheme'] = 3
    metadata.fieldRevisions.connections[id()] = { entity: 5, name: 3, credential: 5 }
    metadata.fieldRevisions.tombstones[id(1)] = 4
    const envelope = JSON.parse(JSON.stringify({ ...settings, _settingsTransaction: metadata }))
    const loaded = createSettingsTransactionSnapshot(settings, envelope._settingsTransaction)
    expect(settingsTransactionMetadata(loaded)).toEqual(metadata)
  })

  it('never resets malformed or unknown-version metadata to legacy defaults', () => {
    for (const invalid of [null, {}, { version: 2 }, { ...emptySettingsTransactionMetadata(), revision: -1 },
      { ...emptySettingsTransactionMetadata(), revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...emptySettingsTransactionMetadata(), minimumBaseRevision: 1 }]) {
      expect(() => parseSettingsTransactionMetadata(invalid, settings)).toThrow(SettingsTransactionSchemaError)
    }
  })

  it('rejects arbitrary global tokens, shortcut action names, and future field revisions', () => {
    for (const [field, revision] of [['models.connections.0.name', 1], ['shortcuts.not-an-action', 1], ['appearance.editorTheme', 2]] as const) {
      const metadata = emptySettingsTransactionMetadata()
      metadata.revision = 1
      metadata.fieldRevisions.fields[field] = revision
      expect(() => parseSettingsTransactionMetadata(metadata, settings)).toThrow(SettingsTransactionSchemaError)
    }
  })

  it('rejects unknown connection fields, orphan rows, and values newer than entity revision', () => {
    const invalidRows: Array<Record<string, Record<string, number>>> = [
      { [id()]: { entity: 1, arbitrary: 1 } },
      { [id(1)]: { entity: 1 } },
      { [id()]: { credential: 1 } },
      { [id()]: { entity: 0, credential: 1 } },
      { constructor: { entity: 1 } },
    ]
    for (const connections of invalidRows) {
      const metadata = { version: 1, revision: 1, minimumBaseRevision: 0, fieldRevisions: { fields: {}, connections, tombstones: {} } }
      expect(() => parseSettingsTransactionMetadata(metadata, settings)).toThrow(SettingsTransactionSchemaError)
    }
  })

  it('rejects live-ID tombstones, malformed IDs, zero tombstones and oversized tombstone maps', () => {
    for (const tombstones of [{ [id()]: 1 }, { arbitrary: 1 }, { [id(1)]: 0 }]) {
      const metadata = { version: 1, revision: 1, minimumBaseRevision: 0, fieldRevisions: { fields: {}, connections: {}, tombstones } }
      expect(() => parseSettingsTransactionMetadata(metadata, settings)).toThrow(SettingsTransactionSchemaError)
    }
    const metadata = emptySettingsTransactionMetadata()
    metadata.revision = 1
    for (let index = 1; index <= SETTINGS_TRANSACTION_TOMBSTONE_LIMIT + 1; index += 1) metadata.fieldRevisions.tombstones[id(index)] = 1
    expect(() => parseSettingsTransactionMetadata(metadata, settings)).toThrow(SettingsTransactionSchemaError)
  })

  it('rejects extra metadata keys without executing accessors', () => {
    const metadata = { ...emptySettingsTransactionMetadata(), unrelated: true }
    expect(() => parseSettingsTransactionMetadata(metadata, settings)).toThrow(SettingsTransactionSchemaError)
    let accessed = false
    const accessor = Object.defineProperty(emptySettingsTransactionMetadata(), 'revision', { get() { accessed = true; return 0 } })
    expect(() => parseSettingsTransactionMetadata(accessor, settings)).toThrow(SettingsTransactionSchemaError)
    expect(accessed).toBe(false)
  })

  it('bounds the number of operations and rejects operation-array accessors without invoking them', () => {
    const initial = createSettingsTransactionSnapshot(settings)
    const oversized = { baseRevision: 0, operations: Array.from({ length: 257 }, () => ({ kind: 'translation-privacy.accept' as const })) }
    expect(reduceSettingsTransaction(initial, oversized)).toMatchObject({ status: 'invalid' })
    let accessed = false
    const operations = Object.defineProperty([undefined], '0', { get() { accessed = true; return { kind: 'translation-privacy.accept' } } })
    expect(reduceSettingsTransaction(initial, { baseRevision: 0, operations } as unknown as SettingsTransactionRequest)).toMatchObject({ status: 'invalid' })
    expect(accessed).toBe(false)
  })

  it('rejects a patch function value rather than executing it or leaking a clone exception', () => {
    const initial = createSettingsTransactionSnapshot(settings)
    let called = false
    const request = { baseRevision: 0, operations: [{ kind: 'appearance.patch', changes: {
      editorTheme: { value: () => { called = true }, expected: { value: 'system', revision: 0 } },
    } }] }
    expect(reduceSettingsTransaction(initial, request as unknown as SettingsTransactionRequest)).toMatchObject({ status: 'invalid', reason: 'invalid-request' })
    expect(called).toBe(false)
  })

  it('rejects nested accessors and cyclic patch values before inspecting their business fields', () => {
    const initial = createSettingsTransactionSnapshot(settings)
    let accessed = false
    const accessor = Object.defineProperty({ ...connection }, 'name', { get() { accessed = true; return 'Unsafe getter' } })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const operation of [
      { kind: 'model-connection.add', connection: accessor, expectedAbsentRevision: 0 },
      { kind: 'appearance.patch', changes: { editorTheme: { value: cyclic, expected: { value: 'system', revision: 0 } } } },
    ]) expect(reduceSettingsTransaction(initial, { baseRevision: 0, operations: [operation] } as unknown as SettingsTransactionRequest)).toMatchObject({ status: 'invalid' })
    expect(accessed).toBe(false)
  })
})
