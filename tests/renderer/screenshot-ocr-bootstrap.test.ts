import { expect, it, vi } from 'vitest'
import { initializeScreenshotOcrBootstrap } from '../../src/renderer/screenshot/screenshot-ocr-bootstrap'

const request = { requestId: 1, sessionId: '123e4567-e89b-42d3-a456-426614174000', generation: 1 }

it('buffers the first request until the verified external worker installs its handler', async () => {
  let complete!: () => void
  const load = vi.fn(() => new Promise<void>((resolve) => { complete = resolve }))
  const scope = { onmessage: null as ((event: MessageEvent<unknown>) => void) | null, postMessage: vi.fn() }
  const ready = initializeScreenshotOcrBootstrap(scope, load)
  const event = { data: request } as MessageEvent<unknown>
  scope.onmessage!(event)
  expect(scope.postMessage).not.toHaveBeenCalled()
  const runtime = vi.fn()
  scope.onmessage = runtime
  complete()
  await ready
  expect(runtime).toHaveBeenCalledExactlyOnceWith(event)
})

it('bounds the queue and safely fails waiting and later requests if loading fails', async () => {
  let fail!: (error: Error) => void
  const scope = { onmessage: null as ((event: MessageEvent<unknown>) => void) | null, postMessage: vi.fn() }
  const ready = initializeScreenshotOcrBootstrap(scope, () => new Promise<void>((_resolve, reject) => { fail = reject }))
  scope.onmessage!({ data: request } as MessageEvent<unknown>)
  scope.onmessage!({ data: { ...request, requestId: 2 } } as MessageEvent<unknown>)
  expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'result', ...request, requestId: 2, ok: false, code: 'OCR_UNAVAILABLE' })
  fail(new Error('private local path or network detail'))
  await ready
  scope.onmessage!({ data: { ...request, requestId: 3 } } as MessageEvent<unknown>)
  expect(scope.postMessage.mock.calls.map(([value]) => value.requestId)).toEqual([2, 1, 3])
  expect(JSON.stringify(scope.postMessage.mock.calls)).not.toContain('private')
})
