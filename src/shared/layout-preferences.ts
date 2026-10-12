export interface LayoutPreferences {
  leftSidebarWidth: number
  rightSidebarWidth: number
}

export interface LayoutPreferencesSnapshot {
  layout: LayoutPreferences
  revision: number
}

export const DEFAULT_LAYOUT_PREFERENCES: LayoutPreferences = Object.freeze({
  leftSidebarWidth: 300,
  rightSidebarWidth: 530,
})

export const LEFT_SIDEBAR_WIDTH_LIMITS = Object.freeze({ minimum: 180, maximum: 600 })
export const RIGHT_SIDEBAR_WIDTH_LIMITS = Object.freeze({ minimum: 240, maximum: 1800 })

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

function parseLayoutNumbers(value: unknown): LayoutPreferences | undefined {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const keys = Reflect.ownKeys(record)
  if (
    keys.length !== 2
    || !keys.every((key) => key === 'leftSidebarWidth' || key === 'rightSidebarWidth')
    || !Object.hasOwn(record, 'leftSidebarWidth')
    || !Object.hasOwn(record, 'rightSidebarWidth')
    || typeof record.leftSidebarWidth !== 'number'
    || !Number.isSafeInteger(record.leftSidebarWidth)
    || record.leftSidebarWidth <= 0
    || typeof record.rightSidebarWidth !== 'number'
    || !Number.isSafeInteger(record.rightSidebarWidth)
    || record.rightSidebarWidth <= 0
  ) return undefined
  return {
    leftSidebarWidth: record.leftSidebarWidth,
    rightSidebarWidth: record.rightSidebarWidth,
  }
}

export function parseCompleteLayoutPreferences(value: unknown): LayoutPreferences | undefined {
  const layout = parseLayoutNumbers(value)
  if (
    !layout
    || layout.leftSidebarWidth < LEFT_SIDEBAR_WIDTH_LIMITS.minimum
    || layout.leftSidebarWidth > LEFT_SIDEBAR_WIDTH_LIMITS.maximum
    || layout.rightSidebarWidth < RIGHT_SIDEBAR_WIDTH_LIMITS.minimum
    || layout.rightSidebarWidth > RIGHT_SIDEBAR_WIDTH_LIMITS.maximum
  ) return undefined
  return layout
}

export function normalizeLayoutPreferences(value: unknown): LayoutPreferences {
  const layout = parseLayoutNumbers(value)
  if (!layout) return { ...DEFAULT_LAYOUT_PREFERENCES }
  return {
    leftSidebarWidth: clamp(
      layout.leftSidebarWidth,
      LEFT_SIDEBAR_WIDTH_LIMITS.minimum,
      LEFT_SIDEBAR_WIDTH_LIMITS.maximum,
    ),
    rightSidebarWidth: clamp(
      layout.rightSidebarWidth,
      RIGHT_SIDEBAR_WIDTH_LIMITS.minimum,
      RIGHT_SIDEBAR_WIDTH_LIMITS.maximum,
    ),
  }
}

export function layoutPreferencesEqual(left: LayoutPreferences, right: LayoutPreferences): boolean {
  return left.leftSidebarWidth === right.leftSidebarWidth
    && left.rightSidebarWidth === right.rightSidebarWidth
}
