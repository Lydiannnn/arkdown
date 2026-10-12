import { describe, expect, it } from 'vitest'
import { placeContextMenu, placeSubmenu } from '../../src/renderer/context-menu/context-menu-position'

describe('placeContextMenu', () => {
  it('keeps a root menu inside the viewport near the lower-right corner', () => {
    expect(placeContextMenu(
      { x: 790, y: 590 },
      { width: 280, height: 320 },
      { width: 800, height: 600 },
      8,
    )).toEqual({ x: 512, y: 272 })
  })

  it('never returns coordinates outside the top-left viewport edge', () => {
    expect(placeContextMenu(
      { x: -40, y: -20 },
      { width: 240, height: 180 },
      { width: 800, height: 600 },
      8,
    )).toEqual({ x: 8, y: 8 })
  })
})

describe('placeSubmenu', () => {
  it('opens to the left when there is not enough room on the right', () => {
    expect(placeSubmenu(
      { left: 600, top: 100, right: 780, bottom: 420, width: 180, height: 320 },
      { width: 260, height: 300 },
      { width: 800, height: 600 },
      8,
    )).toEqual({ x: 340, y: 100, side: 'left' })
  })

  it('opens to the right and clamps vertically when room is available', () => {
    expect(placeSubmenu(
      { left: 40, top: 500, right: 220, bottom: 570, width: 180, height: 70 },
      { width: 260, height: 220 },
      { width: 800, height: 600 },
      8,
    )).toEqual({ x: 220, y: 372, side: 'right' })
  })
})
