import { describe, expect, it, vi } from 'vitest'
import type { CloseDiagnosticEvent } from '../../src/shared/close-diagnostics'

const modulePath = '../../src/shared/close-diagnostics'
const codec = await import(modulePath).catch(() => ({})) as typeof import('../../src/shared/close-diagnostics')
const event = (patch: Partial<CloseDiagnosticEvent> = {}): CloseDiagnosticEvent => ({
  version: '1.0.4', platform: 'win32', windowId: '550e8400-e29b-41d4-a716-446655440000',
  attemptId: '550e8400-e29b-41d4-a716-446655440001', stage: 'settle-document', event: 'exit',
  stageElapsedMs: 1_250.5, dirty: false, pending: { document: 1, ipc: 2 }, errorCode: null, ...patch,
})
const parse = (input: unknown) => {
  expect(codec.parseCloseDiagnosticEvent).toBeTypeOf('function')
  return codec.parseCloseDiagnosticEvent(input)
}

describe('close-only diagnostic whitelist', () => {
  it('copies and freezes accepted facts without retaining mutable caller objects', () => {
    const input = event()
    const result = parse(input)
    expect(result).toEqual(input)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result!.pending)).toBe(true)
    input.pending = { document: 9 }
    expect(result!.pending).toEqual({ document: 1, ipc: 2 })
    expect(codec.serializeCloseDiagnosticEvent(result)).toBe(JSON.stringify(result))
  })

  it('omits unknown dirty state instead of claiming the document is clean', () => {
    const input = event(); delete input.dirty
    const result = parse(input)
    expect(result).toBeDefined()
    expect(result).not.toHaveProperty('dirty')
  })

  it.each(['markdown', 'reasoning', 'path', 'apiKey', 'payload', 'message', 'stack', 'toJSON'])('rejects an extra %s rather than copying or serializing it', key => {
    const input = { ...event(), [key]: 'PRIVATE synthetic value' }
    expect(parse(input)).toBeUndefined()
    expect(codec.serializeCloseDiagnosticEvent(input)).toBeUndefined()
    expect(codec.formatCloseDiagnosticSummary(input)).toBeUndefined()
  })

  it('rejects getters, hidden/symbol keys and inherited fields without evaluating accessors', () => {
    const getter = vi.fn(() => 'PRIVATE')
    const accessor = event(); Object.defineProperty(accessor, 'version', { enumerable: true, get: getter })
    const nested = event(); Object.defineProperty(nested.pending, 'document', { enumerable: true, get: getter })
    const hidden = event(); Object.defineProperty(hidden, 'path', { value: 'PRIVATE' })
    const symbol = { ...event(), [Symbol('private')]: 'PRIVATE' }
    const inherited = Object.assign(Object.create({ path: 'PRIVATE' }), event())
    for (const input of [accessor, nested, hidden, symbol, inherited]) expect(parse(input)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
  })

  it('does not throw if an invalid proxy traps reflection', () => {
    const input = new Proxy({}, { getPrototypeOf() { throw new Error('PRIVATE path or key') } })
    expect(() => parse(input)).not.toThrow()
    expect(codec.serializeCloseDiagnosticEvent(input)).toBeUndefined()
    expect(codec.formatCloseDiagnosticSummary(input)).toBeUndefined()
  })

  it.each([
    { version: 'C:\\private\\document.md' }, { version: '1.0.4\nPRIVATE' }, { version: `1.0.4-${'界'.repeat(1000)}` },
    { version: `1.0.4-${'x'.repeat(64)}` }, { platform: 'PRIVATE' },
    { windowId: '../private' }, { attemptId: 'private-attempt-name' },
    { stage: 'PRIVATE' }, { event: 'PRIVATE' }, { errorCode: 'EACCES: C:\\private' },
    { dirty: 'false' }, { dirty: undefined }, { stageElapsedMs: NaN }, { stageElapsedMs: Infinity },
    { stageElapsedMs: -1 }, { pending: { path: 1 } }, { pending: { document: -1 } },
    { pending: { document: 0.5 } }, { pending: { document: Number.MAX_SAFE_INTEGER + 1 } },
  ])('rejects unsafe field value %j', patch => {
    expect(parse({ ...event(), ...patch })).toBeUndefined()
  })

  it('produces a bounded single-line UTF-8 record and a sanitized current-attempt summary', () => {
    const input = event({ version: `1.0.4-${'x'.repeat(58)}`, event: 'error', errorCode: 'document-result-unknown',
      pending: { editor: 1, document: 2, draft: 3, preferences: 4, owner: 5, ai: 6, ipc: 7, 'window-settings': 8, cleanup: 9, restore: 10 } })
    expect(parse(input)).toBeDefined()
    const line = codec.serializeCloseDiagnosticEvent(input)!
    expect(line).not.toMatch(/[\r\n]/)
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(codec.CLOSE_DIAGNOSTIC_EVENT_MAX_BYTES)
    expect(JSON.parse(line)).toEqual(input)
    const summary = codec.formatCloseDiagnosticSummary(input)!
    expect(summary).toContain('document-result-unknown')
    expect(summary).toContain(input.attemptId)
    expect(summary).not.toMatch(/全部已保存|没有修改任何文件/)
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(codec.CLOSE_DIAGNOSTIC_SUMMARY_MAX_BYTES)
  })
})
