import { describe, expect, it } from 'vitest'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import {
  codexCliModelConnectionId, DEFAULT_LARGE_MODEL_SETTINGS, type CodexCliConnectionSummary,
  type LargeModelSettings, type ModelConnectionSummary,
} from '../../src/shared/large-model-settings'
import { reduceSettingsTransaction } from '../../src/main/settings/settings-transaction-reducer'
import {
  CONNECTION_TEST_FIELDS, createSettingsTransactionSnapshot, emptySettingsTransactionMetadata,
  SETTINGS_TRANSACTION_TOMBSTONE_LIMIT, settingsTransactionMetadata,
} from '../../src/main/settings/settings-transaction-schema'
import type { AppSettings } from '../../src/main/settings/settings-store'
import type {
  ExpectedModelTestInputs, ExpectedSetting, SettingsTransactionOperation, SettingsTransactionSnapshot,
} from '../../src/main/settings/settings-transaction-types'

const id = (index = 0): string => `550e8400-e29b-41d4-a716-${index.toString(16).padStart(12, '0')}`
const expected = <T>(value: T, revision = 0): ExpectedSetting<T> => ({ value, revision })
const change = <T extends string | number | boolean | null | undefined | object>(value: T, before: T, revision = 0) => ({ value, expected: expected(before, revision) })
const connection = (index = 0, patch: Partial<ModelConnectionSummary> = {}): ModelConnectionSummary => ({
  id: id(index), name: `Synthetic ${index}`, provider: 'other', accessType: 'standard-api', protocol: 'openai',
  baseUrl: 'https://api.example.com/v1', modelId: 'synthetic-model', apiKeyHint: '••••test',
  status: 'untested', lastTestedAt: null, capabilityOverride: null, ...patch,
})
const models = (connections: ModelConnectionSummary[] = [connection()]): LargeModelSettings => ({
  ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), connections,
})
const snapshot = (settings: Partial<AppSettings> = {}): SettingsTransactionSnapshot =>
  createSettingsTransactionSnapshot({ lastWorkspace: null, ...settings })

function prepared(before: SettingsTransactionSnapshot, operations: SettingsTransactionOperation[], baseRevision = before.revision): SettingsTransactionSnapshot {
  const result = reduceSettingsTransaction(before, { baseRevision, operations })
  expect(result.status).toBe('prepared')
  if (result.status !== 'prepared') throw new Error('Expected prepared synthetic transaction')
  return result.snapshot
}

function inputs(source: SettingsTransactionSnapshot, connectionId = id()): ExpectedModelTestInputs {
  const current = source.settings.models!.connections.find(item => item.id === connectionId)!
  const result = Object.fromEntries(CONNECTION_TEST_FIELDS.map(field => [field,
    expected(current[field], source.fieldRevisions.connections[connectionId]?.[field] ?? 0)]))
  return { ...result, credentialRevision: source.fieldRevisions.connections[connectionId]?.credential ?? 0 } as ExpectedModelTestInputs
}

function recordTest(source: SettingsTransactionSnapshot): SettingsTransactionOperation {
  const current = source.settings.models!.connections[0]!
  return { kind: 'model-connection.record-test', id: current.id, testedInputs: inputs(source, current.id), changes: {
    status: change('connected', current.status, source.fieldRevisions.connections[current.id]?.status ?? 0),
    lastTestedAt: change('2026-10-03T00:00:00.000Z', current.lastTestedAt, source.fieldRevisions.connections[current.id]?.lastTestedAt ?? 0),
  } }
}

describe('pure settings transaction reduction (synthetic data only)', () => {
  it('merges an old geometry request with a newly created connection and its revisions', () => {
    const initial = snapshot()
    const afterModel = prepared(initial, [{ kind: 'model-connection.add', connection: connection(), expectedAbsentRevision: 0 }])
    const afterBounds = prepared(afterModel, [{ kind: 'window-bounds.set', value: { width: 900, height: 700 }, mode: 'last-writer-wins' }], initial.revision)
    expect(afterBounds.settings.models!.connections).toEqual([connection()])
    expect(afterBounds.settings.windowBounds).toEqual({ width: 900, height: 700 })
    expect(afterBounds.fieldRevisions.connections[id()]?.credential).toBe(1)
    expect(afterBounds.revision).toBe(2)
    expect(initial.settings.models).toBeUndefined()
  })

  it('merges independent stale appearance fields without overwriting the latest theme', () => {
    const initial = snapshot()
    const current = prepared(initial, [{ kind: 'appearance.patch', changes: { editorTheme: change('dark', 'system') } }])
    const next = prepared(current, [{ kind: 'appearance.patch', changes: { maximumContentWidthPx: change(900, 800) } }], 0)
    expect(next.settings.appearance?.editorTheme).toBe('dark')
    expect(next.settings.appearance?.maximumContentWidthPx).toBe(900)
    expect(next.fieldRevisions.fields['appearance.editorTheme']).toBe(1)
    expect(next.fieldRevisions.fields['appearance.maximumContentWidthPx']).toBe(2)
  })

  it('rejects a same-field stale value and returns a detached latest snapshot', () => {
    const current = prepared(snapshot(), [{ kind: 'appearance.patch', changes: { editorTheme: change('dark', 'system') } }])
    const result = reduceSettingsTransaction(current, { baseRevision: 0, operations: [{ kind: 'appearance.patch', changes: { editorTheme: change('minimal', 'system') } }] })
    expect(result).toMatchObject({ status: 'conflict', reason: 'field-changed', fields: [{ kind: 'field', field: 'appearance.editorTheme' }] })
    if (result.status !== 'conflict') throw new Error('Expected conflict')
    result.snapshot.settings.appearance!.editorTheme = 'minimal'
    expect(current.settings.appearance!.editorTheme).toBe('dark')
  })

  it('detects appearance ABA even when the expected value matches again', () => {
    const changed = prepared(snapshot(), [{ kind: 'appearance.patch', changes: { editorTheme: change('dark', 'system') } }])
    const restored = prepared(changed, [{ kind: 'appearance.patch', changes: { editorTheme: change('system', 'dark', 1) } }])
    expect(reduceSettingsTransaction(restored, { baseRevision: 0, operations: [{ kind: 'appearance.patch', changes: { editorTheme: change('minimal', 'system') } }] })).toMatchObject({ status: 'conflict', reason: 'field-changed' })
  })

  it('rejects the whole request after a later field conflict without changing the input', () => {
    const current = prepared(snapshot(), [{ kind: 'appearance.patch', changes: { editorTheme: change('dark', 'system') } }])
    const copy = structuredClone(current)
    const result = reduceSettingsTransaction(current, { baseRevision: 0, operations: [
      { kind: 'workspace.set', value: 'synthetic/workspace', mode: 'last-writer-wins' },
      { kind: 'appearance.patch', changes: { editorTheme: change('minimal', 'system') } },
    ] })
    expect(result.status).toBe('conflict')
    expect(current).toEqual(copy)
  })

  it('skips undefined values, does not materialize defaults for a no-op, and explicitly clears optional fields', () => {
    const initial = snapshot({ lastFolderPickerPath: 'synthetic/folder' })
    expect(reduceSettingsTransaction(initial, { baseRevision: 0, operations: [{ kind: 'appearance.patch', changes: {
      editorTheme: undefined, maximumContentWidthPx: { value: undefined, expected: expected(800) },
    } } as unknown as SettingsTransactionOperation] })).toEqual({ status: 'unchanged', snapshot: initial })
    const next = prepared(initial, [{ kind: 'folder-picker.clear', mode: 'last-writer-wins' }])
    expect(Object.hasOwn(next.settings, 'lastFolderPickerPath')).toBe(false)
    expect(next.settings.appearance).toBeUndefined()
    expect(next.fieldRevisions.fields.lastFolderPickerPath).toBe(1)
  })

  it('rejects arbitrary fields, updater functions, extra request keys, and malformed operation arrays', () => {
    const initial = snapshot()
    const malformed: unknown[] = [
      { baseRevision: 0, operations: [{ kind: 'appearance.patch', changes: { '__proto__.polluted': change(true, false) } }] },
      { baseRevision: 0, operations: [{ kind: 'update', mutator: () => ({}) }] },
      { baseRevision: 0, operations: [], filePath: 'unexpected.json' },
      { baseRevision: 0, operations: new Array(1) },
      { baseRevision: 0, operations: [{ kind: 'workspace.set', value: 'x', mode: 'last-writer-wins', arbitrary: true }] },
    ]
    for (const request of malformed) expect(reduceSettingsTransaction(initial, request as Parameters<typeof reduceSettingsTransaction>[1]).status).toBe('invalid')
  })

  it('rejects duplicate writes even if the first happens to be a no-op', () => {
    const result = reduceSettingsTransaction(snapshot(), { baseRevision: 0, operations: [
      { kind: 'workspace.set', value: null, mode: 'last-writer-wins' },
      { kind: 'workspace.set', value: 'synthetic/next', mode: 'last-writer-wins' },
    ] })
    expect(result).toMatchObject({ status: 'invalid', reason: 'duplicate-write' })
  })

  it('does not advance revisions or materialize settings for unchanged values', () => {
    const initial = snapshot()
    expect(reduceSettingsTransaction(initial, { baseRevision: 0, operations: [{ kind: 'appearance.patch', changes: { editorTheme: change('system', 'system') } }] })).toEqual({ status: 'unchanged', snapshot: initial })
  })

  it('fails closed on future revisions and exhausted revisions', () => {
    const initial = snapshot()
    expect(reduceSettingsTransaction(initial, { baseRevision: 1, operations: [] })).toMatchObject({ status: 'conflict', reason: 'future-revision' })
    const exhausted = { ...initial, revision: Number.MAX_SAFE_INTEGER }
    expect(reduceSettingsTransaction(exhausted, { baseRevision: exhausted.revision, operations: [{ kind: 'workspace.set', value: 'synthetic/path', mode: 'last-writer-wins' }] })).toMatchObject({ status: 'invalid', reason: 'revision-exhausted' })
    expect(reduceSettingsTransaction(exhausted, { baseRevision: exhausted.revision, operations: [] }).status).toBe('unchanged')
  })

  it('keeps a concurrently replaced background image when applying an old controls patch', () => {
    const initial = snapshot()
    const current = prepared(initial, [{ kind: 'main-background.apply', changes: {}, image: { kind: 'replace', relativePath: 'backgrounds/main/synthetic.png', expected: expected(null) } }])
    const next = prepared(current, [{ kind: 'main-background.apply', changes: { imageOpacityPercent: change(60, 50) }, image: { kind: 'keep' } }], 0)
    expect(next.settings.mainBackground).toEqual({ ...DEFAULT_BACKGROUND_SETTINGS, imageRelativePath: 'backgrounds/main/synthetic.png', imageOpacityPercent: 60 })
    expect(reduceSettingsTransaction(next, { baseRevision: 0, operations: [{ kind: 'main-background.apply', changes: {}, image: { kind: 'remove', expected: expected(null) } }] }).status).toBe('conflict')
  })

  it('rejects unowned background path shapes and unknown image instructions', () => {
    for (const relativePath of ['../secret.png', 'C:/outside/image.png', 'backgrounds/main/../image.png', 'backgrounds/main/nested/a.png']) {
      expect(reduceSettingsTransaction(snapshot(), { baseRevision: 0, operations: [{ kind: 'main-background.apply', changes: {}, image: { kind: 'replace', relativePath, expected: expected(null) } }] }).status).toBe('invalid')
    }
  })

  it('updates individual shortcuts and rejects unknown actions and conflicts with defaults', () => {
    const first = prepared(snapshot(), [{ kind: 'shortcuts.patch', changes: { 'file.save': { kind: 'set', value: 'Alt+S', expected: expected(undefined) } } }])
    const second = prepared(first, [{ kind: 'shortcuts.patch', changes: { 'file.open-document': { kind: 'set', value: 'Alt+O', expected: expected(undefined) } } }], 0)
    expect(second.settings.shortcuts).toEqual({ 'file.save': 'Alt+S', 'file.open-document': 'Alt+O' })
    expect(reduceSettingsTransaction(second, { baseRevision: 2, operations: [{ kind: 'shortcuts.patch', changes: { 'not-an-action': { kind: 'set', value: 'Alt+Q', expected: expected(undefined) } } }] }).status).toBe('invalid')
    expect(reduceSettingsTransaction(snapshot(), { baseRevision: 0, operations: [{ kind: 'shortcuts.patch', changes: { 'file.save': { kind: 'set', value: 'Ctrl+O', expected: expected(undefined) } } }] }).status).toBe('invalid')
  })

  it('increments startup state from latest and rejects a completed offer from an older install', () => {
    const start: SettingsTransactionOperation = { kind: 'default-applications.record-start', version: '1.0.4', installationId: '20261003000000-1' }
    const once = prepared(snapshot(), [start])
    const twice = prepared(once, [start], 0)
    expect(twice.settings.defaultApplicationsPrompt?.starts).toBe(2)
    const nextInstall = prepared(twice, [{ ...start, installationId: null }])
    expect(nextInstall.settings.defaultApplicationsPrompt?.installationId).toBeUndefined()
    expect(reduceSettingsTransaction(nextInstall, { baseRevision: twice.revision, operations: [{ kind: 'default-applications.mark-handled', expected: expected(twice.settings.defaultApplicationsPrompt!, 2) }] }).status).toBe('conflict')
  })

  it('applies font migration against latest and preserves custom font sets', () => {
    const custom = { ...DEFAULT_EDITOR_APPEARANCE, bodyLatinFont: 'Arial' }
    const next = prepared(snapshot({ appearance: custom, fontDefaultsVersion: 1 }), [{ kind: 'migration.font-defaults' }])
    expect(next.settings.appearance).toEqual(custom)
    expect(next.settings.fontDefaultsVersion).toBe(3)
    expect(next.fieldRevisions.fields['appearance.bodyLatinFont']).toBeUndefined()
    expect(reduceSettingsTransaction(next, { baseRevision: next.revision, operations: [{ kind: 'migration.font-defaults' }] }).status).toBe('unchanged')
  })
})

describe('model transaction reduction', () => {
  it('records test fields without copying an old name over a concurrent rename', () => {
    const initial = snapshot({ models: models() })
    const renamed = prepared(initial, [{ kind: 'model-connection.patch', id: id(), changes: { name: change('Renamed', 'Synthetic 0') } }])
    const next = prepared(renamed, [recordTest(initial)], initial.revision)
    expect(next.settings.models!.connections[0]).toMatchObject({ name: 'Renamed', status: 'connected', lastTestedAt: '2026-10-03T00:00:00.000Z' })
    expect(next.fieldRevisions.connections[id()]?.name).toBe(1)
  })

  it('rejects a test of an old endpoint, including endpoint ABA', () => {
    const initial = snapshot({ models: models() })
    const moved = prepared(initial, [{ kind: 'model-connection.patch', id: id(), testedInputs: inputs(initial), changes: { baseUrl: change('https://new.example.com/v1', connection().baseUrl) } }])
    const restored = prepared(moved, [{ kind: 'model-connection.patch', id: id(), testedInputs: inputs(moved), changes: { baseUrl: change(connection().baseUrl, 'https://new.example.com/v1', 1) } }])
    expect(reduceSettingsTransaction(restored, { baseRevision: 0, operations: [recordTest(initial)] })).toMatchObject({ status: 'conflict', fields: [{ kind: 'connection', id: id(), field: 'baseUrl' }] })
  })

  it('advances credential revisions even for an unchanged public hint and rejects old test results', () => {
    const initial = snapshot({ models: models() })
    const result = reduceSettingsTransaction(initial, { baseRevision: 0, operations: [{ kind: 'model-connection.patch', id: id(), changes: {}, testedInputs: inputs(initial), credential: { kind: 'replace', expectedRevision: 0 } }] })
    expect(result).toMatchObject({ status: 'prepared', credentialChange: { id: id(), kind: 'replace' } })
    if (result.status !== 'prepared') throw new Error('Expected prepared')
    expect(result.snapshot.settings).toEqual(initial.settings)
    expect(result.snapshot.fieldRevisions.connections[id()]).toMatchObject({ credential: 1, entity: 1 })
    expect(reduceSettingsTransaction(result.snapshot, { baseRevision: 0, operations: [recordTest(initial)] })).toMatchObject({ status: 'conflict', fields: [{ kind: 'connection', id: id(), field: 'credential' }] })
  })

  it('removes only current references to a deleted connection while preserving a concurrent rebind', () => {
    const initialModels = models([connection(), connection(1)])
    initialModels.aiConversation.connectionId = id()
    initialModels.selectionTranslation.connectionId = id()
    const initial = snapshot({ models: initialModels })
    const rebound = prepared(initial, [{ kind: 'model-feature.patch', feature: 'aiConversation', changes: { connectionId: change(id(1), id()) } }])
    const next = prepared(rebound, [{ kind: 'model-connection.remove', id: id(), expected: expected(connection()), expectedCredentialRevision: 0 }], 0)
    expect(next.settings.models!.connections.map(item => item.id)).toEqual([id(1)])
    expect(next.settings.models!.aiConversation.connectionId).toBe(id(1))
    expect(next.settings.models!.selectionTranslation.connectionId).toBeNull()
    expect(next.fieldRevisions.tombstones[id()]).toBe(2)
    expect(next.fieldRevisions.connections[id()]).toBeUndefined()
  })

  it('does not revive a deleted ID from an old patch, test, or add request', () => {
    const initial = snapshot({ models: models() })
    const deleted = prepared(initial, [{ kind: 'model-connection.remove', id: id(), expected: expected(connection()), expectedCredentialRevision: 0 }])
    for (const operation of [
      { kind: 'model-connection.patch', id: id(), changes: { name: change('Old', 'Synthetic 0') } },
      recordTest(initial), { kind: 'model-connection.add', connection: connection(), expectedAbsentRevision: 0 },
    ] as SettingsTransactionOperation[]) expect(reduceSettingsTransaction(deleted, { baseRevision: 0, operations: [operation] }).status).toBe('conflict')
  })

  it('caps deletion metadata and rejects old non-LWW requests after tombstone eviction', () => {
    const initial = snapshot({ models: models([connection(2048)]) })
    const metadata = emptySettingsTransactionMetadata()
    metadata.revision = SETTINGS_TRANSACTION_TOMBSTONE_LIMIT
    for (let index = 0; index < SETTINGS_TRANSACTION_TOMBSTONE_LIMIT; index += 1) metadata.fieldRevisions.tombstones[id(index)] = index + 1
    const loaded = createSettingsTransactionSnapshot(initial.settings, metadata)
    const next = prepared(loaded, [{ kind: 'model-connection.remove', id: id(2048), expected: expected(connection(2048)), expectedCredentialRevision: 0 }])
    expect(Object.keys(next.fieldRevisions.tombstones)).toHaveLength(SETTINGS_TRANSACTION_TOMBSTONE_LIMIT)
    expect(next.minimumBaseRevision).toBe(1)
    expect(next.fieldRevisions.tombstones[id()]).toBeUndefined()
    expect(reduceSettingsTransaction(next, { baseRevision: 0, operations: [{ kind: 'model-connection.add', connection: connection(), expectedAbsentRevision: 0 }] })).toMatchObject({ status: 'conflict', reason: 'snapshot-too-old' })
    expect(reduceSettingsTransaction(next, { baseRevision: 0, operations: [{ kind: 'workspace.set', value: 'synthetic/current', mode: 'last-writer-wins' }] }).status).toBe('prepared')
    expect(settingsTransactionMetadata(next).minimumBaseRevision).toBe(1)
  })

  it('allows one credential journal target per request and rejects the entire second target', () => {
    const initial = snapshot()
    expect(reduceSettingsTransaction(initial, { baseRevision: 0, operations: [
      { kind: 'model-connection.add', connection: connection(), expectedAbsentRevision: 0 },
      { kind: 'model-connection.add', connection: connection(1), expectedAbsentRevision: 0 },
    ] })).toMatchObject({ status: 'invalid', reason: 'credential-change-limit' })
    expect(initial.settings.models).toBeUndefined()
  })

  it('preserves one-way privacy consent and rejects an arbitrary model feature field', () => {
    const initial = snapshot({ models: models() })
    const accepted = prepared(initial, [{ kind: 'translation-privacy.accept' }])
    const next = prepared(accepted, [{ kind: 'model-feature.patch', feature: 'selectionTranslation', changes: { targetLanguage: change('en', 'auto') } }], 0)
    expect(next.settings.models!.selectionTranslation.privacyNoticeAccepted).toBe(true)
    expect(reduceSettingsTransaction(next, { baseRevision: next.revision, operations: [{ kind: 'model-feature.patch', feature: 'selectionTranslation', changes: { privacyNoticeAccepted: change(false, true, 1) } } as unknown as SettingsTransactionOperation] }).status).toBe('invalid')
  })

  it('rejects binding to a missing connection and detects permission ABA', () => {
    const initial = snapshot({ models: models() })
    expect(reduceSettingsTransaction(initial, { baseRevision: 0, operations: [{ kind: 'model-feature.patch', feature: 'aiConversation', changes: { connectionId: change(id(1), null) } }] }).status).toBe('invalid')
    const allowed = prepared(initial, [{ kind: 'model-feature.patch', feature: 'aiConversation', changes: { writePolicy: change('workspace-grant', 'ask-every-time') } }])
    const restored = prepared(allowed, [{ kind: 'model-feature.patch', feature: 'aiConversation', changes: { writePolicy: change('ask-every-time', 'workspace-grant', 1) } }])
    expect(reduceSettingsTransaction(restored, { baseRevision: 0, operations: [{ kind: 'model-feature.patch', feature: 'aiConversation', changes: { writePolicy: change('document-grant', 'ask-every-time') } }] }).status).toBe('conflict')
  })

  it('merges a tested Codex catalog while retaining an old model currently bound by another instance', () => {
    const old: CodexCliConnectionSummary = { cliVersion: 'synthetic-1', status: 'connected', lastTestedAt: '2026-10-02T00:00:00.000Z', models: [{ modelId: 'old', displayName: 'Old', supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low', isDefault: true }] }
    const initialModels = models()
    initialModels.codexCli = old
    const initial = snapshot({ models: initialModels })
    const rebound = prepared(initial, [{ kind: 'model-feature.patch', feature: 'aiConversation', changes: { connectionId: change(codexCliModelConnectionId('old'), null) } }])
    const result: CodexCliConnectionSummary = { cliVersion: 'synthetic-2', status: 'connected', lastTestedAt: '2026-10-03T00:00:00.000Z', models: [] }
    const next = prepared(rebound, [{ kind: 'codex-cli.record-test', value: result, expected: expected(old) }], 0)
    expect(next.settings.models!.codexCli!.models).toEqual([{ ...old.models![0], isDefault: false, unavailable: true }])
    expect(next.settings.models!.aiConversation.connectionId).toBe(codexCliModelConnectionId('old'))
  })

  it('floating migration fills only missing fields and never replaces explicit current null binding', () => {
    const current = models()
    current.floatingTranslation = { connectionId: null, thinkingMode: 'disabled', reasoningEffort: 'low' }
    const legacy = { connectionId: id(), thinkingMode: 'enabled' as const, reasoningEffort: 'high' as const, target: 'en' }
    const next = prepared(snapshot({ models: current }), [{ kind: 'migration.floating-translation', legacy }])
    expect(next.settings.models!.floatingTranslation).toEqual({ ...current.floatingTranslation, target: 'en' })
  })

  it('floating migration drops an unavailable legacy binding as a unit while retaining its target', () => {
    const legacy = { connectionId: id(1), thinkingMode: 'enabled' as const, reasoningEffort: 'high' as const, target: 'en' }
    const next = prepared(snapshot({ models: models() }), [{ kind: 'migration.floating-translation', legacy }])
    expect(next.settings.models!.floatingTranslation).toEqual({ connectionId: null, thinkingMode: 'disabled', reasoningEffort: 'low', target: 'en' })
  })
})
