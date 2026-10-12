import { createArkdownApi } from '../../src/preload/arkdown-api'
import { transactionalModelFixture } from '../helpers/transactional-model-service'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { createModelCatalogClient } from '../../src/main/models/model-catalog-client'
import { createModelProtocolClient } from '../../src/main/models/model-protocol-client'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { modelProtocolError } from '../../src/main/models/model-errors'
import {
  ModelConnectionService,
  type ConnectModelInput,
} from '../../src/main/models/model-connection-service'
import {
  ModelSecretVault,
  type ModelSecretCipher,
  type ModelSecretSnapshot,
} from '../../src/main/models/model-secret-vault'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import type { AppSettings } from '../../src/main/settings/settings-store'
import type {
  LargeModelSettings,
  ModelConnectionSummary,
} from '../../src/shared/large-model-settings'

const CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440000'
const SECOND_CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440001'
const TESTED_AT = '2026-07-30T08:00:00.000Z'
const roots: string[] = []

afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function connection(
  overrides: Partial<ModelConnectionSummary> = {},
): ModelConnectionSummary {
  return {
    id: CONNECTION_ID,
    name: 'DeepSeek',
    provider: 'deepseek',
    accessType: 'standard-api',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-chat',
    apiKeyHint: '••••cret',
    status: 'connected',
    lastTestedAt: '2026-07-29T08:00:00.000Z',
    capabilityOverride: null,
    ...overrides,
  }
}

function modelSettings(
  connections: ModelConnectionSummary[] = [connection()],
  selectionOverrides: Partial<LargeModelSettings['selectionTranslation']> = {},
  aiConversationOverrides: Partial<LargeModelSettings['aiConversation']> = {},
): LargeModelSettings {
  return {
    version: 6,
    codexCli: null,
    connections,
    selectionTranslation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'auto',
      privacyNoticeAccepted: false,
      ...selectionOverrides,
    },
    screenshotTranslation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'auto',
    },
    aiConversation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      writePolicy: 'ask-every-time',
      ...aiConversationOverrides,
    },
  }
}

const reasoningConnection: ModelConnectionSummary = connection({
  id: SECOND_CONNECTION_ID,
  name: 'GPT 5',
  provider: 'other',
  protocol: 'openai',
  baseUrl: 'https://api.example.com/v1',
  modelId: 'gpt-5-mini',
})

const newConnectionInput: ConnectModelInput = {
  name: '  DeepSeek Primary  ',
  provider: 'deepseek',
  accessType: 'standard-api',
  protocol: 'openai',
  baseUrl: '  https://api.deepseek.com  ',
  modelId: '  deepseek-chat  ',
  apiKey: 'sk-line\nABCDE',
}

class MemoryVault {
  readonly secrets = new Map<string, string>()
  private readonly snapshots = new WeakMap<
    ModelSecretSnapshot, { connectionId: string; secret: string | null }
  >()

  constructor(
    private readonly events: string[],
    initial: Record<string, string> = {},
    private readonly hooks: {
      get?: (connectionId: string) => Promise<void>
      set?: (connectionId: string, apiKey: string) => Promise<void>
      delete?: (connectionId: string) => Promise<void>
      restore?: (secret: string | null) => Promise<void>
    } = {},
  ) {
    for (const [id, secret] of Object.entries(initial)) this.secrets.set(id, secret)
  }

  async get(connectionId: string): Promise<string | null> {
    await this.hooks.get?.(connectionId)
    return this.secrets.get(connectionId) ?? null
  }

  async set(connectionId: string, apiKey: string): Promise<void> {
    this.events.push(`secret:set:${apiKey}`)
    await this.hooks.set?.(connectionId, apiKey)
    this.secrets.set(connectionId, apiKey)
  }

  async delete(connectionId: string): Promise<void> {
    this.events.push('secret:delete')
    await this.hooks.delete?.(connectionId)
    this.secrets.delete(connectionId)
  }

  async snapshot(connectionId: string): Promise<ModelSecretSnapshot> {
    this.events.push('secret:snapshot')
    const snapshot = Object.freeze({}) as ModelSecretSnapshot
    this.snapshots.set(snapshot, {
      connectionId,
      secret: this.secrets.get(connectionId) ?? null,
    })
    return snapshot
  }

  async restore(snapshot: ModelSecretSnapshot): Promise<void> {
    this.events.push('secret:restore')
    const state = this.snapshots.get(snapshot)
    if (state === undefined) throw new Error('invalid snapshot')
    await this.hooks.restore?.(state.secret)
    if (state.secret === null) {
      this.secrets.delete(state.connectionId)
    } else {
      this.secrets.set(state.connectionId, state.secret)
    }
  }
}

function createHarness(options: {
  initial?: AppSettings
  initialSecrets?: Record<string, string>
  testConnection?: (input: { apiKey: string }) => Promise<void>
  listModels?: (input: { apiKey: string }) => Promise<{
    models: string[]
    recommendedModelId: string | null
  }>
  save?: (settings: AppSettings) => Promise<void>
  vaultSet?: (connectionId: string, apiKey: string) => Promise<void>
  vaultGet?: (connectionId: string) => Promise<void>
  vaultDelete?: (connectionId: string) => Promise<void>
  vaultRestore?: (secret: string | null) => Promise<void>
} = {}) {
  const events: string[] = []
  const save = vi.fn(async (settings: AppSettings) => {
    events.push('settings:save')
    await options.save?.(settings)
  })
  const settings = new SettingsCoordinator(
    { save },
    options.initial ?? { lastWorkspace: null },
  )
  const vault = new MemoryVault(events, options.initialSecrets, {
    get: options.vaultGet,
    set: options.vaultSet,
    delete: options.vaultDelete,
    restore: options.vaultRestore,
  })
  const protocolClient = {
    streamChat: vi.fn(),
    testConnection: vi.fn(async (input) => {
      events.push('connection:test')
      await options.testConnection?.(input)
    }),
  }
  const catalogClient = {
    listModels: vi.fn(async (input) => (
      options.listModels?.(input) ?? {
        models: ['deepseek-chat'],
        recommendedModelId: 'deepseek-chat',
      }
    )),
  }
  const service = new ModelConnectionService(settings, vault, protocolClient, {
    nowIso: () => TESTED_AT,
    createId: () => CONNECTION_ID,
    catalogClient,
  })
  return { catalogClient, events, protocolClient, save, service, settings, vault }
}

it.each([
  ['deepseek', 'https://api.deepseek.com', 'deepseek-v4-pro', 'disabled', 'low'],
  ['zhipu', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', 'enabled', 'low'],
  ['other', 'https://proxy.example/v1', 'unknown', 'default', 'default'],
] as const)('uses minimum-cost %s probe controls without changing saved preferences', async (provider, baseUrl, modelId, thinkingMode, reasoningEffort) => {
  const selected = connection({ provider, baseUrl, modelId })
  const models = modelSettings([selected], {}, { connectionId: selected.id, thinkingMode: 'enabled', reasoningEffort: 'max' })
  const { service, protocolClient } = createHarness({ initial: { lastWorkspace: null, models }, initialSecrets: { [CONNECTION_ID]: 'fixture' } })
  await service.test(CONNECTION_ID)
  expect(protocolClient.testConnection).toHaveBeenCalledWith(expect.objectContaining({ thinkingMode, reasoningEffort }))
  expect(service.getSettings().aiConversation).toEqual(models.aiConversation)
})

describe('ModelConnectionService model catalog', () => {
  it('uses a newly entered key without persisting it', async () => {
    const { catalogClient, events, service, vault } = createHarness()

    await expect(service.listModels({
      provider: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-new',
    })).resolves.toEqual({
      models: ['deepseek-chat'],
      recommendedModelId: 'deepseek-chat',
    })

    expect(catalogClient.listModels).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'sk-new',
      provider: 'deepseek',
    }))
    expect(events).not.toContain(expect.stringMatching(/^secret:set:/))
    expect(vault.secrets.size).toBe(0)
  })

  it('uses the encrypted key for an existing connection when no replacement is entered', async () => {
    const { catalogClient, service } = createHarness({
      initial: { lastWorkspace: null, models: modelSettings() },
      initialSecrets: { [CONNECTION_ID]: 'sk-saved' },
    })

    await service.listModels({
      id: CONNECTION_ID,
      provider: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
    })

    expect(catalogClient.listModels).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'sk-saved',
    }))
  })
})

async function createUndecryptableVault(): Promise<{
  foreignCiphertext: string
  root: string
  vault: ModelSecretVault
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-model-service-'))
  roots.push(root)
  const foreignCiphertext = Buffer.from('foreign-ciphertext-bytes').toString('base64')
  const cipher: ModelSecretCipher = {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(`local:${value}`),
    decrypt: (value) => {
      if (value.toString('base64') === foreignCiphertext) {
        throw new Error('foreign ciphertext cannot be decrypted')
      }
      return value.toString('utf8').replace(/^local:/, '')
    },
  }
  await writeFile(path.join(root, 'model-secrets.json'), JSON.stringify({
    version: 1,
    secrets: { [CONNECTION_ID]: foreignCiphertext },
  }), 'utf8')
  return {
    foreignCiphertext,
    root,
    vault: new ModelSecretVault(root, cipher),
  }
}

describe('ModelConnectionService connection transactions', () => {
  it('normalizes missing model settings to isolated public defaults', () => {
    const { service } = createHarness()

    const first = service.getSettings()
    first.selectionTranslation.targetLanguage = 'fr'
    first.connections.push(connection())

    expect(service.getSettings()).toEqual({
      version: 6,
      codexCli: null,
      connections: [],
      selectionTranslation: {
        connectionId: null,
        thinkingMode: 'disabled' as const, reasoningEffort: 'low',
        targetLanguage: 'auto',
        privacyNoticeAccepted: false,
      },
      screenshotTranslation: {
        connectionId: null,
        thinkingMode: 'disabled' as const, reasoningEffort: 'low',
        targetLanguage: 'auto',
      },
      aiConversation: {
        connectionId: null,
        thinkingMode: 'default' as const, reasoningEffort: 'default',
        writePolicy: 'ask-every-time',
      },
    })
  })

  it('never returns an unmasked API key stored in public metadata', () => {
    const { service } = createHarness({
      initial: {
        lastWorkspace: null,
        models: modelSettings([connection({ apiKeyHint: 'sk-raw-secret' })]),
      },
    })

    expect(JSON.stringify(service.getSettings())).not.toContain('sk-raw-secret')
    expect(service.getSettings().connections).toEqual([])
  })

  it('tests a normalized new connection before persisting its secret and metadata', async () => {
    const { events, protocolClient, service, settings, vault } = createHarness()

    const next = await service.connect(newConnectionInput)
    const summary = next.connections[0]!

    expect(events).toEqual([
      'connection:test',
      'secret:snapshot',
      'secret:set:sk-line\nABCDE',
      'settings:save',
    ])
    expect(protocolClient.testConnection).toHaveBeenCalledWith({
      provider: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
      apiKey: 'sk-line\nABCDE',
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      signal: expect.any(AbortSignal),
    })
    expect(summary).toEqual({
      id: CONNECTION_ID,
      name: 'DeepSeek Primary',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
      apiKeyHint: '••••BCDE',
      status: 'connected',
      lastTestedAt: TESTED_AT,
      capabilityOverride: null,
    })
    expect(next.selectionTranslation).toEqual({
      connectionId: null,
      thinkingMode: 'disabled' as const, reasoningEffort: 'low',
      targetLanguage: 'auto',
      privacyNoticeAccepted: false,
    })
    expect(JSON.stringify(summary)).not.toContain('sk-line')
    expect(vault.secrets.get(CONNECTION_ID)).toBe('sk-line\nABCDE')
    expect(settings.get().models).toEqual(next)
  })

  it('persists neither a new secret nor metadata after a classified connection failure', async () => {
    const { save, service, settings, vault } = createHarness({
      testConnection: async () => { throw modelProtocolError('authentication-failed') },
    })

    await expect(service.connect(newConnectionInput)).rejects.toMatchObject({
      status: 'authentication-failed',
    })

    expect(save).not.toHaveBeenCalled()
    expect(vault.secrets.size).toBe(0)
    expect(settings.get().models).toBeUndefined()
  })

  it('persists a validated capability override with the connection', async () => {
    const { service } = createHarness()

    const result = await service.connect({
      ...newConnectionInput,
      capabilityOverride: {
        contextWindowTokens: 200_000,
        maxInputTokens: 180_000,
        maxOutputTokens: 40_000,
      },
    })

    expect(result.connections[0]?.capabilityOverride).toEqual({
      contextWindowTokens: 200_000,
      maxInputTokens: 180_000,
      maxOutputTokens: 40_000,
    })
  })

  it('uses manual thinking controls for both initial and saved connection tests', async () => {
    const { service, protocolClient } = createHarness()
    const thinking = { thinking: 'toggle' as const, encoding: 'enable-thinking' as const, efforts: [], disabledEfforts: [], defaultThinking: 'enabled' as const, defaultEffort: 'default' as const }
    const result = await service.connect({ ...newConnectionInput, modelId: 'future-model', capabilityOverride: { thinking } })
    await service.test(result.connections[0].id)
    expect(protocolClient.testConnection).toHaveBeenCalledTimes(2)
    for (const [request] of protocolClient.testConnection.mock.calls) {
      expect(request).toMatchObject({ capabilityOverride: { thinking }, thinkingMode: 'disabled', reasoningEffort: 'default' })
    }
    result.connections[0].capabilityOverride!.thinking!.defaultThinking = 'disabled'
    expect(service.getSettings().connections[0].capabilityOverride!.thinking!.defaultThinking).toBe('enabled')
  })

  it('leaves old metadata and secret exact after a classified edit failure', async () => {
    const original = modelSettings()
    const { save, service, settings, vault } = createHarness({
      initial: { lastWorkspace: null, models: original },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
      testConnection: async () => { throw modelProtocolError('model-not-found') },
    })

    await expect(service.connect({
      ...newConnectionInput,
      id: CONNECTION_ID,
      name: 'Edited',
      apiKey: 'new-secret',
    })).rejects.toMatchObject({ status: 'model-not-found' })

    expect(save).not.toHaveBeenCalled()
    expect(vault.secrets.get(CONNECTION_ID)).toBe('old-secret')
    expect(settings.get().models).toEqual(original)
  })

  it('replaces undecryptable old ciphertext when an edit supplies a new API key', async () => {
    const { vault } = await createUndecryptableVault()
    const settings = new SettingsCoordinator(
      { save: vi.fn().mockResolvedValue(undefined) },
      { lastWorkspace: null, models: modelSettings() },
    )
    const service = new ModelConnectionService(settings, vault, {
      streamChat: vi.fn(),
      testConnection: vi.fn().mockResolvedValue(undefined),
    }, {
      nowIso: () => TESTED_AT,
      createId: () => CONNECTION_ID,
    })

    const result = await service.connect({
      ...newConnectionInput,
      id: CONNECTION_ID,
      name: 'Replacement',
      apiKey: 'replacement-secret',
    })

    expect(result).toEqual({
      version: 6,
      codexCli: null,
      connections: [expect.objectContaining({
        id: CONNECTION_ID,
        name: 'Replacement',
        apiKeyHint: '••••cret',
      })],
      selectionTranslation: modelSettings().selectionTranslation,
      screenshotTranslation: modelSettings().screenshotTranslation,
      aiConversation: modelSettings().aiConversation,
    })
    await expect(vault.get(CONNECTION_ID)).resolves.toBe('replacement-secret')
  })

  it('deletes a connection whose old ciphertext cannot be decrypted', async () => {
    const { vault } = await createUndecryptableVault()
    const settings = new SettingsCoordinator(
      { save: vi.fn().mockResolvedValue(undefined) },
      { lastWorkspace: null, models: modelSettings() },
    )
    const service = new ModelConnectionService(settings, vault, {
      streamChat: vi.fn(),
      testConnection: vi.fn(),
    })

    await expect(service.delete(CONNECTION_ID)).resolves.toEqual({
      version: 6,
      codexCli: null,
      connections: [],
      selectionTranslation: modelSettings().selectionTranslation,
      screenshotTranslation: modelSettings().screenshotTranslation,
      aiConversation: modelSettings().aiConversation,
    })
    await expect(vault.get(CONNECTION_ID)).resolves.toBeNull()
  })

  it('rolls an undecryptable entry back to the exact original ciphertext', async () => {
    const { foreignCiphertext, root, vault } = await createUndecryptableVault()
    const settings = new SettingsCoordinator(
      { save: vi.fn().mockRejectedValue(new Error('disk full')) },
      { lastWorkspace: null, models: modelSettings() },
    )
    const service = new ModelConnectionService(settings, vault, {
      streamChat: vi.fn(),
      testConnection: vi.fn().mockResolvedValue(undefined),
    }, {
      nowIso: () => TESTED_AT,
      createId: () => CONNECTION_ID,
    })

    await expect(service.connect({
      ...newConnectionInput,
      id: CONNECTION_ID,
      apiKey: 'replacement-secret',
    })).rejects.toThrow('disk full')

    const persisted = JSON.parse(
      await readFile(path.join(root, 'model-secrets.json'), 'utf8'),
    ) as { secrets: Record<string, string> }
    expect(persisted.secrets[CONNECTION_ID]).toBe(foreignCiphertext)
  })

  it('preserves saved feature preferences when the edited model has unknown controls', async () => {
    const testEntered = deferred()
    const releaseTest = deferred()
    const supported = connection({
      provider: 'other',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-5-mini',
    })
    const { service, settings } = createHarness({
      initial: {
        lastWorkspace: null,
        models: {
          ...modelSettings([supported], {
            connectionId: CONNECTION_ID,
            thinkingMode: 'enabled' as const, reasoningEffort: 'high',
            targetLanguage: 'fr',
            privacyNoticeAccepted: true,
          }),
          screenshotTranslation: {
            connectionId: CONNECTION_ID,
            thinkingMode: 'enabled' as const, reasoningEffort: 'high',
            targetLanguage: 'fr',
          },
        },
      },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
      testConnection: async () => {
        testEntered.resolve()
        await releaseTest.promise
      },
    })

    const edit = service.connect({
      ...newConnectionInput,
      id: CONNECTION_ID,
      name: 'Unsupported after edit',
      apiKey: 'replacement-secret',
    })
    await testEntered.promise
    await settings.update((latest) => ({
      ...latest,
      models: {
        ...latest.models!,
        selectionTranslation: {
          ...latest.models!.selectionTranslation,
          targetLanguage: 'de',
        },
      },
    }))
    releaseTest.resolve()

    await expect(edit).resolves.toEqual({
      version: 6,
      codexCli: null,
      connections: [expect.objectContaining({
        id: CONNECTION_ID,
        name: 'Unsupported after edit',
      })],
      selectionTranslation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled' as const, reasoningEffort: 'high',
        targetLanguage: 'de',
        privacyNoticeAccepted: true,
      },
      screenshotTranslation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled' as const, reasoningEffort: 'high',
        targetLanguage: 'fr',
      },
      aiConversation: {
        connectionId: null,
        thinkingMode: 'default' as const, reasoningEffort: 'default',
        writePolicy: 'ask-every-time',
      },
    })
  })

  it('retains AI preference when an edit removes verified reasoning support', async () => {
    const initial = modelSettings(
      [reasoningConnection],
      {},
      { connectionId: reasoningConnection.id, thinkingMode: 'enabled' as const, reasoningEffort: 'high' },
    )
    const { service } = createHarness({
      initial: { lastWorkspace: null, models: initial },
      initialSecrets: { [reasoningConnection.id]: 'old-secret' },
    })

    await expect(service.connect({
      id: reasoningConnection.id,
      name: 'Edited unsupported',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
    })).resolves.toEqual({
      version: 6, codexCli: null,
      connections: [expect.objectContaining({
        id: reasoningConnection.id,
        name: 'Edited unsupported',
        provider: 'deepseek',
        modelId: 'deepseek-chat',
      })],
      selectionTranslation: initial.selectionTranslation,
      screenshotTranslation: initial.screenshotTranslation,
      aiConversation: {
        connectionId: reasoningConnection.id,
        thinkingMode: 'enabled' as const, reasoningEffort: 'high',
        writePolicy: 'ask-every-time',
      },
    })
  })

  it('reuses an old secret when an edit omits apiKey', async () => {
    const original = modelSettings()
    const { events, protocolClient, service, vault } = createHarness({
      initial: { lastWorkspace: null, models: original },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
    })

    const updated = await service.connect({
      id: CONNECTION_ID,
      name: 'Edited',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      modelId: 'deepseek-reasoner',
    })

    expect(protocolClient.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'old-secret' }),
    )
    expect(events).toEqual(['connection:test', 'settings:save'])
    expect(vault.secrets.get(CONNECTION_ID)).toBe('old-secret')
    expect(updated.connections[0]?.apiKeyHint).toBe('••••cret')
  })

  it('restores an old secret exactly when edited metadata cannot be saved', async () => {
    const { events, service, settings, vault } = createHarness({
      initial: { lastWorkspace: null, models: modelSettings() },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
      save: async () => { throw new Error('disk full') },
    })

    await expect(service.connect({
      ...newConnectionInput,
      id: CONNECTION_ID,
      apiKey: 'new-secret',
    })).rejects.toThrow('disk full')

    expect(events).toEqual([
      'connection:test',
      'secret:snapshot',
      'secret:set:new-secret',
      'settings:save',
      'secret:restore',
    ])
    expect(vault.secrets.get(CONNECTION_ID)).toBe('old-secret')
    expect(settings.get().models).toEqual(modelSettings())
  })

  it('serializes overlapping replacement edits so stale rollback cannot overwrite a newer key', async () => {
    const firstTestEntered = deferred()
    const releaseFirstTest = deferred()
    const { protocolClient, service, settings, vault } = createHarness({
      initial: { lastWorkspace: null, models: modelSettings() },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
      testConnection: async ({ apiKey }) => {
        if (apiKey === 'first-secret') {
          firstTestEntered.resolve()
          await releaseFirstTest.promise
        }
      },
      save: async (nextSettings) => {
        if (nextSettings.models?.connections[0]?.name === 'First edit') {
          throw new Error('first metadata save failed')
        }
      },
    })

    const firstResult = service.connect({
      ...newConnectionInput,
      id: CONNECTION_ID,
      name: 'First edit',
      apiKey: 'first-secret',
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    await firstTestEntered.promise
    const secondResult = service.connect({
      ...newConnectionInput,
      id: CONNECTION_ID,
      name: 'Second edit',
      apiKey: 'second-secret',
    })
    await flushMicrotasks()
    const callsBeforeRelease = protocolClient.testConnection.mock.calls.length
    releaseFirstTest.resolve()

    expect(String(await firstResult)).toContain('first metadata save failed')
    await expect(secondResult).resolves.toMatchObject({
      connections: [expect.objectContaining({ name: 'Second edit' })],
    })
    expect(callsBeforeRelease).toBe(1)
    expect(settings.get().models?.connections[0]?.name).toBe('Second edit')
    expect(vault.secrets.get(CONNECTION_ID)).toBe('second-secret')
  })

  it('serializes credential snapshots with connection edits so endpoint and secret stay paired', async () => {
    const snapshotReadEntered = deferred()
    const releaseSnapshotRead = deferred()
    const { protocolClient, service } = createHarness({
      initial: { lastWorkspace: null, models: modelSettings() },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
      vaultGet: async () => {
        snapshotReadEntered.resolve()
        await releaseSnapshotRead.promise
      },
    })

    const snapshotPromise = service.getCredentialSnapshot(CONNECTION_ID)
    await snapshotReadEntered.promise
    const editPromise = service.connect({
      ...newConnectionInput,
      id: CONNECTION_ID,
      name: 'Edited connection',
      baseUrl: 'https://new.example.com/v1',
      modelId: 'new-model',
      apiKey: 'new-secret',
    })
    await flushMicrotasks()

    expect(protocolClient.testConnection).not.toHaveBeenCalled()
    releaseSnapshotRead.resolve()
    await expect(snapshotPromise).resolves.toEqual({
      connection: connection(),
      apiKey: 'old-secret',
    })
    await expect(editPromise).resolves.toMatchObject({
      connections: [expect.objectContaining({
        baseUrl: 'https://new.example.com/v1',
        modelId: 'new-model',
      })],
    })
    await expect(service.getCredentialSnapshot(CONNECTION_ID)).resolves.toEqual({
      connection: expect.objectContaining({
        baseUrl: 'https://new.example.com/v1',
        modelId: 'new-model',
      }),
      apiKey: 'new-secret',
    })
  })

  it('serializes delete and edit so delete rollback cannot overwrite the edited key', async () => {
    const deleteSaveEntered = deferred()
    const releaseDeleteSave = deferred()
    const { protocolClient, service, settings, vault } = createHarness({
      initial: { lastWorkspace: null, models: modelSettings() },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
      save: async (nextSettings) => {
        if (nextSettings.models?.connections.length === 0) {
          deleteSaveEntered.resolve()
          await releaseDeleteSave.promise
          throw new Error('delete metadata save failed')
        }
      },
    })

    const deleteResult = service.delete(CONNECTION_ID).then(
      () => undefined,
      (error: unknown) => error,
    )
    await deleteSaveEntered.promise
    const editResult = service.connect({
      ...newConnectionInput,
      id: CONNECTION_ID,
      name: 'Edited after delete',
      apiKey: 'edited-secret',
    })
    await flushMicrotasks()
    const callsBeforeRelease = protocolClient.testConnection.mock.calls.length
    releaseDeleteSave.resolve()

    expect(String(await deleteResult)).toContain('delete metadata save failed')
    await expect(editResult).resolves.toMatchObject({
      connections: [expect.objectContaining({ name: 'Edited after delete' })],
    })
    expect(callsBeforeRelease).toBe(0)
    expect(settings.get().models?.connections[0]?.name).toBe('Edited after delete')
    expect(vault.secrets.get(CONNECTION_ID)).toBe('edited-secret')
  })

  it('allows a different connection transaction to proceed while one ID is blocked', async () => {
    const firstTestEntered = deferred()
    const releaseFirstTest = deferred()
    const secondConnection = connection({
      id: SECOND_CONNECTION_ID,
      name: 'Second',
      apiKeyHint: '••••cret',
    })
    const { service } = createHarness({
      initial: {
        lastWorkspace: null,
        models: modelSettings([connection(), secondConnection]),
      },
      initialSecrets: {
        [CONNECTION_ID]: 'first-old-secret',
        [SECOND_CONNECTION_ID]: 'second-old-secret',
      },
      testConnection: async ({ apiKey }) => {
        if (apiKey === 'first-new-secret') {
          firstTestEntered.resolve()
          await releaseFirstTest.promise
        }
      },
    })

    const firstEdit = service.connect({
      ...newConnectionInput,
      id: CONNECTION_ID,
      apiKey: 'first-new-secret',
    })
    await firstTestEntered.promise
    await expect(service.connect({
      ...newConnectionInput,
      id: SECOND_CONNECTION_ID,
      name: 'Second edited',
      apiKey: 'second-new-secret',
    })).resolves.toMatchObject({
      connections: expect.arrayContaining([
        expect.objectContaining({ name: 'Second edited' }),
      ]),
    })

    releaseFirstTest.resolve()
    await expect(firstEdit).resolves.toMatchObject({
      connections: expect.arrayContaining([expect.objectContaining({ id: CONNECTION_ID })]),
    })
  })

  it('restores a deleted key when deleting public metadata cannot be saved', async () => {
    const original = modelSettings()
    const { service, settings, vault } = createHarness({
      initial: { lastWorkspace: null, models: original },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
      save: async () => { throw new Error('disk full') },
    })

    await expect(service.delete(CONNECTION_ID)).rejects.toThrow('disk full')

    expect(vault.secrets.get(CONNECTION_ID)).toBe('old-secret')
    expect(settings.get().models).toEqual(original)
  })

  it('reports rollback failure without exposing nested secret-bearing errors', async () => {
    const { service } = createHarness({
      initial: { lastWorkspace: null, models: modelSettings() },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
      save: async () => { throw new Error('disk full') },
      vaultRestore: async (secret) => {
        throw new Error(`could not restore ${secret ?? 'missing secret'}`)
      },
    })

    const error = await service.connect({
      ...newConnectionInput,
      id: CONNECTION_ID,
      apiKey: 'new-secret',
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(AggregateError)
    expect(String(error)).toBe('Error: Could not roll back model secret after settings failure')
    expect(Reflect.ownKeys(error as object)).not.toContain('errors')
    expect(JSON.stringify(error)).not.toContain('old-secret')
  })

  it('removes a newly inserted secret when its metadata cannot be saved', async () => {
    const { events, service, settings, vault } = createHarness({
      save: async () => { throw new Error('disk full') },
    })

    await expect(service.connect(newConnectionInput)).rejects.toThrow('disk full')

    expect(events).toEqual([
      'connection:test',
      'secret:snapshot',
      'secret:set:sk-line\nABCDE',
      'settings:save',
      'secret:restore',
    ])
    expect(vault.secrets.size).toBe(0)
    expect(settings.get().models).toBeUndefined()
  })

  it('deletes the secret and connection while clearing every feature binding', async () => {
    const initial: LargeModelSettings = {
      ...modelSettings([connection()], {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled' as const, reasoningEffort: 'high',
        targetLanguage: 'fr',
        privacyNoticeAccepted: true,
      }),
      screenshotTranslation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled' as const, reasoningEffort: 'high',
        targetLanguage: 'fr',
      },
    }
    const { service, vault } = createHarness({
      initial: { lastWorkspace: null, models: initial },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
    })

    await expect(service.delete(CONNECTION_ID)).resolves.toMatchObject({
      version: 6,
      codexCli: null,
      connections: [],
      selectionTranslation: {
        connectionId: null,
        thinkingMode: 'disabled' as const, reasoningEffort: 'low',
        targetLanguage: 'fr',
        privacyNoticeAccepted: true,
      },
      screenshotTranslation: {
        connectionId: null,
        thinkingMode: 'disabled' as const, reasoningEffort: 'low',
        targetLanguage: 'fr',
      },
      aiConversation: {
        connectionId: null,
        thinkingMode: 'default' as const, reasoningEffort: 'default',
        writePolicy: 'ask-every-time',
      },
    })
    expect(vault.secrets.has(CONNECTION_ID)).toBe(false)
  })
})

describe('ModelConnectionService retest and feature settings', () => {
  it('persists and returns a connected retest without changing feature bindings', async () => {
    const initial = modelSettings([connection({ status: 'untested', lastTestedAt: null })], {
      connectionId: CONNECTION_ID,
      targetLanguage: 'ja',
      privacyNoticeAccepted: true,
    })
    const { service } = createHarness({
      initial: { lastWorkspace: null, models: initial },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
    })

    const summary = await service.test(CONNECTION_ID)

    expect(summary).toEqual(connection({ lastTestedAt: TESTED_AT }))
    expect(service.getSettings().selectionTranslation).toEqual(initial.selectionTranslation)
  })

  it('persists and returns a classified retest failure without changing feature bindings', async () => {
    const initial = modelSettings([connection()], {
      connectionId: CONNECTION_ID,
      targetLanguage: 'ja',
      privacyNoticeAccepted: true,
    })
    const { service } = createHarness({
      initial: { lastWorkspace: null, models: initial },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
      testConnection: async () => { throw modelProtocolError('rate-limited') },
    })

    await expect(service.test(CONNECTION_ID)).resolves.toEqual(connection({
      status: 'rate-limited',
      lastTestedAt: TESTED_AT,
    }))
    expect(service.getSettings().selectionTranslation).toEqual(initial.selectionTranslation)
  })

  it('rejects a local retest failure without persisting it as provider status', async () => {
    const original = modelSettings([connection({ status: 'untested', lastTestedAt: null })])
    const { save, service, settings } = createHarness({
      initial: { lastWorkspace: null, models: original },
      initialSecrets: { [CONNECTION_ID]: 'old-secret' },
      testConnection: async () => { throw new Error('local client failure') },
    })

    await expect(service.test(CONNECTION_ID)).rejects.toThrow('local client failure')

    expect(save).not.toHaveBeenCalled()
    expect(settings.get().models).toEqual(original)
  })

  it('rejects an unknown feature connection without saving settings', async () => {
    const { save, service } = createHarness({
      initial: { lastWorkspace: null, models: modelSettings() },
    })

    await expect(service.setSelectionTranslation({
      connectionId: SECOND_CONNECTION_ID,
      thinkingMode: 'enabled' as const, reasoningEffort: 'low',
      targetLanguage: 'fr',
    })).rejects.toThrow('Unknown model connection')
    expect(save).not.toHaveBeenCalled()
  })

  it('rejects an unknown AI conversation connection without saving settings', async () => {
    const { save, service } = createHarness({
      initial: { lastWorkspace: null, models: modelSettings() },
    })

    await expect(service.setAiConversation({
      connectionId: SECOND_CONNECTION_ID,
      thinkingMode: 'enabled' as const, reasoningEffort: 'low',
      writePolicy: 'document-grant',
    })).rejects.toThrow('Unknown model connection')
    expect(save).not.toHaveBeenCalled()
  })

  it('preserves unsupported preference, target language, and privacy acceptance for encoder suppression', async () => {
    const { service } = createHarness({
      initial: {
        lastWorkspace: null,
        models: modelSettings([connection()], { privacyNoticeAccepted: true }),
      },
    })

    await expect(service.setSelectionTranslation({
      connectionId: CONNECTION_ID,
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      targetLanguage: 'fr',
    })).resolves.toEqual({
      version: 6,
      codexCli: null,
      connections: [connection()],
      selectionTranslation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled' as const, reasoningEffort: 'high',
        targetLanguage: 'fr',
        privacyNoticeAccepted: true,
      },
      screenshotTranslation: modelSettings().screenshotTranslation,
      aiConversation: modelSettings().aiConversation,
    })
  })

  it('assigns AI conversation and persists supported reasoning effort', async () => {
    const { service } = createHarness({
      initial: {
        lastWorkspace: null,
        models: modelSettings([reasoningConnection]),
      },
    })

    await expect(service.setAiConversation({
      connectionId: reasoningConnection.id,
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      writePolicy: 'workspace-grant',
    })).resolves.toEqual({
      version: 6, codexCli: null,
      connections: [reasoningConnection],
      selectionTranslation: modelSettings().selectionTranslation,
      screenshotTranslation: modelSettings().screenshotTranslation,
      aiConversation: {
        connectionId: reasoningConnection.id,
        thinkingMode: 'enabled' as const, reasoningEffort: 'high',
        writePolicy: 'workspace-grant',
      },
    })
  })

  it('preserves unsupported AI preference for encoder suppression', async () => {
    const { service } = createHarness({
      initial: {
        lastWorkspace: null,
        models: modelSettings([connection()]),
      },
    })

    await expect(service.setAiConversation({
      connectionId: CONNECTION_ID,
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      writePolicy: 'document-grant',
    })).resolves.toEqual({
      version: 6, codexCli: null,
      connections: [connection()],
      selectionTranslation: modelSettings().selectionTranslation,
      screenshotTranslation: modelSettings().screenshotTranslation,
      aiConversation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled' as const, reasoningEffort: 'high',
        writePolicy: 'document-grant',
      },
    })
  })

  it('updates screenshot settings without changing selection settings', async () => {
    const initial = modelSettings([connection()], {
      connectionId: CONNECTION_ID,
      targetLanguage: 'de',
      privacyNoticeAccepted: true,
    })
    const { service } = createHarness({
      initial: { lastWorkspace: null, models: initial },
    })

    await expect(service.setScreenshotTranslation({
      connectionId: CONNECTION_ID,
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      targetLanguage: 'fr',
    })).resolves.toEqual({
      ...initial,
      screenshotTranslation: {
        connectionId: CONNECTION_ID,
        thinkingMode: 'enabled' as const, reasoningEffort: 'high',
        targetLanguage: 'fr',
      },
    })
  })

  it('accepts the privacy notice by changing only its boolean', async () => {
    const initial = modelSettings([connection()], {
      connectionId: CONNECTION_ID,
      thinkingMode: 'enabled' as const, reasoningEffort: 'medium',
      targetLanguage: 'de',
      privacyNoticeAccepted: false,
    })
    const { service } = createHarness({
      initial: { lastWorkspace: null, models: initial },
    })

    await expect(service.acceptTranslationPrivacyNotice()).resolves.toEqual({
      ...initial,
      selectionTranslation: {
        ...initial.selectionTranslation,
        privacyNoticeAccepted: true,
      },
    })
  })

  it('clears AI conversation when its connection is deleted', async () => {
    const initial = modelSettings(
      [reasoningConnection],
      {},
      { connectionId: reasoningConnection.id, thinkingMode: 'enabled' as const, reasoningEffort: 'high' },
    )
    const { service } = createHarness({
      initial: { lastWorkspace: null, models: initial },
      initialSecrets: { [reasoningConnection.id]: 'old-secret' },
    })

    await expect(service.delete(reasoningConnection.id)).resolves.toEqual({
      version: 6, codexCli: null,
      connections: [],
      selectionTranslation: modelSettings([], {
        connectionId: null,
        thinkingMode: 'default' as const, reasoningEffort: 'default',
        targetLanguage: 'auto',
        privacyNoticeAccepted: false,
      }).selectionTranslation,
      screenshotTranslation: modelSettings([], {}, {}).screenshotTranslation,
      aiConversation: {
        connectionId: null,
        thinkingMode: 'default' as const, reasoningEffort: 'default',
        writePolicy: 'ask-every-time',
      },
    })
  })
})

it.each(['openai', 'anthropic'] as const)('lists and saves Hy via real preload, IPC, service and %s protocol using only a fetch stub', async (protocol) => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init })
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: [{ id: 'hy-fixture' }] }), { status: 200 })
    const payload = protocol === 'openai'
      ? { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }
      : { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } }
    return new Response('data: ' + JSON.stringify(payload) + '\n\n' + (protocol === 'openai' ? 'data: [DONE]\n\n' : 'event: message_stop\ndata: {"type":"message_stop"}\n\n'), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof fetch
  const { service } = await transactionalModelFixture(DEFAULT_LARGE_MODEL_SETTINGS,
    createModelProtocolClient(fetchImpl), createModelCatalogClient(fetchImpl),
    { createId: () => CONNECTION_ID, nowIso: () => TESTED_AT })
  const operations = createIpcOperations({ chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never,
    observedModelConnections: service, getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn() })
  const api = createArkdownApi(async (channel, input) => {
    if (channel === IPC_CHANNELS.listModels) return operations.listModels(input)
    if (channel === IPC_CHANNELS.connectModel) return operations.connectModel(input)
    if (channel === IPC_CHANNELS.getLargeModelSettings) return operations.getLargeModelSettings()
    throw new Error('Unexpected IPC channel')
  })
  const input = { provider: 'hy' as const, protocol, baseUrl: 'https://tokenhub.tencentmaas.com/v1', apiKey: 'stub-only-key' }
  const observed = await service.getSettings()
  await expect(api.listModels(input, observed)).resolves.toEqual({ ok: true, value: { status: 'catalog', catalog: { models: ['hy-fixture'], recommendedModelId: 'hy-fixture' } } })
  const connected = await api.connectModel({ ...input, name: 'Hy', accessType: 'standard-api', modelId: 'hy-fixture' }, observed)
  expect(connected).toMatchObject({ ok: true, value: { status: 'committed', snapshot: { settings: { version: 6, connections: [{ provider: 'hy', protocol,
    baseUrl: 'https://tokenhub.tencentmaas.com/v1', modelId: 'hy-fixture', status: 'connected' }] } } } })
  if (!connected.ok) throw new Error('Synthetic connection failed')
  await expect(api.getLargeModelSettings()).resolves.toEqual({ ok: true, value: connected.value.snapshot.settings })
  expect(requests.map(({ url }) => url)).toEqual(['https://tokenhub.tencentmaas.com/v1/models',
    protocol === 'openai' ? 'https://tokenhub.tencentmaas.com/v1/chat/completions' : 'https://tokenhub.tencentmaas.com/v1/messages'])
  expect(requests[0]?.init).toMatchObject({ method: 'GET', headers: { authorization: 'Bearer stub-only-key' } })
  const body = JSON.parse(String(requests[1]?.init?.body))
  expect(body).toMatchObject({ model: 'hy-fixture', messages: [{ role: 'user', content: 'Reply with OK only.' }] })
  expect(body).not.toHaveProperty('thinking')
  expect(body).not.toHaveProperty('reasoning_effort')
})
