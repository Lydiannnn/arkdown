import { describe, expect, it } from 'vitest'
import { calculateShrinkOnlyCoverLayout } from '../../src/renderer/backgrounds/background-layout'

describe('calculateShrinkOnlyCoverLayout', () => {
  it('shrinks a wide image to cover a main editor from its right-bottom corner', () => {
    expect(calculateShrinkOnlyCoverLayout({
      containerWidth: 500,
      containerHeight: 300,
      imageWidth: 1000,
      imageHeight: 400,
      anchor: 'right-bottom',
    })).toEqual({
      scale: 0.75,
      width: 750,
      height: 300,
      left: -250,
      top: 0,
    })
  })

  it('keeps the same covered image at the top-left for a sticky note', () => {
    expect(calculateShrinkOnlyCoverLayout({
      containerWidth: 500,
      containerHeight: 300,
      imageWidth: 1000,
      imageHeight: 400,
      anchor: 'left-top',
    })).toEqual({
      scale: 0.75,
      width: 750,
      height: 300,
      left: 0,
      top: 0,
    })
  })

  it.each([
    ['right-top', -250, 0],
    ['left-bottom', 0, 0],
    ['center', -125, 0],
  ] as const)('places a covered image at the %s alignment', (anchor, left, top) => {
    expect(calculateShrinkOnlyCoverLayout({
      containerWidth: 500,
      containerHeight: 300,
      imageWidth: 1000,
      imageHeight: 400,
      anchor,
    })).toEqual({
      scale: 0.75,
      width: 750,
      height: 300,
      left,
      top,
    })
  })

  it.each([
    ['right-bottom', 0, -325],
    ['left-top', 0, 0],
    ['right-top', 0, 0],
    ['left-bottom', 0, -325],
    ['center', 0, -162.5],
  ] as const)('places a tall covered image at the %s alignment', (anchor, left, top) => {
    expect(calculateShrinkOnlyCoverLayout({
      containerWidth: 500,
      containerHeight: 300,
      imageWidth: 800,
      imageHeight: 1000,
      anchor,
    })).toEqual({
      scale: 0.625,
      width: 500,
      height: 625,
      left,
      top,
    })
  })

  it('does not enlarge an undersized image and leaves the uncovered bottom-right area visible', () => {
    expect(calculateShrinkOnlyCoverLayout({
      containerWidth: 800,
      containerHeight: 600,
      imageWidth: 400,
      imageHeight: 300,
      anchor: 'right-bottom',
    })).toEqual({
      scale: 1,
      width: 400,
      height: 300,
      left: 400,
      top: 300,
    })
  })
})
