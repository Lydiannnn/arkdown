import { expect, it } from 'vitest'
import { normalizeBrowserSearchPreferences } from '../../src/shared/search-preferences'

it.each([undefined, null, {}, { provider: 'unknown', customTemplate: '' }, { provider: 'custom', customTemplate: 'http://example.com/?q={query}' }])('defaults missing or invalid search %j to Baidu', (value) => {
  expect(normalizeBrowserSearchPreferences(value)).toEqual({ provider: 'baidu', customTemplate: '' })
})
it.each(['bing', 'baidu', 'google'] as const)('preserves saved %s', (provider) => {
  expect(normalizeBrowserSearchPreferences({ provider, customTemplate: '' })).toEqual({ provider, customTemplate: '' })
})
it('preserves a safe saved custom provider', () => {
  const saved = { provider: 'custom', customTemplate: 'https://example.com/?q={query}' }
  expect(normalizeBrowserSearchPreferences(saved)).toEqual(saved)
})
