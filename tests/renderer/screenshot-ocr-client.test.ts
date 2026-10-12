import { describe, expect, it, vi } from 'vitest'
import { createScreenshotOcrClient, ScreenshotOcrClientError } from '../../src/renderer/screenshot/screenshot-ocr-client'

const sessionId = '123e4567-e89b-42d3-a456-426614174000'
const image = { width: 4, height: 3, dataUrl: 'data:image/png;base64,AAAA' }
const result = { width: 4, height: 3, language: 'mul', blocks: [] }
const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()
  emit(value: unknown): void { this.onmessage?.({ data: value } as MessageEvent<unknown>) }
}

function harness() {
  const workers: FakeWorker[] = []
  const createWorker = vi.fn(() => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
  const encodeImage = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer)
  const client = createScreenshotOcrClient({ createWorker, encodeImage })
  return { client, workers, createWorker, encodeImage }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

describe('screenshot OCR client', () => {
  it('decodes canonical PNG data locally and rejects invalid or dimension-mismatched PNG bytes before Worker creation', async () => {
    const worker = new FakeWorker()
    const createWorker = vi.fn(() => worker as unknown as Worker)
    const client = createScreenshotOcrClient({ createWorker })
    const valid = client.recognize({
      sessionId, generation: 1, image: { width: 1, height: 1, dataUrl: onePixelPng }, tier: 'small',
    })
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce())
    const [request, transfer] = worker.postMessage.mock.calls[0]!
    expect(Array.from(new Uint8Array(request.image.bytes).slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(transfer).toEqual([request.image.bytes])
    worker.emit({ type: 'result', requestId: 1, sessionId, generation: 1, ok: true, result: { ...result, width: 1, height: 1 } })
    await expect(valid).resolves.toMatchObject({ width: 1, height: 1 })

    const invalid = client.recognize({ sessionId, generation: 2, image, tier: 'small' })
    await expect(invalid).rejects.toMatchObject({ code: 'OCR_FAILED' })
    const mismatched = client.recognize({
      sessionId, generation: 3, image: { width: 2, height: 1, dataUrl: onePixelPng }, tier: 'small',
    })
    await expect(mismatched).rejects.toMatchObject({ code: 'OCR_FAILED' })
    expect(createWorker).toHaveBeenCalledOnce()
  })

  it('uses one Worker for sequential requests and posts only the exact transferable envelope', async () => {
    const h = harness()
    const first = h.client.recognize({ sessionId, generation: 1, image, tier: 'small' })
    await vi.waitFor(() => expect(h.workers[0]?.postMessage).toHaveBeenCalledOnce())
    const [request, transfer] = h.workers[0]!.postMessage.mock.calls[0]!
    expect(Object.keys(request)).toEqual(['type', 'requestId', 'sessionId', 'generation', 'image', 'tier'])
    expect(request).toMatchObject({ type: 'recognize', requestId: 1, sessionId, generation: 1, image: { width: 4, height: 3 }, tier: 'small' })
    expect(Object.keys(request.image)).toEqual(['width', 'height', 'bytes'])
    expect(transfer).toEqual([request.image.bytes])
    h.workers[0]!.emit({ type: 'result', requestId: 1, sessionId, generation: 1, ok: true, result })
    await expect(first).resolves.toEqual(result)

    const second = h.client.recognize({ sessionId, generation: 2, image, tier: 'small' })
    await vi.waitFor(() => expect(h.workers[0]!.postMessage).toHaveBeenCalledTimes(2))
    expect(h.createWorker).toHaveBeenCalledOnce()
    h.workers[0]!.emit({ type: 'result', requestId: 2, sessionId, generation: 2, ok: true, result })
    await expect(second).resolves.toEqual(result)
  })

  it('supersedes the active request by terminating its Worker and ignores its late result', async () => {
    const h = harness()
    const first = h.client.recognize({ sessionId, generation: 1, image, tier: 'small' })
    await vi.waitFor(() => expect(h.workers).toHaveLength(1))
    const second = h.client.recognize({ sessionId, generation: 2, image, tier: 'small' })
    await expect(first).rejects.toMatchObject({ code: 'OCR_CANCELLED' })
    expect(h.workers[0]!.terminate).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(h.workers).toHaveLength(2))
    h.workers[0]!.emit({ type: 'result', requestId: 1, sessionId, generation: 1, ok: true, result })
    h.workers[1]!.emit({ type: 'result', requestId: 2, sessionId, generation: 2, ok: true, result })
    await expect(second).resolves.toEqual(result)
  })

  it('aborts, disposes, and maps worker faults to fixed codes without logging source content', async () => {
    const h = harness()
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const controller = new AbortController()
    const aborted = h.client.recognize({ sessionId, generation: 1, image, tier: 'small', signal: controller.signal })
    await vi.waitFor(() => expect(h.workers).toHaveLength(1))
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'OCR_CANCELLED' })
    expect(h.workers[0]!.terminate).toHaveBeenCalledOnce()

    const faulted = h.client.recognize({ sessionId, generation: 2, image, tier: 'small' })
    await vi.waitFor(() => expect(h.workers).toHaveLength(2))
    h.workers[1]!.onmessageerror?.({ data: image.dataUrl } as MessageEvent<unknown>)
    await expect(faulted).rejects.toEqual(new ScreenshotOcrClientError('OCR_FAILED'))
    expect(JSON.stringify(log.mock.calls)).not.toContain(image.dataUrl)
    h.client.dispose()
    expect(h.workers[1]!.terminate).toHaveBeenCalledOnce()
    await expect(h.client.recognize({ sessionId, generation: 3, image, tier: 'small' }))
      .rejects.toMatchObject({ code: 'OCR_CANCELLED' })
    log.mockRestore()
  })

  it('ignores wrong request identity and rejects malformed or fixed failure output', async () => {
    const h = harness()
    const pending = h.client.recognize({ sessionId, generation: 1, image, tier: 'small' })
    await vi.waitFor(() => expect(h.workers).toHaveLength(1))
    h.workers[0]!.emit({ type: 'result', requestId: 99, sessionId, generation: 1, ok: true, result })
    h.workers[0]!.emit({ type: 'result', requestId: 1, sessionId, generation: 1, ok: true, result, extra: true })
    await expect(pending).rejects.toMatchObject({ code: 'OCR_FAILED' })

    const failed = h.client.recognize({ sessionId, generation: 2, image, tier: 'small' })
    await vi.waitFor(() => expect(h.workers[0]!.postMessage).toHaveBeenCalledTimes(2))
    h.workers[0]!.emit({ type: 'result', requestId: 2, sessionId, generation: 2, ok: false, code: 'OCR_UNAVAILABLE' })
    await expect(failed).rejects.toMatchObject({ code: 'OCR_UNAVAILABLE' })
  })

  it('settles exactly once and terminates when postMessage throws synchronously', async () => {
    const worker = new FakeWorker()
    worker.postMessage.mockImplementation(() => { throw new Error('private transport detail') })
    const client = createScreenshotOcrClient({
      createWorker: () => worker as unknown as Worker,
      encodeImage: async () => new Uint8Array([1]).buffer,
    })
    const rejection = vi.fn()
    const failed = client.recognize({ sessionId, generation: 1, image, tier: 'small' }).catch((error) => {
      rejection(error)
      throw error
    })
    await expect(failed).rejects.toMatchObject({ code: 'OCR_FAILED' })
    expect(rejection).toHaveBeenCalledOnce()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('supersedes, aborts, and disposes requests while image encoding is still pending', async () => {
    const worker = new FakeWorker()
    const firstEncoding = deferred<ArrayBuffer>()
    const secondEncoding = deferred<ArrayBuffer>()
    const thirdEncoding = deferred<ArrayBuffer>()
    const encodings = [firstEncoding, secondEncoding, thirdEncoding]
    const client = createScreenshotOcrClient({
      createWorker: () => worker as unknown as Worker,
      encodeImage: vi.fn(() => encodings.shift()!.promise),
    })

    const first = client.recognize({ sessionId, generation: 1, image, tier: 'small' })
    const second = client.recognize({ sessionId, generation: 2, image, tier: 'small' })
    await expect(first).rejects.toMatchObject({ code: 'OCR_CANCELLED' })
    firstEncoding.resolve(new Uint8Array([1]).buffer)
    await Promise.resolve()
    expect(worker.postMessage).not.toHaveBeenCalled()
    secondEncoding.resolve(new Uint8Array([2]).buffer)
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce())
    worker.emit({ type: 'result', requestId: 1, sessionId, generation: 2, ok: true, result })
    await expect(second).resolves.toEqual(result)

    const controller = new AbortController()
    const aborted = client.recognize({ sessionId, generation: 3, image, tier: 'small', signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ code: 'OCR_CANCELLED' })
    thirdEncoding.resolve(new Uint8Array([3]).buffer)
    await Promise.resolve()
    expect(worker.postMessage).toHaveBeenCalledOnce()

    const disposingEncoding = deferred<ArrayBuffer>()
    const disposingClient = createScreenshotOcrClient({
      createWorker: () => worker as unknown as Worker,
      encodeImage: () => disposingEncoding.promise,
    })
    const disposing = disposingClient.recognize({ sessionId, generation: 4, image, tier: 'small' })
    disposingClient.dispose()
    await expect(disposing).rejects.toMatchObject({ code: 'OCR_CANCELLED' })
    disposingEncoding.resolve(new Uint8Array([4]).buffer)
    await Promise.resolve()
    expect(worker.postMessage).toHaveBeenCalledOnce()
  })
})
