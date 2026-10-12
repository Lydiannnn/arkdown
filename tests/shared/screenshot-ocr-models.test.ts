import { describe, expect, it, vi } from 'vitest'
import { parseObservedOcrPreference, parseObservedScreenshotOcrState } from '../../src/shared/screenshot-ocr-models'

const state = (overrides: Record<string, unknown> = {}) => ({
  activeTier: 'small',
  bundledVersion: '6.0.0',
  mediumVersion: null,
  availableMediumVersion: null,
  status: 'bundled-small',
  progress: null,
  errorCode: null,
  ...overrides,
})

describe('screenshot OCR model schema', () => {
  it('copies finite OCR observations and rejects hostile or impossible revisions before reading getters', () => {
    const original = { revision: 7, preferredTier: 'medium' as const, tierRevision: 4 }
    expect(parseObservedOcrPreference(original)).toEqual(original)
    expect(parseObservedOcrPreference(original)).not.toBe(original)
    expect(parseObservedOcrPreference({ ...original, mediumSource: 'bundled' })).toEqual({ ...original, mediumSource: 'bundled' })
    const getter = vi.fn(() => 'medium')
    for (const value of [{ ...original, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...original, tierRevision: -1 },
      { ...original, tierRevision: 8 }, { ...original, preferredTier: 'large' }, { ...original, path: 'private' },
      { ...original, mediumSource: 'private-path' },
      Object.create(original), Object.defineProperty({ ...original }, 'preferredTier', { get: getter })]) {
      expect(parseObservedOcrPreference(value)).toBeUndefined()
    }
    expect(parseObservedScreenshotOcrState({ state: state(), observed: original })).toEqual({ state: state(), observed: original })
    expect(parseObservedScreenshotOcrState(Object.defineProperty({ observed: original }, 'state', {
      enumerable: true, get: getter,
    }))).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
  })
  it('accepts every exact public model status and reconstructs only public fields', async () => {
    const { parseScreenshotOcrModelState } = await import('../../src/shared/screenshot-ocr-models')
    const variants = [
      state(),
      state({ status: 'medium-absent', availableMediumVersion: '6.1.0' }),
      state({ status: 'medium-downloading', availableMediumVersion: '6.1.0', progress: { receivedBytes: 4, totalBytes: 10 } }),
      state({ activeTier: 'medium', status: 'medium-installed', mediumVersion: '6.1.0' }),
      state({ activeTier: 'medium', status: 'medium-update-available', mediumVersion: '6.1.0', availableMediumVersion: '6.2.0' }),
      state({ status: 'medium-failed', availableMediumVersion: '6.1.0', errorCode: 'OPERATION_FAILED' }),
      state({ activeTier: 'medium', status: 'medium-installed', mediumVersion: '6.1.0', mediumSource: 'bundled' }),
      state({ status: 'medium-disabled', mediumVersion: '6.1.0', mediumSource: 'bundled' }),
      state({ status: 'medium-disabled', mediumVersion: '6.1.0', mediumSource: 'bundled', availableMediumVersion: '6.2.0' }),
      state({ mediumSource: null }),
    ]

    for (const candidate of variants) {
      expect(parseScreenshotOcrModelState(candidate)).toEqual(candidate)
    }
  })

  it('rejects non-exact, unsafe, or inconsistent public model state', async () => {
    const { parseScreenshotOcrModelState } = await import('../../src/shared/screenshot-ocr-models')
    const inherited = Object.create(state())
    const invalid = [
      { ...state(), extra: 'C:\\private\\model' },
      { ...state(), bundledVersion: ' 6.0.0' },
      { ...state(), bundledVersion: 'v6.0.0' },
      { ...state(), availableMediumVersion: '6.1' },
      (() => { const { errorCode: _missing, ...missing } = state(); return missing })(),
      { ...state({ status: 'medium-absent', availableMediumVersion: '6.1.0' }), progress: { receivedBytes: -1, totalBytes: 10 } },
      { ...state({ status: 'medium-absent', availableMediumVersion: '6.1.0' }), progress: { receivedBytes: 11, totalBytes: 10 } },
      { ...state({ status: 'medium-absent', availableMediumVersion: '6.1.0' }), progress: { receivedBytes: 0.5, totalBytes: 10 } },
      { ...state({ status: 'medium-downloading', availableMediumVersion: '6.1.0', progress: { receivedBytes: 1, totalBytes: 10 } }), progress: { receivedBytes: 1, totalBytes: 2_147_483_649 } },
      { ...state({ status: 'medium-downloading', availableMediumVersion: '6.1.0', progress: { receivedBytes: 1, totalBytes: 10 } }), progress: null },
      state({ status: 'medium-installed', mediumVersion: null }),
      state({ status: 'medium-update-available', mediumVersion: '6.1.0', availableMediumVersion: '6.1.0' }),
      state({ status: 'medium-failed', errorCode: 'UNKNOWN_ERROR' }),
      state({ status: 'bundled-small', errorCode: 'OPERATION_FAILED' }),
      state({ status: 'medium-disabled', mediumVersion: '6.1.0', mediumSource: 'managed' }),
      state({ status: 'medium-disabled', mediumVersion: '6.1.0', mediumSource: 'bundled', activeTier: 'medium' }),
      state({ status: 'medium-disabled', mediumSource: 'bundled' }),
      state({ status: 'medium-disabled', mediumVersion: '6.1.0', mediumSource: 'bundled', errorCode: 'OPERATION_FAILED' }),
      state({ status: 'medium-disabled', mediumVersion: '6.1.0' }),
      state({ mediumSource: 'private-path' }),
      state({ mediumSource: 'bundled' }),
      inherited,
    ]

    for (const candidate of invalid) expect(parseScreenshotOcrModelState(candidate)).toBeUndefined()
  })

  it('normalizes only an exact persisted preferred tier and defaults every other value', async () => {
    const {
      DEFAULT_SCREENSHOT_OCR_PREFERENCES,
      normalizeScreenshotOcrPreferences,
      parseScreenshotOcrPreferences,
    } = await import('../../src/shared/screenshot-ocr-models')

    expect(DEFAULT_SCREENSHOT_OCR_PREFERENCES).toEqual({ preferredTier: 'small' })
    expect(parseScreenshotOcrPreferences({ preferredTier: 'medium' })).toEqual({ preferredTier: 'medium' })
    expect(parseScreenshotOcrPreferences({ preferredTier: 'medium', progress: 1 })).toBeUndefined()
    expect(parseScreenshotOcrPreferences(Object.create({ preferredTier: 'medium' }))).toBeUndefined()
    expect(normalizeScreenshotOcrPreferences(undefined)).toEqual({ preferredTier: 'small' })
    expect(normalizeScreenshotOcrPreferences({ preferredTier: 'invalid' })).toEqual({ preferredTier: 'small' })
  })
})
