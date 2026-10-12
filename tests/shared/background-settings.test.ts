import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_IMAGE_ALIGNMENTS,
  BACKGROUND_MASK_TYPES,
  copyBackgroundSettings,
  DEFAULT_BACKGROUND_SETTINGS,
  normalizeBackgroundSettings,
  parseBackgroundSettings,
} from '../../src/shared/background-settings'

describe('background settings contract', () => {
  it('accepts exactly the persisted background fields and all supported mask ids', () => {
    const source = {
      imageRelativePath: 'backgrounds/aurora.webp',
      imageOpacityPercent: 42,
      imageAlignment: 'center',
      maskType: 'diagonal-bottom-right',
      maskOpacityPercent: 68,
      maskTransitionPercent: 25,
      maskStrengthPercent: 73,
    }

    expect(parseBackgroundSettings(source)).toEqual(source)
    expect(BACKGROUND_IMAGE_ALIGNMENTS).toEqual([
      'right-bottom',
      'left-top',
      'right-top',
      'left-bottom',
      'center',
    ])
    expect(BACKGROUND_MASK_TYPES).toEqual([
      'diagonal-bottom-right',
      'none',
      'circle',
      'diagonal-top-left',
      'diagonal-top-right',
      'diagonal-bottom-left',
      'column-horizontal',
      'column-vertical',
    ])
    expect(parseBackgroundSettings({ ...source, unexpected: true })).toBeUndefined()
    expect(parseBackgroundSettings({ imageRelativePath: null })).toBeUndefined()
    expect(parseBackgroundSettings({ ...source, maskType: 'stripe' })).toBeUndefined()
  })

  it('only accepts whole percentage values from zero through one hundred', () => {
    const source = {
      imageRelativePath: null,
      imageOpacityPercent: 0,
      imageAlignment: 'right-bottom',
      maskType: 'diagonal-bottom-right',
      maskOpacityPercent: 100,
      maskTransitionPercent: 50,
      maskStrengthPercent: 0,
    }

    expect(parseBackgroundSettings(source)).toEqual(source)
    expect(parseBackgroundSettings({ ...source, imageOpacityPercent: -1 })).toBeUndefined()
    expect(parseBackgroundSettings({ ...source, maskOpacityPercent: 101 })).toBeUndefined()
    expect(parseBackgroundSettings({ ...source, maskTransitionPercent: 50.5 })).toBeUndefined()
    expect(parseBackgroundSettings({ ...source, maskStrengthPercent: 101 })).toBeUndefined()
    expect(parseBackgroundSettings({ ...source, imageAlignment: 'stretch' })).toBeUndefined()
  })

  it('supplies the requested independent defaults for malformed settings', () => {
    const normalized = normalizeBackgroundSettings({})
    normalized.imageOpacityPercent = 64

    expect(DEFAULT_BACKGROUND_SETTINGS).toEqual({
      imageRelativePath: null,
      imageOpacityPercent: 50,
      imageAlignment: 'right-bottom',
      maskType: 'diagonal-top-left',
      maskOpacityPercent: 0,
      maskTransitionPercent: 30,
      maskStrengthPercent: 80,
    })
    expect(normalizeBackgroundSettings(undefined)).toEqual(DEFAULT_BACKGROUND_SETTINGS)
    expect(DEFAULT_BACKGROUND_SETTINGS.imageOpacityPercent).toBe(50)
  })

  it('migrates the previous five-field settings without losing the selected image', () => {
    expect(parseBackgroundSettings({
      imageRelativePath: 'backgrounds/legacy.webp',
      imageOpacityPercent: 35,
      maskType: 'diamond',
      maskOpacityPercent: 60,
      maskTransitionPercent: 25,
    })).toEqual({
      imageRelativePath: 'backgrounds/legacy.webp',
      imageOpacityPercent: 35,
      imageAlignment: 'right-bottom',
      maskType: 'diagonal-bottom-right',
      maskOpacityPercent: 60,
      maskTransitionPercent: 25,
      maskStrengthPercent: 50,
    })
  })

  it('copies settings without sharing mutable state', () => {
    const source = {
      imageRelativePath: 'backgrounds/mist.png',
      imageOpacityPercent: 20,
      imageAlignment: 'left-bottom',
      maskType: 'circle',
      maskOpacityPercent: 75,
      maskTransitionPercent: 90,
      maskStrengthPercent: 45,
    } as const
    const copy = copyBackgroundSettings(source)
    copy.maskOpacityPercent = 1

    expect(source.maskOpacityPercent).toBe(75)
    expect(copy).not.toBe(source)
    expect(copy).toEqual({
      imageRelativePath: 'backgrounds/mist.png',
      imageOpacityPercent: 20,
      imageAlignment: 'left-bottom',
      maskType: 'circle',
      maskOpacityPercent: 1,
      maskTransitionPercent: 90,
      maskStrengthPercent: 45,
    })
  })
})
