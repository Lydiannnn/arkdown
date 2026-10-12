import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES,
  normalizeDesktopLifecyclePreferences,
  parseDesktopLifecyclePreferences,
} from '../../src/shared/desktop-lifecycle-preferences'

describe('desktop lifecycle preferences', () => {
  it('defaults to launch disabled, close-to-tray, and an unshown first-use prompt', () => {
    expect(DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES).toEqual({
      launchAtLogin: false,
      closeBehavior: 'tray',
      stickyNoteAutostartPrompted: false,
    })
    expect(normalizeDesktopLifecyclePreferences(undefined))
      .toEqual(DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES)
  })

  it('accepts only the exact public preference shape', () => {
    const value = {
      launchAtLogin: true,
      closeBehavior: 'quit' as const,
      stickyNoteAutostartPrompted: true,
    }
    expect(parseDesktopLifecyclePreferences(value)).toEqual(value)

    expect(parseDesktopLifecyclePreferences({ ...value, extra: true })).toBeUndefined()
    expect(parseDesktopLifecyclePreferences({ ...value, launchAtLogin: 1 })).toBeUndefined()
    expect(parseDesktopLifecyclePreferences({ ...value, closeBehavior: 'hide' })).toBeUndefined()
    expect(parseDesktopLifecyclePreferences({
      ...value,
      stickyNoteAutostartPrompted: 'yes',
    })).toBeUndefined()
  })

  it('falls back as a complete unit when stored settings are damaged', () => {
    expect(normalizeDesktopLifecyclePreferences({
      launchAtLogin: true,
      closeBehavior: 'quit',
    })).toEqual(DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES)
  })
})
