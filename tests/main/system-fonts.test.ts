import { describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_SYSTEM_FONTS,
  listSystemFontFamilies,
  parseWindowsFontRegistryOutput,
} from '../../src/main/settings/system-fonts'

describe('Windows system font discovery', () => {
  it('normalizes registry display names, removes suffixes, and de-duplicates families', () => {
    expect(parseWindowsFontRegistryOutput(
      '\uFEFF["Arial (TrueType)","SimHei (TrueType)","Arial (TrueType)","  Georgia  "]',
    )).toEqual(['Arial', 'Georgia', 'SimHei'])
  })

  it('includes the supported defaults and discovered local families', async () => {
    const run = vi.fn(async () => ({
      stdout: '["Microsoft YaHei & Microsoft YaHei UI (TrueType)","Georgia (TrueType)"]',
    }))

    await expect(listSystemFontFamilies(run)).resolves.toEqual(
      expect.arrayContaining([...FALLBACK_SYSTEM_FONTS, 'Georgia', 'Microsoft YaHei & Microsoft YaHei UI']),
    )
    expect(run).toHaveBeenCalledWith(
      'powershell.exe',
      expect.any(Array),
      expect.objectContaining({ encoding: 'utf8', windowsHide: true }),
    )
  })

  it('falls back safely when registry discovery fails', async () => {
    expect(FALLBACK_SYSTEM_FONTS).toEqual(expect.arrayContaining(['Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI']))
    await expect(listSystemFontFamilies(async () => {
      throw new Error('registry unavailable')
    })).resolves.toEqual(FALLBACK_SYSTEM_FONTS)
  })
})
