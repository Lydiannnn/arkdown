import { describe, expect, it } from 'vitest'
import { computePreferencesTocOffset } from '../../src/renderer/settings/preferences-toc-offset'

describe('computePreferencesTocOffset', () => {
  it.each([
    { availableLeftPx: 100, expected: 30 },
    { availableLeftPx: 46, expected: 30 },
    { availableLeftPx: 16, expected: 0 },
    { availableLeftPx: -10, expected: 0 },
    { availableLeftPx: Number.NaN, expected: 0 },
  ])('returns $expected for $availableLeftPx CSS px of available left space', ({
    availableLeftPx,
    expected,
  }) => {
    expect(computePreferencesTocOffset({ availableLeftPx })).toBe(expected)
  })

  it('respects safe custom displacement and inset values', () => {
    expect(computePreferencesTocOffset({
      availableLeftPx: 46,
      desiredOffsetPx: 24,
      minimumSafeInsetPx: 20,
    })).toBe(24)
  })
})
