import { describe, expect, it } from 'vitest'
import {
  buildStickyNoteFontSizeItems,
  nextStickyNoteFontSize,
} from '../../src/renderer/sticky-notes/sticky-note-font-size'

describe('sticky note font size controls', () => {
  it('changes the entire note by one CSS pixel only within 11px through 20px', () => {
    expect(nextStickyNoteFontSize(13, 'increase')).toBe(14)
    expect(nextStickyNoteFontSize(13, 'decrease')).toBe(12)
    expect(nextStickyNoteFontSize(11, 'decrease')).toBeNull()
    expect(nextStickyNoteFontSize(20, 'increase')).toBeNull()
  })

  it('disables the boundary action instead of creating a Markdown edit', () => {
    expect(buildStickyNoteFontSizeItems(11)).toMatchObject([
      { id: 'sticky-font-size-increase', disabled: false },
      { id: 'sticky-font-size-decrease', disabled: true },
    ])
    expect(buildStickyNoteFontSizeItems(20)).toMatchObject([
      { id: 'sticky-font-size-increase', disabled: true },
      { id: 'sticky-font-size-decrease', disabled: false },
    ])
  })
})
