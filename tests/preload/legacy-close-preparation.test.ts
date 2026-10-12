import { afterEach, expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'

afterEach(() => vi.useRealTimers())

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

it('fails an early close request closed before React registers its handler', async () => {
  let receive!: (payload: unknown) => void
  const transport = {
    subscribe: (listener: (payload: unknown) => void) => {
      receive = listener
      return () => {}
    },
    heartbeat: vi.fn(),
    respond: vi.fn(),
  }

  createArkdownApi(vi.fn(), transport)
  receive({ requestId: 'close-before-render' })

  await vi.waitFor(() => expect(transport.respond).toHaveBeenCalledWith({
    requestId: 'close-before-render',
    ok: false,
  }))
  expect(transport.heartbeat).not.toHaveBeenCalled()
})

it('responds to exact close requests with the renderer preparation result', async () => {
  let receive!: (payload: unknown) => void
  const transport = {
    subscribe: vi.fn((listener: (payload: unknown) => void) => {
      receive = listener
      return vi.fn()
    }),
    heartbeat: vi.fn(),
    respond: vi.fn(),
  }
  const api = createArkdownApi(vi.fn(), transport)
  const handler = vi.fn().mockResolvedValue(true)

  api.onPrepareClose(handler)
  receive({ requestId: 'close-1', extra: true })
  await Promise.resolve()
  expect(handler).not.toHaveBeenCalled()
  expect(transport.respond).not.toHaveBeenCalled()

  receive({ requestId: 'close-1' })
  await vi.waitFor(() => expect(transport.respond).toHaveBeenCalledWith({
    requestId: 'close-1',
    ok: true,
  }))
  expect(transport.heartbeat).toHaveBeenCalledWith({ requestId: 'close-1' })
})

it('keeps a long interactive close alive and stops heartbeats after success', async () => {
  vi.useFakeTimers()
  let receive!: (payload: unknown) => void
  const result = deferred<boolean>()
  const transport = {
    subscribe: (listener: (payload: unknown) => void) => {
      receive = listener
      return () => {}
    },
    heartbeat: vi.fn(),
    respond: vi.fn(),
  }
  const api = createArkdownApi(vi.fn(), transport)
  api.onPrepareClose(() => result.promise)

  receive({ requestId: 'slow-close' })
  expect(transport.heartbeat).toHaveBeenCalledWith({ requestId: 'slow-close' })
  await vi.advanceTimersByTimeAsync(12_000)
  expect(transport.heartbeat.mock.calls.length).toBeGreaterThan(10)
  expect(transport.respond).not.toHaveBeenCalled()

  result.resolve(true)
  await vi.advanceTimersByTimeAsync(0)
  expect(transport.respond).toHaveBeenCalledOnce()
  expect(transport.respond).toHaveBeenCalledWith({ requestId: 'slow-close', ok: true })
  expect(vi.getTimerCount()).toBe(0)
})

it('stops heartbeats and responds false when close preparation is cancelled', async () => {
  vi.useFakeTimers()
  let receive!: (payload: unknown) => void
  const result = deferred<boolean>()
  const transport = {
    subscribe: (listener: (payload: unknown) => void) => {
      receive = listener
      return () => {}
    },
    heartbeat: vi.fn(),
    respond: vi.fn(),
  }
  const api = createArkdownApi(vi.fn(), transport)
  api.onPrepareClose(() => result.promise)

  receive({ requestId: 'cancelled-close' })
  await vi.advanceTimersByTimeAsync(2_000)
  result.resolve(false)
  await vi.advanceTimersByTimeAsync(0)

  expect(transport.respond).toHaveBeenCalledOnce()
  expect(transport.respond).toHaveBeenCalledWith({ requestId: 'cancelled-close', ok: false })
  expect(vi.getTimerCount()).toBe(0)
})

it('fails close preparation closed when the renderer handler rejects', async () => {
  vi.useFakeTimers()
  let receive!: (payload: unknown) => void
  const transport = {
    subscribe: (listener: (payload: unknown) => void) => {
      receive = listener
      return () => {}
    },
    heartbeat: vi.fn(),
    respond: vi.fn(),
  }
  const api = createArkdownApi(vi.fn(), transport)

  api.onPrepareClose(async () => {
    throw new Error('disk full')
  })
  receive({ requestId: 'close-2' })

  await vi.advanceTimersByTimeAsync(0)
  expect(transport.respond).toHaveBeenCalledWith({
    requestId: 'close-2',
    ok: false,
  })
  expect(vi.getTimerCount()).toBe(0)
})
