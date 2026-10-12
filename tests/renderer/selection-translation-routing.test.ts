import { describe, expect, it } from 'vitest'
import {
  chooseTranslationPresentation,
  countVisibleCharacters,
} from '../../src/shared/selection-translation'

describe('selection translation presentation routing', () => {
  it('uses a popover for a 99-character visual selection without a real newline', () => {
    expect(chooseTranslationPresentation({
      content: { markdown: 'a'.repeat(99), plainText: 'a'.repeat(99) },
      mode: 'visual',
    })).toBe('popover')
  })

  it('uses a sidebar at the 100-visible-character visual threshold', () => {
    expect(chooseTranslationPresentation({
      content: { markdown: 'a'.repeat(100), plainText: 'a'.repeat(100) },
      mode: 'visual',
    })).toBe('sidebar')
  })

  it.each(['first\nsecond', 'first\rsecond'])('uses a sidebar for a visual selection with a real newline: %j', (content) => {
    expect(chooseTranslationPresentation({
      content: { markdown: content, plainText: content },
      mode: 'visual',
    })).toBe('sidebar')
  })

  it('uses a sidebar for every source selection', () => {
    expect(chooseTranslationPresentation({
      content: { markdown: 'short', plainText: 'short' },
      mode: 'source',
    })).toBe('sidebar')
  })

  it('counts a surrogate pair as one visible character', () => {
    expect(countVisibleCharacters('A😀')).toBe(2)
  })
})
