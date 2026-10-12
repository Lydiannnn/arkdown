import { describe, expect, it } from 'vitest'
import { resizeRenderedColumnWidths } from '../../src/renderer/editor/bounded-column-resizing-plugin'

describe('bounded table column resize interaction', () => {
  it('changes only the dragged column while respecting the table boundary', () => {
    expect(resizeRenderedColumnWidths({
      widths: [100, 120, 80],
      columnIndex: 1,
      pointerDelta: 40,
      availableWidth: 320,
      minimumWidth: 25,
    })).toEqual([100, 140, 80])
  })
})
