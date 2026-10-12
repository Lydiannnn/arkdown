import { describe, expect, it } from 'vitest'
import { parseStickyNoteMicaAppearance } from '../../src/shared/sticky-note-mica-appearance'

const value = { tintColor: '#aBcDeF', tintOpacity: 0.42, luminosityOpacity: 0.85, saturation: 0.8 }

describe('native Mica appearance input', () => {
  it('normalizes hex color and returns an independent validated object', () => {
    const parsed = parseStickyNoteMicaAppearance(value)
    expect(parsed).toEqual({ tintColor: '#ABCDEF', tintOpacity: 0.42, luminosityOpacity: 0.85, saturation: 0.8 })
    expect(parsed).not.toBe(value)
  })

  it.each([
    null, [], {}, { ...value, extra: 1 }, { ...value, tintColor: '#abc' },
    { ...value, tintColor: '#ffffff80' }, { ...value, tintColor: 'white' },
    { ...value, tintOpacity: -0.01 }, { ...value, tintOpacity: 1.01 },
    { ...value, luminosityOpacity: Number.NaN }, { ...value, luminosityOpacity: Infinity },
    { ...value, luminosityOpacity: -1 }, { ...value, luminosityOpacity: 1.01 },
    { ...value, saturation: -0.01 }, { ...value, saturation: 1.01 },
    { ...value, saturation: '1' }, { ...value, [Symbol('hidden')]: true },
  ])('rejects unsafe or ambiguous parameters: %s', input => {
    expect(parseStickyNoteMicaAppearance(input)).toBeUndefined()
  })

  it('allows fully raw and endpoint settings without coercing them', () => {
    expect(parseStickyNoteMicaAppearance({ ...value, tintOpacity: 0, luminosityOpacity: 0, saturation: 0 }))
      .toEqual({ tintColor: '#ABCDEF', tintOpacity: 0, luminosityOpacity: 0, saturation: 0 })
    expect(parseStickyNoteMicaAppearance({ ...value, tintOpacity: 1, luminosityOpacity: 1, saturation: 1 }))
      .toEqual({ tintColor: '#ABCDEF', tintOpacity: 1, luminosityOpacity: 1, saturation: 1 })
  })
})
