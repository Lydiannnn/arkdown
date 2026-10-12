import { modelObservation, modelCommit } from '../helpers/model-observation'
import type { TransactionalModelConnectionService } from '../../src/main/models/transactional-model-connection-service'
import type { ObservedCodexTestResult } from '../../src/shared/model-settings-commands'
import { describe, expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import type {
  ConnectModelInput,
  FeatureSettingsInput,
} from '../../src/main/models/model-connection-service'
import type {
  LargeModelSettings,
  ModelConnectionSummary,
} from '../../src/shared/large-model-settings'

const CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440000'
const UNKNOWN_CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440001'

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

function settings(): LargeModelSettings {
  return {
    version: 6,
    codexCli: null,
    connections: [connection()],
    selectionTranslation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'auto',
      privacyNoticeAccepted: false,
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

function createHarness(runtimeHooks: Pick<Parameters<typeof createIpcOperations>[0], 'ensureCodexCli' | 'startCodexCliLogin' | 'cancelCodexCliLogin'> = {}) {
  const modelConnections = {
    getSettings: vi.fn(async () => modelObservation(settings())),
    listModels: vi.fn<TransactionalModelConnectionService['listModels']>(async () => ({ status: 'catalog', catalog: { models: ['deepseek-chat'], recommendedModelId: 'deepseek-chat' } })),
    connect: vi.fn<TransactionalModelConnectionService['connect']>(async () => modelCommit(settings())),
    test: vi.fn<TransactionalModelConnectionService['test']>(async () => ({ mutation: modelCommit(settings()) })),
    delete: vi.fn<TransactionalModelConnectionService['delete']>(async () => modelCommit(settings())),
    setFeature: vi.fn<TransactionalModelConnectionService['setFeature']>(async () => modelCommit(settings())),
    acceptTranslationPrivacyNotice: vi.fn(async () => modelCommit(settings())),
  }
  const codexCliConnections = {
    test: vi.fn(async (): Promise<ObservedCodexTestResult> => ({ status: 'connected', mutation: modelCommit(connectedCodexSettings()) })),
    remove: vi.fn(async () => modelCommit(settings())),
  }
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(),
    workspace: {} as never,
    documents: {} as never,
    observedModelConnections: modelConnections,
    observedCodexCliConnections: codexCliConnections,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    ...runtimeHooks,
  })
  return { codexCliConnections, modelConnections, operations }
}

const newConnectionInput = {
  name: 'DeepSeek',
  provider: 'deepseek',
  accessType: 'standard-api',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com',
  modelId: 'deepseek-chat',
  apiKey: 'sk-private',
} as const

describe('large-model IPC operations', () => {
  it('waits for old process cancellation before starting a replacement login', async () => {
    let finishCancel!: () => void
    const cancellation = new Promise<void>(resolve => { finishCancel = resolve })
    const start = vi.fn(async () => ({ status: 'cancelled' as const }))
    const h = createHarness({ ensureCodexCli: async () => true, startCodexCliLogin: start, cancelCodexCliLogin: () => cancellation })
    const cancelling = h.operations.cancelCodexCliLogin()
    const reopened = h.operations.startCodexCliLogin({ observed: modelObservation(settings()) })
    await Promise.resolve(); await Promise.resolve()
    expect(start).not.toHaveBeenCalled()
    finishCancel()
    await cancelling
    expect(await reopened).toEqual({ ok: true, value: { status: 'cancelled' } })
    expect(start).toHaveBeenCalledOnce()
  })
  it('does not report completion when cancellation arrives during the post-login model refresh', async () => {
    const h = createHarness({ ensureCodexCli: async () => true, startCodexCliLogin: async () => ({ status: 'completed' }) })
    let finish!: (value: ObservedCodexTestResult) => void
    h.codexCliConnections.test.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = h.operations.startCodexCliLogin({ observed: modelObservation(settings()) })
    await vi.waitFor(() => expect(h.codexCliConnections.test).toHaveBeenCalledOnce())
    await h.operations.cancelCodexCliLogin()
    finish({ status: 'connected', mutation: modelCommit(connectedCodexSettings()) })
    expect(await pending).toEqual({ ok: true, value: { status: 'cancelled' } })
  })
  it('does not open a browser after login is canceled while the runtime is being prepared', async () => {
    let ready!: (value: boolean) => void
    const start = vi.fn(async () => ({ status: 'completed' as const }))
    const h = createHarness({ ensureCodexCli: () => new Promise<boolean>(resolve => { ready = resolve }), startCodexCliLogin: start })
    const pending = h.operations.startCodexCliLogin({ observed: modelObservation(settings()) })
    await h.operations.cancelCodexCliLogin()
    ready(true)
    expect(await pending).toEqual({ ok: true, value: { status: 'cancelled' } })
    expect(start).not.toHaveBeenCalled()
    expect(h.codexCliConnections.test).not.toHaveBeenCalled()
  })
  it('prepares the CLI runtime before an explicit connection check', async () => {
    const ensure = vi.fn(async () => true)
    const h = createHarness({ ensureCodexCli: ensure })
    expect((await h.operations.testCodexCliConnection({ observed: modelObservation(settings()) })).ok).toBe(true)
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(h.codexCliConnections.test.mock.invocationCallOrder[0])
  })
  it('does not start login or a health check when component preparation is canceled', async () => {
    const start = vi.fn(async () => ({ status: 'completed' as const }))
    const h = createHarness({ ensureCodexCli: async () => false, startCodexCliLogin: start })
    expect(await h.operations.startCodexCliLogin({ observed: modelObservation(settings()) })).toEqual({ ok: true, value: { status: 'cancelled' } })
    expect(start).not.toHaveBeenCalled()
    expect(h.codexCliConnections.test).not.toHaveBeenCalled()
  })
  it('refreshes models after successful login and rejects login payloads', async () => {
    const start = vi.fn(async () => ({ status: 'completed' as const }))
    const h = createHarness({ ensureCodexCli: async () => true, startCodexCliLogin: start })
    expect(await h.operations.startCodexCliLogin({ observed: modelObservation(settings()) })).toMatchObject({ ok: true, value: { status: 'completed', connection: { status: 'connected' } } })
    expect(h.codexCliConnections.test).toHaveBeenCalledOnce()
    expect((await h.operations.startCodexCliLogin({ path: 'arbitrary' })).ok).toBe(false)
    expect(start).toHaveBeenCalledOnce()
  })
  it('cancels only the owner-bound login service without removing the connection', async () => {
    const cancel = vi.fn(async () => undefined)
    const h = createHarness({ cancelCodexCliLogin: cancel })
    expect(await h.operations.cancelCodexCliLogin()).toEqual({ ok: true, value: null })
    expect(cancel).toHaveBeenCalledOnce()
    expect(h.codexCliConnections.remove).not.toHaveBeenCalled()
  })
  it('validates the floating feature binding and dispatches finite fields with the original observation', async () => {
    const { operations, modelConnections } = createHarness()
    const value = { connectionId: CONNECTION_ID, thinkingMode: 'disabled', reasoningEffort: 'low' }
    expect((await operations.setFloatingTranslationSettings({ observed: modelObservation(settings()), input: value })).ok).toBe(true)
    expect(modelConnections.setFeature).toHaveBeenCalledExactlyOnceWith(modelObservation(settings()), 'floatingTranslation', value)
    for (const input of [{ ...value, targetLanguage: 'auto' },
      { ...value, reasoningEffort: 'invalid' }, null]) {
      expect((await operations.setFloatingTranslationSettings({ observed: modelObservation(settings()), input: input })).ok).toBe(false)
    }
    expect(modelConnections.setFeature).toHaveBeenCalledTimes(1)
    expect((await operations.setFloatingTranslationSettings({ observed: modelObservation(settings()), input: { reasoningEffort: 'high' } })).ok).toBe(true)
    expect(modelConnections.setFeature).toHaveBeenLastCalledWith(modelObservation(settings()), 'floatingTranslation', { reasoningEffort: 'high' })
    expect((await operations.setFloatingTranslationSettings({ observed: modelObservation(settings()), input: { target: 'fra' } })).ok).toBe(true)
    expect(modelConnections.setFeature).toHaveBeenLastCalledWith(modelObservation(settings()), 'floatingTranslation', { target: 'fra' })
    expect((await operations.setFloatingTranslationSettings({ observed: modelObservation(settings()), input: { target: 'fr' } })).ok).toBe(false)
  })
  it('dispatches both Codex CLI operations only with the original observation', async () => {
    const { codexCliConnections, operations } = createHarness()

    await expect(operations.testCodexCliConnection({ observed: modelObservation(settings()) })).resolves.toEqual({
      ok: true,
      value: {
        status: 'connected',
        mutation: modelCommit(connectedCodexSettings()),
      },
    })
    await expect(operations.removeCodexCliConnection({ observed: modelObservation(settings()) })).resolves.toEqual({
      ok: true,
      value: modelCommit(settings()),
    })

    expect(codexCliConnections.test).toHaveBeenCalledExactlyOnceWith(modelObservation(settings()))
    expect(codexCliConnections.remove).toHaveBeenCalledExactlyOnceWith(modelObservation(settings()))

    for (const payload of [{}, null, [], '', 0]) {
      await expect(operations.testCodexCliConnection(payload)).resolves.toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT', message: '请求参数无效' },
      })
      await expect(operations.removeCodexCliConnection(payload)).resolves.toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT', message: '请求参数无效' },
      })
    }

    expect(codexCliConnections.test).toHaveBeenCalledTimes(1)
    expect(codexCliConnections.remove).toHaveBeenCalledTimes(1)
  })

  it('dispatches the public operations with one validated argument', async () => {
    const { modelConnections, operations } = createHarness()
    const featureInput = {
      connectionId: CONNECTION_ID,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'ja',
    } as const

    await expect(operations.getLargeModelSettings()).resolves.toEqual({
      ok: true,
      value: settings(),
    })
    await expect(operations.connectModel({ observed: modelObservation(settings()), input: newConnectionInput })).resolves.toEqual({
      ok: true,
      value: modelCommit(settings()),
    })
    await expect(operations.listModels({ observed: modelObservation(settings()), input: {
      provider: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-private',
    } })).resolves.toEqual({
      ok: true,
      value: { status: 'catalog', catalog: { models: ['deepseek-chat'], recommendedModelId: 'deepseek-chat' } },
    })
    await expect(operations.testModel({ observed: modelObservation(settings()), input: { connectionId: CONNECTION_ID } })).resolves.toEqual({
      ok: true,
      value: { mutation: modelCommit(settings()), error: null },
    })
    await expect(operations.deleteModel({ observed: modelObservation(settings()), input: { connectionId: CONNECTION_ID } })).resolves.toEqual({
      ok: true,
      value: modelCommit(settings()),
    })
    const aiInput = {
      connectionId: CONNECTION_ID,
      thinkingMode: 'enabled' as const, reasoningEffort: 'max',
      writePolicy: 'workspace-grant',
    } as const
    await expect(operations.setAiConversationSettings({ observed: modelObservation(settings()), input: aiInput })).resolves.toEqual({
      ok: true,
      value: modelCommit(settings()),
    })
    await expect(operations.setSelectionTranslationSettings({ observed: modelObservation(settings()), input: featureInput })).resolves.toEqual({
      ok: true,
      value: modelCommit(settings()),
    })
    await expect(operations.setScreenshotTranslationSettings({ observed: modelObservation(settings()), input: featureInput })).resolves.toEqual({
      ok: true,
      value: modelCommit(settings()),
    })
    await expect(operations.acceptTranslationPrivacyNotice({ observed: modelObservation(settings()) })).resolves.toEqual({
      ok: true,
      value: modelCommit(settings()),
    })

    expect(modelConnections.connect).toHaveBeenCalledWith(modelObservation(settings()), newConnectionInput)
    expect(modelConnections.listModels).toHaveBeenCalledWith(modelObservation(settings()), {
      provider: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-private',
    })
    expect(modelConnections.test).toHaveBeenCalledWith(modelObservation(settings()), CONNECTION_ID)
    expect(modelConnections.delete).toHaveBeenCalledWith(modelObservation(settings()), CONNECTION_ID)
    expect(modelConnections.setFeature).toHaveBeenCalledWith(modelObservation(settings()), 'aiConversation', aiInput)
    expect(modelConnections.setFeature).toHaveBeenCalledWith(modelObservation(settings()), 'selectionTranslation', featureInput)
    expect(modelConnections.setFeature).toHaveBeenCalledWith(modelObservation(settings()), 'screenshotTranslation', featureInput)
    expect(modelConnections.acceptTranslationPrivacyNotice).toHaveBeenCalledTimes(1)
  })

  it('rejects unsafe or incomplete model catalog input before service calls', async () => {
    const { modelConnections, operations } = createHarness()
    const valid = {
      provider: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-private',
    } as const
    for (const input of [
      Object.create(valid),
      { ...valid, extra: true },
      { ...valid, baseUrl: 'http://api.example.com' },
      { ...valid, apiKey: '' },
      { provider: 'deepseek', protocol: 'openai', baseUrl: valid.baseUrl },
    ]) {
      await expect(operations.listModels({ observed: modelObservation(settings()), input: input })).resolves.toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT', message: '请求参数无效' },
      })
    }
    expect(modelConnections.listModels).not.toHaveBeenCalled()
  })

  it('rejects inherited, unknown, unsafe, and incomplete connection input before service calls', async () => {
    const { modelConnections, operations } = createHarness()
    const inherited = Object.create(newConnectionInput) as unknown
    const malformedInputs: unknown[] = [
      inherited,
      { ...newConnectionInput, extra: true },
      { ...newConnectionInput, baseUrl: 'http://api.example.com/v1' },
      { ...newConnectionInput, baseUrl: 'file:///C:/secret' },
      { ...newConnectionInput, baseUrl: 'https://user:pass@example.com/v1' },
      { ...newConnectionInput, apiKey: undefined },
      { ...newConnectionInput, apiKey: '' },
      { ...newConnectionInput, id: 'not-a-uuid' },
      { ...newConnectionInput, capabilityOverride: { contextWindowTokens: 0 } },
      {
        ...newConnectionInput,
        capabilityOverride: { contextWindowTokens: 100, maxInputTokens: 101 },
      },
      {
        ...newConnectionInput,
        capabilityOverride: { contextWindowTokens: 100, maxOutputTokens: 101 },
      },
      {
        ...newConnectionInput,
        capabilityOverride: { contextWindowTokens: 100, extra: 1 },
      },
      {
        ...newConnectionInput,
        capabilityOverride: { contextWindowTokens: 100, maxInputTokens: undefined },
      },
      {
        ...newConnectionInput,
        capabilityOverride: { contextWindowTokens: 100, maxOutputTokens: undefined },
      },
      {
        ...newConnectionInput,
        capabilityOverride: Object.create({ contextWindowTokens: 100 }),
      },
    ]

    for (const input of malformedInputs) {
      await expect(operations.connectModel({ observed: modelObservation(settings()), input: input })).resolves.toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT', message: '请求参数无效' },
      })
    }
    expect(modelConnections.connect).not.toHaveBeenCalled()
  })

  it('rejects malformed and inherited connection references before service calls', async () => {
    const { modelConnections, operations } = createHarness()
    const inherited = Object.create({ connectionId: CONNECTION_ID }) as unknown

    for (const input of [
      inherited,
      { connectionId: 'not-a-uuid' },
      { connectionId: CONNECTION_ID, extra: true },
    ]) {
      await expect(operations.testModel({ observed: modelObservation(settings()), input: input })).resolves.toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT', message: '请求参数无效' },
      })
      await expect(operations.deleteModel({ observed: modelObservation(settings()), input: input })).resolves.toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT', message: '请求参数无效' },
      })
    }
    expect(modelConnections.test).not.toHaveBeenCalled()
    expect(modelConnections.delete).not.toHaveBeenCalled()
  })

  it('rejects invalid feature settings before service calls', async () => {
    const { modelConnections, operations } = createHarness()
    const valid = {
      connectionId: CONNECTION_ID,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'fr',
    }
    const malformedInputs: unknown[] = [
      Object.create(valid),
      { ...valid, extra: true },
      { ...valid, targetLanguage: 'klingon' },
      { ...valid, thinkingMode: 'default' as const, reasoningEffort: 'extreme' },
      { ...valid, connectionId: 'not-a-uuid' },
    ]

    for (const input of malformedInputs) {
      await expect(operations.setSelectionTranslationSettings({ observed: modelObservation(settings()), input: input })).resolves.toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT', message: '请求参数无效' },
      })
      await expect(operations.setScreenshotTranslationSettings({ observed: modelObservation(settings()), input: input })).resolves.toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT', message: '请求参数无效' },
      })
    }
    expect(modelConnections.setFeature).not.toHaveBeenCalled()
    expect(modelConnections.setFeature).not.toHaveBeenCalled()
  })

  it('sanitizes service errors to a stable Chinese response without secret material', async () => {
    const { modelConnections, operations } = createHarness()
    modelConnections.connect.mockRejectedValueOnce(
      new Error('sk-private\n{"provider_body":"account 123"}\nC:\\private\\stack.ts:42'),
    )

    const result = await operations.connectModel({ observed: modelObservation(settings()), input: newConnectionInput })

    expect(result).toEqual({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
    })
    expect(JSON.stringify(result)).not.toContain('sk-private')
    expect(JSON.stringify(result)).not.toContain('provider_body')
    expect(JSON.stringify(result)).not.toContain('stack.ts')
  })

  it('sanitizes Codex CLI service errors without exposing local diagnostics', async () => {
    const { codexCliConnections, operations } = createHarness()
    codexCliConnections.test.mockRejectedValueOnce(
      new Error('C:\\private\\codex.cmd\naccount@example.com\nraw app-server output'),
    )

    const result = await operations.testCodexCliConnection({ observed: modelObservation(settings()) })

    expect(result).toEqual({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
    })
    expect(JSON.stringify(result)).not.toContain('codex.cmd')
    expect(JSON.stringify(result)).not.toContain('account@example.com')
    expect(JSON.stringify(result)).not.toContain('app-server')
  })
})
