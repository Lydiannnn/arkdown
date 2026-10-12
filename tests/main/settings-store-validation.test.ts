import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SettingsStore } from '../../src/main/settings/settings-store'
import type { LargeModelSettings } from '../../src/shared/large-model-settings'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

it('drops malformed window bounds while preserving a valid workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'settings.json'),
    JSON.stringify({ lastWorkspace: 'C:\\文档', windowBounds: { width: 'bad', height: -1 } }),
    'utf8',
  )

  const settings = await new SettingsStore(root).load()

  expect(settings).toEqual({
    lastWorkspace: 'C:\\文档',
    windowBounds: undefined,
    layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 },
    screenshotOcr: { preferredTier: 'small' },
    mainBackground: DEFAULT_BACKGROUND_SETTINGS,
    shellIntegration: { documentOpenMenu: true, markdownShellNew: true },
  })
})

it('preserves a valid folder chooser path without restoring it as the startup workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'settings.json'),
    JSON.stringify({
      lastWorkspace: null,
      lastFolderPickerPath: 'C:\\选择过的文件夹',
    }),
    'utf8',
  )

  await expect(new SettingsStore(root).load()).resolves.toEqual({
    lastWorkspace: null,
    lastFolderPickerPath: 'C:\\选择过的文件夹',
    windowBounds: undefined,
    layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 },
    screenshotOcr: { preferredTier: 'small' },
    mainBackground: DEFAULT_BACKGROUND_SETTINGS,
    shellIntegration: { documentOpenMenu: true, markdownShellNew: true },
  })
})

it('round-trips only strict public model metadata through the settings whitelist', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  const models: LargeModelSettings = {
    version: 6,
    codexCli: null,
    connections: [{
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'DeepSeek',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
      apiKeyHint: '••••cret',
      status: 'connected',
      lastTestedAt: '2026-07-30T08:00:00.000Z',
      capabilityOverride: {
        contextWindowTokens: 200_000,
        maxInputTokens: 180_000,
        maxOutputTokens: 40_000,
      },
    }],
    selectionTranslation: {
      connectionId: '550e8400-e29b-41d4-a716-446655440000',
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'fr',
      privacyNoticeAccepted: true,
    },
    screenshotTranslation: {
      connectionId: '550e8400-e29b-41d4-a716-446655440000',
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'fr',
    },
    aiConversation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      writePolicy: 'document-grant',
    },
  }
  const store = new SettingsStore(root)

  await store.save(Object.assign(
    { lastWorkspace: null, models },
    { apiKey: 'top-level-secret', modelConnection: { apiKey: 'nested-secret' } },
  ) as never)

  const persisted = await readFile(path.join(root, 'settings.json'), 'utf8')
  expect(persisted).not.toContain('top-level-secret')
  expect(persisted).not.toContain('nested-secret')
  await expect(store.load()).resolves.toMatchObject({ models })
})

it('migrates stored AI-v3 model settings to v6 without grant state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  const legacyModels = {
    version: 3,
    connections: [],
    selectionTranslation: {
      connectionId: null,
      reasoningEffort: 'off',
      targetLanguage: 'auto',
      privacyNoticeAccepted: false,
    },
    screenshotTranslation: {
      connectionId: null,
      reasoningEffort: 'off',
      targetLanguage: 'auto',
    },
    aiConversation: {
      connectionId: null,
      reasoningEffort: 'high',
    },
  }
  await writeFile(
    path.join(root, 'settings.json'),
    JSON.stringify({ lastWorkspace: null, models: legacyModels }),
    'utf8',
  )

  const loaded = await new SettingsStore(root).load()

  expect(loaded.models).toEqual({
    ...legacyModels,
    selectionTranslation: { ...legacyModels.selectionTranslation, thinkingMode: 'disabled', reasoningEffort: 'low' },
    screenshotTranslation: { ...legacyModels.screenshotTranslation, thinkingMode: 'disabled', reasoningEffort: 'low' },
    version: 6,
    codexCli: null,
    floatingTranslation: {
      connectionId: null,
      thinkingMode: 'disabled',
      reasoningEffort: 'low',
      target: 'auto',
    },
    aiConversation: {
      connectionId: null,
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      writePolicy: 'ask-every-time',
    },
  })
  expect(loaded.models?.aiConversation).not.toHaveProperty('workspaceGrant')
})

it('round-trips a strict combined Codex CLI summary without private diagnostics', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  const store = new SettingsStore(root)
  const models = {
    version: 6,
    codexCli: {
      cliVersion: 'codex-cli 0.144.1',
      status: 'connected',
      lastTestedAt: '2026-09-01T00:00:00.000Z',
    },
    connections: [],
    selectionTranslation: {
      connectionId: null, thinkingMode: 'default' as const, reasoningEffort: 'default', targetLanguage: 'auto', privacyNoticeAccepted: false,
    },
    screenshotTranslation: { connectionId: null, thinkingMode: 'default' as const, reasoningEffort: 'default', targetLanguage: 'auto' },
    aiConversation: { connectionId: null, thinkingMode: 'enabled' as const, reasoningEffort: 'max', writePolicy: 'document-grant' },
  }
  await store.save({ lastWorkspace: null, models } as never)
  const persisted = await readFile(path.join(root, 'settings.json'), 'utf8')
  expect(persisted).not.toContain('diagnostic')
  await expect(store.load()).resolves.toMatchObject({ models })
})

it('rejects unexpected secret-bearing fields inside public model metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  const store = new SettingsStore(root)
  const unsafeModels = {
    version: 3,
    codexCli: null,
    connections: [{
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'DeepSeek',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
      apiKeyHint: '••••cret',
      status: 'connected',
      lastTestedAt: '2026-07-30T08:00:00.000Z',
      apiKey: 'nested-secret',
    }],
    selectionTranslation: {
      connectionId: null,
      reasoningEffort: 'off',
      targetLanguage: 'auto',
      privacyNoticeAccepted: false,
    },
    screenshotTranslation: {
      connectionId: null,
      reasoningEffort: 'off',
      targetLanguage: 'auto',
    },
  }

  await store.save({ lastWorkspace: null, models: unsafeModels } as never)

  const persisted = await readFile(path.join(root, 'settings.json'), 'utf8')
  expect(persisted).not.toContain('nested-secret')
  expect(JSON.parse(persisted)).not.toHaveProperty('models')
})

it('rejects an unmasked API key placed in the public hint field', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-'))
  roots.push(root)
  const store = new SettingsStore(root)
  const unsafeModels = {
    version: 3,
    codexCli: null,
    connections: [{
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'DeepSeek',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
      apiKeyHint: 'sk-raw-secret',
      status: 'connected',
      lastTestedAt: '2026-07-30T08:00:00.000Z',
    }],
    selectionTranslation: {
      connectionId: null,
      reasoningEffort: 'off',
      targetLanguage: 'auto',
      privacyNoticeAccepted: false,
    },
    screenshotTranslation: {
      connectionId: null,
      reasoningEffort: 'off',
      targetLanguage: 'auto',
    },
  }

  await store.save({ lastWorkspace: null, models: unsafeModels } as never)

  const persisted = await readFile(path.join(root, 'settings.json'), 'utf8')
  expect(persisted).not.toContain('sk-raw-secret')
  expect(JSON.parse(persisted)).not.toHaveProperty('models')
})
