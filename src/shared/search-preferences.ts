export type SearchProviderId = 'bing' | 'baidu' | 'google' | 'custom'

export interface BrowserSearchPreferences {
  provider: SearchProviderId
  customTemplate: string
}

export const DEFAULT_BROWSER_SEARCH: BrowserSearchPreferences = Object.freeze({
  provider: 'baidu',
  customTemplate: '',
})

const BUILT_IN_PROVIDERS = new Set<SearchProviderId>([
  'bing',
  'baidu',
  'google',
])

export function isSafeCustomSearchTemplate(template: string): boolean {
  if ((template.match(/\{query\}/g) ?? []).length !== 1) return false
  try {
    const candidate = new URL(template.replace('{query}', 'test'))
    return (
      candidate.protocol === 'https:'
      && candidate.username === ''
      && candidate.password === ''
    )
  } catch {
    return false
  }
}

export function parseBrowserSearchPreferences(
  value: unknown,
): BrowserSearchPreferences | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { provider, customTemplate } = value as Record<string, unknown>
  if (typeof provider !== 'string' || typeof customTemplate !== 'string') return undefined
  if (BUILT_IN_PROVIDERS.has(provider as SearchProviderId)) {
    return { provider: provider as SearchProviderId, customTemplate: '' }
  }
  if (provider === 'custom' && isSafeCustomSearchTemplate(customTemplate)) {
    return { provider, customTemplate }
  }
  return undefined
}

export function normalizeBrowserSearchPreferences(
  value: unknown,
): BrowserSearchPreferences {
  return parseBrowserSearchPreferences(value) ?? { ...DEFAULT_BROWSER_SEARCH }
}
