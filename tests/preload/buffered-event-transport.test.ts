import { expect, it, vi } from 'vitest'
import { createBufferedEventTransport } from '../../src/preload/buffered-event-transport'

it('replays an event that arrives before the renderer subscribes', () => {
  let emit: ((value: string) => void) | undefined
  const transport = createBufferedEventTransport<string>((listener) => {
    emit = listener
  })
  const listener = vi.fn()

  emit?.('open-note')
  transport.subscribe(listener)

  expect(listener).toHaveBeenCalledTimes(1)
  expect(listener).toHaveBeenCalledWith('open-note')
})

it('delivers live events and buffers the latest event while unsubscribed', () => {
  let emit: ((value: string) => void) | undefined
  const transport = createBufferedEventTransport<string>((listener) => {
    emit = listener
  })
  const first = vi.fn()
  const unsubscribe = transport.subscribe(first)

  emit?.('first')
  unsubscribe()
  emit?.('stale')
  emit?.('latest')

  const second = vi.fn()
  transport.subscribe(second)

  expect(first).toHaveBeenCalledWith('first')
  expect(second).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledWith('latest')
})

type PreparedEvent = {
  requestId: string
  type: 'started' | 'delta' | 'completed' | 'failed'
  delta?: string
}

function preparedEventPolicy(options: {
  maxPending: number
  maxPendingBytes: number
  maxClosedGroups?: number
}) {
  return {
    mode: 'queue' as const,
    ...options,
    maxClosedGroups: options.maxClosedGroups ?? options.maxPending,
    prepare(value: unknown) {
      if (
        typeof value !== 'object'
        || value === null
        || !('requestId' in value)
        || !('type' in value)
      ) return undefined
      const event = value as PreparedEvent
      if (!['started', 'delta', 'completed'].includes(event.type)) return undefined
      const expectedKeys = event.type === 'delta'
        ? ['requestId', 'type', 'delta']
        : ['requestId', 'type']
      if (Reflect.ownKeys(event).some((key) => !expectedKeys.includes(String(key)))) return undefined
      return {
        value: { ...event },
        groupKey: event.requestId,
        byteLength: event.delta?.length ?? 1,
        phase: event.type === 'started'
          ? 'started' as const
          : event.type === 'delta' ? 'progress' as const : 'terminal' as const,
      }
    },
    overflow(groupKey: string) {
      return {
        value: { requestId: groupKey, type: 'failed' as const },
        groupKey,
        byteLength: 1,
        phase: 'terminal' as const,
      }
    },
  }
}

it('replaces a request with one failure when count overflow would drop its terminal event', () => {
  let emit: ((value: unknown) => void) | undefined
  const transport = createBufferedEventTransport<unknown>(
    (listener) => {
      emit = listener
    },
    preparedEventPolicy({ maxPending: 3, maxPendingBytes: 100 }),
  )
  const listener = vi.fn()

  emit?.({ requestId: 'r1', type: 'started' })
  emit?.({ requestId: 'r1', type: 'delta', delta: 'one' })
  emit?.({ requestId: 'r1', type: 'delta', delta: 'two' })
  emit?.({ requestId: 'r1', type: 'completed' })
  transport.subscribe(listener)

  expect(listener.mock.calls.map(([value]) => value)).toEqual([
    { requestId: 'r1', type: 'failed' },
  ])
})

it('atomically fails another request when its events must be displaced', () => {
  let emit: ((value: unknown) => void) | undefined
  const onOverflow = vi.fn()
  const transport = createBufferedEventTransport<unknown>(
    (listener) => {
      emit = listener
    },
    {
      ...preparedEventPolicy({ maxPending: 3, maxPendingBytes: 100 }),
      onOverflow,
    },
  )
  const listener = vi.fn()

  emit?.({ requestId: 'r1', type: 'started' })
  emit?.({ requestId: 'r1', type: 'completed' })
  emit?.({ requestId: 'r2', type: 'started' })
  emit?.({ requestId: 'r3', type: 'started' })
  transport.subscribe(listener)

  expect(listener.mock.calls.map(([value]) => value)).toEqual([
    { requestId: 'r1', type: 'failed' },
    { requestId: 'r2', type: 'started' },
    { requestId: 'r3', type: 'failed' },
  ])

  for (const requestId of ['r1', 'r3']) {
    emit?.({ requestId, type: 'started' })
    emit?.({ requestId, type: 'delta', delta: 'late' })
    emit?.({ requestId, type: 'completed' })
  }
  expect(listener).toHaveBeenCalledTimes(3)
  expect(onOverflow.mock.calls).toEqual([['r1'], ['r3']])
})

it('rejects an unseen incoming group when a full singleton queue cannot reduce', () => {
  let emit: ((value: unknown) => void) | undefined
  const onOverflow = vi.fn()
  const transport = createBufferedEventTransport<unknown>(
    (listener) => {
      emit = listener
    },
    {
      ...preparedEventPolicy({ maxPending: 2, maxPendingBytes: 100 }),
      onOverflow,
    },
  )
  const listener = vi.fn()

  emit?.({ requestId: 'r1', type: 'started' })
  emit?.({ requestId: 'r2', type: 'started' })
  emit?.({ requestId: 'r3', type: 'started' })
  transport.subscribe(listener)
  emit?.({ requestId: 'r3', type: 'started' })
  emit?.({ requestId: 'r3', type: 'delta', delta: 'late' })
  emit?.({ requestId: 'r3', type: 'completed' })
  emit?.({ requestId: 'r1', type: 'completed' })
  emit?.({ requestId: 'r2', type: 'completed' })

  expect(listener.mock.calls.map(([value]) => value)).toEqual([
    { requestId: 'r1', type: 'started' },
    { requestId: 'r2', type: 'started' },
    { requestId: 'r1', type: 'completed' },
    { requestId: 'r2', type: 'completed' },
  ])
  expect(onOverflow).toHaveBeenCalledOnce()
  expect(onOverflow).toHaveBeenCalledWith('r3')
})
it('fails one request on byte overflow and suppresses its later completion', () => {
  let emit: ((value: unknown) => void) | undefined

  const transport = createBufferedEventTransport<unknown>(
    (listener) => {
      emit = listener
    },
    preparedEventPolicy({ maxPending: 10, maxPendingBytes: 5 }),
  )
  const listener = vi.fn()

  emit?.({ requestId: 'r1', type: 'started' })
  emit?.({ requestId: 'r1', type: 'delta', delta: '12345' })
  emit?.({ requestId: 'r1', type: 'completed' })
  transport.subscribe(listener)

  expect(listener.mock.calls.map(([value]) => value)).toEqual([
    { requestId: 'r1', type: 'failed' },
  ])
})

it('keeps a bounded FIFO of closed groups and evicts only the oldest marker', () => {
  let emit: ((value: unknown) => void) | undefined
  const transport = createBufferedEventTransport<unknown>(
    (listener) => {
      emit = listener
    },
    preparedEventPolicy({
      maxPending: 1,
      maxPendingBytes: 100,
      maxClosedGroups: 2,
    }),
  )
  const listener = vi.fn()

  const overflowAndReplay = (requestId: string) => {
    emit?.({ requestId, type: 'started' })
    emit?.({ requestId, type: 'delta', delta: 'overflow' })
    const unsubscribe = transport.subscribe(listener)
    unsubscribe()
  }
  overflowAndReplay('r1')
  overflowAndReplay('r2')
  overflowAndReplay('r3')

  transport.subscribe(listener)
  for (const requestId of ['r2', 'r3']) {
    emit?.({ requestId, type: 'started' })
    emit?.({ requestId, type: 'delta', delta: 'ignored' })
    emit?.({ requestId, type: 'completed' })
  }
  emit?.({ requestId: 'r1', type: 'started' })
  emit?.({ requestId: 'r1', type: 'delta', delta: 'admitted-after-fifo-eviction' })
  emit?.({ requestId: 'r1', type: 'completed' })

  expect(listener.mock.calls.map(([value]) => value)).toEqual([
    { requestId: 'r1', type: 'failed' },
    { requestId: 'r2', type: 'failed' },
    { requestId: 'r3', type: 'failed' },
    { requestId: 'r1', type: 'started' },
    {
      requestId: 'r1',
      type: 'delta',
      delta: 'admitted-after-fifo-eviction',
    },
    { requestId: 'r1', type: 'completed' },
  ])
})

it('does not retain rejected prepared values or charge them to queue limits', () => {
  let emit: ((value: unknown) => void) | undefined
  const transport = createBufferedEventTransport<unknown>(
    (listener) => {
      emit = listener
    },
    preparedEventPolicy({ maxPending: 2, maxPendingBytes: 2 }),
  )
  const listener = vi.fn()

  emit?.({ requestId: 'r1', type: 'delta', delta: 'ignored', extra: 'x'.repeat(1_000_000) })
  emit?.({ requestId: 'r1', type: 'started' })
  emit?.({ requestId: 'r1', type: 'completed' })
  transport.subscribe(listener)

  expect(listener.mock.calls.map(([value]) => value)).toEqual([
    { requestId: 'r1', type: 'started' },
    { requestId: 'r1', type: 'completed' },
  ])
})
