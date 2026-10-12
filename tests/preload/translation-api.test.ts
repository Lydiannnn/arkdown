import { expect, it, vi } from 'vitest'
import { createArkdownApi, type TranslationEventTransport } from '../../src/preload/arkdown-api'
import {
  IPC_CHANNELS,
  TRANSLATION_EVENT_CHANNEL,
  type ArkdownApi,
} from '../../src/shared/contracts'
import { PUBLIC_ERROR_MESSAGES } from '../../src/shared/public-errors'
import { MODEL_ID_MAX_LENGTH } from '../../src/shared/large-model-settings'

const requestId = '123e4567-e89b-42d3-a456-426614174000'

function transport() {
  let listener: ((payload: unknown) => void) | undefined
  return {
    value: {
      subscribe(next: (payload: unknown) => void) {
        listener = next
        return () => {
          if (listener === next) listener = undefined
        }
      },
    } satisfies TranslationEventTransport,
    emit(payload: unknown) {
      listener?.(payload)
    },
  }
}

it('invokes fixed translation channels and reconstructs strict success values', async () => {
  const started = {
    requestId,
    targetLanguage: 'fr',
    modelId: 'm'.repeat(MODEL_ID_MAX_LENGTH),
  }
  const invoke = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: started })
    .mockResolvedValueOnce({ ok: true, value: null })
  const api = createArkdownApi(invoke)
  const input = {
    documentKey: 'note.md',
    content: { markdown: '**hello**', plainText: 'hello' },
    mode: 'visual' as const,
  }

  await expect(api.startTranslation(input)).resolves.toEqual({ ok: true, value: started })
  await expect(api.cancelTranslation(requestId)).resolves.toEqual({ ok: true, value: null })
  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.startTranslation, input],
    [IPC_CHANNELS.cancelTranslation, { requestId }],
  ])
})

it('fails closed for malformed translation start responses', async () => {
  for (const value of [
    { requestId: requestId.toUpperCase(), targetLanguage: 'fr', modelId: 'chat-model' },
    { requestId, targetLanguage: 'auto', modelId: 'chat-model' },
    { requestId, targetLanguage: 'fr' },
    { requestId, targetLanguage: 'fr', modelId: '' },
    { requestId, targetLanguage: 'fr', modelId: ' chat-model' },
    { requestId, targetLanguage: 'fr', modelId: 'chat-model ' },
    { requestId, targetLanguage: 'fr', modelId: 'x'.repeat(MODEL_ID_MAX_LENGTH + 1) },
    { requestId, targetLanguage: 'fr', modelId: 'chat-model', extra: true },
    Object.create({ requestId, targetLanguage: 'fr', modelId: 'chat-model' }),
  ]) {
    const api = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value }))
    await expect(api.startTranslation({
      documentKey: 'note.md',
      content: { markdown: 'hello', plainText: 'hello' },
      mode: 'source',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE' },
    })
  }
})

it('rejects malformed structured translation content before invoking main', async () => {
  const invoke = vi.fn()
  const valid = { markdown: '**hello**', plainText: 'hello' }
  const inherited = Object.create({ markdown: valid.markdown })
  Object.assign(inherited, { plainText: valid.plainText })

  for (const content of [
    inherited,
    { ...valid, extra: true },
    { markdown: valid.markdown },
    { plainText: valid.plainText },
    null,
    [],
    { markdown: 42, plainText: valid.plainText },
    { markdown: valid.markdown, plainText: 42 },
    { markdown: 'x'.repeat(200_001), plainText: valid.plainText },
    { markdown: valid.markdown, plainText: 'x'.repeat(200_001) },
  ]) {
    const api = createArkdownApi(invoke)
    await expect(api.startTranslation({
      documentKey: 'note.md',
      content,
      mode: 'visual',
    } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }

  const inheritedInput = Object.create({ documentKey: 'note.md' })
  Object.assign(inheritedInput, { content: valid, mode: 'visual' })
  for (const input of [
    inheritedInput,
    { documentKey: 'note.md', content: valid, mode: 'visual', extra: true },
  ]) {
    const api = createArkdownApi(invoke)
    await expect(api.startTranslation(input as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }

  expect(invoke).not.toHaveBeenCalled()
})

it('accepts and preserves empty and whitespace-only plain-text summaries', async () => {
  const started = { requestId, targetLanguage: 'fr', modelId: 'chat-model' }
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: started })
  const api = createArkdownApi(invoke)
  const inputs = ['', ' \r\n\t '].map((plainText) => ({
    documentKey: 'note.md',
    content: { markdown: '---', plainText },
    mode: 'source' as const,
  }))

  for (const input of inputs) {
    await expect(api.startTranslation(input)).resolves.toEqual({ ok: true, value: started })
  }
  expect(invoke.mock.calls).toEqual(inputs.map((input) => [IPC_CHANNELS.startTranslation, input]))
})

it('delivers only reconstructed event-specific payloads and releases unsubscribed handlers', () => {
  const source = transport()
  const api = createArkdownApi(
    vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, source.value,
  )
  const handler = vi.fn()
  const unsubscribe = api.onTranslationEvent(handler)
  const validEvents = [
    { requestId, type: 'started' },
    { requestId, type: 'delta', delta: 'Bon' },
    { requestId, type: 'completed' },
    { requestId, type: 'stopped' },
    {
      requestId,
      type: 'failed',
      code: 'MODEL_TIMEOUT',
      message: PUBLIC_ERROR_MESSAGES.MODEL_TIMEOUT,
    },
  ]

  for (const event of validEvents) source.emit(event)

  expect(handler.mock.calls.map(([event]) => event)).toEqual(validEvents)
  for (let index = 0; index < validEvents.length; index += 1) {
    expect(handler.mock.calls[index]![0]).not.toBe(validEvents[index])
  }
  unsubscribe()
  source.emit({ requestId, type: 'completed' })
  expect(handler).toHaveBeenCalledTimes(validEvents.length)
})

it('rejects malformed, oversized, inherited, extra, and event-mismatched payloads', () => {
  const source = transport()
  const api = createArkdownApi(
    vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, source.value,
  )
  const handler = vi.fn()
  api.onTranslationEvent(handler)
  const inherited = Object.create({ requestId })
  Object.assign(inherited, { type: 'started' })

  for (const event of [
    inherited,
    { requestId, type: 'started', extra: true },
    { requestId: requestId.toUpperCase(), type: 'started' },
    { requestId, type: 'unknown' },
    { requestId, type: 'completed', delta: 'wrong' },
    { requestId, type: 'delta' },
    { requestId, type: 'delta', delta: 'x'.repeat(256 * 1024 + 1) },
    { requestId, type: 'delta', delta: '汉'.repeat(100_000) },
    { requestId, type: 'failed', code: 'PRIVATE_PROVIDER_FAILURE', message: 'secret' },
    { requestId, type: 'failed', code: 'MODEL_TIMEOUT', message: 'provider body' },
    {
      requestId,
      type: 'failed',
      code: 'MODEL_TIMEOUT',
      message: PUBLIC_ERROR_MESSAGES.MODEL_TIMEOUT,
      stack: 'secret',
    },
  ]) source.emit(event)

  expect(handler).not.toHaveBeenCalled()
})

it('uses one buffered translation listener in the real preload entry', async () => {
  const electron = {
    expose: vi.fn(),
    invoke: vi.fn().mockResolvedValue({ ok: true, value: null }),
    listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  }
  vi.doMock('electron', () => ({
    contextBridge: { exposeInMainWorld: electron.expose },
    ipcRenderer: {
      invoke: electron.invoke,
      on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        electron.listeners.set(channel, listener)
      }),
      removeListener: vi.fn(),
      send: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn(() => '') },
  }))
  vi.resetModules()
  await import('../../src/preload/index')
  const api = electron.expose.mock.calls[0]![1] as ArkdownApi

  const emit = electron.listeners.get(TRANSLATION_EVENT_CHANNEL)!
  emit({}, {
    requestId,
    type: 'delta',
    delta: 'ignored',
    extra: 'x'.repeat(9 * 1024 * 1024),
  })
  emit({}, { requestId, type: 'started' })
  for (let index = 0; index < 1022; index += 1) {
    emit({}, { requestId, type: 'delta', delta: `buffered-${index}` })
  }
  emit({}, { requestId, type: 'completed' })
  const handler = vi.fn()
  const unsubscribe = api.onTranslationEvent(handler)
  expect(handler).toHaveBeenCalledTimes(1024)
  expect(handler.mock.calls[0]![0]).toEqual({ requestId, type: 'started' })
  expect(handler.mock.calls[1023]![0]).toEqual({ requestId, type: 'completed' })
  expect(handler.mock.calls[501]![0]).toEqual({
    requestId, type: 'delta', delta: 'buffered-500',
  })
  unsubscribe()

  const countOverflowId = '223e4567-e89b-42d3-a456-426614174000'
  emit({}, { requestId: countOverflowId, type: 'started' })
  for (let index = 0; index < 1023; index += 1) {
    emit({}, { requestId: countOverflowId, type: 'delta', delta: 'x' })
  }
  emit({}, { requestId: countOverflowId, type: 'completed' })
  const countOverflowHandler = vi.fn()
  const unsubscribeCountOverflow = api.onTranslationEvent(countOverflowHandler)
  expect(countOverflowHandler.mock.calls.map(([event]) => event)).toEqual([{
    requestId: countOverflowId,
    type: 'failed',
    code: 'OPERATION_FAILED',
    message: PUBLIC_ERROR_MESSAGES.OPERATION_FAILED,
  }])
  emit({}, { requestId: countOverflowId, type: 'started' })
  emit({}, { requestId: countOverflowId, type: 'delta', delta: 'late' })
  emit({}, { requestId: countOverflowId, type: 'completed' })
  expect(countOverflowHandler).toHaveBeenCalledOnce()
  unsubscribeCountOverflow()

  const byteOverflowId = '323e4567-e89b-42d3-a456-426614174000'
  const maximumDelta = 'x'.repeat(240 * 1024)
  emit({}, { requestId: byteOverflowId, type: 'started' })
  for (let index = 0; index < 35; index += 1) {
    emit({}, { requestId: byteOverflowId, type: 'delta', delta: maximumDelta })
  }
  emit({}, { requestId: byteOverflowId, type: 'completed' })
  const byteOverflowHandler = vi.fn()
  api.onTranslationEvent(byteOverflowHandler)
  expect(byteOverflowHandler.mock.calls.map(([event]) => event)).toEqual([{
    requestId: byteOverflowId,
    type: 'failed',
    code: 'OPERATION_FAILED',
    message: PUBLIC_ERROR_MESSAGES.OPERATION_FAILED,
  }])
  expect([...electron.listeners.keys()].filter(
    (channel) => channel === TRANSLATION_EVENT_CHANNEL,
  )).toHaveLength(1)
  expect(electron.invoke).toHaveBeenCalledWith(
    IPC_CHANNELS.cancelTranslation, { requestId: countOverflowId },
  )
  expect(electron.invoke).toHaveBeenCalledWith(
    IPC_CHANNELS.cancelTranslation, { requestId: byteOverflowId },
  )
})
