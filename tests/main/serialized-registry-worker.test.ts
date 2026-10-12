// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { WindowsShellRegistry } from '../../src/main/shell-integration/windows-registry'
import { ShellMenuRegistration } from '../../src/main/shell-integration/registration'
import { createRegistryTransactionScheduler, createSerializedRegistryWorker } from '../../src/main/shell-integration/serialized-registry-worker'

const transportFactory = vi.hoisted(() => vi.fn())
vi.mock('../../src/main/shell-integration/registry-worker-client', () => ({
  createThreadedRegistryWorker: transportFactory,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

it('serializes default registry transactions until the first worker has actually closed', async () => {
  const firstClose = deferred<void>()
  const events: string[] = []
  let created = 0
  transportFactory.mockImplementation(() => {
    const id = ++created
    events.push(`create:${id}`)
    return {
      execute: async (payload: { key: string }) => { events.push(`read:${id}:${payload.key}`); return null },
      close: async () => { events.push(`close:${id}`); if (id === 1) await firstClose.promise },
    }
  })
  const first = new WindowsShellRegistry()
  const second = new WindowsShellRegistry()
  try {
    await first.read('first')
    const readingSecond = second.read('second')
    await nextTurn()
    expect([...events]).toEqual(['create:1', 'read:1:first'])
    const closingFirst = first.close()
    await nextTurn()
    expect(events).toEqual(['create:1', 'read:1:first', 'close:1'])
    firstClose.resolve()
    await closingFirst
    await readingSecond
    expect(events).toEqual(['create:1', 'read:1:first', 'close:1', 'create:2', 'read:2:second'])
  } finally {
    firstClose.resolve()
    await Promise.allSettled([first.close(), second.close()])
  }
})

function harness() {
  const scheduler = createRegistryTransactionScheduler()
  const events: string[] = []
  const make = (name: string, options: { execute?: (payload: object) => Promise<unknown>; close?: () => Promise<void> } = {}) =>
    createSerializedRegistryWorker(() => {
      events.push(`create:${name}`)
      return {
        execute: async (payload: object) => {
          events.push(`execute:${name}`)
          return options.execute ? await options.execute(payload) : payload
        },
        close: async () => { events.push(`close:${name}`); await options.close?.() },
      }
    }, scheduler)
  return { scheduler, events, make }
}

it('reserves FIFO on first execute and lets the owner finish multiple requests before releasing', async () => {
  const h = harness()
  const first = h.make('first'), second = h.make('second'), third = h.make('third')
  await first.execute({ step: 1 })
  const secondRequest = second.execute({ step: 2 }), thirdRequest = third.execute({ step: 3 })
  await expect(first.execute({ step: 4 })).resolves.toEqual({ step: 4 })
  expect(h.events).toEqual(['create:first', 'execute:first', 'execute:first'])
  await first.close()
  await secondRequest
  expect(h.events).toEqual(['create:first', 'execute:first', 'execute:first', 'close:first', 'create:second', 'execute:second'])
  await second.close()
  await thirdRequest
  await third.close()
  expect(h.events.slice(-3)).toEqual(['create:third', 'execute:third', 'close:third'])
})

it('drains an execute accepted in the same tick as close before closing the transport', async () => {
  const h = harness(), response = deferred<unknown>()
  const first = h.make('first', { execute: () => response.promise }), second = h.make('second')
  const request = first.execute({ action: 'change' })
  const closing = first.close()
  expect(first.close()).toBe(closing)
  const next = second.execute({ action: 'read' })
  await nextTurn()
  expect(h.events).toEqual(['create:first', 'execute:first'])
  response.resolve('committed')
  await expect(request).resolves.toBe('committed')
  await closing
  await next
  expect(h.events).toEqual(['create:first', 'execute:first', 'close:first', 'create:second', 'execute:second'])
  await second.close()
})

it('honors an accepted request when close arrives while its instance is waiting for the lane', async () => {
  const h = harness()
  const first = h.make('first'), waiting = h.make('waiting'), last = h.make('last')
  await first.execute({})
  const request = waiting.execute({ action: 'change' })
  const closing = waiting.close()
  const lastRequest = last.execute({})
  expect(waiting.close()).toBe(closing)
  await nextTurn()
  expect(h.events).toEqual(['create:first', 'execute:first'])
  await first.close()
  await expect(request).resolves.toEqual({ action: 'change' })
  await closing
  await lastRequest
  expect(h.events).toEqual(['create:first', 'execute:first', 'close:first', 'create:waiting', 'execute:waiting', 'close:waiting', 'create:last', 'execute:last'])
  await last.close()
})

it('puts execute after close in a new transaction behind already waiting instances', async () => {
  const h = harness(), finishClose = deferred<void>()
  let closes = 0
  const first = h.make('first', { close: async () => { if (++closes === 1) await finishClose.promise } })
  const second = h.make('second')
  await first.execute({ cycle: 1 })
  const secondRequest = second.execute({})
  const firstClosing = first.close()
  const again = first.execute({ cycle: 2 })
  const secondClosing = first.close()
  expect(secondClosing).not.toBe(firstClosing)
  await nextTurn()
  expect(h.events).toEqual(['create:first', 'execute:first', 'close:first'])
  finishClose.resolve()
  await firstClosing
  await secondRequest
  expect(h.events.slice(-2)).toEqual(['create:second', 'execute:second'])
  await second.close()
  await expect(again).resolves.toEqual({ cycle: 2 })
  await secondClosing
  expect(h.events.slice(-4)).toEqual(['close:second', 'create:first', 'execute:first', 'close:first'])
})

it('releases a failed factory transaction on close without automatically creating another transport', async () => {
  const h = harness(), failure = new Error('factory failed')
  const create = vi.fn(() => { throw failure })
  const failed = createSerializedRegistryWorker(create, h.scheduler)
  const next = h.make('next')
  const one = failed.execute({}), two = failed.execute({})
  const checks = [expect(one).rejects.toBe(failure), expect(two).rejects.toBe(failure)]
  const waiting = next.execute({})
  await Promise.all(checks)
  expect(create).toHaveBeenCalledOnce()
  expect(h.events).toEqual([])
  await failed.close()
  await waiting
  await next.close()
  expect(create).toHaveBeenCalledOnce()
})

it('retains the lane after execution failure so rollback uses the same transport', async () => {
  const h = harness(), failure = new Error('write status must not be retried')
  let calls = 0
  const first = h.make('first', { execute: async payload => { if (++calls === 1) throw failure; return payload } })
  const second = h.make('second')
  await expect(first.execute({ action: 'change' })).rejects.toBe(failure)
  const waiting = second.execute({})
  await expect(first.execute({ action: 'rollback' })).resolves.toEqual({ action: 'rollback' })
  expect(h.events).toEqual(['create:first', 'execute:first', 'execute:first'])
  await first.close()
  await waiting
  await second.close()
  expect(calls).toBe(2)
})

it('does not give another instance the lane if the underlying close rejects', async () => {
  const h = harness(), failure = new Error('exit is not confirmed')
  const first = h.make('first', { close: async () => { throw failure } }), second = h.make('second')
  await first.execute({})
  const closing = first.close()
  await expect(closing).rejects.toBe(failure)
  expect(first.close()).toBe(closing)
  void second.execute({})
  await nextTurn()
  expect(h.events).toEqual(['create:first', 'execute:first', 'close:first'])
})

it('closing an unused instance neither creates a transport nor occupies the lane', async () => {
  const h = harness(), unused = h.make('unused'), used = h.make('used')
  await unused.close()
  await unused.close()
  await used.execute({})
  await used.close()
  expect(h.events).toEqual(['create:used', 'execute:used', 'close:used'])
  await unused.execute({})
  await unused.close()
  expect(h.events.slice(-3)).toEqual(['create:unused', 'execute:unused', 'close:unused'])
})

it('reuses the active transaction for the default-application query inside Markdown registration', async () => {
  const events: string[] = []
  let created = 0
  transportFactory.mockImplementation(() => {
    const id = ++created
    events.push(`create:${id}`)
    return {
      execute: async (payload: { action: string }) => {
        events.push(`${payload.action}:${id}`)
        if (payload.action === 'choice') return 'Arkdown.Document.Markdown'
        if (payload.action === 'associations') return {
          '.md': { progId: 'Arkdown.Document.Markdown', executable: 'C:\\Arkdown.exe' },
          '.txt': { progId: null, executable: null },
        }
        return null
      },
      close: async () => { events.push(`close:${id}`) },
    }
  })
  const registry = new WindowsShellRegistry()
  const registration = new ShellMenuRegistration({ executablePath: 'C:\\Arkdown.exe', registry })
  const completed = registration.setEnabled('markdownShellNew', true).then(() => undefined, error => error)
  try {
    await nextTurn()
    expect([...events]).toContain('associations:1')
    // The fixture intentionally has no matching candidate command; its rejection
    // must still close the one transaction after reads following the query.
    expect(await completed).toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
    expect(created).toBe(1)
    expect(events.slice(events.indexOf('associations:1'))).toEqual(['associations:1', 'read:1', 'read:1', 'close:1'])
  } finally {
    await registry.close()
    await completed
  }
})

it('preserves an explicitly supplied default-application callback inside registration', async () => {
  let queries = 0
  transportFactory.mockImplementation(() => ({
    execute: async (payload: { action: string }) => {
      if (payload.action === 'associations') queries += 1
      return payload.action === 'choice' ? 'Arkdown.Document.Markdown' : null
    },
    close: async () => undefined,
  }))
  const isCurrentMarkdownDefault = vi.fn(async () => false)
  const registration = new ShellMenuRegistration({ executablePath: 'C:\\Arkdown.exe', isCurrentMarkdownDefault })
  await expect(registration.setEnabled('markdownShellNew', true)).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  expect(isCurrentMarkdownDefault).toHaveBeenCalledOnce()
  expect(queries).toBe(0)
})
