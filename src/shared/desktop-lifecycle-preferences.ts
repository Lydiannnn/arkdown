export type CloseBehavior = 'tray' | 'quit'

export interface DesktopLifecyclePreferences {
  launchAtLogin: boolean
  closeBehavior: CloseBehavior
  stickyNoteAutostartPrompted: boolean
}

export const DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES: DesktopLifecyclePreferences = Object.freeze({
  launchAtLogin: false,
  closeBehavior: 'tray',
  stickyNoteAutostartPrompted: false,
})

function isExactRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const expected = ['launchAtLogin', 'closeBehavior', 'stickyNoteAutostartPrompted']
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length
    && keys.every((key) => typeof key === 'string' && expected.includes(key))
}

export function parseDesktopLifecyclePreferences(
  value: unknown,
): DesktopLifecyclePreferences | undefined {
  if (
    !isExactRecord(value)
    || typeof value.launchAtLogin !== 'boolean'
    || (value.closeBehavior !== 'tray' && value.closeBehavior !== 'quit')
    || typeof value.stickyNoteAutostartPrompted !== 'boolean'
  ) return undefined

  return {
    launchAtLogin: value.launchAtLogin,
    closeBehavior: value.closeBehavior,
    stickyNoteAutostartPrompted: value.stickyNoteAutostartPrompted,
  }
}

export function copyDesktopLifecyclePreferences(
  value: DesktopLifecyclePreferences,
): DesktopLifecyclePreferences {
  return { ...value }
}

export function normalizeDesktopLifecyclePreferences(
  value: unknown,
): DesktopLifecyclePreferences {
  return parseDesktopLifecyclePreferences(value)
    ?? copyDesktopLifecyclePreferences(DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES)
}
