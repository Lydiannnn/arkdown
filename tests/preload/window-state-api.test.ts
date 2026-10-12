import { expect, it, vi } from 'vitest'
import {
  createArkdownApi,
  type WindowStateChangedTransport,
} from '../../src/preload/arkdown-api'

function createApiWithWindowStateTransport(transport: WindowStateChangedTransport) {
  return createArkdownApi(
    vi.fn(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    transport,
  )
}

it('delivers only exact revisioned WindowState events and returns the transport cleanup', () => {
  let emit: ((payload: unknown) => void) | undefined
  const unsubscribe = vi.fn()
  const transport: WindowStateChangedTransport = {
    subscribe: vi.fn((listener) => {
      emit = listener
      return unsubscribe
    }),
  }
  const api = createApiWithWindowStateTransport(transport)
  const listener = vi.fn()
  const state = { maximized: true, fullscreen: true, revision: 0 }

  const stop = api.onWindowStateChanged(listener)
  expect(emit).toBeTypeOf('function')
  emit?.(state)
  emit?.({ maximized: false, fullscreen: false })
  emit?.({ maximized: false, fullscreen: false, revision: 1, hidden: false })

  expect(listener).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledWith(state)
  expect(listener.mock.calls[0]?.[0]).not.toBe(state)
  stop()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it.each([
  { maximized: false, fullscreen: false, revision: -1 },
  { maximized: false, fullscreen: false, revision: 0.5 },
  { maximized: false, fullscreen: false, revision: Number.NaN },
  { maximized: false, fullscreen: false, revision: Number.POSITIVE_INFINITY },
  { maximized: false, fullscreen: false, revision: Number.MAX_SAFE_INTEGER + 1 },
  { maximized: false, fullscreen: false, revision: '1' },
  { maximized: 0, fullscreen: false, revision: 1 },
  { maximized: false, fullscreen: 0, revision: 1 },
] as const)('rejects malformed event snapshot %#', (payload) => {
  let emit: ((payload: unknown) => void) | undefined
  const api = createApiWithWindowStateTransport({
    subscribe(listener) {
      emit = listener
      return () => undefined
    },
  })
  const listener = vi.fn()
  api.onWindowStateChanged(listener)

  expect(emit).toBeTypeOf('function')
  emit?.(payload)

  expect(listener).not.toHaveBeenCalled()
})
