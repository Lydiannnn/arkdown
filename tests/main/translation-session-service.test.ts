import { describe, expect, it, vi } from 'vitest'
import type {
  LargeModelSettings,
  ModelConnectionSummary,
  ReasoningEffort,
  TargetLanguage,
} from '../../src/shared/large-model-settings'
import type {
  StartTranslationInput,
  TranslationEvent,
} from '../../src/shared/selection-translation'
import type { AppSettings } from '../../src/main/settings/settings-store'
import type { SettingsUpdater } from '../../src/main/settings/settings-coordinator'
import {
  ModelSecretVaultError,
  type ModelSecretVault,
} from '../../src/main/models/model-secret-vault'
import {
  ModelProtocolError,
  type ModelProtocolFailureStatus,
} from '../../src/main/models/model-errors'
import type {
  ModelChatInput,
  ModelChatResult,
  ModelProtocolClient,
} from '../../src/main/models/model-protocol-client'
import {
  TranslationSessionService,
  type TranslationEventSink,
} from '../../src/main/models/translation-session-service'

const CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440000'
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function connection(
  overrides: Partial<ModelConnectionSummary> = {},
): ModelConnectionSummary {
  return {
    id: CONNECTION_ID,
    name: 'Test model',
    provider: 'deepseek',
    accessType: 'standard-api',
    protocol: 'openai',
    baseUrl: 'https://api.example.com/v1',
    modelId: 'chat-model',
    apiKeyHint: '••••test',
    status: 'connected',
    lastTestedAt: '2026-07-30T00:00:00.000Z',
    capabilityOverride: null,
    ...overrides,
  }
}

function modelSettings(options: {
  privacyNoticeAccepted?: boolean
  selected?: ModelConnectionSummary | null
  targetLanguage?: TargetLanguage
  reasoningEffort?: ReasoningEffort
  thinkingMode?: 'default' | 'enabled' | 'disabled'
} = {}): LargeModelSettings {
  const selected = options.selected === undefined ? connection() : options.selected
  return {
    version: 6,
    codexCli: null,
    connections: selected === null ? [] : [selected],
    selectionTranslation: {
      connectionId: selected?.id ?? null,
      thinkingMode: options.thinkingMode ?? 'default', reasoningEffort: options.reasoningEffort ?? 'default',
      targetLanguage: options.targetLanguage ?? 'fr',
      privacyNoticeAccepted: options.privacyNoticeAccepted ?? true,
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

function settingsUpdater(
  models: LargeModelSettings | undefined = modelSettings(),
  onUpdate: SettingsUpdater['update'] = async () => undefined,
): SettingsUpdater {
  const settings: AppSettings = {
    lastWorkspace: null,
    ...(models === undefined ? {} : { models }),
  }
  return {
    get: () => settings,
    update: onUpdate,
  }
}

function secretVault(
  get: (connectionId: string) => Promise<string | null> = async () => 'api-key',
): ModelSecretVault {
  return { get } as unknown as ModelSecretVault
}

function protocolClient(
  streamChat: (input: ModelChatInput) => Promise<void>,
): ModelProtocolClient {
  return {
    streamChat: async (input) => {
      await streamChat(input)
      return {
        toolCalls: [],
        reasoningContent: '',
        providerReplay: null,
        usage: null,
      } satisfies ModelChatResult
    },
    testConnection: async () => undefined,
  }
}

function service(options: {
  models?: LargeModelSettings
  settings?: SettingsUpdater
  secrets?: ModelSecretVault
  streamChat?: (input: ModelChatInput) => Promise<void>
  events?: TranslationEvent[]
}) {
  const events = options.events ?? []
  const eventSink: TranslationEventSink = {
    emit: (event) => events.push(event),
  }
  return {
    events,
    instance: new TranslationSessionService({
      settings: options.settings ?? settingsUpdater(options.models),
      secrets: options.secrets ?? secretVault(),
      client: protocolClient(options.streamChat ?? (async () => undefined)),
      events: eventSink,
    }),
  }
}

function input(
  overrides: Partial<StartTranslationInput> = {},
): StartTranslationInput {
  return {
    documentKey: 'document.md',
    content: { markdown: '**Hello**', plainText: 'Hello' },
    mode: 'visual',
    ...overrides,
  }
}

function content(markdown: string, plainText = markdown) {
  return { markdown, plainText }
}

async function waitForEvent(
  events: TranslationEvent[],
  type: TranslationEvent['type'],
): Promise<TranslationEvent> {
  await vi.waitFor(() => {
    expect(events.some((event) => event.type === type)).toBe(true)
  })
  return events.find((event) => event.type === type)!
}

describe('TranslationSessionService', () => {
  it('passes the saved manual capability through to selection translation requests', async () => {
    const capabilityOverride = { thinking: {thinking:'toggle' as const,encoding:'enable-thinking' as const,efforts:[],disabledEfforts:[],defaultThinking:'enabled' as const,defaultEffort:'default' as const} }
    const request = vi.fn(async (call: ModelChatInput) => { call.onDelta('Bonjour') })
    const { instance, events } = service({ models:modelSettings({selected:connection({capabilityOverride}),thinkingMode:'disabled'}),streamChat:request })
    await instance.start(input())
    await waitForEvent(events,'completed')
    expect(request).toHaveBeenCalledWith(expect.objectContaining({capabilityOverride,thinkingMode:'disabled'}))
    instance.dispose()
  })
  it('starts translation when the retired privacy flag remains false', async () => {
    let secretRead = false
    let clientCalled = false
    const { instance, events } = service({
      models: modelSettings({ privacyNoticeAccepted: false }),
      secrets: secretVault(async () => {
        secretRead = true
        return 'api-key'
      }),
      streamChat: async () => {
        clientCalled = true
      },
    })

    const started = await instance.start(input())

    expect(started.requestId).toMatch(REQUEST_ID_PATTERN)
    expect(secretRead).toBe(true)
    expect(clientCalled).toBe(true)
    expect(events[0]).toEqual({ requestId: started.requestId, type: 'started' })
  })

  it('rejects an unbound translation with the canonical public classification', async () => {
    let secretRead = false
    let clientCalled = false
    const { instance, events } = service({
      models: modelSettings({ selected: null }),
      secrets: secretVault(async () => {
        secretRead = true
        return 'unused'
      }),
      streamChat: async () => {
        clientCalled = true
      },
    })

    await expect(instance.start(input())).rejects.toMatchObject({
      name: 'PublicError',
      code: 'MODEL_NOT_CONFIGURED',
      message: '尚未配置划词翻译使用的大模型',
    })
    expect(secretRead).toBe(false)
    expect(clientCalled).toBe(false)
    expect(events).toEqual([])
  })

  it.each([
    {
      name: 'missing',
      read: async () => null,
    },
    {
      name: 'undecryptable',
      read: async () => {
        throw new ModelSecretVaultError('DECRYPTION_FAILED')
      },
    },
  ])('rejects a $name secret with a fixed sanitized failure', async ({ read }) => {
    let clientCalled = false
    const { instance, events } = service({
      secrets: secretVault(read),
      streamChat: async () => {
        clientCalled = true
      },
    })

    await expect(instance.start(input())).rejects.toMatchObject({
      name: 'PublicError',
      code: 'MODEL_SECRET_UNAVAILABLE',
      message: '无法读取已保存的大模型 API Key，请重新输入',
    })
    expect(clientCalled).toBe(false)
    expect(events).toEqual([])
  })

  it('resolves start while streaming and tags the entire event sequence with one request ID', async () => {
    const stream = deferred()
    let call: ModelChatInput | undefined
    const { instance, events } = service({
      streamChat: async (streamInput) => {
        call = streamInput
        await stream.promise
      },
    })

    const started = await instance.start(input())

    expect(started).toMatchObject({ targetLanguage: 'fr' })
    expect(started.requestId).toMatch(REQUEST_ID_PATTERN)
    expect(call).toBeDefined()
    expect(events).toEqual([{ requestId: started.requestId, type: 'started' }])

    call!.onDelta('Bon')
    call!.onDelta('jour')
    stream.resolve()
    await waitForEvent(events, 'completed')

    expect(events).toEqual([
      { requestId: started.requestId, type: 'started' },
      { requestId: started.requestId, type: 'delta', delta: 'Bon' },
      { requestId: started.requestId, type: 'delta', delta: 'jour' },
      { requestId: started.requestId, type: 'completed' },
    ])
  })

  it('chunks a JSON-fallback-sized multibyte delta without splitting code points before completion', async () => {
    const stream = deferred()
    let call: ModelChatInput | undefined
    const { instance, events } = service({
      streamChat: async (streamInput) => {
        call = streamInput
        await stream.promise
      },
    })
    const started = await instance.start(input())
    const loneHigh = String.fromCharCode(0xd800)
    const loneLow = String.fromCharCode(0xdc00)
    const boundaryBytes = 240 * 1024
    const delta = `${'a'.repeat(boundaryBytes - 1)}${loneHigh}H${
      'b'.repeat(boundaryBytes - 5)
    }${loneLow}L${'汉😀'.repeat(450_000)}`

    call!.onDelta(delta)
    stream.resolve()
    await waitForEvent(events, 'completed')

    const deltaEvents = events.filter(
      (event): event is Extract<TranslationEvent, { type: 'delta' }> =>
        event.type === 'delta',
    )
    expect(deltaEvents.length).toBeGreaterThan(2)
    expect(deltaEvents.map((event) => event.delta).join('')).toBe(delta)
    for (const [index, event] of deltaEvents.entries()) {
      expect(new TextEncoder().encode(event.delta).byteLength).toBeLessThanOrEqual(boundaryBytes)
      const next = deltaEvents[index + 1]
      if (next) {
        expect(
          /[\uD800-\uDBFF]$/u.test(event.delta) && /^[\uDC00-\uDFFF]/u.test(next.delta),
        ).toBe(false)
      }
    }
    expect(events.at(-1)).toEqual({ requestId: started.requestId, type: 'completed' })
  })

  it('aborts and stops the first request exactly once before the second owns the session', async () => {
    const streams = [deferred(), deferred()]
    const calls: ModelChatInput[] = []
    const { instance, events } = service({
      streamChat: async (streamInput) => {
        const index = calls.push(streamInput) - 1
        await streams[index].promise
      },
    })

    const first = await instance.start(input({ content: content('first') }))
    const second = await instance.start(input({ content: content('second') }))

    expect(calls[0].signal.aborted).toBe(true)
    expect(calls[1].signal.aborted).toBe(false)
    expect(events.slice(0, 3)).toEqual([
      { requestId: first.requestId, type: 'started' },
      { requestId: first.requestId, type: 'stopped' },
      { requestId: second.requestId, type: 'started' },
    ])

    calls[0].onDelta('stale')
    streams[0].reject(new DOMException('aborted', 'AbortError'))
    await Promise.resolve()
    await Promise.resolve()

    expect(events.filter((event) => (
      event.requestId === first.requestId && event.type === 'stopped'
    ))).toHaveLength(1)
    expect(events.some((event) => (
      event.requestId === first.requestId && event.type === 'delta'
    ))).toBe(false)
    instance.dispose()
  })

  it('cancels only the matching active request and emits stopped once', async () => {
    const stream = deferred()
    let call: ModelChatInput | undefined
    const { instance, events } = service({
      streamChat: async (streamInput) => {
        call = streamInput
        await stream.promise
      },
    })
    const started = await instance.start(input())

    await instance.cancel('550e8400-e29b-41d4-a716-446655440099')
    expect(call!.signal.aborted).toBe(false)
    expect(events).toEqual([{ requestId: started.requestId, type: 'started' }])

    await instance.cancel(started.requestId)
    await instance.cancel(started.requestId)
    expect(call!.signal.aborted).toBe(true)
    expect(events.filter((event) => event.type === 'stopped')).toEqual([
      { requestId: started.requestId, type: 'stopped' },
    ])

    stream.reject(new DOMException('aborted', 'AbortError'))
    await Promise.resolve()
    await Promise.resolve()
    expect(events.filter((event) => event.type === 'stopped')).toHaveLength(1)
    expect(events.some((event) => event.type === 'failed')).toBe(false)
  })

  it('discards deltas and completion that race after cancellation', async () => {
    const stream = deferred()
    let call: ModelChatInput | undefined
    const { instance, events } = service({
      streamChat: async (streamInput) => {
        call = streamInput
        await stream.promise
      },
    })
    const started = await instance.start(input())

    await instance.cancel(started.requestId)
    call!.onDelta('late delta')
    stream.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(events).toEqual([
      { requestId: started.requestId, type: 'started' },
      { requestId: started.requestId, type: 'stopped' },
    ])
  })

  it('aborts on dispose and never emits to the disposed sink again', async () => {
    const stream = deferred()
    let call: ModelChatInput | undefined
    const { instance, events } = service({
      streamChat: async (streamInput) => {
        call = streamInput
        await stream.promise
      },
    })
    const started = await instance.start(input())

    instance.dispose()
    expect(call!.signal.aborted).toBe(true)
    call!.onDelta('late delta')
    stream.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(events).toEqual([{ requestId: started.requestId, type: 'started' }])
  })

  it('resolves automatic target language and passes preferences to the shared request encoder', async () => {
    let call: ModelChatInput | undefined
    const { instance } = service({
      models: modelSettings({
        targetLanguage: 'auto',
        thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      }),
      streamChat: async (streamInput) => {
        call = streamInput
      },
    })

    const markdown = '# English Markdown sent to model'
    const started = await instance.start(input({
      content: content(markdown, '中文内容'),
    }))

    expect(started.targetLanguage).toBe('zh-CN')
    expect(started.modelId).toBe('chat-model')
    expect(call).toMatchObject({
      initialInactivityTimeoutMs: 30_000,
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      messages: [
        {
          role: 'system',
          content: expect.stringContaining('译为简体中文'),
        },
        { role: 'user', content: markdown },
      ],
    })
  })

  it('passes supported reasoning effort through to the protocol client', async () => {
    let call: ModelChatInput | undefined
    const selected = connection({
      provider: 'other',
      modelId: 'gpt-5',
    })
    const { instance } = service({
      models: modelSettings({
        selected,
        thinkingMode: 'enabled' as const, reasoningEffort: 'medium',
      }),
      streamChat: async (streamInput) => {
        call = streamInput
      },
    })

    await instance.start(input())

    expect(call?.reasoningEffort).toBe('medium')
  })

  it('uses one Markdown-preserving prompt in both modes without changing selected Markdown', async () => {
    const calls: ModelChatInput[] = []
    const markdown = '# Heading\n\n[Link](https://example.com)\n\n`const value = 1`'
    const { instance } = service({
      streamChat: async (streamInput) => {
        calls.push(streamInput)
      },
    })

    await instance.start(input({ content: content(markdown, 'Heading Link'), mode: 'visual' }))
    await instance.start(input({ content: content(markdown, 'Heading Link'), mode: 'source' }))

    expect(calls).toHaveLength(2)
    expect(calls[0]?.messages[0]).toEqual(calls[1]?.messages[0])
    expect(calls[0]?.messages[0]?.content).toContain('Markdown 结构')
    expect(calls[0]?.messages[0]?.content).toContain('列表编号及勾选状态')
    expect(calls[0]?.messages[0]?.content).toContain('表格行列')
    expect(calls[0]?.messages[0]?.content).toContain('链接目标')
    expect(calls[0]?.messages[0]?.content).toContain(
      '不加说明或外层代码围栏',
    )
    expect(calls.map((call) => call.messages[1])).toEqual([
      { role: 'user', content: markdown },
      { role: 'user', content: markdown },
    ])
  })

  it.each([
    ['authentication-failed', 'MODEL_AUTHENTICATION_FAILED', '大模型认证失败'],
    ['model-not-found', 'MODEL_NOT_FOUND', '未找到配置的大模型'],
    ['invalid-endpoint', 'MODEL_INVALID_ENDPOINT', '大模型接口地址无效或不可用'],
    ['timeout', 'MODEL_TIMEOUT', '大模型请求超时'],
    ['rate-limited', 'MODEL_RATE_LIMITED', '大模型服务商请求过于频繁'],
    ['quota-exceeded', 'MODEL_QUOTA_EXCEEDED', '大模型账户余额或配额不足'],
    ['incompatible-response', 'MODEL_INCOMPATIBLE_RESPONSE', '大模型服务返回的响应格式不兼容'],
  ] satisfies readonly [
    ModelProtocolFailureStatus,
    string,
    string,
  ][])('maps %s to the fixed public failure', async (status, code, message) => {
    const { instance, events } = service({
      streamChat: async () => {
        throw new ModelProtocolError(status)
      },
    })

    const started = await instance.start(input())
    await waitForEvent(events, 'failed')

    expect(events).toEqual([
      { requestId: started.requestId, type: 'started' },
      { requestId: started.requestId, type: 'failed', code, message },
    ])
  })

  it.each([
    ['ENCRYPTION_UNAVAILABLE', 'MODEL_ENCRYPTION_UNAVAILABLE', 'Windows 加密不可用'],
    ['INVALID_CONNECTION_ID', 'INVALID_INPUT', '请求参数无效'],
    ['VAULT_MALFORMED', 'MODEL_SECRET_STORAGE_FAILED', '大模型 API Key 存储失败'],
    ['VAULT_READ_FAILED', 'MODEL_SECRET_STORAGE_FAILED', '大模型 API Key 存储失败'],
    ['VAULT_WRITE_FAILED', 'MODEL_SECRET_STORAGE_FAILED', '大模型 API Key 存储失败'],
  ] as const)('maps vault error %s to a fixed public failure', async (vaultCode, code, message) => {
    const { instance } = service({
      secrets: secretVault(async () => {
        throw new ModelSecretVaultError(vaultCode)
      }),
    })

    await expect(instance.start(input())).rejects.toMatchObject({
      name: 'PublicError',
      code,
      message,
    })
  })

  it('keeps selected content and raw upstream details out of events, logs, and persistence', async () => {
    const selectedContent = 'PRIVATE_SELECTED_SOURCE_7cf84f'
    const apiKey = 'PRIVATE_API_KEY_5b9d2a'
    const upstreamDetails =
      'https://user:password@example.com PRIVATE_PROVIDER_BODY_51e9'
    const persisted: AppSettings[] = []
    const settings = settingsUpdater(
      modelSettings(),
      async (mutator) => {
        persisted.push(mutator({ lastWorkspace: null, models: modelSettings() }))
      },
    )
    const logged: unknown[][] = []
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...values) => logged.push(values)),
      vi.spyOn(console, 'warn').mockImplementation((...values) => logged.push(values)),
      vi.spyOn(console, 'error').mockImplementation((...values) => logged.push(values)),
    ]
    const events: TranslationEvent[] = []
    const { instance } = service({
      settings,
      secrets: secretVault(async () => apiKey),
      events,
      streamChat: async (streamInput) => {
        streamInput.onDelta('required translated delta')
        throw new Error(upstreamDetails)
      },
    })

    try {
      const started = await instance.start(input({ content: content(selectedContent) }))
      await waitForEvent(events, 'failed')

      expect(started).toEqual({
        requestId: expect.stringMatching(REQUEST_ID_PATTERN),
        targetLanguage: 'fr',
        modelId: 'chat-model',
      })
      const publicSurfaces = JSON.stringify({ started, events, logged, persisted })
      expect(publicSurfaces).toContain('required translated delta')
      expect(publicSurfaces).not.toContain(selectedContent)
      expect(publicSurfaces).not.toContain(apiKey)
      expect(publicSurfaces).not.toContain(upstreamDetails)
      expect(publicSurfaces).not.toContain('https://api.example.com/v1')
      expect(persisted).toEqual([])
      expect(events.at(-1)).toMatchObject({
        type: 'failed',
        code: 'OPERATION_FAILED',
        message: '操作未能完成',
      })
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
