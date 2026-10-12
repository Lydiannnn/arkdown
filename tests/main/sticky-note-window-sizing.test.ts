import { describe, expect, it } from 'vitest'
import {
  calculateStickyNoteWindowSize,
  parseStickyNoteContentMeasurement,
} from '../../src/main/sticky-notes/sticky-note-window-sizing'

describe('sticky note content sizing', () => {
  it('keeps short notes at the 320x320 default', () => {
    expect(calculateStickyNoteWindowSize(
      { scrollWidth: 220, scrollHeight: 140 },
      { width: 1920, height: 1040 },
    )).toEqual({ width: 320, height: 320 })
  })

  it('expands long content while enforcing the 600x800 product maximum', () => {
    expect(calculateStickyNoteWindowSize(
      { scrollWidth: 420, scrollHeight: 600 },
      { width: 1920, height: 1040 },
    )).toEqual({ width: 460, height: 688 })
    expect(calculateStickyNoteWindowSize(
      { scrollWidth: 3000, scrollHeight: 9000 },
      { width: 1920, height: 1040 },
    )).toEqual({ width: 600, height: 800 })
  })

  it('also respects small display work areas without going below 180px', () => {
    expect(calculateStickyNoteWindowSize(
      { scrollWidth: 800, scrollHeight: 1000 },
      { width: 260, height: 240 },
    )).toEqual({ width: 260, height: 240 })
    expect(calculateStickyNoteWindowSize(
      { scrollWidth: 800, scrollHeight: 1000 },
      { width: 100, height: 100 },
    )).toEqual({ width: 180, height: 180 })
  })

  it('strictly rejects arbitrary or oversized renderer measurements', () => {
    expect(parseStickyNoteContentMeasurement({ scrollWidth: 500, scrollHeight: 700 }))
      .toEqual({ scrollWidth: 500, scrollHeight: 700 })
    expect(parseStickyNoteContentMeasurement({ scrollWidth: 500, scrollHeight: 700, x: 1 }))
      .toBeUndefined()
    expect(parseStickyNoteContentMeasurement({ scrollWidth: -1, scrollHeight: 700 }))
      .toBeUndefined()
    expect(parseStickyNoteContentMeasurement({ scrollWidth: 20_000, scrollHeight: 700 }))
      .toBeUndefined()
  })
})
