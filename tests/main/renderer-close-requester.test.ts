import { afterEach, expect, it, vi } from 'vitest'
import { createRendererCloseRequester } from '../../src/main/renderer-close-requester'
import { CLOSE_CHANNELS } from '../../src/shared/contracts'

afterEach(() => vi.useRealTimers())

function createHarness(
  requestIds = ['request-1', 'request-2'],
  timeoutMs = 1_000,
) {
  const ipcListeners = new Map<string, (event: unknown, payload: unknown) => void>()
  const webListeners = new Map<string, (...args: unknown[]) => void>()
  const mainFrame = {}
  const webContents = {
    mainFrame,
    send: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      webListeners.set(event, listener)
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (webListeners.get(event) === listener) webListeners.delete(event)
    }),
  }
  const ipcMain = {
    on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
      ipcListeners.set(channel, listener)
    }),
    removeListener: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
      if (ipcListeners.get(channel) === listener) ipcListeners.delete(channel)
    }),
  }
  const createRequestId = vi.fn(() => {
    const requestId = requestIds.shift()
    if (!requestId) throw new Error('No request ID prepared')
    return requestId
  })
  const requester = createRendererCloseRequester({
    ipcMain,
    window: { webContents },
    createRequestId,
    timeoutMs,
  })
  const trustedEvent = { sender: webContents, senderFrame: mainFrame }
  return {
    ipcListeners, webListeners, mainFrame, webContents, ipcMain, createRequestId, requester,
    trustedEvent,
  }
}

it('resolves only an exact close response from the trusted main frame and cleans listeners', async () => {
  vi.useFakeTimers()
  const { ipcListeners, webListeners, mainFrame, webContents, requester, trustedEvent } =
    createHarness()
  const preparation = requester.prepare()

  expect(webContents.send).toHaveBeenCalledWith(
    CLOSE_CHANNELS.prepare,
    { requestId: 'request-1' },
  )
  const respond = ipcListeners.get(CLOSE_CHANNELS.response)!
  respond({ sender: {}, senderFrame: mainFrame }, { requestId: 'request-1', ok: true })
  respond(trustedEvent, { requestId: 'request-1', ok: true, extra: 'leak' })

  let settled = false
  void preparation.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)

  respond(trustedEvent, { requestId: 'request-1', ok: true })
  await expect(preparation).resolves.toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  expect(ipcListeners).toHaveLength(0)
  expect(webListeners).toHaveLength(0)
})

it('keeps a responsive close preparation alive past ten seconds until its terminal response', async () => {
  vi.useFakeTimers()
  const { ipcListeners, trustedEvent, requester } = createHarness(
    ['request-1', 'request-2'],
    10_000,
  )
  const preparation = requester.prepare()
  let settled = false
  void preparation.then(() => { settled = true })

  for (let elapsed = 0; elapsed < 12_000; elapsed += 1_000) {
    ipcListeners.get(CLOSE_CHANNELS.heartbeat)?.(
      trustedEvent,
      { requestId: 'request-1' },
    )
    await vi.advanceTimersByTimeAsync(1_000)
  }

  expect(settled).toBe(false)
  ipcListeners.get(CLOSE_CHANNELS.response)?.(
    trustedEvent,
    { requestId: 'request-1', ok: true },
  )
  await expect(preparation).resolves.toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not renew the timeout for another window or request', async () => {
  vi.useFakeTimers()
  const { ipcListeners, mainFrame, webContents, requester, trustedEvent } = createHarness()
  const preparation = requester.prepare()
  let result: boolean | undefined
  void preparation.then((ready) => { result = ready })

  await vi.advanceTimersByTimeAsync(500)
  ipcListeners.get(CLOSE_CHANNELS.heartbeat)?.(
    { sender: {}, senderFrame: mainFrame },
    { requestId: 'request-1' },
  )
  ipcListeners.get(CLOSE_CHANNELS.heartbeat)?.(
    { sender: webContents, senderFrame: {} },
    { requestId: 'request-1' },
  )
  ipcListeners.get(CLOSE_CHANNELS.heartbeat)?.(
    trustedEvent,
    { requestId: 'request-2' },
  )
  ipcListeners.get(CLOSE_CHANNELS.heartbeat)?.(
    trustedEvent,
    { requestId: 'request-1', extra: true },
  )
  await vi.advanceTimersByTimeAsync(500)

  expect(result).toBe(false)
  await expect(preparation).resolves.toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('isolates simultaneous heartbeat leases for two windows with the same request ID', async () => {
  vi.useFakeTimers()
  type Listener = (event: unknown, payload: unknown) => void
  const listeners = new Map<string, Set<Listener>>()
  const ipcMain = {
    on: vi.fn((channel: string, listener: Listener) => {
      const channelListeners = listeners.get(channel) ?? new Set<Listener>()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    }),
    removeListener: vi.fn((channel: string, listener: Listener) => {
      const channelListeners = listeners.get(channel)
      channelListeners?.delete(listener)
      if (channelListeners?.size === 0) listeners.delete(channel)
    }),
  }
  const createWindow = () => {
    const mainFrame = {}
    const webListeners = new Map<string, () => void>()
    const webContents = {
      mainFrame,
      send: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => webListeners.set(event, listener)),
      removeListener: vi.fn((event: string, listener: () => void) => {
        if (webListeners.get(event) === listener) webListeners.delete(event)
      }),
    }
    return { webContents }
  }
  const emit = (channel: string, event: unknown, payload: unknown) => {
    for (const listener of [...(listeners.get(channel) ?? [])]) listener(event, payload)
  }
  const firstWindow = createWindow()
  const secondWindow = createWindow()
  const firstRequester = createRendererCloseRequester({
    ipcMain,
    window: firstWindow,
    createRequestId: () => 'shared-request',
    timeoutMs: 1_000,
  })
  const secondRequester = createRendererCloseRequester({
    ipcMain,
    window: secondWindow,
    createRequestId: () => 'shared-request',
    timeoutMs: 1_000,
  })
  const first = firstRequester.prepare()
  const second = secondRequester.prepare()
  let firstResult: boolean | undefined
  let secondResult: boolean | undefined
  void first.then((ready) => { firstResult = ready })
  void second.then((ready) => { secondResult = ready })

  await vi.advanceTimersByTimeAsync(500)
  emit(
    CLOSE_CHANNELS.heartbeat,
    { sender: firstWindow.webContents, senderFrame: firstWindow.webContents.mainFrame },
    { requestId: 'shared-request' },
  )
  await vi.advanceTimersByTimeAsync(500)

  expect(firstResult).toBeUndefined()
  expect(secondResult).toBe(false)
  await expect(second).resolves.toBe(false)
  emit(
    CLOSE_CHANNELS.response,
    { sender: firstWindow.webContents, senderFrame: firstWindow.webContents.mainFrame },
    { requestId: 'shared-request', ok: true },
  )
  await expect(first).resolves.toBe(true)
  expect(listeners).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('times out without renderer response and retries with a fresh request ID', async () => {
  vi.useFakeTimers()
  const { ipcListeners, webListeners, webContents, createRequestId, requester } =
    createHarness()
  const first = requester.prepare()

  await vi.advanceTimersByTimeAsync(1_000)
  await expect(first).resolves.toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  expect(ipcListeners).toHaveLength(0)
  expect(webListeners).toHaveLength(0)

  const second = requester.prepare()
  expect(createRequestId).toHaveBeenCalledTimes(2)
  expect(webContents.send).toHaveBeenNthCalledWith(
    2,
    CLOSE_CHANNELS.prepare,
    { requestId: 'request-2' },
  )
  requester.dispose()
  await expect(second).resolves.toBe(false)
})

it.each(['render-process-gone', 'destroyed'])(
  'settles promptly and cleans up when webContents emits %s',
  async (eventName) => {
    vi.useFakeTimers()
    const { webListeners, ipcListeners, requester } = createHarness()
    const preparation = requester.prepare()

    webListeners.get(eventName)?.()

    await expect(preparation).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(ipcListeners).toHaveLength(0)
    expect(webListeners).toHaveLength(0)
  },
)

it('ignores a late expired response while a newer request is pending', async () => {
  vi.useFakeTimers()
  const { ipcListeners, trustedEvent, requester } = createHarness()
  const first = requester.prepare()
  const expiredResponder = ipcListeners.get(CLOSE_CHANNELS.response)!
  const expiredHeartbeat = ipcListeners.get(CLOSE_CHANNELS.heartbeat)
  await vi.advanceTimersByTimeAsync(1_000)
  await expect(first).resolves.toBe(false)

  const second = requester.prepare()
  const currentResponder = ipcListeners.get(CLOSE_CHANNELS.response)!
  const currentHeartbeat = ipcListeners.get(CLOSE_CHANNELS.heartbeat)
  expiredResponder(trustedEvent, { requestId: 'request-1', ok: true })
  expiredHeartbeat?.(trustedEvent, { requestId: 'request-1' })
  currentResponder(trustedEvent, { requestId: 'request-1', ok: true })
  currentHeartbeat?.(trustedEvent, { requestId: 'request-1' })

  let settled = false
  void second.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)

  currentResponder(trustedEvent, { requestId: 'request-2', ok: true })
  await expect(second).resolves.toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('single-flights requests and cleans timers/listeners on disposal', async () => {
  vi.useFakeTimers()
  const { ipcMain, webContents, ipcListeners, webListeners, requester } = createHarness()
  const first = requester.prepare()
  expect(requester.prepare()).toBe(first)

  requester.dispose()

  await expect(first).resolves.toBe(false)
  expect(vi.getTimerCount()).toBe(0)
  expect(ipcListeners).toHaveLength(0)
  expect(webListeners).toHaveLength(0)
  expect(ipcMain.removeListener).toHaveBeenCalledWith(
    CLOSE_CHANNELS.response,
    expect.any(Function),
  )
  expect(webContents.removeListener).toHaveBeenCalledTimes(2)
})
