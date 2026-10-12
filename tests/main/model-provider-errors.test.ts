import { describe, expect, it } from 'vitest'
import { providerModelError, transportModelError } from '../../src/main/models/model-provider-errors'

describe('structured provider evidence', () => {
  it.each([
    [403, { message: 'invalid key quota secret' }, 'access-denied'],
    [404, { message: 'model not found' }, 'not-found'],
    [404, { code: 'model_not_found' }, 'model-not-found'],
    [429, { message: 'quota exhausted' }, 'rate-limited'],
    [429, { code: 'insufficient_quota' }, 'quota-exceeded'],
    [503, { message: 'private details' }, 'service-unavailable'],
    [400, { code: 'context_length_exceeded' }, 'context-limit'],
    [400, { code: 'unsupported_parameter', param: 'tools' }, 'tools-unsupported'],
    [400, { code: 'invalid_request_error', param: 'tools' }, 'request-rejected'],
  ] as const)('maps HTTP %s by structured evidence to %s', (httpStatus, error, reason) => {
    const result = providerModelError(error, { source: 'http', httpStatus })
    expect(result.detail.reason).toBe(reason)
    expect(result.detail.httpStatus).toBe(httpStatus)
    expect(result.capability).toBe(reason === 'tools-unsupported' ? 'tools' : undefined)
    expect(JSON.stringify(result)).not.toMatch(/private|secret|quota exhausted/)
  })
  it('classifies stream overload separately from provider rate limits', () => {
    expect(providerModelError({ type: 'overloaded_error' }, { source: 'sse' }).detail.reason).toBe('service-unavailable')
    expect(providerModelError({ type: 'rate_limit_error' }, { source: 'sse' }).detail.reason).toBe('rate-limited')
  })
  it('reads only known transport codes, never exception prose', () => {
    expect(transportModelError(new Error('TLS private path'), 'connect').detail.reason).toBe('network')
    expect(transportModelError({ cause: { code: 'CERT_HAS_EXPIRED' } }, 'connect').detail.reason).toBe('tls')
    expect(transportModelError({ code: 'ENOTFOUND' }, 'connect').detail.reason).toBe('dns')
    expect(transportModelError({ cause: { code: 'UND_ERR_SOCKET' } }, 'receive').detail.reason).toBe('stream-interrupted')
    expect(transportModelError(new Error('callback failed'), 'receive').detail.reason).toBe('unknown')
  })
  it('never coerces untrusted structured field objects into text', () => {
    let touched = false
    const opaque = { toString() { touched = true; return 'tools' } }
    expect(providerModelError({ code: 'unsupported_parameter', param: opaque }, { source: 'http', httpStatus: 400 }).detail.reason).toBe('request-rejected')
    expect(transportModelError({ code: opaque }, 'receive').detail.reason).toBe('unknown')
    expect(touched).toBe(false)
  })
})
