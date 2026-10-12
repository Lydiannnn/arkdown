import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { createThreadedRegistryWorker, type RegistryThread } from '../../src/main/shell-integration/registry-worker-client'

class ThreadFixture extends EventEmitter {
  messages: Array<{ kind: string; id?: number; payload?: object }> = []
  postMessage(message: { kind: string; id?: number; payload?: object }) { this.messages.push(message) }
}
const fixture = () => {
  const threads: ThreadFixture[] = []
  const create = vi.fn(() => {
    const thread = new ThreadFixture()
    threads.push(thread)
    return thread as RegistryThread
  })
  return { threads, create, worker: createThreadedRegistryWorker(create) }
}

it('starts lazily, sends structured requests and routes out-of-order replies by id', async () => {
  const { worker, create, threads } = fixture()
  expect(create).not.toHaveBeenCalled()
  const first = worker.execute({ action: 'read', key: '中文' })
  const second = worker.execute({ action: 'read', key: 'next' })
  await Promise.resolve()
  expect(create).toHaveBeenCalledOnce()
  const thread = threads[0]!
  expect(thread.messages.map(m => m.payload)).toEqual([{ action: 'read', key: '中文' }, { action: 'read', key: 'next' }])
  thread.emit('message', { kind: 'result', id: thread.messages[1]!.id, ok: true, value: ['two'] })
  thread.emit('message', { kind: 'result', id: thread.messages[0]!.id, ok: true, value: null })
  await expect(first).resolves.toBeNull()
  await expect(second).resolves.toEqual(['two'])
  const closing = worker.close()
  thread.emit('exit', 0)
  await closing
})

it('drains the current worker before another transaction gets a fresh worker', async () => {
  const { worker, threads } = fixture()
  const pending = worker.execute({ action: 'change' })
  const closing = worker.close()
  let closed = false
  void closing.then(() => { closed = true })
  const following = worker.execute({ action: 'read' })
  await Promise.resolve()
  const first = threads[0]!
  expect(threads).toHaveLength(1)
  expect(closed).toBe(false)
  expect(first.messages.map(m => m.kind)).toEqual(['execute', 'close'])
  first.emit('message', { kind: 'result', id: first.messages[0]!.id, ok: true, value: [] })
  first.emit('exit', 0)
  await closing
  await pending
  await Promise.resolve()
  const second = threads[1]!
  second.emit('message', { kind: 'result', id: second.messages[0]!.id, ok: true, value: 'ok' })
  await expect(following).resolves.toBe('ok')
  const finalClose = worker.close()
  second.emit('exit', 0)
  await finalClose
})

it('propagates conflict codes while hiding native errors and rejects every waiter on a crash', async () => {
  const { worker, threads } = fixture()
  const conflict = worker.execute({ action: 'change' })
  const thread = threads[0]!
  thread.emit('message', { kind: 'result', id: thread.messages[0]!.id, ok: false, code: 'SHELL_INTEGRATION_CONFLICT' })
  await expect(conflict).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  const a = worker.execute({ action: 'read' })
  const b = worker.execute({ action: 'read' })
  const checks = [expect(a).rejects.toMatchObject({ code: 'OPERATION_FAILED' }), expect(b).rejects.toMatchObject({ code: 'OPERATION_FAILED' })]
  thread.emit('error', new Error('secret native diagnostic'))
  thread.emit('exit', 1)
  await Promise.all(checks)
  await worker.close()
})
