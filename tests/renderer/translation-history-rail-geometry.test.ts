import { describe, expect, it } from 'vitest'
import { computeTranslationHistoryRailItems } from '../../src/renderer/editor/translation-history-rail-geometry'

function rect(left: number, top: number, width: number, height: number): DOMRectReadOnly {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  }
}

const surfaceRect = rect(100, 100, 300, 200)

describe('translation history rail geometry', () => {
  it('places 30 CSS px source buttons 20 CSS px after content inside a 50 CSS px reservation', () => {
    const [item] = computeTranslationHistoryRailItems({
      anchors: [{ recordId: 'one', createdAt: 1, rect: rect(160, 120, 0, 20) }],
      mode: 'source',
      surfaceRect,
      contentRight: 350,
    })

    expect(item).toMatchObject({
      recordId: 'one',
      buttonLeft: 270,
      connectorLeft: null,
      connectorTop: null,
      connectorHorizontalWidth: 0,
      connectorVerticalHeight: 0,
    })
    expect(item!.buttonLeft - (350 - surfaceRect.left)).toBe(20)
    expect(surfaceRect.width - item!.buttonLeft).toBe(30)
  })

  it('sorts deterministically, separates collisions by four pixels, and clamps buttons', () => {
    const items = computeTranslationHistoryRailItems({
      anchors: [
        { recordId: 'late', createdAt: 2, rect: rect(160, 115, 0, 10) },
        { recordId: 'early-b', createdAt: 1, rect: rect(160, 110, 0, 10) },
        { recordId: 'early-a', createdAt: 1, rect: rect(160, 110, 0, 10) },
      ],
      mode: 'source',
      surfaceRect,
      contentRight: 360,
    })

    expect(items.map(({ recordId }) => recordId)).toEqual(['early-a', 'early-b', 'late'])
    expect(items[1]!.buttonTop - items[0]!.buttonTop).toBeGreaterThanOrEqual(34)
    expect(items[2]!.buttonTop).toBeLessThanOrEqual(170)
  })

  it('uses horizontal and vertical dotted segments between the anchor and button', () => {
    const [item] = computeTranslationHistoryRailItems({
      anchors: [{ recordId: 'one', createdAt: 1, rect: rect(160, 120, 40, 20) }],
      mode: 'visual',
      surfaceRect,
      contentRight: 320,
    })

    expect(item!.buttonLeft).toBe(240)
    expect(item!.buttonLeft - (320 - surfaceRect.left)).toBe(20)
    expect(item!.connectorLeft).toBe(100)
    expect(item!.connectorTop).toBe(42)
    expect(item!.connectorHorizontalWidth).toBe(140)
    expect(item!.connectorVerticalLeft).toBe(240)
    expect(item!.connectorVerticalTop).toBe(42)
    expect(item!.connectorVerticalHeight).toBe(15)
  })

  it('rejects malformed and non-finite rectangles instead of guessing', () => {
    const items = computeTranslationHistoryRailItems({
      anchors: [
        { recordId: 'nan', createdAt: 1, rect: rect(Number.NaN, 120, 0, 20) },
        { recordId: 'negative', createdAt: 2, rect: rect(160, 120, -1, 20) },
      ],
      mode: 'source',
      surfaceRect,
      contentRight: 360,
    })

    expect(items).toEqual([])
  })
})
