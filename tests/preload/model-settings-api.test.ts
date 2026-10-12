import { describe, expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { modelProtocolError } from '../../src/main/models/model-errors'
import type { ConnectModelInput } from '../../src/main/models/model-connection-service'
import { ModelSecretVaultError } from '../../src/main/models/model-secret-vault'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import type {
  LargeModelSettings,
  ModelConnectionSummary,
} from '../../src/shared/large-model-settings'

import type { PublicModelSettingsSnapshot } from '../../src/shared/settings-observation'
import type { ObservedCodexTestResult } from '../../src/shared/model-settings-commands'

const CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440000'

function connection(): ModelConnectionSummary {
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
    lastTestedAt: '2026-07-30T08:00:00.000Z',
    capabilityOverride: null,
  }
}

const connectInput: ConnectModelInput = {
  name: 'DeepSeek',
  provider: 'deepseek',
  accessType: 'standard-api',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com',
  modelId: 'deepseek-chat',
  apiKey: 'sk-private',
}

function settings(): LargeModelSettings {
  return {
    version: 6,
    codexCli: null,
    connections: [connection()],
    selectionTranslation: {
      connectionId: CONNECTION_ID,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'ja',
      privacyNoticeAccepted: true,
    },
    screenshotTranslation: {
      connectionId: CONNECTION_ID,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'ja',
    },
    aiConversation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      writePolicy: 'ask-every-time',
    },
  }
}

function connectedCodexSettings(): LargeModelSettings {
  return {
    ...settings(),
    codexCli: {
      cliVersion: 'codex-cli 0.144.1',
      status: 'connected',
      lastTestedAt: '2026-09-01T00:00:00.000Z',
    },
  }
}

function observed(value = settings()): PublicModelSettingsSnapshot {
  return { settings: value, observation: { version: 1, revision: 2, minimumBaseRevision: 0, fields: {}, connections: { [CONNECTION_ID]: { entity: 2 } } } }
}
function committed(value = settings()) { return { status: 'committed' as const, snapshot: observed(value) } }
function tested() { return { mutation: committed(), error: null } }
function connectedCodexResult(): ObservedCodexTestResult {
  return { status: 'connected', mutation: committed(connectedCodexSettings()) }
}

const invalidResponse = {
  ok: false,
  error: { code: 'INVALID_RESPONSE', message: '响应数据无效' },
}

describe('large-model preload API', () => {
  it('round-trips the floating binding through its dedicated channel and rejects extra keys', async () => {
    const floatingTranslation = { connectionId: CONNECTION_ID, thinkingMode: 'disabled' as const, reasoningEffort: 'low' as const }
    const value = committed({ ...settings(), floatingTranslation })
    const invoke = vi.fn(async () => ({ ok: true, value }))
    const api = createArkdownApi(invoke)
    expect(await api.setFloatingTranslationSettings(floatingTranslation, observed())).toEqual({ ok: true, value })
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.setFloatingTranslationSettings, { observed: observed(), input: floatingTranslation })
    expect((await api.setFloatingTranslationSettings({ ...floatingTranslation, targetLanguage: 'auto' } as never, observed())).ok).toBe(false)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect((await api.setFloatingTranslationSettings({ reasoningEffort: 'high' }, observed())).ok).toBe(true)
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.setFloatingTranslationSettings, { observed: observed(), input: { reasoningEffort: 'high' } })
    for (const invalid of [{}, { connectionId: undefined }, { reasoningEffort: 'invalid' }]) {
      expect((await api.setFloatingTranslationSettings(invalid as never, observed())).ok).toBe(false)
    }
    expect(invoke).toHaveBeenCalledTimes(2)
    expect((await api.setFloatingTranslationSettings({ target: 'jp' }, observed())).ok).toBe(true)
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.setFloatingTranslationSettings, { observed: observed(), input: { target: 'jp' } })
    for (const invalid of [{ target: undefined }, { target: 'ja' }, { target: null }]) {
      expect((await api.setFloatingTranslationSettings(invalid as never, observed())).ok).toBe(false)
    }
    expect(invoke).toHaveBeenCalledTimes(3)
  })
  it('exposes a screenshot translation mutation method', () => {
    const api = createArkdownApi(vi.fn())

    expect(api).toHaveProperty('setScreenshotTranslationSettings')
  })

  it('uses ten fixed channels and omits payloads for no-input operations', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: settings() })
      .mockResolvedValueOnce({ ok: true, value: committed() })
      .mockResolvedValueOnce({
        ok: true,
        value: { status: 'catalog', catalog: { models: ['deepseek-chat'], recommendedModelId: 'deepseek-chat' } },
      })
      .mockResolvedValueOnce({ ok: true, value: tested() })
      .mockResolvedValueOnce({ ok: true, value: committed() })
      .mockResolvedValueOnce({ ok: true, value: connectedCodexResult() })
      .mockResolvedValueOnce({ ok: true, value: committed() })
      .mockResolvedValueOnce({ ok: true, value: committed() })
      .mockResolvedValueOnce({ ok: true, value: committed() })
      .mockResolvedValueOnce({ ok: true, value: committed() })
    const api = createArkdownApi(invoke)
    const connectInput = {
      name: 'DeepSeek',
      provider: 'deepseek' as const,
      accessType: 'standard-api' as const,
      protocol: 'openai' as const,
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
      apiKey: 'sk-private',
    }
    const featureInput = {
      connectionId: CONNECTION_ID,
      thinkingMode: 'default' as const, reasoningEffort: 'default' as const,
      targetLanguage: 'ja' as const,
    }

    await expect(api.getLargeModelSettings!()).resolves.toEqual({
      ok: true,
      value: settings(),
    })
    await expect(api.connectModel!(connectInput, observed())).resolves.toEqual({
      ok: true,
      value: committed(),
    })
    await expect(api.listModels!({
      provider: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-private',
    }, observed())).resolves.toEqual({
      ok: true,
      value: { status: 'catalog', catalog: {
        models: ['deepseek-chat'],
        recommendedModelId: 'deepseek-chat',
      } },
    })
    await expect(api.testModel!(CONNECTION_ID, observed())).resolves.toEqual({
      ok: true,
      value: tested(),
    })
    await expect(api.deleteModel!(CONNECTION_ID, observed())).resolves.toEqual({
      ok: true,
      value: committed(),
    })
    await expect(api.testCodexCliConnection(observed())).resolves.toEqual({
      ok: true,
      value: connectedCodexResult(),
    })
    await expect(api.removeCodexCliConnection(observed())).resolves.toEqual({
      ok: true,
      value: committed(),
    })
    await expect(api.setSelectionTranslationSettings!(featureInput, observed())).resolves.toEqual({
      ok: true,
      value: committed(),
    })
    await expect(api.setScreenshotTranslationSettings(featureInput, observed())).resolves.toEqual({
      ok: true,
      value: committed(),
    })
    await expect(api.acceptTranslationPrivacyNotice!(observed())).resolves.toEqual({
      ok: true,
      value: committed(),
    })

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.getLargeModelSettings],
      [IPC_CHANNELS.connectModel, { observed: observed(), input: connectInput }],
      [IPC_CHANNELS.listModels, { observed: observed(), input: {
        provider: 'deepseek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-private',
      } }],
      [IPC_CHANNELS.testModel, { observed: observed(), input: { connectionId: CONNECTION_ID } }],
      [IPC_CHANNELS.deleteModel, { observed: observed(), input: { connectionId: CONNECTION_ID } }],
      [IPC_CHANNELS.testCodexCliConnection, { observed: observed() }],
      [IPC_CHANNELS.removeCodexCliConnection, { observed: observed() }],
      [IPC_CHANNELS.setSelectionTranslationSettings, { observed: observed(), input: featureInput }],
      [IPC_CHANNELS.setScreenshotTranslationSettings, { observed: observed(), input: featureInput }],
      [IPC_CHANNELS.acceptTranslationPrivacyNotice, { observed: observed() }],
    ])
  })

  it('reconstructs exact Codex CLI results and rejects malformed responses', async () => {
    const rawResult = connectedCodexResult()
    const validApi = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value: rawResult }))

    const result = await validApi.testCodexCliConnection(observed())

    expect(result).toEqual({ ok: true, value: connectedCodexResult() })
    expect(result.ok && result.value).not.toBe(rawResult)
    if (result.ok) expect(result.value.mutation.snapshot.settings).not.toBe(rawResult.mutation.snapshot.settings)

    const malformedResults: unknown[] = [
      { ...connectedCodexResult(), extra: true },
      { ...connectedCodexResult(), status: 'unknown' },
      {
        ...connectedCodexResult(),
        mutation: { ...committed(connectedCodexSettings()), snapshot: { ...observed(connectedCodexSettings()), settings: { ...connectedCodexSettings(), rawOutput: 'private diagnostics' } } },
      },
      Object.create(connectedCodexResult()),
    ]
    for (const value of malformedResults) {
      const api = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value }))
      await expect(api.testCodexCliConnection(observed())).resolves.toEqual(invalidResponse)
    }
  })

  it('validates Codex CLI removal settings with the exact shared parser', async () => {
    const validApi = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value: committed() }))
    await expect(validApi.removeCodexCliConnection(observed())).resolves.toEqual({
      ok: true,
      value: committed(),
    })

    const malformedApi = createArkdownApi(vi.fn().mockResolvedValue({
      ok: true,
      value: { ...committed(), snapshot: { ...observed(), settings: { ...settings(), command: 'codex' } } },
    }))
    await expect(malformedApi.removeCodexCliConnection(observed())).resolves.toEqual(invalidResponse)
  })

  it('reconstructs valid public values without exposing an apiKey property', async () => {
    const rawSettings = settings()
    const rawSummary = tested()
    const invoke = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: rawSettings })
      .mockResolvedValueOnce({ ok: true, value: rawSummary })
    const api = createArkdownApi(invoke)

    const settingsResult = await api.getLargeModelSettings!()
    const summaryResult = await api.testModel!(CONNECTION_ID, observed())

    expect(settingsResult).toEqual({ ok: true, value: settings() })
    expect(summaryResult).toEqual({ ok: true, value: tested() })
    expect(settingsResult.ok && settingsResult.value).not.toBe(rawSettings)
    expect(summaryResult.ok && summaryResult.value).not.toBe(rawSummary)
    expect(JSON.stringify([settingsResult, summaryResult])).not.toContain('"apiKey"')
    if (settingsResult.ok) {
      expect(settingsResult.value.connections[0]).not.toHaveProperty('apiKey')
    }
    if (summaryResult.ok) expect(summaryResult.value.mutation.snapshot.settings.connections[0]).not.toHaveProperty('apiKey')
  })

  it('strictly validates capability overrides and max AI settings before invoking main', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: committed() })
    const api = createArkdownApi(invoke)
    const validAiSettings = {
      connectionId: CONNECTION_ID,
      thinkingMode: 'enabled' as const, reasoningEffort: 'max' as const,
      writePolicy: 'workspace-grant' as const,
    }

    await expect(api.setAiConversationSettings!(validAiSettings, observed())).resolves.toEqual({
      ok: true,
      value: committed(),
    })
    await expect(api.connectModel!({
      ...connectInput,
      capabilityOverride: {
        contextWindowTokens: 100,
        maxInputTokens: 101,
      },
    }, observed())).resolves.toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: '请求参数无效' },
    })
    await expect(api.connectModel!({
      ...connectInput,
      capabilityOverride: {
        contextWindowTokens: 100,
        maxInputTokens: undefined,
      },
    }, observed())).resolves.toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: '请求参数无效' },
    })
    await expect(api.connectModel!({
      ...connectInput,
      capabilityOverride: {
        contextWindowTokens: 100,
        maxOutputTokens: undefined,
      },
    }, observed())).resolves.toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: '请求参数无效' },
    })
    await expect(api.setAiConversationSettings!({
      ...validAiSettings,
      writePolicy: 'persisted-grant',
    } as never, observed())).resolves.toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT', message: '请求参数无效' },
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('parses exact selection and screenshot settings before invoking main', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: committed() })
    const api = createArkdownApi(invoke)
    const valid = {
      connectionId: CONNECTION_ID,
      thinkingMode: 'enabled' as const, reasoningEffort: 'max' as const,
      targetLanguage: 'fr' as const,
    }

    await expect(api.setSelectionTranslationSettings!(valid, observed())).resolves.toEqual({
      ok: true,
      value: committed(),
    })
    await expect(api.setScreenshotTranslationSettings(valid, observed())).resolves.toEqual({
      ok: true,
      value: committed(),
    })
    expect(invoke.mock.calls[0]?.[1]).toEqual({ observed: observed(), input: valid })
    expect(invoke.mock.calls[0]?.[1]?.input).not.toBe(valid)
    expect(invoke.mock.calls[1]?.[1]).toEqual({ observed: observed(), input: valid })
    expect(invoke.mock.calls[1]?.[1]?.input).not.toBe(valid)
  })

  it('rejects inherited, extra, and invalid feature settings before invoking main', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: committed() })
    const api = createArkdownApi(invoke)
    const valid = {
      connectionId: CONNECTION_ID,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'fr',
    }
    const malformed: unknown[] = [
      Object.create(valid),
      { ...valid, extra: true },
      { ...valid, connectionId: 'not-a-uuid' },
      { ...valid, targetLanguage: 'klingon' },
      { ...valid, thinkingMode: 'default' as const, reasoningEffort: 'extreme' },
    ]

    for (const value of malformed) {
      await expect(api.setSelectionTranslationSettings!(value as never, observed())).resolves.toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT', message: '请求参数无效' },
      })
      await expect(api.setScreenshotTranslationSettings(value as never, observed())).resolves.toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT', message: '请求参数无效' },
      })
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('returns INVALID_RESPONSE for malformed public summaries', async () => {
    const malformedSummaries: unknown[] = [
      { ...connection(), apiKey: 'sk-leaked' },
      { ...connection(), apiKeyHint: 'sk-leaked' },
      { ...connection(), id: 'not-a-uuid' },
      { ...connection(), baseUrl: 'http://api.example.com/v1' },
      { ...connection(), status: 'unknown' },
      { ...connection(), lastTestedAt: 'not-a-date' },
      {
        ...connection(),
        capabilityOverride: { contextWindowTokens: 100, maxOutputTokens: 101 },
      },
      Object.create(connection()),
    ]

    for (const value of malformedSummaries) {
      const malformedMutation = { status: 'committed', snapshot: { ...observed(), settings: { ...settings(), connections: [value] } } }
      const summaryApi = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value: { mutation: malformedMutation, error: null } }))
      await expect(summaryApi.testModel!(CONNECTION_ID, observed())).resolves.toEqual(invalidResponse)

      const connectApi = createArkdownApi(vi.fn().mockResolvedValue({
        ok: true,
        value: malformedMutation,
      }))
      await expect(connectApi.connectModel!({
        name: 'DeepSeek',
        provider: 'deepseek',
        accessType: 'standard-api',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        modelId: 'deepseek-chat',
        apiKey: 'sk-private',
      }, observed())).resolves.toEqual(invalidResponse)
    }
  })

  it('returns INVALID_RESPONSE for malformed settings and nested inherited values', async () => {
    const inheritedSelection = Object.create(settings().selectionTranslation)
    const malformedSettings: unknown[] = [
      { ...settings(), apiKey: 'sk-leaked' },
      { ...settings(), connections: [{ ...connection(), apiKey: 'sk-leaked' }] },
      { ...settings(), connections: Object.assign([connection()], { extra: true }) },
      { ...settings(), selectionTranslation: inheritedSelection },
      { ...settings(), connections: [connection(), { ...connection(), name: 'Duplicate ID' }] },
      { ...settings(), connections: [{ ...connection(), name: ' DeepSeek ' }] },
      { ...settings(), connections: [{ ...connection(), lastTestedAt: '2026-07-30' }] },
      {
        ...settings(),
        selectionTranslation: {
          ...settings().selectionTranslation,
          targetLanguage: 'klingon',
        },
      },
      {
        ...settings(),
        selectionTranslation: {
          ...settings().selectionTranslation,
          connectionId: 'not-a-uuid',
        },
      },
    ]

    for (const value of malformedSettings) {
      const api = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value }))
      await expect(api.getLargeModelSettings!()).resolves.toEqual(invalidResponse)
    }
  })

  it.each([
    [
      modelProtocolError('authentication-failed'),
      'MODEL_AUTHENTICATION_FAILED',
      '大模型认证失败',
    ],
    [
      modelProtocolError('model-not-found'),
      'MODEL_NOT_FOUND',
      '未找到配置的大模型',
    ],
    [
      modelProtocolError('invalid-endpoint'),
      'MODEL_INVALID_ENDPOINT',
      '大模型接口地址无效或不可用',
    ],
    [
      modelProtocolError('timeout'),
      'MODEL_TIMEOUT',
      '大模型请求超时',
    ],
    [
      modelProtocolError('rate-limited'),
      'MODEL_RATE_LIMITED',
      '大模型服务商请求过于频繁',
    ],
    [
      modelProtocolError('quota-exceeded'),
      'MODEL_QUOTA_EXCEEDED',
      '大模型账户余额或配额不足',
    ],
    [
      modelProtocolError('incompatible-response'),
      'MODEL_INCOMPATIBLE_RESPONSE',
      '大模型服务返回的响应格式不兼容',
    ],
    [
      new ModelSecretVaultError('ENCRYPTION_UNAVAILABLE'),
      'MODEL_ENCRYPTION_UNAVAILABLE',
      'Windows 加密不可用',
    ],
    [
      new ModelSecretVaultError('DECRYPTION_FAILED'),
      'MODEL_SECRET_UNAVAILABLE',
      '无法读取已保存的大模型 API Key，请重新输入',
    ],
    [
      new ModelSecretVaultError('VAULT_MALFORMED'),
      'MODEL_SECRET_STORAGE_FAILED',
      '大模型 API Key 存储失败',
    ],
    [
      new ModelSecretVaultError('VAULT_READ_FAILED'),
      'MODEL_SECRET_STORAGE_FAILED',
      '大模型 API Key 存储失败',
    ],
    [
      new ModelSecretVaultError('VAULT_WRITE_FAILED'),
      'MODEL_SECRET_STORAGE_FAILED',
      '大模型 API Key 存储失败',
    ],
  ])('preserves classified fixed errors through main IPC and preload', async (
    classifiedError,
    expectedCode,
    expectedMessage,
  ) => {
    Object.assign(classifiedError, {
      privateHeaders: { authorization: 'Bearer sk-private' },
      upstreamBody: '{"account":"private-provider-body"}',
    })
    const observedModelConnections = {
      getSettings: vi.fn(async () => observed()),
      listModels: vi.fn(),
      connect: vi.fn(async () => { throw classifiedError }),
      test: vi.fn(),
      delete: vi.fn(),
      setFeature: vi.fn(),
      acceptTranslationPrivacyNotice: vi.fn(),
    }
    const operations = createIpcOperations({
      chooseDirectory: vi.fn(),
      workspace: {} as never,
      documents: {} as never,
      observedModelConnections,
      getLastWorkspace: () => null,
      setLastWorkspace: vi.fn(),
      reportError: vi.fn(),
    })
    const api = createArkdownApi(async (channel, input) => {
      if (channel !== IPC_CHANNELS.connectModel) throw new Error('unexpected channel')
      return operations.connectModel(input)
    })

    const result = await api.connectModel(connectInput, observed())

    expect(result).toEqual({
      ok: false,
      error: { code: expectedCode, message: expectedMessage },
    })
    expect(observedModelConnections.connect).toHaveBeenCalledExactlyOnceWith(observed(), connectInput)
    expect(JSON.stringify(result)).not.toContain('sk-private')
    expect(JSON.stringify(result)).not.toContain('private-provider-body')
    expect(JSON.stringify(result)).not.toContain('authorization')
  })

  it('contains transport failures separately from malformed model responses', async () => {
    const api = createArkdownApi(vi.fn().mockRejectedValue(
      new Error('sk-private at C:\\private\\transport.ts'),
    ))

    await expect(api.getLargeModelSettings!()).resolves.toEqual({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
    })
  })
})
