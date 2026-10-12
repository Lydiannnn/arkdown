import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildWindowOptions } from '../../src/main/create-main-window'

const shellCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/app/styles.css'),
  'utf8',
)

describe('Mica shell regressions', () => {
  it('computes the tint where the adjustable opacity variable is in scope', () => {
    expect(shellCss).not.toMatch(/:root\s*\{[^}]*--mica-shell-tint:/)
    expect(shellCss).toMatch(
      /\.app-shell\s*\{[^}]*--mica-shell-tint:\s*rgb\(255 255 255\s*\/\s*0%\)/,
    )
    expect(shellCss).not.toContain('--mica-shell-opacity')
  })

  it('uses a normal DWM-backed Mica window for native corners and shadow', () => {
    const options = buildWindowOptions('C:\\app\\preload.js')

    expect(options).toMatchObject({
      backgroundMaterial: 'mica',
      roundedCorners: true,
      hasShadow: true,
      thickFrame: true,
      titleBarStyle: 'hidden',
    })
    expect(options.backgroundColor).toBeUndefined()
    expect(options.transparent).not.toBe(true)
  })
})
