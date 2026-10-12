import { describe, expect, it } from 'vitest'
import { scaleColumnWidths } from '../../src/renderer/editor/responsive-table-layout'

describe('responsive table column layout', () => {
  it('preserves authored widths when they fit', () => {
    expect(scaleColumnWidths([180, 96], 400)).toEqual([180, 96])
  })

  it('shrinks every column by the same ratio when space is limited', () => {
    expect(scaleColumnWidths([180, 96], 138)).toEqual([90, 48])
    expect(scaleColumnWidths([300, 150, 50], 250)).toEqual([150, 75, 25])
  })

  it('returns no layout for invalid measurements', () => {
    expect(scaleColumnWidths([], 200)).toBeNull()
    expect(scaleColumnWidths([180, 0], 200)).toBeNull()
    expect(scaleColumnWidths([180, Number.NaN], 200)).toBeNull()
    expect(scaleColumnWidths([180, 96], 0)).toBeNull()
  })
})
