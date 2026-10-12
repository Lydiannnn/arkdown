import { describe, expect, it, vi } from 'vitest'
import { canTransitionClosePreparation, parseClosePreparationEvent, parseClosePreparationRequest, parseClosePreparationResult } from '../../src/shared/close-preparation'

const identity = { attemptId: '550e8400-e29b-41d4-a716-446655440001', generation: 1,
  requestId: '550e8400-e29b-41d4-a716-446655440002' }

describe('structured close preparation wire', () => {
  it('copies and freezes exact request/event/result data without exposing arbitrary renderer content', () => {
    const request = parseClosePreparationRequest(identity)
    expect(request).toEqual(identity)
    expect(request).not.toBe(identity)
    expect(Object.isFrozen(request)).toBe(true)
    for (const event of [
      { ...identity, sequence: 1, type: 'heartbeat' },
      { ...identity, sequence: 2, type: 'stage', stage: 'await-user' },
      { ...identity, sequence: 3, type: 'result', result: { status: 'ready' } },
    ]) {
      const parsed = parseClosePreparationEvent(event)
      expect(parsed).toEqual(event)
      expect(Object.isFrozen(parsed)).toBe(true)
      if (parsed?.type === 'result') expect(Object.isFrozen(parsed.result)).toBe(true)
    }
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'])('rejects invalid generation/sequence %s', invalid => {
    expect(parseClosePreparationRequest({ ...identity, generation: invalid })).toBeUndefined()
    expect(parseClosePreparationEvent({ ...identity, sequence: invalid, type: 'heartbeat' })).toBeUndefined()
  })

  it.each([
    { ...identity, requestId: 'document-path' }, { ...identity, extra: 'secret' },
    { ...identity, attemptId: 'A'.repeat(1000) }, Object.assign([], identity),
    Object.assign(Object.create({ inherited: true }), identity),
  ])('rejects non-contract request shapes', value => expect(parseClosePreparationRequest(value)).toBeUndefined())

  it('rejects getters, symbols and hostile proxies without invoking renderer accessors', () => {
    const getter = vi.fn(() => identity.requestId)
    const request = { ...identity }
    Object.defineProperty(request, 'requestId', { enumerable: true, get: getter })
    expect(parseClosePreparationRequest(request)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
    expect(parseClosePreparationRequest({ ...identity, [Symbol('hidden')]: true })).toBeUndefined()
    expect(parseClosePreparationEvent(new Proxy({}, { getPrototypeOf() { throw new Error('private') } }))).toBeUndefined()
  })

  it('distinguishes unknown from recoverable failure and rejects arbitrary messages', () => {
    expect(parseClosePreparationResult({ status: 'blocked', code: 'document-result-unknown' })).toEqual({ status: 'blocked', code: 'document-result-unknown' })
    expect(parseClosePreparationResult({ status: 'failed', code: 'document-save-failed' })).toEqual({ status: 'failed', code: 'document-save-failed' })
    for (const result of [
      { status: 'failed', code: 'document-result-unknown' }, { status: 'ready', code: 'editor-unavailable' },
      { status: 'cancelled', message: 'path/secret' }, { status: 'failed', code: 'anything' },
    ]) expect(parseClosePreparationResult(result)).toBeUndefined()
    expect(parseClosePreparationEvent({ ...identity, sequence: 1, type: 'stage', stage: 'native-close' })).toBeUndefined()
    expect(parseClosePreparationEvent({ ...identity, sequence: 1, type: 'heartbeat', now: 123 })).toBeUndefined()
  })

  it('permits document/user loops but requires a fresh prepare after preference settlement', () => {
    expect(canTransitionClosePreparation('prepare-editor', 'await-user')).toBe(true)
    expect(canTransitionClosePreparation('await-user', 'settle-document')).toBe(true)
    expect(canTransitionClosePreparation('settle-document', 'await-user')).toBe(true)
    expect(canTransitionClosePreparation('settle-preferences', 'await-preferences')).toBe(true)
    expect(canTransitionClosePreparation('await-preferences', 'settle-preferences')).toBe(true)
    expect(canTransitionClosePreparation('await-preferences', 'settle-document')).toBe(false)
    expect(canTransitionClosePreparation('prepare-editor', 'await-preferences')).toBe(false)
    expect(canTransitionClosePreparation('settle-document', 'settle-preferences')).toBe(true)
    expect(canTransitionClosePreparation('settle-preferences', 'prepare-editor')).toBe(true)
    expect(canTransitionClosePreparation('settle-preferences', 'settle-document')).toBe(false)
  })
})
