export interface ThemeColorPreset {
  name: string
  value: string
}

export const THEME_COLOR_PRESETS = Object.freeze([
  { name: '红色', value: '#C62828' },
  { name: '紫色', value: '#800080' },
  { name: '蓝色', value: '#2563EB' },
  { name: '标准蓝色', value: '#3677B7' },
  { name: '青色', value: '#007C91' },
  { name: '绿色', value: '#18864B' },
  { name: '橙色', value: '#C66A00' },
  { name: '粉色', value: '#B83280' },
  { name: '深灰色', value: '#5F6368' },
] as const satisfies readonly ThemeColorPreset[])

export const DEFAULT_THEME_COLOR = THEME_COLOR_PRESETS[0].value

export function isThemeColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/u.test(value)
}

export function normalizeThemeColor(value: string): string {
  return value.toUpperCase()
}

export function themeColorRgbChannels(value: string): string {
  const color = isThemeColor(value) ? value : DEFAULT_THEME_COLOR
  return [1, 3, 5]
    .map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16))
    .join(' ')
}
