import { expect, it, vi } from 'vitest'
import {
  createArkdownApi,
  type ScreenshotOcrHostEventTransport,
  type ScreenshotCaptureEventTransport,
  type ScreenshotTranslationEventTransport,
} from '../../src/preload/arkdown-api'
import { IPC_CHANNELS, SCREENSHOT_OCR_MODEL_CHANNELS } from '../../src/shared/contracts'
import {
  SCREENSHOT_CAPTURE_EVENT_CHANNEL,
  SCREENSHOT_OCR_HOST_EVENT_CHANNEL,
  SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
  type ArkdownApi,
} from '../../src/shared/contracts'

it('owns the OCR model state API channels and drops malformed state events', async () => {
  let emit: ((value: unknown) => void) | undefined
  const transport = { subscribe(listener: (payload: unknown) => void) { emit = listener; return () => { emit = undefined } } }
  const invoke = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      activeTier: 'small', bundledVersion: '6.0.0', mediumVersion: null,
      availableMediumVersion: null, status: 'bundled-small', progress: null, errorCode: null,
    },
  })
  const observed = { revision: 0, preferredTier: 'small' as const, tierRevision: 0 }
  invoke.mockResolvedValueOnce({ ok: true, value: { observed, state: {
    activeTier: 'small', bundledVersion: '6.0.0', mediumVersion: null,
    availableMediumVersion: null, status: 'bundled-small', progress: null, errorCode: null,
  } } })
  const api = createArkdownApi(
    invoke, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, transport,
  )
  const listener = vi.fn()
  const unsubscribe = api.onScreenshotOcrModelState!(listener)
  expect(emit).toBeTypeOf('function')
  emit?.({ activeTier: 'small', bundledVersion: '6.0.0', mediumVersion: null, availableMediumVersion: null, status: 'bundled-small', progress: null, errorCode: null, privatePath: 'C:\\private' })
  expect(listener).not.toHaveBeenCalled()
  emit?.({ activeTier: 'small', bundledVersion: '6.0.0', mediumVersion: null, availableMediumVersion: null, status: 'bundled-small', progress: null, errorCode: null })
  unsubscribe()
  emit?.({ activeTier: 'small', bundledVersion: '6.0.0', mediumVersion: null, availableMediumVersion: null, status: 'bundled-small', progress: null, errorCode: null })

  await expect(api.getScreenshotOcrModelState!()).resolves.toMatchObject({ ok: true })
  await expect(api.downloadScreenshotOcrMedium!(observed)).resolves.toMatchObject({ ok: true })
  await expect(api.cancelScreenshotOcrMediumDownload!()).resolves.toMatchObject({ ok: true })
  await expect(api.removeScreenshotOcrMedium!(observed)).resolves.toMatchObject({ ok: true })
  expect(listener).toHaveBeenCalledOnce()
  expect(invoke.mock.calls).toEqual([
    [SCREENSHOT_OCR_MODEL_CHANNELS.getState],
    [SCREENSHOT_OCR_MODEL_CHANNELS.downloadMedium, observed],
    [SCREENSHOT_OCR_MODEL_CHANNELS.cancelMediumDownload],
    [SCREENSHOT_OCR_MODEL_CHANNELS.removeMedium, observed],
  ])
})

const sessionId = '123e4567-e89b-42d3-a456-426614174000'

it('exposes exact OCR host commands only to an ordinary renderer subscriber', () => {
  let emit: ((value: unknown) => void) | undefined
  const transport: ScreenshotOcrHostEventTransport = {
    subscribe(listener) { emit = listener; return () => { emit = undefined } },
  }
  const api = createArkdownApi(
    vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, transport,
  )
  const listener = vi.fn()
  const unsubscribe = api.onScreenshotOcrHostCommand!(listener)
  const command = {
    type: 'recognize' as const,
    sessionId,
    generation: 1,
    image: { width: 4, height: 3, dataUrl: 'data:image/png;base64,AAAA' },
    tier: 'small' as const,
    cacheKey: 'small:6.0.0',
  }
  expect(emit).toBeTypeOf('function')
  emit?.({ ...command, extra: true })
  expect(listener).not.toHaveBeenCalled()
  emit?.(command)
  unsubscribe()
  emit?.({ type: 'cancel', sessionId, generation: 1 })
  expect(listener).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledWith(command)
})

it('bounds startup OCR commands at two and exactly fails or settles every evicted command without retaining its image', async () => {
  let finishEvictedFailure!: () => void
  const evictedFailure = new Promise<{ ok: true; value: null }>((resolve) => {
    finishEvictedFailure = () => resolve({ ok: true, value: null })
  })
  const electron = {
    expose: vi.fn(),
    invoke: vi.fn((channel: string) => channel === IPC_CHANNELS.submitScreenshotOcr
      ? evictedFailure
      : Promise.resolve({ ok: true, value: null })),
    listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  }
  vi.doMock('electron', () => ({
    contextBridge: { exposeInMainWorld: electron.expose },
    ipcRenderer: {
      invoke: electron.invoke,
      on: vi.fn((channel, listener) => electron.listeners.set(channel, listener)),
      removeListener: vi.fn(), send: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn(() => '') },
  }))
  vi.resetModules()
  await import('../../src/preload/index')
  const emit = electron.listeners.get(SCREENSHOT_OCR_HOST_EVENT_CHANNEL)!
  const command = {
    type: 'recognize' as const,
    sessionId,
    generation: 1,
    image: { width: 4, height: 3, dataUrl: 'data:image/png;base64,AAAA' },
    tier: 'small' as const,
    cacheKey: 'small:6.0.0',
  }
  const cancel = { type: 'cancel' as const, sessionId, generation: 2 }
  const retained = [
    { ...command, generation: 3, image: { ...command.image, dataUrl: 'data:image/png;base64,CCCC' } },
    { ...command, generation: 4, image: { ...command.image, dataUrl: 'data:image/png;base64,DDDD' } },
  ]
  emit({}, { ...command, extra: true })
  for (const next of [command, cancel, ...retained]) emit({}, next)

  const evictedFailureCall = [IPC_CHANNELS.submitScreenshotOcr, {
    sessionId, generation: 1, status: 'failure', code: 'OCR_UNAVAILABLE',
  }]
  const evictedRecognizeSettlement = [
    IPC_CHANNELS.settleScreenshotOcr, { sessionId, generation: 1 },
  ]
  const evictedCancelSettlement = [
    IPC_CHANNELS.settleScreenshotOcr, { sessionId, generation: 2 },
  ]
  const api = electron.expose.mock.calls[0]![1] as ArkdownApi
  const stale = vi.fn()
  const unsubscribeStale = api.onScreenshotOcrHostCommand!(stale)
  await vi.waitFor(() => expect(electron.invoke.mock.calls).toContainEqual(evictedFailureCall))
  expect(electron.invoke.mock.calls).not.toContainEqual(evictedRecognizeSettlement)
  expect(stale).not.toHaveBeenCalled()
  unsubscribeStale()
  const first = vi.fn()
  const unsubscribe = api.onScreenshotOcrHostCommand!(first)
  expect(first).not.toHaveBeenCalled()
  finishEvictedFailure()
  await vi.waitFor(() => expect(electron.invoke).toHaveBeenCalledTimes(3))
  expect(electron.invoke.mock.calls).toEqual([
    evictedFailureCall, evictedRecognizeSettlement, evictedCancelSettlement,
  ])
  expect(JSON.stringify(electron.invoke.mock.calls)).not.toContain('data:image/png')
  expect(JSON.stringify(electron.invoke.mock.calls)).not.toContain('AAAA')

  await vi.waitFor(() => expect(first.mock.calls.map(([value]) => value)).toEqual(retained))
  expect(stale).not.toHaveBeenCalled()
  expect(JSON.stringify(first.mock.calls)).not.toContain('AAAA')
  unsubscribe()

  const second = vi.fn()
  api.onScreenshotOcrHostCommand!(second)
  expect(second).not.toHaveBeenCalled()
})

it('still exactly settles an evicted recognize command when its fixed failure submission rejects', async () => {
  const electron = {
    expose: vi.fn(),
    invoke: vi.fn((channel: string) => channel === IPC_CHANNELS.submitScreenshotOcr
      ? Promise.reject(new Error('private invoke detail'))
      : Promise.resolve({ ok: true, value: null })),
    listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  }
  vi.doMock('electron', () => ({
    contextBridge: { exposeInMainWorld: electron.expose },
    ipcRenderer: {
      invoke: electron.invoke,
      on: vi.fn((channel, listener) => electron.listeners.set(channel, listener)),
      removeListener: vi.fn(), send: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn(() => '') },
  }))
  vi.resetModules()
  await import('../../src/preload/index')
  const emit = electron.listeners.get(SCREENSHOT_OCR_HOST_EVENT_CHANNEL)!
  const command = {
    type: 'recognize' as const,
    sessionId,
    generation: 1,
    image: { width: 4, height: 3, dataUrl: 'data:image/png;base64,AAAA' },
    tier: 'small' as const,
    cacheKey: 'small:6.0.0',
  }
  emit({}, command)
  emit({}, { ...command, generation: 2 })
  emit({}, { ...command, generation: 3 })

  const api = electron.expose.mock.calls[0]![1] as ArkdownApi
  const retained = vi.fn()
  api.onScreenshotOcrHostCommand!(retained)
  await vi.waitFor(() => expect(electron.invoke.mock.calls).toEqual([
    [IPC_CHANNELS.submitScreenshotOcr, {
      sessionId, generation: 1, status: 'failure', code: 'OCR_UNAVAILABLE',
    }],
    [IPC_CHANNELS.settleScreenshotOcr, { sessionId, generation: 1 }],
  ]))
  await vi.waitFor(() => expect(retained).toHaveBeenCalledTimes(2))
  expect(retained.mock.calls.map(([value]) => value.generation)).toEqual([2, 3])
})

it('fails closed locally and exposes exact screenshot capture channels', async () => {
  const hit = { processId: 77, rectDip: { x: 10, y: 20, width: 30, height: 40 } }
  const invoke = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: hit })
    .mockResolvedValueOnce({ ok: true, value: null })
  const api = createArkdownApi(invoke)
  await expect(api.updateScreenshotCapturePointer!({ sessionId, displayId: '1', screenPointDip: { x: 1, y: 2 } }))
    .resolves.toEqual({ ok: true, value: hit })
  await api.cancelScreenshotCapture!({ sessionId })
  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.updateScreenshotCapturePointer, { sessionId, displayId: '1', screenPointDip: { x: 1, y: 2 } }],
    [IPC_CHANNELS.cancelScreenshotCapture, { sessionId }],
  ])
})

it('fails closed when a screenshot pointer response contains a malformed native hit', async () => {
  const api = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: { processId: 77, rectDip: { x: 10, y: 20, width: 30, height: 40 }, extra: true },
  }))
  await expect(api.updateScreenshotCapturePointer!({ sessionId, displayId: '1', screenPointDip: { x: 1, y: 2 } }))
    .resolves.toMatchObject({ ok: false })
})

it('retains only the newest ready session and its latest valid state across resubscription', async () => {
  const electron = { expose: vi.fn(), invoke: vi.fn(), listeners: new Map<string, (event: unknown, payload: unknown) => void>() }
  vi.doMock('electron', () => ({ contextBridge: { exposeInMainWorld: electron.expose }, ipcRenderer: { invoke: electron.invoke, on: vi.fn((channel, listener) => electron.listeners.set(channel, listener)), removeListener: vi.fn(), send: vi.fn() }, webUtils: { getPathForFile: vi.fn(() => '') } }))
  vi.resetModules(); await import('../../src/preload/index')
  const emit = electron.listeners.get(SCREENSHOT_CAPTURE_EVENT_CHANNEL)!
  const display = { displayId: '1', boundsDip: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1, imageSizePx: { width: 1, height: 1 }, dataUrl: 'data:image/png;base64,AAAA' }
  const nextSessionId = '223e4567-e89b-42d3-a456-426614174000'
  emit({}, { sessionId, type: 'selection-ready', display })
  const api = electron.expose.mock.calls[0]![1] as ArkdownApi
  const first = vi.fn()
  const unsubscribe = api.onScreenshotCaptureEvent!(first)
  emit({}, { sessionId: nextSessionId, type: 'selection-ready', display })
  emit({}, { sessionId, type: 'committing' })
  emit({}, { sessionId: nextSessionId, type: 'window-highlight', displayId: '1', hit: null })
  emit({}, { sessionId: nextSessionId, type: 'committing', extra: true })
  unsubscribe()

  expect(first.mock.calls.map(([event]) => [event.sessionId, event.type])).toEqual([
    [sessionId, 'selection-ready'],
    [nextSessionId, 'selection-ready'],
    [nextSessionId, 'window-highlight'],
  ])

  const second = vi.fn()
  const unsubscribeSecond = api.onScreenshotCaptureEvent!(second)
  expect(second.mock.calls.map(([event]) => [event.sessionId, event.type])).toEqual([
    [nextSessionId, 'selection-ready'],
    [nextSessionId, 'window-highlight'],
  ])
  unsubscribeSecond()

  const third = vi.fn()
  api.onScreenshotCaptureEvent!(third)
  expect(third).toHaveBeenCalledTimes(2)
})

it('drops malformed capture events', () => {
  let emit: ((value: unknown) => void) | undefined
  const transport: ScreenshotCaptureEventTransport = { subscribe(listener) { emit = listener; return () => { emit = undefined } } }
  const handler = vi.fn()
  const api = createArkdownApi(vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, transport)
  api.onScreenshotCaptureEvent!(handler)
  expect(emit).toBeTypeOf('function')
  emit?.({ sessionId, type: 'cancelled', extra: true })
  expect(handler).not.toHaveBeenCalled()
  emit?.({ sessionId, type: 'cancelled' })
  expect(handler).toHaveBeenCalledOnce()
  expect(handler).toHaveBeenCalledWith({ sessionId, type: 'cancelled' })
})

it('validates exact screenshot-result intents before invoking their dedicated channels', async () => {
  const accepted = { sessionId, generation: 5 }
  const invoke = vi.fn((channel: string) => Promise.resolve({
    ok: true,
    value: channel === IPC_CHANNELS.startScreenshotTranslation ? accepted : null,
  }))
  const api = createArkdownApi(invoke)
  const input = { sessionId, generation: 4 }
  await expect(api.startScreenshotTranslation!(input)).resolves.toEqual({ ok: true, value: accepted })
  await api.cancelScreenshotTranslation!(input)
  await api.minimizeScreenshotTranslation!(input)
  await api.closeScreenshotTranslation!(input)
  await api.openScreenshotTranslationSettings!(input)
  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.startScreenshotTranslation, input],
    [IPC_CHANNELS.cancelScreenshotTranslation, input],
    [IPC_CHANNELS.minimizeScreenshotTranslation, input],
    [IPC_CHANNELS.closeScreenshotTranslation, input],
    [IPC_CHANNELS.openScreenshotTranslationSettings, input],
  ])

  invoke.mockClear()
  await api.startScreenshotTranslation!({ ...input, extra: true } as never)
  await api.cancelScreenshotTranslation!({ sessionId, generation: 0 })
  await api.minimizeScreenshotTranslation!({ sessionId: 'bad', generation: 4 })
  expect(invoke).not.toHaveBeenCalled()
})

it('fails closed when the accepted retry generation is malformed', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: { sessionId, generation: 0 } })
  const api = createArkdownApi(invoke)

  await expect(api.startScreenshotTranslation!({ sessionId, generation: 1 }))
    .resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })
})

it('drops malformed result events at the Arkdown API boundary', () => {
  let emit: ((value: unknown) => void) | undefined
  const transport: ScreenshotTranslationEventTransport = {
    subscribe(listener) { emit = listener; return () => { emit = undefined } },
  }
  const handler = vi.fn()
  const api = createArkdownApi(
    vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, transport,
  )
  api.onScreenshotTranslationEvent!(handler)
  expect(emit).toBeTypeOf('function')
  emit?.({ sessionId, generation: 1, type: 'ocr-started', tier: 'small', extra: true })
  expect(handler).not.toHaveBeenCalled()
  emit?.({ sessionId, generation: 1, type: 'ocr-started', tier: 'small' })
  expect(handler).toHaveBeenCalledOnce()
  expect(handler).toHaveBeenCalledWith({ sessionId, generation: 1, type: 'ocr-started', tier: 'small' })
})

it('replays a bounded snapshot, OCR slot, and translation slot in order', async () => {
  const electron = {
    expose: vi.fn(), invoke: vi.fn(),
    listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  }
  vi.doMock('electron', () => ({
    contextBridge: { exposeInMainWorld: electron.expose },
    ipcRenderer: {
      invoke: electron.invoke,
      on: vi.fn((channel, listener) => electron.listeners.set(channel, listener)),
      removeListener: vi.fn(), send: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn(() => '') },
  }))
  vi.resetModules()
  await import('../../src/preload/index')
  const emit = electron.listeners.get(SCREENSHOT_TRANSLATION_EVENT_CHANNEL)!
  const image = { width: 400, height: 200, dataUrl: 'data:image/png;base64,AAAA' }
  const blocks = [{
    id: 'line-1', text: 'Hello', rectPx: { x: 0, y: 0, width: 100, height: 20 },
    words: [{ text: 'Hello', rectPx: { x: 0, y: 0, width: 100, height: 20 } }],
  }]
  emit({}, {
    sessionId, generation: 1, type: 'snapshot-ready',
    image: { ...image, width: 32_769 },
  })
  emit({}, { sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  emit({}, { sessionId, generation: 1, type: 'ocr-completed', blocks })
  emit({}, { sessionId, generation: 1, type: 'translation-started' })
  emit({}, { sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '你好' }] })

  const api = electron.expose.mock.calls[0]![1] as ArkdownApi
  const first = vi.fn()
  const unsubscribe = api.onScreenshotTranslationEvent!(first)
  expect(first.mock.calls.map(([event]) => event.type)).toEqual([
    'snapshot-ready', 'ocr-completed', 'translation-completed',
  ])
  unsubscribe()

  emit({}, { sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  const afterDuplicate = vi.fn()
  const stopAfterDuplicate = api.onScreenshotTranslationEvent!(afterDuplicate)
  expect(afterDuplicate.mock.calls.map(([event]) => event.type)).toEqual([
    'snapshot-ready', 'ocr-completed', 'translation-completed',
  ])
  stopAfterDuplicate()

  emit({}, {
    sessionId, generation: 2, type: 'snapshot-ready',
    image: { ...image, width: 32_769 },
  })
  emit({}, { sessionId, generation: 0, type: 'ocr-started' })
  emit({}, { sessionId, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_TIMEOUT', extra: true })
  const second = vi.fn()
  api.onScreenshotTranslationEvent!(second)
  expect(second.mock.calls.map(([event]) => event.type)).toEqual([
    'snapshot-ready', 'ocr-completed', 'translation-completed',
  ])

  const nextSessionId = '223e4567-e89b-42d3-a456-426614174000'
  emit({}, { sessionId: nextSessionId, generation: 2, type: 'snapshot-ready', image, tier: 'small' })
  const third = vi.fn()
  api.onScreenshotTranslationEvent!(third)
  expect(third).toHaveBeenCalledOnce()
  expect(third).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: nextSessionId, generation: 2, type: 'snapshot-ready',
  }))
})

it('replays only the newest cumulative document progress without losing its prefix', async () => {
  const electron = {
    expose: vi.fn(), invoke: vi.fn(),
    listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  }
  vi.doMock('electron', () => ({
    contextBridge: { exposeInMainWorld: electron.expose },
    ipcRenderer: {
      invoke: electron.invoke,
      on: vi.fn((channel, listener) => electron.listeners.set(channel, listener)),
      removeListener: vi.fn(), send: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn(() => '') },
  }))
  vi.resetModules()
  await import('../../src/preload/index')
  const emit = electron.listeners.get(SCREENSHOT_TRANSLATION_EVENT_CHANNEL)!
  const image = { width: 400, height: 200, dataUrl: 'data:image/png;base64,AAAA' }
  const blocks = [{
    id: 'line-1', text: 'Hello', rectPx: { x: 0, y: 0, width: 100, height: 20 },
    words: [{ text: 'Hello', rectPx: { x: 0, y: 0, width: 100, height: 20 } }],
  }]
  emit({}, { sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  emit({}, { sessionId, generation: 1, type: 'ocr-completed', blocks })
  emit({}, {
    sessionId, generation: 1, type: 'document-translation-progress',
    text: '第一段', completedChunks: 0, totalChunks: 2,
  })
  emit({}, {
    sessionId, generation: 1, type: 'document-translation-progress',
    text: '第一段\n第二段', completedChunks: 1, totalChunks: 2,
  })

  const api = electron.expose.mock.calls[0]![1] as ArkdownApi
  const replay = vi.fn()
  api.onScreenshotTranslationEvent!(replay)

  expect(replay.mock.calls.map(([event]) => event.type)).toEqual([
    'snapshot-ready', 'ocr-completed', 'document-translation-progress',
  ])
  expect(replay.mock.calls.at(-1)?.[0]).toMatchObject({ text: '第一段\n第二段' })
})

it('replays retained document progress before a later retryable failure', async () => {
  const electron = {
    expose: vi.fn(), invoke: vi.fn(),
    listeners: new Map<string, (event: unknown, payload: unknown) => void>(),
  }
  vi.doMock('electron', () => ({
    contextBridge: { exposeInMainWorld: electron.expose },
    ipcRenderer: {
      invoke: electron.invoke,
      on: vi.fn((channel, listener) => electron.listeners.set(channel, listener)),
      removeListener: vi.fn(), send: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn(() => '') },
  }))
  vi.resetModules()
  await import('../../src/preload/index')
  const emit = electron.listeners.get(SCREENSHOT_TRANSLATION_EVENT_CHANNEL)!
  const image = { width: 400, height: 200, dataUrl: 'data:image/png;base64,AAAA' }
  const blocks = [{
    id: 'line-1', text: 'Hello', rectPx: { x: 0, y: 0, width: 100, height: 20 },
    words: [{ text: 'Hello', rectPx: { x: 0, y: 0, width: 100, height: 20 } }],
  }]
  emit({}, { sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  emit({}, { sessionId, generation: 1, type: 'ocr-completed', blocks })
  emit({}, {
    sessionId, generation: 1, type: 'document-translation-progress',
    text: '已完成部分', completedChunks: 1, totalChunks: 2,
  })
  emit({}, {
    sessionId, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_TIMEOUT',
  })

  const api = electron.expose.mock.calls[0]![1] as ArkdownApi
  const replay = vi.fn()
  api.onScreenshotTranslationEvent!(replay)

  expect(replay.mock.calls.map(([event]) => event.type)).toEqual([
    'snapshot-ready', 'ocr-completed', 'document-translation-progress', 'failed',
  ])
  expect(replay.mock.calls[2]?.[0]).toMatchObject({ text: '已完成部分' })
})
