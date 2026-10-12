import { describe, expect, it, vi } from 'vitest'
import {
  createEditIndicatorClient,
  type EditIndicatorWorkerLike,
} from '../../src/renderer/editor/edit-indicators/edit-indicator-client'
import * as workerProtocol from '../../src/renderer/editor/edit-indicators/edit-indicator-worker-protocol'

class FakeWorker extends EventTarget implements EditIndicatorWorkerLike {
  readonly postMessage = vi.fn()
  readonly terminate = vi.fn()

  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  fail(type: 'error' | 'messageerror' = 'error') {
    this.dispatchEvent(type === 'error'
      ? new ErrorEvent(type, { message: 'worker failed' })
      : new MessageEvent(type, { data: 'bad clone' }))
  }
}

const input = (documentKey: string) => ({
  documentKey,
  openingMarkdown: 'opening',
  savedMarkdown: 'saved',
  currentMarkdown: 'current',
})

const snapshot = {
  openingLineCount: 1,
  savedLineCount: 1,
  currentLineCount: 1,
  states: ['unsaved'] as const,
}

describe('createEditIndicatorClient', () => {
  it('creates one worker lazily, uses monotonic request ids, and settles superseded work', async () => {
    const worker = new FakeWorker()
    const factory = vi.fn(() => worker)
    const client = createEditIndicatorClient(factory)

    expect(factory).not.toHaveBeenCalled()
    const first = client.compute(input('a'))
    expect(factory).toHaveBeenCalledTimes(1)
    expect(worker.postMessage).toHaveBeenNthCalledWith(1, { requestId: 1, ...input('a') })

    const second = client.compute(input('b'))
    await expect(first).resolves.toBeNull()
    expect(worker.postMessage).toHaveBeenNthCalledWith(2, { requestId: 2, ...input('b') })

    worker.message({ requestId: 2, documentKey: 'b', ok: true, snapshot })
    await expect(second).resolves.toEqual(snapshot)
  })

  it('settles stale and wrong-document responses without accepting their snapshots', async () => {
    const worker = new FakeWorker()
    const client = createEditIndicatorClient(() => worker)
    const current = client.compute(input('current'))

    worker.message({ requestId: 99, documentKey: 'old', ok: true, snapshot })
    worker.message({ requestId: 1, documentKey: 'wrong', ok: true, snapshot })
    await expect(current).resolves.toBeNull()
  })

  it('rejects serializable failures without invalidating a healthy worker', async () => {
    const worker = new FakeWorker()
    const factory = vi.fn(() => worker)
    const client = createEditIndicatorClient(factory)
    const failed = client.compute(input('a'))

    worker.message({ requestId: 1, documentKey: 'a', ok: false, message: 'diff failed' })
    await expect(failed).rejects.toThrow('diff failed')

    const next = client.compute(input('a'))
    expect(factory).toHaveBeenCalledTimes(1)
    worker.message({ requestId: 2, documentKey: 'a', ok: true, snapshot })
    await expect(next).resolves.toEqual(snapshot)
  })

  it.each([
    ['malformed response', (worker: FakeWorker) => worker.message({ nope: true })],
    ['worker error', (worker: FakeWorker) => worker.fail('error')],
    ['worker messageerror', (worker: FakeWorker) => worker.fail('messageerror')],
  ])('settles pending work and recreates after %s', async (_label, trigger) => {
    const workers = [new FakeWorker(), new FakeWorker()]
    const factory = vi.fn(() => workers.shift()!)
    const client = createEditIndicatorClient(factory)
    const failed = client.compute(input('a'))

    trigger(factory.mock.results[0]!.value)
    await expect(failed).rejects.toThrow()
    expect(factory.mock.results[0]!.value.terminate).toHaveBeenCalledOnce()

    const recovered = client.compute(input('b'))
    expect(factory).toHaveBeenCalledTimes(2)
    factory.mock.results[1]!.value.message({ requestId: 2, documentKey: 'b', ok: true, snapshot })
    await expect(recovered).resolves.toEqual(snapshot)
  })

  it('recovers from construction and postMessage failures on a later request', async () => {
    const brokenPost = new FakeWorker()
    brokenPost.postMessage.mockImplementationOnce(() => { throw new Error('post failed') })
    const healthy = new FakeWorker()
    const factory = vi.fn()
      .mockImplementationOnce(() => { throw new Error('construct failed') })
      .mockImplementationOnce(() => brokenPost)
      .mockImplementationOnce(() => healthy)
    const client = createEditIndicatorClient(factory)

    await expect(client.compute(input('a'))).rejects.toThrow('construct failed')
    await expect(client.compute(input('b'))).rejects.toThrow('post failed')
    expect(brokenPost.terminate).toHaveBeenCalledOnce()

    const recovered = client.compute(input('c'))
    healthy.message({ requestId: 3, documentKey: 'c', ok: true, snapshot })
    await expect(recovered).resolves.toEqual(snapshot)
  })

  it('terminates and settles all pending work on dispose, then remains inert', async () => {
    const worker = new FakeWorker()
    const client = createEditIndicatorClient(() => worker)
    const pending = client.compute(input('a'))

    client.dispose()
    await expect(pending).resolves.toBeNull()
    expect(worker.terminate).toHaveBeenCalledOnce()
    await expect(client.compute(input('b'))).resolves.toBeNull()
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
  })
})

describe('edit indicator Worker runtime boundary', () => {
  it('requires exact safe request and response objects', () => {
    const isRequest = (workerProtocol as typeof workerProtocol & {
      isEditIndicatorWorkerRequest(value: unknown): boolean
    }).isEditIndicatorWorkerRequest
    expect(typeof isRequest).toBe('function')
    const validRequest = { requestId: 1, ...input('doc') }
    expect(isRequest(validRequest)).toBe(true)
    for (const invalid of [
      null,
      undefined,
      1,
      'request',
      [],
      { ...validRequest, requestId: Number.MAX_SAFE_INTEGER + 1 },
      { ...validRequest, currentMarkdown: undefined },
      { ...validRequest, extra: true },
    ]) expect(isRequest(invalid)).toBe(false)

    const validSuccess = { requestId: 1, documentKey: 'doc', ok: true, snapshot }
    const validFailure = { requestId: 1, documentKey: 'doc', ok: false, message: 'failed' }
    expect(workerProtocol.isEditIndicatorWorkerResponse(validSuccess)).toBe(true)
    expect(workerProtocol.isEditIndicatorWorkerResponse(validFailure)).toBe(true)
    expect(workerProtocol.isEditIndicatorWorkerResponse({ ...validSuccess, extra: true })).toBe(false)
    expect(workerProtocol.isEditIndicatorWorkerResponse({
      ...validSuccess,
      requestId: Number.MAX_SAFE_INTEGER + 1,
    })).toBe(false)
    expect(workerProtocol.isEditIndicatorWorkerResponse({
      ...validSuccess,
      snapshot: { ...snapshot, states: Array(1) },
    })).toBe(false)
    expect(workerProtocol.isEditIndicatorWorkerResponse({
      ...validSuccess,
      snapshot: { ...snapshot, states: Object.assign(['saved'], { foo: true }) },
    })).toBe(false)
    expect(workerProtocol.isEditIndicatorWorkerResponse({ ...validFailure, snapshot })).toBe(false)
  })

  it('never throws on hostile messages and returns controlled failures only with usable identity', async () => {
    const listeners = new Map<string, EventListener>()
    const postMessage = vi.fn()
    const workerScope = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener)
      }),
      postMessage,
    }
    vi.stubGlobal('self', workerScope)
    vi.resetModules()
    await import('../../src/renderer/editor/edit-indicators/edit-indicator-worker')
    const onMessage = listeners.get('message')!
    expect(onMessage).toBeTypeOf('function')

    for (const data of [null, undefined, 42, 'bad', [], {
      requestId: Number.MAX_SAFE_INTEGER + 1,
      documentKey: 'doc',
      openingMarkdown: '', savedMarkdown: '', currentMarkdown: '',
    }]) {
      expect(() => onMessage(new MessageEvent('message', { data }))).not.toThrow()
    }
    expect(postMessage).not.toHaveBeenCalled()

    const nearValid = [
      { requestId: 1, documentKey: 'doc' },
      { requestId: 2, ...input('doc'), extra: true },
    ]
    nearValid.forEach((data) => {
      expect(() => onMessage(new MessageEvent('message', { data }))).not.toThrow()
    })
    expect(postMessage.mock.calls.map(([response]) => response)).toEqual([
      { requestId: 1, documentKey: 'doc', ok: false, message: 'Invalid edit indicator worker request' },
      { requestId: 2, documentKey: 'doc', ok: false, message: 'Invalid edit indicator worker request' },
    ])

    onMessage(new MessageEvent('message', { data: {
      requestId: 3,
      documentKey: 'doc',
      openingMarkdown: 'same',
      savedMarkdown: 'same',
      currentMarkdown: 'same',
    } }))
    expect(postMessage).toHaveBeenLastCalledWith({
      requestId: 3,
      documentKey: 'doc',
      ok: true,
      snapshot: {
        openingLineCount: 1,
        savedLineCount: 1,
        currentLineCount: 1,
        states: ['none'],
      },
    })
    vi.unstubAllGlobals()
  })
})
