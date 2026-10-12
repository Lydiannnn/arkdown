import { describe, expect, it, vi } from 'vitest'
import type { LargeModelSettings, ModelConnectionSummary } from '../../src/shared/large-model-settings'
import type {
  ModelChatInput,
  ModelChatResult,
  ModelProtocolClient,
} from '../../src/main/models/model-protocol-client'
import { ModelProtocolError } from '../../src/main/models/model-errors'
import { ModelSecretVaultError, type ModelSecretVault } from '../../src/main/models/model-secret-vault'
import type { SettingsUpdater } from '../../src/main/settings/settings-coordinator'
import type {
  ScreenshotOcrBlock,
  ScreenshotTranslationEvent,
} from '../../src/shared/screenshot-translation'
import {
  createScreenshotTranslationService,
  type ScreenshotTranslationEventSink,
  type ScreenshotTranslationStartInput,
} from '../../src/main/screenshot-translation/screenshot-translation-service'
import * as screenshotTranslationServiceModule from '../../src/main/screenshot-translation/screenshot-translation-service'
import { SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES } from '../../src/main/screenshot-translation/screenshot-translation-prompts'

const SESSION_1 = '123e4567-e89b-42d3-a456-426614174000'
const SESSION_2 = '223e4567-e89b-42d3-a456-426614174000'
const SCREENSHOT_CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440000'
const SELECTION_CONNECTION_ID = '650e8400-e29b-41d4-a716-446655440000'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}

function connection(id: string, overrides: Partial<ModelConnectionSummary> = {}): ModelConnectionSummary {
  return {
    id, name: 'model', provider: 'deepseek', accessType: 'standard-api', protocol: 'openai',
    baseUrl: 'https://api.example.com/v1', modelId: 'chat-model', apiKeyHint: '••••test',
    status: 'connected', lastTestedAt: null, capabilityOverride: null, ...overrides,
  }
}

function modelSettings(options: {
  screenshotConnectionId?: string | null
  screenshotReasoning?: LargeModelSettings['screenshotTranslation']['reasoningEffort']
  screenshotTarget?: LargeModelSettings['screenshotTranslation']['targetLanguage']
  screenshotConnection?: ModelConnectionSummary
} = {}): LargeModelSettings {
  const screenshotConnection = options.screenshotConnection
    ?? connection(SCREENSHOT_CONNECTION_ID)
  return {
    version: 6,
    codexCli: null,
    connections: [
      connection(SELECTION_CONNECTION_ID, { name: 'selection-only', modelId: 'selection-model' }),
      screenshotConnection,
    ],
    selectionTranslation: {
      connectionId: SELECTION_CONNECTION_ID, thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      targetLanguage: 'ru', privacyNoticeAccepted: true,
    },
    screenshotTranslation: {
      connectionId: options.screenshotConnectionId === undefined
        ? screenshotConnection.id
        : options.screenshotConnectionId,
      thinkingMode: 'default' as const, reasoningEffort: options.screenshotReasoning ?? 'default',
      targetLanguage: options.screenshotTarget ?? 'fr',
    },
    aiConversation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      writePolicy: 'ask-every-time',
    },
  }
}

function settingsUpdater(models: LargeModelSettings | undefined): SettingsUpdater {
  return {
    get: () => ({ lastWorkspace: null, ...(models ? { models } : {}) }),
    update: vi.fn(),
  }
}

function ocrBlock(index: number, text = `source-${index}`): ScreenshotOcrBlock {
  return {
    id: `line-${index}`, text,
    rectPx: { x: index, y: 0, width: 1, height: 1 },
    words: [{ text, rectPx: { x: index, y: 0, width: 1, height: 1 } }],
  }
}

function input(sessionId = SESSION_1, generation = 1, blocks = [ocrBlock(1)]): ScreenshotTranslationStartInput {
  return { sessionId, generation, blocks }
}

const EMPTY_CHAT_RESULT: ModelChatResult = {
  toolCalls: [],
  reasoningContent: '',
  providerReplay: null,
  usage: null,
}

it.each([
  ['authentication-failed', 'MODEL_AUTHENTICATION_FAILED'],
  ['model-not-found', 'MODEL_NOT_FOUND'],
  ['invalid-endpoint', 'MODEL_UNAVAILABLE'],
  ['rate-limited', 'MODEL_RATE_LIMITED'],
  ['quota-exceeded', 'MODEL_QUOTA_EXCEEDED'],
  ['incompatible-response', 'MODEL_RESPONSE_INVALID'],
  ['timeout', 'MODEL_TIMEOUT'],
] as const)('preserves %s as a specific screenshot failure instead of a resize suggestion', async (status, code) => {
  const {service, events} = makeService({stream: async () => { throw new ModelProtocolError(status) }})
  await service.start(input())
  await service.whenSettled({sessionId: SESSION_1, generation: 1})
  expect(events.at(-1)).toEqual({sessionId: SESSION_1, generation: 1, type: 'failed', stage: 'translation', code})
  await service.dispose()
})

function makeService(options: {
  models?: LargeModelSettings
  settings?: SettingsUpdater
  secret?: (id: string) => Promise<string | null>
  stream?: (input: ModelChatInput) => Promise<void>
  events?: ScreenshotTranslationEvent[]
} = {}) {
  const events = options.events ?? []
  const settings = options.settings ?? settingsUpdater(options.models ?? modelSettings())
  const secrets = { get: options.secret ?? (async () => 'secret') } as unknown as ModelSecretVault
  const client: ModelProtocolClient = {
    streamChat: async (call) => {
      await (options.stream ?? (async (value: ModelChatInput) => {
        const payload = JSON.parse(value.messages[1]!.content) as { blocks: Array<{ id: string }> }
        value.onDelta(JSON.stringify({
          translations: payload.blocks.map(({ id }) => ({ id, text: `translated-${id}` })),
        }))
      }))(call)
      return EMPTY_CHAT_RESULT
    },
    testConnection: async () => undefined,
  }
  const sink: ScreenshotTranslationEventSink = { emit: (event) => events.push(event) }
  const dependencies = {
    settings,
    secrets,
    client,
    events: sink,
  }
  return {
    events, settings, secrets, client,
    service: createScreenshotTranslationService(dependencies),
  }
}

async function waitForEvent(events: ScreenshotTranslationEvent[], type: ScreenshotTranslationEvent['type']) {
  await vi.waitFor(() => expect(events.some((event) => event.type === type)).toBe(true))
  return events.find((event) => event.type === type)!
}

it.each([
  [ocrBlock(1, 'A'.repeat(600))],
  Array.from({ length: 12 }, (_, index) => ocrBlock(index + 1, 'A'.repeat(20))),
  Array.from({ length: 129 }, (_, index) => ocrBlock(index + 1, 'A'.repeat(30))),
])('keeps dense OCR translations mapped to every source ID without document events %#', async (...source) => {
  const { service, events } = makeService()
  await service.start(input(SESSION_1, 1, source))
  await service.whenSettled({ sessionId: SESSION_1, generation: 1 })
  const completed = events.find(event => event.type === 'translation-completed')
  expect(completed?.type).toBe('translation-completed')
  if (completed?.type === 'translation-completed') expect(completed.translations.map(block => block.id)).toEqual(source.map(block => block.id))
  expect(events.some(event => event.type.startsWith('document-'))).toBe(false)
  await service.dispose()
})

it('keeps duplicate block IDs and suppresses the model duplicate notice before publication', async () => {
  const stream = vi.fn(async (call: ModelChatInput) => {
    call.onDelta(JSON.stringify({ translations: [
      { id: 'line-1', text: '你好' },
      { id: 'line-2', text: '（本行重复并入上一条，请以上一条译文为准。）' },
    ] }))
  })
  const { service, events } = makeService({ stream })
  await service.start(input(SESSION_1, 1, [ocrBlock(1, 'Hello'), ocrBlock(2, 'Hello')]))
  expect(await waitForEvent(events, 'translation-completed')).toMatchObject({
    translations: [{ id: 'line-1', text: '你好' }, { id: 'line-2', text: '你好' }],
  })
  expect(stream).toHaveBeenCalledOnce()
})

it.each(['short','dense'] as const)('passes manual capabilities to screenshot %s translation', async mode => {
  const capabilityOverride = {thinking:{thinking:'toggle' as const,encoding:'enable-thinking' as const,efforts:[],disabledEfforts:[],defaultThinking:'enabled' as const,defaultEffort:'default' as const}}
  const stream = vi.fn(async (call:ModelChatInput) => {
    call.onDelta(JSON.stringify({translations:[{id:'line-1',text:'译文'}]}))
  })
  const {service,events} = makeService({models:modelSettings({screenshotConnection:connection(SCREENSHOT_CONNECTION_ID,{capabilityOverride})}),stream})
  await service.start(input(SESSION_1,1,[ocrBlock(1,mode === 'dense' ? 'A'.repeat(600) : 'A')]))
  await service.whenSettled({sessionId:SESSION_1,generation:1})
  expect(stream).toHaveBeenCalledWith(expect.objectContaining({capabilityOverride}))
  expect(events.some(event=>event.type==='failed')).toBe(false)
  await service.dispose()
})

interface TestBoundedUtf8Accumulator {
  readonly value: string
  readonly byteLength: number
  append(delta: string): boolean
}

function boundedUtf8Accumulator(maxBytes: number): TestBoundedUtf8Accumulator {
  const factory = (screenshotTranslationServiceModule as unknown as {
    createBoundedUtf8Accumulator?: (limit: number) => TestBoundedUtf8Accumulator
  }).createBoundedUtf8Accumulator
  expect(factory).toBeTypeOf('function')
  return factory!(maxBytes)
}

describe('bounded screenshot model response accumulation', () => {
  it('does not retain a single non-ASCII delta whose real UTF-8 bytes exceed the cap', () => {
    const accumulator = boundedUtf8Accumulator(SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES)
    const delta = '汉'.repeat(Math.floor(SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES / 3) + 1)
    expect(delta.length).toBeLessThanOrEqual(SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES)

    expect(accumulator.append(delta)).toBe(false)

    expect(accumulator.value).toBe('')
    expect(accumulator.byteLength).toBe(0)
  })

  it('keeps the prior state when a later non-ASCII delta would exceed the real UTF-8 cap', () => {
    const accumulator = boundedUtf8Accumulator(SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES)
    const retained = '汉'.repeat(Math.floor(SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES / 3))
    expect(accumulator.append(retained)).toBe(true)
    const retainedBytes = new TextEncoder().encode(retained).byteLength

    expect(accumulator.append('汉')).toBe(false)

    expect(accumulator.value).toBe(retained)
    expect(accumulator.byteLength).toBe(retainedBytes)
  })

  it('accepts one surrogate pair split across deltas using its exact aggregate four bytes', () => {
    const accumulator = boundedUtf8Accumulator(4)
    const emoji = '😀'

    expect(accumulator.append(emoji.slice(0, 1))).toBe(true)
    expect(accumulator.byteLength).toBe(3)
    expect(accumulator.append(emoji.slice(1))).toBe(true)

    expect(accumulator.value).toBe(emoji)
    expect(accumulator.byteLength).toBe(4)
  })
})

describe('screenshot translation model assignment and privacy', () => {
  it('uses only the screenshot assignment, explicit target, and stable ID/text payload', async () => {
    let call: ModelChatInput | undefined
    const settings = modelSettings({ screenshotTarget: 'de' })
    const snapshot = structuredClone(settings)
    const { service, events } = makeService({
      models: settings,
      stream: async (value) => {
        call = value
        value.onDelta('{"translations":[{"id":"line-1","text":"Hallo"}]}')
      },
    })

    await expect(service.start(input())).resolves.toEqual({
      sessionId: SESSION_1, generation: 1, targetLanguage: 'de', modelId: 'chat-model',
    })
    await waitForEvent(events, 'translation-completed')

    expect(call).toMatchObject({ modelId: 'chat-model', thinkingMode: 'default' as const, reasoningEffort: 'default' })
    expect(call?.messages[0]?.content).toContain('译为德语')
    expect(call?.messages[1]?.content).toBe('{"blocks":[{"id":"line-1","text":"source-1"}]}')
    expect(settings).toEqual(snapshot)
    expect(events).toEqual([
      { sessionId: SESSION_1, generation: 1, type: 'translation-started' },
      { sessionId: SESSION_1, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: 'Hallo' }] },
    ])
  })

  it('does not fall back to selection translation and avoids secrets/model when unconfigured', async () => {
    const secret = vi.fn(async () => 'unused')
    const stream = vi.fn(async () => undefined)
    const { service, events } = makeService({
      models: modelSettings({ screenshotConnectionId: null }), secret, stream,
    })

    await expect(service.start(input())).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
    expect(secret).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    expect(events).toEqual([{
      sessionId: SESSION_1, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_NOT_CONFIGURED',
    }])
  })

  it('sanitizes missing/failing secrets without exposing native messages', async () => {
    for (const secret of [
      async () => null,
      async () => { throw new ModelSecretVaultError('VAULT_READ_FAILED') },
      async () => { throw new Error('PRIVATE_NATIVE_SECRET_MESSAGE') },
    ]) {
      const { service, events } = makeService({ secret })
      await expect(service.start(input())).rejects.toMatchObject({ code: 'MODEL_AUTHENTICATION_FAILED' })
      expect(JSON.stringify(events)).not.toContain('PRIVATE_NATIVE_SECRET_MESSAGE')
      expect(events).toEqual([{
        sessionId: SESSION_1, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_AUTHENTICATION_FAILED',
      }])
    }
  })

  it('uses auto mixed-language detection and passes preferences without mutating settings', async () => {
    const settings = modelSettings({ screenshotTarget: 'auto', screenshotReasoning: 'high' })
    settings.screenshotTranslation.thinkingMode = 'disabled'
    const snapshot = structuredClone(settings)
    let call: ModelChatInput | undefined
    const { service } = makeService({
      models: settings,
      stream: async (value) => { call = value; value.onDelta('{"translations":[]}') },
    })

    const started = await service.start(input(SESSION_1, 1, [ocrBlock(1, 'English'), ocrBlock(2, '中文')]))

    expect(started.targetLanguage).toBe('zh-CN')
    expect(call?.reasoningEffort).toBe('high')
    expect(call?.thinkingMode).toBe('disabled')
    expect(settings).toEqual(snapshot)
  })

  it('passes supported reasoning effort without changing the configured object', async () => {
    const selected = connection(SCREENSHOT_CONNECTION_ID, { provider: 'other', modelId: 'gpt-5-mini' })
    const settings = modelSettings({ screenshotConnection: selected, screenshotReasoning: 'medium' })
    let call: ModelChatInput | undefined
    const { service } = makeService({
      models: settings,
      stream: async (value) => { call = value; value.onDelta('{"translations":[]}') },
    })
    await service.start(input())
    expect(call?.reasoningEffort).toBe('medium')
    expect(settings.screenshotTranslation.reasoningEffort).toBe('medium')
  })
})

describe('screenshot translation streaming, batching, and atomic publication', () => {
  it('aggregates non-empty deltas privately and emits no partial translation', async () => {
    const stream = deferred()
    let call: ModelChatInput | undefined
    const { service, events } = makeService({
      stream: async (value) => { call = value; await stream.promise },
    })
    await service.start(input())

    call!.onDelta('')
    expect(call).toMatchObject({ initialInactivityTimeoutMs: 30_000 })
    call!.onDelta('{"translations":[')
    call!.onDelta('{"id":"line-1","text":"Bonjour"}]}')
    expect(events).toEqual([{ sessionId: SESSION_1, generation: 1, type: 'translation-started' }])
    stream.resolve()
    await waitForEvent(events, 'translation-completed')

    expect(events.at(-1)).toEqual({
      sessionId: SESSION_1, generation: 1, type: 'translation-completed',
      translations: [{ id: 'line-1', text: 'Bonjour' }],
    })
  })

  it('relies on the protocol timeout and maps it without adding a service timer', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const { service, events } = makeService({
      stream: async () => { throw new ModelProtocolError('timeout') },
    })
    try {
      await service.start(input())
      await waitForEvent(events, 'failed')
      expect(timer).not.toHaveBeenCalled()
      expect(events.at(-1)).toEqual({
        sessionId: SESSION_1, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_TIMEOUT',
      })
    } finally {
      timer.mockRestore()
    }
  })

  it('runs multiple batches with the complete-source target and publishes one atomic merge', async () => {
    const gates = [deferred(), deferred()]
    const calls: ModelChatInput[] = []
    const source = Array.from({ length: 129 }, (_, index) => ocrBlock(index + 1, index < 128 ? '中' : 'English'))
    const { service, events } = makeService({
      models: modelSettings({ screenshotTarget: 'auto' }),
      stream: async (call) => {
        const index = calls.push(call) - 1
        await gates[index]!.promise
      },
    })
    const started = await service.start(input(SESSION_1, 1, source))
    expect(started.targetLanguage).toBe('en')
    expect(calls).toHaveLength(1)
    expect(events.filter((event) => event.type === 'translation-completed')).toEqual([])

    const firstPayload = JSON.parse(calls[0]!.messages[1]!.content) as { blocks: Array<{ id: string }> }
    calls[0]!.onDelta(JSON.stringify({
      translations: [...firstPayload.blocks].reverse().map(({ id }) => ({ id, text: `translated-${id}` })),
    }))
    gates[0]!.resolve()
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls.map((call) => call.messages[0]?.content)).toEqual([
      expect.stringContaining('译为英语'), expect.stringContaining('译为英语'),
    ])
    expect(events.filter((event) => event.type === 'translation-completed')).toEqual([])

    const secondPayload = JSON.parse(calls[1]!.messages[1]!.content) as { blocks: Array<{ id: string }> }
    calls[1]!.onDelta(JSON.stringify({
      translations: secondPayload.blocks.map(({ id }) => ({ id, text: `translated-${id}` })),
    }))
    gates[1]!.resolve()
    const completed = await waitForEvent(events, 'translation-completed')
    if (completed.type !== 'translation-completed') throw new Error('unexpected event')
    expect(completed.translations.map(({ id }) => id)).toEqual(source.map(({ id }) => id))
  })

  it('publishes no translations when any batch has invalid terminal JSON', async () => {
    let index = 0
    const source = Array.from({ length: 129 }, (_, offset) => ocrBlock(offset + 1, 'x'))
    const { service, events } = makeService({
      stream: async (call) => {
        index += 1
        const payload = JSON.parse(call.messages[1]!.content) as { blocks: Array<{ id: string }> }
        call.onDelta(index === 1
          ? JSON.stringify({ translations: payload.blocks.map(({ id }) => ({ id, text: 'valid-but-private' })) })
          : 'PRIVATE_RAW_MODEL_OUTPUT invalid')
      },
    })
    await service.start(input(SESSION_1, 1, source))
    await waitForEvent(events, 'failed')

    expect(events.some((event) => event.type === 'translation-completed')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('valid-but-private')
    expect(JSON.stringify(events)).not.toContain('PRIVATE_RAW_MODEL_OUTPUT')
    expect(events.at(-1)).toEqual({
      sessionId: SESSION_1, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_RESPONSE_INVALID',
    })
  })

  it('retries one invalid structured batch once without publishing partial output', async () => {
    let attempts = 0
    const { service, events } = makeService({
      stream: async (call) => {
        attempts += 1
        call.onDelta(attempts === 1
          ? 'not-json'
          : '{"translations":[{"id":"line-1","text":"recovered"}]}')
      },
    })

    await service.start(input())
    const completed = await waitForEvent(events, 'translation-completed')
    expect(attempts).toBe(2)
    expect(completed).toMatchObject({
      type: 'translation-completed',
      translations: [{ id: 'line-1', text: 'recovered' }],
    })
    expect(events.filter((event) => event.type === 'failed')).toEqual([])
  })

  it('fails retryably without publishing a partial translation when a batch omits a requested ID', async () => {
    const source = [ocrBlock(1, 'source-one'), ocrBlock(2, 'source-two')]
    const { service, events } = makeService({
      stream: async (call) => {
        call.onDelta('{"translations":[{"id":"line-1","text":"translated-one"}]}')
      },
    })

    await service.start(input(SESSION_1, 1, source))
    await waitForEvent(events, 'failed')

    expect(events.some((event) => event.type === 'translation-completed')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('translated-one')
    expect(JSON.stringify(events)).not.toContain('source-one')
    expect(JSON.stringify(events)).not.toContain('source-two')
    expect(events.at(-1)).toEqual({
      sessionId: SESSION_1, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_RESPONSE_INVALID',
    })
  })

  it('bounds streamed batch bytes before unlimited concatenation', async () => {
    const { service, events } = makeService({
      stream: async (call) => {
        for (let index = 0; index < 9; index += 1) call.onDelta('x'.repeat(64 * 1024))
      },
    })
    await service.start(input())
    await waitForEvent(events, 'failed')
    expect(events.at(-1)).toMatchObject({ code: 'MODEL_RESPONSE_INVALID' })
  })

  it('counts a surrogate pair split across deltas by aggregate UTF-8 bytes', async () => {
    const terminal = '{"translations":[{"id":"line-1","text":"😀"}]}'
    const padding = ' '.repeat(
      SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES
        - new TextEncoder().encode(terminal).byteLength,
    )
    const response = `${terminal}${padding}`
    const emojiIndex = response.indexOf('😀')
    expect(new TextEncoder().encode(response).byteLength)
      .toBe(SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES)
    const { service, events } = makeService({
      stream: async (call) => {
        call.onDelta(response.slice(0, emojiIndex + 1))
        call.onDelta(response.slice(emojiIndex + 1))
      },
    })

    await service.start(input())
    await waitForEvent(events, 'translation-completed')

    expect(events.at(-1)).toEqual({
      sessionId: SESSION_1,
      generation: 1,
      type: 'translation-completed',
      translations: [{ id: 'line-1', text: '😀' }],
    })
  })

  it('waits for a deferred secret lookup to settle after cancellation', async () => {
    const secret = deferred<string | null>()
    const stream = vi.fn(async () => undefined)
    const { service, events } = makeService({
      secret: async () => secret.promise,
      stream,
    })
    const starting = service.start(input(SESSION_1, 1))
    await Promise.resolve()

    const cancelling = service.cancel({ sessionId: SESSION_1, generation: 1 })
    let settled = false
    void cancelling.then(() => { settled = true })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(events.filter((event) => event.type === 'translation-cancelled')).toHaveLength(1)
    secret.resolve('secret')
    await expect(starting).resolves.toMatchObject({ sessionId: SESSION_1, generation: 1 })
    await cancelling

    expect(stream).not.toHaveBeenCalled()
    expect(events.filter((event) => event.type === 'translation-cancelled')).toHaveLength(1)
  })

  it('does not resolve disposal until every aborted model stream settles', async () => {
    const streams = [deferred(), deferred()]
    const calls: ModelChatInput[] = []
    const { service } = makeService({
      stream: async (call) => {
        const index = calls.push(call) - 1
        await streams[index]!.promise
      },
    })
    await service.start(input(SESSION_1, 1))
    await service.start(input(SESSION_2, 1))

    const disposal = service.dispose()
    let settled = false
    void disposal.then(() => { settled = true })
    await Promise.resolve()

    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.signal.aborted)).toBe(true)
    expect(settled).toBe(false)
    streams[0]!.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    streams[1]!.resolve()
    await disposal
    expect(settled).toBe(true)
  })

  it('cancels only an exact session/generation and emits cancellation once', async () => {
    const streams = [deferred(), deferred()]
    const calls: ModelChatInput[] = []
    const { service, events } = makeService({
      stream: async (call) => { const index = calls.push(call) - 1; await streams[index]!.promise },
    })
    await service.start(input(SESSION_1, 1))
    await service.start(input(SESSION_2, 1))

    service.cancel({ sessionId: SESSION_1, generation: 2 })
    expect(calls.every((call) => !call.signal.aborted)).toBe(true)
    service.cancel({ sessionId: SESSION_1, generation: 1 })
    service.cancel({ sessionId: SESSION_1, generation: 1 })

    expect(calls[0]!.signal.aborted).toBe(true)
    expect(calls[1]!.signal.aborted).toBe(false)
    expect(events.filter((event) => event.type === 'translation-cancelled')).toEqual([{
      sessionId: SESSION_1, generation: 1, type: 'translation-cancelled',
    }])
    streams[0]!.reject(new DOMException('late abort', 'AbortError'))
    streams[1]!.resolve()
  })

  it('a newer generation aborts the older generation and ignores its late delta/settlement', async () => {
    const streams = [deferred(), deferred()]
    const calls: ModelChatInput[] = []
    const { service, events } = makeService({
      stream: async (call) => { const index = calls.push(call) - 1; await streams[index]!.promise },
    })
    await service.start(input(SESSION_1, 1))
    await service.start(input(SESSION_1, 2))

    expect(calls[0]!.signal.aborted).toBe(true)
    calls[0]!.onDelta('PRIVATE_LATE_MODEL_OUTPUT')
    streams[0]!.resolve()
    calls[1]!.onDelta('{"translations":[{"id":"line-1","text":"fresh"}]}')
    streams[1]!.resolve()
    await waitForEvent(events, 'translation-completed')

    expect(JSON.stringify(events)).not.toContain('PRIVATE_LATE_MODEL_OUTPUT')
    expect(events.filter((event) => event.type === 'translation-cancelled')).toEqual([{
      sessionId: SESSION_1, generation: 1, type: 'translation-cancelled',
    }])
    expect(events.at(-1)).toMatchObject({ generation: 2, type: 'translation-completed' })
  })

  it('a newer generation invalidates old work even when the new model assignment is unavailable', async () => {
    let models = modelSettings()
    const settings: SettingsUpdater = {
      get: () => ({ lastWorkspace: null, models }),
      update: vi.fn(),
    }
    const stream = deferred()
    let call: ModelChatInput | undefined
    const { service, events } = makeService({
      settings,
      stream: async (value) => { call = value; await stream.promise },
    })
    await service.start(input(SESSION_1, 1))
    models = modelSettings({ screenshotConnectionId: null })

    await expect(service.start(input(SESSION_1, 2))).rejects.toMatchObject({
      code: 'MODEL_NOT_CONFIGURED',
    })

    expect(call!.signal.aborted).toBe(true)
    expect(events).toContainEqual({
      sessionId: SESSION_1, generation: 1, type: 'translation-cancelled',
    })
    stream.resolve()
  })

  it('invalid blocks in a newer generation still invalidate old work and own latest', async () => {
    const stream = deferred()
    let call: ModelChatInput | undefined
    const { service, events } = makeService({
      stream: async (value) => { call = value; await stream.promise },
    })
    await service.start(input(SESSION_1, 1))

    await expect(service.start(input(SESSION_1, 2, [{
      ...ocrBlock(1),
      text: '',
    }]))).rejects.toMatchObject({ code: 'TRANSLATION_FAILED' })

    expect(call!.signal.aborted).toBe(true)
    call!.onDelta('{"translations":[{"id":"line-1","text":"late"}]}')
    stream.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toContainEqual({
      sessionId: SESSION_1, generation: 1, type: 'translation-cancelled',
    })
    expect(events).toContainEqual({
      sessionId: SESSION_1, generation: 2, type: 'failed',
      stage: 'translation', code: 'TRANSLATION_FAILED',
    })
    expect(events.some((event) => (
      event.generation === 1 && event.type === 'translation-completed'
    ))).toBe(false)
    await expect(service.start(input(SESSION_1, 2))).rejects.toMatchObject({
      code: 'TRANSLATION_FAILED',
    })
  })

  it('does not replay a cancelled generation or emit a second cancellation', async () => {
    const stream = deferred()
    const calls: ModelChatInput[] = []
    const { service, events } = makeService({
      stream: async (call) => { calls.push(call); await stream.promise },
    })
    await service.start(input(SESSION_1, 1))
    service.cancel({ sessionId: SESSION_1, generation: 1 })

    await expect(service.start(input(SESSION_1, 1))).rejects.toMatchObject({
      code: 'TRANSLATION_FAILED',
    })

    expect(calls).toHaveLength(1)
    expect(events.filter((event) => event.type === 'translation-cancelled')).toEqual([{
      sessionId: SESSION_1, generation: 1, type: 'translation-cancelled',
    }])
    stream.resolve()
  })

  it('does not replay a completed generation or publish a second completion', async () => {
    const stream = vi.fn(async (call: ModelChatInput) => {
      call.onDelta('{"translations":[{"id":"line-1","text":"done"}]}')
    })
    const { service, events } = makeService({ stream })
    await service.start(input(SESSION_1, 1))
    await waitForEvent(events, 'translation-completed')

    await expect(service.start(input(SESSION_1, 1))).rejects.toMatchObject({
      code: 'TRANSLATION_FAILED',
    })

    expect(stream).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.type === 'translation-completed')).toHaveLength(1)
  })

  it('does not replay a failed generation or invoke the model twice', async () => {
    const stream = vi.fn(async () => { throw new Error('first failure') })
    const { service, events } = makeService({ stream })
    await service.start(input(SESSION_1, 1))
    await waitForEvent(events, 'failed')

    await expect(service.start(input(SESSION_1, 1))).rejects.toMatchObject({
      code: 'TRANSLATION_FAILED',
    })

    expect(stream).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.type === 'failed')).toHaveLength(1)
  })

  it('supports concurrent sessions and disposes all without late events or future starts', async () => {
    const streams = [deferred(), deferred()]
    const calls: ModelChatInput[] = []
    const { service, events } = makeService({
      stream: async (call) => { const index = calls.push(call) - 1; await streams[index]!.promise },
    })
    await service.start(input(SESSION_1, 1))
    await service.start(input(SESSION_2, 4))
    const beforeDispose = [...events]

    service.dispose()
    expect(calls.every((call) => call.signal.aborted)).toBe(true)
    calls[0]!.onDelta('late-one')
    calls[1]!.onDelta('late-two')
    streams[0]!.resolve()
    streams[1]!.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(beforeDispose)
    await expect(service.start(input(SESSION_1, 2))).rejects.toMatchObject({ code: 'TRANSLATION_FAILED' })
  })
})

describe('screenshot translation public surfaces', () => {
  it('excludes screenshot/path/OCR geometry/raw output/secret/native canaries and writes no selection history', async () => {
    const settings = settingsUpdater(modelSettings())
    const logged: unknown[][] = []
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...values) => logged.push(values)),
      vi.spyOn(console, 'warn').mockImplementation((...values) => logged.push(values)),
      vi.spyOn(console, 'error').mockImplementation((...values) => logged.push(values)),
    ]
    const events: ScreenshotTranslationEvent[] = []
    const privateBlock = {
      ...ocrBlock(1, 'allowed OCR text'),
      rectPx: { x: 987, y: 654, width: 3, height: 2 },
      words: [{ text: 'PRIVATE_WORD_GEOMETRY', rectPx: { x: 987, y: 654, width: 3, height: 2 } }],
    }
    const { service } = makeService({
      settings, events,
      secret: async () => 'PRIVATE_API_SECRET',
      stream: async (call) => {
        expect(JSON.stringify(call.messages)).not.toContain('PRIVATE_WORD_GEOMETRY')
        call.onDelta('PRIVATE_RAW_MODEL_OUTPUT')
        throw new Error('PRIVATE_NATIVE_MESSAGE C:\\PRIVATE\\temp.png')
      },
    })
    try {
      await service.start(input(SESSION_1, 1, [privateBlock]))
      await waitForEvent(events, 'failed')
      const publicSurfaces = JSON.stringify({ events, logged })
      for (const canary of [
        'PRIVATE_API_SECRET', 'PRIVATE_RAW_MODEL_OUTPUT', 'PRIVATE_NATIVE_MESSAGE',
        'C:\\PRIVATE\\temp.png', 'PRIVATE_WORD_GEOMETRY', '987', '654',
      ]) expect(publicSurfaces).not.toContain(canary)
      expect(settings.update).not.toHaveBeenCalled()
      expect(events.every((event) => !('requestId' in event))).toBe(true)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
