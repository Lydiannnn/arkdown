import { describe, expect, it, vi } from 'vitest'
import {
  buildSearchUrl,
  BrowserSearchService,
} from '../../src/main/search/browser-search'
import {
  DEFAULT_BROWSER_SEARCH,
  normalizeBrowserSearchPreferences,
} from '../../src/shared/search-preferences'

describe('normalizeBrowserSearchPreferences', () => {
  it('uses Baidu for missing or malformed preferences', () => {
    expect(normalizeBrowserSearchPreferences(undefined)).toEqual(DEFAULT_BROWSER_SEARCH)
    expect(normalizeBrowserSearchPreferences({
      provider: 'duckduckgo',
      customTemplate: '',
    })).toEqual(DEFAULT_BROWSER_SEARCH)
    expect(normalizeBrowserSearchPreferences({
      provider: 'custom',
      customTemplate: 'http://example.com/?q={query}',
    })).toEqual(DEFAULT_BROWSER_SEARCH)
  })

  it('accepts a custom HTTPS template with exactly one query placeholder', () => {
    expect(normalizeBrowserSearchPreferences({
      provider: 'custom',
      customTemplate: 'https://search.example/query?q={query}',
    })).toEqual({
      provider: 'custom',
      customTemplate: 'https://search.example/query?q={query}',
    })
  })
})

describe('buildSearchUrl', () => {
  it.each([
    ['bing', 'https://www.bing.com/search?q=%E4%B8%AD%E6%96%87%20test'],
    ['baidu', 'https://www.baidu.com/s?wd=%E4%B8%AD%E6%96%87%20test'],
    ['google', 'https://www.google.com/search?q=%E4%B8%AD%E6%96%87%20test'],
  ] as const)('builds the %s search URL without logging the query', (provider, expected) => {
    expect(buildSearchUrl('中文 test', { provider, customTemplate: '' })).toBe(expected)
  })

  it('rejects empty, overlong and oversized searches', () => {
    expect(() => buildSearchUrl('  ', DEFAULT_BROWSER_SEARCH)).toThrow('搜索内容不能为空')
    expect(() => buildSearchUrl('😀'.repeat(1001), DEFAULT_BROWSER_SEARCH)).toThrow('搜索内容过长')
    expect(() => buildSearchUrl('a'.repeat(1000), {
      provider: 'custom',
      customTemplate: `https://example.com/${'x'.repeat(1100)}?q={query}`,
    })).toThrow('搜索地址过长')
  })

  it('rejects unsafe custom templates', () => {
    for (const template of [
      'http://example.com/?q={query}',
      'https://user:secret@example.com/?q={query}',
      'https://example.com/?q={query}&again={query}',
      'https://example.com/',
    ]) {
      expect(() => buildSearchUrl('test', {
        provider: 'custom',
        customTemplate: template,
      })).toThrow()
    }
  })
})

describe('BrowserSearchService', () => {
  it('opens the validated URL with the system default browser', async () => {
    const openExternal = vi.fn(async () => undefined)
    const service = new BrowserSearchService({
      getPreferences: () => ({ provider: 'baidu', customTemplate: '' }),
      openExternal,
    })

    await expect(service.search('Arkdown')).resolves.toBe(
      'https://www.baidu.com/s?wd=Arkdown',
    )
    expect(openExternal).toHaveBeenCalledWith('https://www.baidu.com/s?wd=Arkdown')
  })
})
