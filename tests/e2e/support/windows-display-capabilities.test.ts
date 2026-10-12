import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chooseScreenshotSourceDisplay,
  createScreenshotEnvironmentEvidence,
  parseWindowsDisplayCapabilities,
} from './windows-display-capabilities'

describe('Windows screenshot environment evidence parser', () => {
  it('accepts sanitized finite display evidence and derives negative-coordinate availability', () => {
    expect(parseWindowsDisplayCapabilities({
      primaryScaleFactor: 1.5,
      displays: [
        { id: 'display-1', bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1400 }, scaleFactor: 1.5 },
        { id: 'display-2', bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 },
      ],
      hdr: 'unavailable',
      protectedContent: 'unsupported',
    })).toEqual({
      primaryRealScaleFactor: 1.5,
      displays: [
        { id: 'display-1', bounds: { x: 0, y: 0, width: 2560, height: 1440 }, workArea: { x: 0, y: 0, width: 2560, height: 1400 }, scaleFactor: 1.5 },
        { id: 'display-2', bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 },
      ],
      negativeCoordinateDisplay: 'exercised',
      hdrAdvancedColor: 'unavailable',
      protectedContentAffinity: 'unsupported',
    })
  })

  it('rejects probe errors, duplicate IDs, non-finite geometry, and unexpected keys', () => {
    expect(() => parseWindowsDisplayCapabilities({
      primaryScaleFactor: 1.5,
      displays: [],
      hdr: 'probe-error',
      protectedContent: 'unsupported',
    })).toThrow('probe')
    expect(() => parseWindowsDisplayCapabilities({
      primaryScaleFactor: 1.5,
      displays: [
        { id: 'same', bounds: { x: 0, y: 0, width: 10, height: 10 }, workArea: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1 },
        { id: 'same', bounds: { x: Number.NaN, y: 0, width: 10, height: 10 }, workArea: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1 },
      ],
      hdr: 'unavailable',
      protectedContent: 'unsupported',
      extra: true,
    })).toThrow()
  })

  it('queries active-path Advanced Color and round-trips affinity on a test-owned window', async () => {
    const script = await readFile(path.resolve(
      'tests/e2e/fixtures/windows-display-capabilities.ps1',
    ), 'utf8')
    expect(script).toContain('QueryDisplayConfig')
    expect(script).toContain('DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO')
    expect(script).toContain('SetWindowDisplayAffinity')
    expect(script).toContain('0x00000011')
    expect(script).not.toContain("hdr = 'unavailable'")
  })

  it('targets a differently scaled secondary display for direct-window coverage when authoritative', () => {
    const primary = {
      id: 'primary',
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 0, width: 2560, height: 1400 },
      scaleFactor: 1.5,
    }
    const secondary = {
      id: 'secondary',
      bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
      workArea: { x: 2560, y: 0, width: 1920, height: 1040 },
      scaleFactor: 1,
    }
    expect(chooseScreenshotSourceDisplay([primary, secondary], 'differently-scaled-secondary'))
      .toEqual({ display: secondary, evidence: 'differently-scaled-secondary-exercised' })
    expect(chooseScreenshotSourceDisplay([primary], 'differently-scaled-secondary'))
      .toEqual({ display: primary, evidence: 'authoritative-unavailable-primary-fallback' })
  })

  it('records a registered shortcut separately when repeated captures use the production menu', () => {
    const capabilities = parseWindowsDisplayCapabilities({
      primaryScaleFactor: 1.5,
      displays: [{
        id: 'primary',
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 0, width: 2560, height: 1400 },
        scaleFactor: 1.5,
      }],
      hdr: 'unavailable',
      protectedContent: 'unsupported',
    })
    expect(createScreenshotEnvironmentEvidence(capabilities, {
      shortcut: 'registered-menu-trigger',
      ocr: { language: 'eng', status: 'completed', blockCount: 2, wordCount: 4 },
    }).shortcut).toBe('registered-menu-trigger')
  })
})
