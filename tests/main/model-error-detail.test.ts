import { describe, expect, it } from 'vitest'
import { parseModelErrorDetail } from '../../src/shared/model-error-detail'
import { ModelProtocolError, modelProtocolError } from '../../src/main/models/model-errors'

describe('model error detail boundary', () => {
  it('preserves legacy construction and public status while exposing a safe semantic detail', () => {
    const legacy = new ModelProtocolError('incompatible-response', 'tools')
    expect(legacy.status).toBe('incompatible-response')
    expect(legacy.capability).toBe('tools')
    expect(legacy.message).toBe('The model provider returned an incompatible response')
    const error = modelProtocolError('authentication-failed', undefined, { version: 1, reason: 'access-denied', stage: 'provider', source: 'http', httpStatus: 403 })
    expect(error.detail.reason).toBe('access-denied')
    expect(Object.isFrozen(error.detail)).toBe(true)
  })
  it('accepts only bounded finite metadata with no provider text, paths or automatic retry instructions', () => {
    const detail = { version: 1, reason: 'rate-limited', stage: 'provider', source: 'http', httpStatus: 429, retryAfterSeconds: 12 }
    expect(parseModelErrorDetail(detail)).toEqual(detail)
    for (const extra of [{ message: 'PRIVATE' }, { apiKey: 'SECRET' }, { path: 'C:/private' }, { retry: true }]) {
      expect(parseModelErrorDetail({ ...detail, ...extra })).toBeNull()
    }
    for (const retryAfterSeconds of [-1, Infinity, 86_401, '12']) expect(parseModelErrorDetail({ ...detail, retryAfterSeconds })).toBeNull()
    expect(parseModelErrorDetail({ ...detail, reason: 'SECRET' })).toBeNull()
    expect(parseModelErrorDetail({ ...detail, httpStatus: 42 })).toBeNull()
  })
  it('does not invoke getters or accept custom prototypes', () => {
    let read = false
    expect(parseModelErrorDetail({ get reason() { read = true; return 'unknown' } })).toBeNull()
    expect(read).toBe(false)
    expect(parseModelErrorDetail(Object.create({ version: 1, reason: 'unknown' }))).toBeNull()
  })
})
