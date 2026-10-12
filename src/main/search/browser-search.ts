import {
  type BrowserSearchPreferences,
  isSafeCustomSearchTemplate,
} from '../../shared/search-preferences'

const SEARCH_TEMPLATES = Object.freeze({
  bing: 'https://www.bing.com/search?q={query}',
  baidu: 'https://www.baidu.com/s?wd={query}',
  google: 'https://www.google.com/search?q={query}',
})

export function buildSearchUrl(
  query: string,
  preferences: BrowserSearchPreferences,
): string {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) throw new Error('搜索内容不能为空')
  if ([...normalizedQuery].length > 1000) throw new Error('搜索内容过长')

  let template: string
  if (preferences.provider === 'custom') {
    if (!isSafeCustomSearchTemplate(preferences.customTemplate)) {
      throw new Error('自定义搜索地址无效')
    }
    template = preferences.customTemplate
  } else {
    template = SEARCH_TEMPLATES[preferences.provider]
  }

  const target = template.replace('{query}', encodeURIComponent(normalizedQuery))
  if (target.length > 2000) throw new Error('搜索地址过长')
  const url = new URL(target)
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
  ) throw new Error('搜索地址无效')
  return url.href
}

export class BrowserSearchService {
  constructor(private readonly dependencies: {
    getPreferences(): BrowserSearchPreferences
    openExternal(url: string): Promise<void>
  }) {}

  async search(query: string): Promise<string> {
    const target = buildSearchUrl(query, this.dependencies.getPreferences())
    await this.dependencies.openExternal(target)
    return target
  }
}
