import { describe, expect, it } from 'vitest'
import { validateModelBaseUrl } from '../../src/main/models/model-protocol-client'

describe('model endpoint validation', () => {
  it.each([
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['http://127.0.0.1:4179/v1', 'http://127.0.0.1:4179/v1'],
    ['http://localhost:4179/v1', 'http://localhost:4179/v1'],
    ['http://[::1]:4179/v1', 'http://[::1]:4179/v1'],
  ])('accepts a safe model endpoint: %s', (value, expected) => {
    expect(validateModelBaseUrl(value).href).toBe(expected)
  })

  it.each([
    'http://api.example.com/v1',
    'file:///C:/secret',
    'https://user:pass@example.com/v1',
    'https://example.com/v1?key=value',
    'https://example.com/v1#secret',
    'not a URL',
  ])('rejects an unsafe model endpoint: %s', (value) => {
    expect(() => validateModelBaseUrl(value)).toThrow()
  })
})
