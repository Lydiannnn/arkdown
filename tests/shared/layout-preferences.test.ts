import { expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT_PREFERENCES,
  normalizeLayoutPreferences,
  parseCompleteLayoutPreferences,
} from '../../src/shared/layout-preferences'

it('migrates missing layout preferences to independent 300 and 530 defaults', () => {
  expect(DEFAULT_LAYOUT_PREFERENCES).toEqual({ leftSidebarWidth: 300, rightSidebarWidth: 530 })
  expect(normalizeLayoutPreferences(undefined)).toEqual({ leftSidebarWidth: 300, rightSidebarWidth: 530 })
})

it('keeps valid stored widths and clamps restored widths to their current allowed limits', () => {
  expect(parseCompleteLayoutPreferences({ leftSidebarWidth: 420, rightSidebarWidth: 760 }))
    .toEqual({ leftSidebarWidth: 420, rightSidebarWidth: 760 })
  expect(normalizeLayoutPreferences({ leftSidebarWidth: 900, rightSidebarWidth: 2000 }))
    .toEqual({ leftSidebarWidth: 600, rightSidebarWidth: 1800 })
})

it('rejects out-of-range values at the strict IPC boundary while retaining restore migration', () => {
  expect(parseCompleteLayoutPreferences({ leftSidebarWidth: 900, rightSidebarWidth: 2000 }))
    .toBeUndefined()
  expect(normalizeLayoutPreferences({ leftSidebarWidth: 900, rightSidebarWidth: 2000 }))
    .toEqual({ leftSidebarWidth: 600, rightSidebarWidth: 1800 })
})
