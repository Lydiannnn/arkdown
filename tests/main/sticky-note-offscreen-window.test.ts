import { describe, expect, it } from 'vitest'
import { normalizeStickyNoteWindowBounds } from '../../src/main/sticky-notes/sticky-note-window-manager'

describe('sticky note multi-display bounds', () => {
  it('preserves valid negative coordinates on a display placed left of primary', () => {
    expect(normalizeStickyNoteWindowBounds(
      { x: -1700, y: 80, width: 360, height: 420 },
      [
        { x: 0, y: 0, width: 1920, height: 1040 },
        { x: -1920, y: 0, width: 1920, height: 1080 },
      ],
    )).toEqual({ x: -1700, y: 80, width: 360, height: 420 })
  })

  it('recenters a note whose previous display has been removed', () => {
    expect(normalizeStickyNoteWindowBounds(
      { x: 2500, y: 100, width: 320, height: 320 },
      [{ x: 0, y: 0, width: 1920, height: 1040 }],
    )).toEqual({ x: 800, y: 360, width: 320, height: 320 })
  })

  it('never restores a sticky note below the 180px minimum size', () => {
    expect(normalizeStickyNoteWindowBounds(
      { x: 50, y: 60, width: 100, height: 120 },
      [{ x: 0, y: 0, width: 1920, height: 1040 }],
    )).toEqual({ x: 50, y: 60, width: 180, height: 180 })
  })
})
