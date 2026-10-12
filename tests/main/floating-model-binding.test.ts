import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_LARGE_MODEL_SETTINGS, parseFloatingTranslationPatch, parseLargeModelSettings } from '../../src/shared/large-model-settings'
import { SettingsStore } from '../../src/main/settings/settings-store'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { ModelConnectionService } from '../../src/main/models/model-connection-service'
import { CodexCliConnectionService } from '../../src/main/codex/codex-cli-connection-service'

const roots: string[] = []
const binding = { connectionId: 'codex-cli', thinkingMode: 'enabled' as const, reasoningEffort: 'high' as const }
const models = () => ({ ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), codexCli: {
  status: 'connected' as const, cliVersion: '1.0', lastTestedAt: '2026-09-01T00:00:00.000Z',
} })
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('accepts and copies a floating binding while rejecting unknown connections and extra fields', () => {
  const source = { ...models(), floatingTranslation: { ...binding } }
  const parsed = parseLargeModelSettings(source)
  expect(parsed?.floatingTranslation).toEqual(binding)
  expect(parsed?.floatingTranslation).not.toBe(source.floatingTranslation)
  expect(parseLargeModelSettings({ ...source, floatingTranslation: { ...binding, targetLanguage: 'zh' } })).toBeUndefined()
  expect(parseLargeModelSettings({ ...source, floatingTranslation: { ...binding, connectionId: 'missing' } })).toBeUndefined()
})

it('accepts optional floating targets and rejects unknown or explicitly undefined target fields', () => {
  for (const target of ['auto', 'zh', 'jp', 'fra']) {
    expect(parseLargeModelSettings({ ...models(), floatingTranslation: { ...binding, target } })?.floatingTranslation?.target).toBe(target)
    expect(parseFloatingTranslationPatch({ target })).toEqual({ target })
  }
  for (const target of ['ja', '', undefined, null]) {
    expect(parseLargeModelSettings({ ...models(), floatingTranslation: { ...binding, target } })).toBeUndefined()
    expect(parseFloatingTranslationPatch({ target })).toBeUndefined()
  }
})

it.each([null, 'codex-cli'])('migrates a legacy target into an existing central binding without changing model %s', async connectionId => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-floating-target-')); roots.push(root)
  await mkdir(path.join(root, 'screen-translation'))
  const local = { backend: 'baidu', target: 'fra', bounds: { x: 10, y: 20, width: 100, height: 80 }, ...binding }
  await writeFile(path.join(root, 'screen-translation/settings.json'), JSON.stringify(local), 'utf8')
  await writeFile(path.join(root, 'screen-translation/baidu.credentials.json'), 'opaque-encrypted-fixture', 'utf8')
  const store = new SettingsStore(root)
  await store.save({ lastWorkspace: null, models: { ...models(), floatingTranslation: { ...binding, connectionId } } })
  const loaded = await store.load()
  expect(loaded.models?.floatingTranslation).toEqual({ ...binding, connectionId, target: 'fra' })
  expect(loaded.models?.selectionTranslation).toEqual(models().selectionTranslation)
  expect(loaded.models?.screenshotTranslation).toEqual(models().screenshotTranslation)
  expect(loaded.models?.aiConversation).toEqual(models().aiConversation)
  expect(JSON.parse(await readFile(path.join(root, 'screen-translation/settings.json'), 'utf8'))).toEqual(local)
  expect(await readFile(path.join(root, 'screen-translation/baidu.credentials.json'), 'utf8')).toBe('opaque-encrypted-fixture')
  await store.save({ ...loaded, models: { ...loaded.models!, floatingTranslation: { ...loaded.models!.floatingTranslation!, target: 'auto' } } })
  expect((await store.load()).models?.floatingTranslation?.target).toBe('auto')
})

it.each(['missing', 'invalid-json', 'invalid-target'])('defaults missing central target to auto for %s local settings', async state => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-floating-target-default-')); roots.push(root)
  if (state !== 'missing') {
    await mkdir(path.join(root, 'screen-translation'))
    await writeFile(path.join(root, 'screen-translation/settings.json'), state === 'invalid-json' ? '{' : JSON.stringify({ target: 'unknown' }), 'utf8')
  }
  const store = new SettingsStore(root)
  await store.save({ lastWorkspace: null, models: { ...models(), floatingTranslation: { ...binding, connectionId: null } } })
  expect((await store.load()).models?.floatingTranslation).toEqual({ ...binding, connectionId: null, target: 'auto' })
})

it.each([true, false])('preserves a Baidu-only legacy target with main settings present=%s', async mainSettingsPresent => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-floating-baidu-target-')); roots.push(root)
  await mkdir(path.join(root, 'screen-translation'))
  await writeFile(path.join(root, 'screen-translation/settings.json'), JSON.stringify({ backend: 'baidu', target: 'jp' }), 'utf8')
  const store = new SettingsStore(root)
  if (mainSettingsPresent) await store.save({ lastWorkspace: null })
  expect((await store.load()).models?.floatingTranslation).toMatchObject({ connectionId: null, target: 'jp' })
})

it('merges target-only edits without reverting independent model and effort changes', async () => {
  const coordinator = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null, models: models() })
  const service = new ModelConnectionService(coordinator, {} as never, {} as never)
  await service.setFloatingTranslation({ ...binding, target: 'zh' })
  await service.setFloatingTranslation({ connectionId: null, reasoningEffort: 'medium' })
  expect((await service.setFloatingTranslation({ target: 'jp' })).floatingTranslation).toEqual({ ...binding, connectionId: null, reasoningEffort: 'medium', target: 'jp' })
})

it('migrates existing module binding on settings load, preserving local backend and explicit central clearing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-floating-binding-')); roots.push(root)
  await mkdir(path.join(root, 'screen-translation'))
  const legacy = { backend: 'baidu', target: 'jp', triggerMode: 'hotkey', ...binding }
  await writeFile(path.join(root, 'screen-translation/settings.json'), '\uFEFF' + JSON.stringify(legacy), 'utf8')
  const store = new SettingsStore(root)
  await store.save({ lastWorkspace: null, models: models() })
  const loaded = await store.load()
  expect(loaded.models?.floatingTranslation).toEqual({ ...binding, target: 'jp' })
  expect(JSON.parse((await readFile(path.join(root, 'screen-translation/settings.json'), 'utf8')).replace(/^\uFEFF/, ''))).toEqual(legacy)
  await store.save({ ...loaded, models: { ...loaded.models!, floatingTranslation: { ...binding, connectionId: null } } })
  expect((await store.load()).models?.floatingTranslation?.connectionId).toBeNull()
})

it('sets the fourth feature independently and clears it when removing CLI', async () => {
  const coordinator = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null, models: models() })
  const service = new ModelConnectionService(coordinator, {} as never, {} as never)
  await service.setFloatingTranslation(binding)
  expect(service.getSettings().floatingTranslation).toEqual({ ...binding, target: 'auto' })
  expect(service.getSettings().selectionTranslation).toEqual(DEFAULT_LARGE_MODEL_SETTINGS.selectionTranslation)
  const cli = new CodexCliConnectionService(coordinator, { dispose: async () => {} } as never)
  expect((await cli.remove()).floatingTranslation?.connectionId).toBeNull()
})

it('merges an effort-only edit into the latest binding inside the settings transaction', async () => {
  const coordinator = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null, models: models() })
  const service = new ModelConnectionService(coordinator, {} as never, {} as never)
  await service.setFloatingTranslation(binding)
  await service.setFloatingTranslation({ ...binding, connectionId: null })
  const result = await service.setFloatingTranslation({ reasoningEffort: 'medium' })
  expect(result.floatingTranslation).toEqual({ ...binding, connectionId: null, reasoningEffort: 'medium', target: 'auto' })
})

it('does not rebind an unknown legacy model to an available CLI', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-floating-stale-')); roots.push(root)
  await mkdir(path.join(root, 'screen-translation'))
  await writeFile(path.join(root, 'screen-translation/settings.json'), JSON.stringify({ ...binding, connectionId: '11111111-1111-4111-8111-111111111111' }), 'utf8')
  const store = new SettingsStore(root)
  await store.save({ lastWorkspace: null, models: models() })
  expect((await store.load()).models?.floatingTranslation).toEqual({ connectionId: null, thinkingMode: 'disabled', reasoningEffort: 'low', target: 'auto' })
})

it('retains a vanished CLI catalog choice referenced only by the floating feature', async () => {
  const initial = { ...models(), floatingTranslation: { ...binding, connectionId: 'codex-cli:old-model' }, codexCli: {
    ...models().codexCli, models: [{ modelId: 'old-model', displayName: 'Old', supportedReasoningEfforts: ['high' as const], defaultReasoningEffort: 'high' as const, isDefault: true }],
  } }
  const coordinator = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null, models: initial })
  const cli = new CodexCliConnectionService(coordinator, { test: async () => ({ status: 'connected', cliVersion: '2.0', models: [] }), dispose: async () => {} } as never)
  const result = await cli.test()
  expect(result.settings.floatingTranslation?.connectionId).toBe('codex-cli:old-model')
  expect(result.settings.codexCli?.models).toEqual([expect.objectContaining({ modelId: 'old-model', unavailable: true })])
  expect(parseLargeModelSettings(result.settings)).toBeDefined()
})

it('clears only floating usage when its API connection is deleted', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const initial = { ...models(), floatingTranslation: { ...binding, connectionId: id, target: 'jp' }, connections: [{
    id, name: 'API', provider: 'other' as const, accessType: 'standard-api' as const, protocol: 'openai' as const,
    baseUrl: 'https://example.com/v1', modelId: 'model', apiKeyHint: '••••abcd', status: 'connected' as const,
    lastTestedAt: null, capabilityOverride: null,
  }] }
  const coordinator = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null, models: initial })
  const service = new ModelConnectionService(coordinator, { snapshot: async () => ({}), delete: async () => {} } as never, {} as never)
  const result = await service.delete(id)
  expect(result.floatingTranslation).toEqual({ connectionId: null, thinkingMode: 'disabled', reasoningEffort: 'low', target: 'jp' })
  expect(result.selectionTranslation).toEqual(initial.selectionTranslation)
})
