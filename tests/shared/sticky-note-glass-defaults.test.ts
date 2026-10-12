import { expect, it } from 'vitest'
import { DEFAULT_STICKY_NOTE_PREFERENCES, defaultStickyNoteStyle, parseStickyNotePreferences } from '../../src/shared/sticky-note-preferences'

it.each(['warm-frosted-glass', 'clear-glass'])('round-trips %s as a new-note default without altering existing color values', defaultAppearance => {
  const input = { ...DEFAULT_STICKY_NOTE_PREFERENCES, defaultAppearance, defaultColor: '#ABCDEF' }
  const parsed = parseStickyNotePreferences(input)
  expect(parsed).toBeDefined()
  expect(parsed?.defaultColor).toBe('#ABCDEF')
  expect(defaultStickyNoteStyle(parsed!)).toEqual({ mode: 'material', materialPresetId: defaultAppearance })
})
