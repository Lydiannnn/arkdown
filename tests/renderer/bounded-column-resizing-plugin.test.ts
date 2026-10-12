import { describe, expect, it } from 'vitest'
import {
  clampDraggedColumnWidth,
  normalizeRenderedColumnWidths,
  totalColumnWidth,
} from '../../src/renderer/editor/bounded-column-resizing-plugin'

describe('bounded table column resizing', () => {
  it('stops widening when the table reaches the available content width', () => {
    expect(clampDraggedColumnWidth({
      startWidth: 120,
      pointerDelta: 100,
      tableWidth: 360,
      availableWidth: 400,
      minimumWidth: 25,
    })).toBe(160)
  })

  it('does not allow positive growth when the table already fills the content width', () => {
    expect(clampDraggedColumnWidth({
      startWidth: 120,
      pointerDelta: 40,
      tableWidth: 400,
      availableWidth: 400,
      minimumWidth: 25,
    })).toBe(120)
  })

  it('keeps normal drags within the available width unchanged', () => {
    expect(clampDraggedColumnWidth({
      startWidth: 120,
      pointerDelta: 20,
      tableWidth: 360,
      availableWidth: 400,
      minimumWidth: 25,
    })).toBe(140)
  })

  it('still enforces the minimum width while narrowing', () => {
    expect(clampDraggedColumnWidth({
      startWidth: 120,
      pointerDelta: -200,
      tableWidth: 360,
      availableWidth: 400,
      minimumWidth: 25,
    })).toBe(25)
  })

  it('normalizes rendered widths to serialization-safe integers', () => {
    expect(normalizeRenderedColumnWidths([100.9, 90.2, 80.8])).toEqual([100, 90, 80])
    expect(totalColumnWidth([100, 90, 80])).toBe(270)
  })
})
