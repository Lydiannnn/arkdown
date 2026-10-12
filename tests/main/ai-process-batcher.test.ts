import { afterEach, describe, expect, it, vi } from 'vitest'
import * as module from '../../src/main/models/ai-process-batcher'
import type { ModelProcessDelta } from '../../src/main/models/model-process-delta'

afterEach(() => vi.useRealTimers())
const delta = (text: string, extra: Partial<ModelProcessDelta> = {}): ModelProcessDelta => ({
  kind: 'reasoning-text', itemId: 'provider-item', segmentIndex: 0, delta: text, delivery: 'stream', ...extra,
})
function fixture(isCurrent = () => true) {
  vi.useFakeTimers()
  expect(module.AiProcessBatcher).toBeTypeOf('function')
  const emit = vi.fn<(value: ModelProcessDelta) => void>()
  return { emit, batcher: new module.AiProcessBatcher({ isCurrent, emit }) }
}

describe('bounded readable process batching', () => {
  it('explicitly rejects consumer-reentrant appends without allocating an unbounded queue', () => {
    const { emit, batcher } = fixture()
    const rejected: unknown[] = []
    emit.mockImplementationOnce(() => {
      rejected.push(batcher.append(delta('a'.repeat(1024 * 1024))))
      for (let index = 0; index < 1000; index++) rejected.push(batcher.append(delta('x', { itemId: String(index) })))
    })
    batcher.append(delta('accepted'))
    batcher.flush()
    expect(rejected).toEqual(Array(1001).fill(false))
    expect(emit.mock.calls.map(([value]) => value.delta)).toEqual(['accepted'])
    expect(batcher.append(delta('next serial input'))).toBe(true)
    batcher.close()
    expect(emit.mock.calls.map(([value]) => value.delta)).toEqual(['accepted', 'next serial input'])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('defers a consumer-reentrant close until every already accepted entry is flushed', () => {
    const { emit, batcher } = fixture()
    emit.mockImplementationOnce(() => { batcher.close(); batcher.close() })
    batcher.append(delta('one'))
    batcher.append(delta('two', { itemId: 'second' }))
    batcher.flush()
    expect(emit.mock.calls.map(([value]) => value.delta)).toEqual(['one', 'two'])
    expect(batcher.append(delta('late'))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('coalesces adjacent segments for 50ms while retaining channel and item order', async () => {
    const { emit, batcher } = fixture()
    batcher.append(delta('one '))
    batcher.append(delta('two'))
    batcher.append(delta('summary', { kind: 'reasoning-summary' }))
    batcher.append(delta('next', { itemId: 'second' }))
    await vi.advanceTimersByTimeAsync(49)
    expect(emit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(emit.mock.calls.map(([value]) => value)).toEqual([delta('one two'), delta('summary', { kind: 'reasoning-summary' }), delta('next', { itemId: 'second' })])
    expect(vi.getTimerCount()).toBe(0)
    batcher.close()
  })
  it('flushes immediately before a caller transition and never merges stream/complete delivery', () => {
    const { emit, batcher } = fixture()
    batcher.append(delta('stream'))
    batcher.append(delta('final suffix', { delivery: 'complete' }))
    batcher.flush()
    expect(emit.mock.calls.map(([value]) => value.delivery)).toEqual(['stream', 'complete'])
    expect(vi.getTimerCount()).toBe(0)
    batcher.close()
  })
  it('chunks multi-byte text into at most 16KiB without splitting a Unicode character', () => {
    const { emit, batcher } = fixture()
    const text = `${'中😀a'.repeat(18_000)}tail`
    batcher.append(delta(text))
    batcher.close()
    const chunks = emit.mock.calls.map(([value]) => value.delta)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every(chunk => Buffer.byteLength(chunk) <= 16 * 1024)).toBe(true)
    expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk))).toBe(true)
  })
  it('flushes a bounded pending buffer during a synchronous burst without dropping readable text', () => {
    const { emit, batcher } = fixture()
    const text = 'a'.repeat(1024 * 1024)
    batcher.append(delta(text))
    expect(emit).toHaveBeenCalled()
    batcher.close()
    expect(emit.mock.calls.map(([value]) => value.delta).join('')).toBe(text)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('flushes final buffered text once, rejecting reentrant and late appends after close', async () => {
    const { emit, batcher } = fixture()
    batcher.append(delta('last'))
    emit.mockImplementation(() => { batcher.append(delta('reentrant')); batcher.close() })
    batcher.close()
    batcher.close()
    batcher.append(delta('late'))
    await vi.advanceTimersByTimeAsync(100)
    expect(emit.mock.calls.map(([value]) => value.delta)).toEqual(['last'])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('discards pending text on invalidation and checks ownership again between emitted chunks', async () => {
    let current = true
    const { emit, batcher } = fixture(() => current)
    batcher.append(delta('before switch'))
    current = false
    await vi.advanceTimersByTimeAsync(50)
    expect(emit).not.toHaveBeenCalled()
    current = true
    batcher.append(delta('must not resurrect'))
    batcher.flush()
    expect(emit).not.toHaveBeenCalled()
    const second = fixture(() => current)
    second.emit.mockImplementation(() => { current = false })
    second.batcher.append(delta('a'.repeat(32 * 1024)))
    second.batcher.close()
    expect(second.emit).toHaveBeenCalledOnce()
  })
  it('disposes without emitting and does not let a display callback exception break provider output', async () => {
    const first = fixture()
    first.batcher.append(delta('discard'))
    first.batcher.dispose()
    await vi.advanceTimersByTimeAsync(50)
    expect(first.emit).not.toHaveBeenCalled()
    const second = fixture()
    second.emit.mockImplementation(() => { throw new Error('display port unavailable') })
    second.batcher.append(delta('a'.repeat(32 * 1024)))
    expect(() => second.batcher.close()).not.toThrow()
    expect(second.emit).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
