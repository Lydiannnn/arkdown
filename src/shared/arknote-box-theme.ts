import { isThemeColor, normalizeThemeColor } from './theme-color'
export const ARKNOTE_BOX_THEME_CHANNEL = 'arknote:box-theme'
export const ARKNOTE_BOX_THEME_EVENT = 'arknote:box-theme-changed'
export interface ArknoteBoxTheme { mode: 'light' | 'dark'; themeColor: string }
export interface ArknoteBoxThemeApi {
  get(): Promise<ArknoteBoxTheme>
  subscribe(listener: (theme: ArknoteBoxTheme) => void): () => void
}
export function parseArknoteBoxTheme(value: unknown): ArknoteBoxTheme | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).length !== 2 || !Object.hasOwn(record, 'mode') || !Object.hasOwn(record, 'themeColor')
    || record.mode !== 'light' && record.mode !== 'dark' || !isThemeColor(record.themeColor)) return undefined
  return { mode: record.mode, themeColor: normalizeThemeColor(record.themeColor) }
}
