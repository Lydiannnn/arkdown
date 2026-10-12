import { describe, expect, it } from 'vitest'
import {
  EDITOR_ZOOM_MAX,
  EDITOR_ZOOM_MIN,
  EDITOR_ZOOM_STEP,
  nextEditorZoom,
} from '../../src/renderer/editor/editor-zoom'

describe('editor-only zoom', () => {
  it('steps by ten percent, clamps to the exact bounds, and resets to 100 percent', () => {
    expect({
      min: EDITOR_ZOOM_MIN,
      max: EDITOR_ZOOM_MAX,
      step: EDITOR_ZOOM_STEP,
    }).toEqual({ min: 70, max: 200, step: 10 })
    expect(nextEditorZoom(100, 'in')).toBe(110)
    expect(nextEditorZoom(200, 'in')).toBe(200)
    expect(nextEditorZoom(70, 'out')).toBe(70)
    expect(nextEditorZoom(140, 'reset')).toBe(100)
  })

  it('normalizes off-step, non-finite, and out-of-range current values before acting', () => {
    expect(nextEditorZoom(74, 'in')).toBe(80)
    expect(nextEditorZoom(76, 'out')).toBe(70)
    expect(nextEditorZoom(Number.NaN, 'in')).toBe(110)
    expect(nextEditorZoom(Number.POSITIVE_INFINITY, 'out')).toBe(90)
    expect(nextEditorZoom(-500, 'out')).toBe(70)
    expect(nextEditorZoom(500, 'in')).toBe(200)
  })
})
