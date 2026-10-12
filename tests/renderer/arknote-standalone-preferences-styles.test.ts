import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const pageCss = readFileSync(
  resolve(process.cwd(), 'src/renderer/settings/search-preferences.css'),
  'utf8',
)
const standaloneCss = readFileSync(
  resolve(process.cwd(), 'src/renderer/settings/arknote-standalone-preferences.css'),
  'utf8',
)

describe('standalone Arknote settings styles', () => {
  it('keeps a scoped stable scrollbar', () => {
    expect(standaloneCss).toMatch(/\.arknote-settings-page\s*>\s*\.preferences-page-content\s*\{[^}]*scrollbar-gutter:\s*stable/su)
    expect(standaloneCss).toMatch(/\.arknote-settings-page\s*>\s*\.preferences-page-content::-webkit-scrollbar\s*\{[^}]*width:\s*12px/su)
    expect(standaloneCss).toMatch(/\.arknote-settings-page\s*>\s*\.preferences-page-content::-webkit-scrollbar-thumb\s*\{[^}]*10%/su)
    expect(standaloneCss).toMatch(/\.arknote-settings-page\s*>\s*\.preferences-page-content::-webkit-scrollbar-thumb:hover\s*\{[^}]*20%/su)
    expect(standaloneCss).toMatch(/\.arknote-settings-page\s*>\s*\.preferences-page-content::-webkit-scrollbar-button\s*\{[^}]*display:\s*none/su)
  })

  it('preserves the existing base range control geometry', () => {
    expect(pageCss).toMatch(/\.preferences-range-input\s*\{[^}]*height:\s*10px[^}]*margin:\s*0/u)
    expect(pageCss).toMatch(/\.preferences-range-input::-webkit-slider-runnable-track\s*\{[^}]*height:\s*4px/u)
    expect(pageCss).toMatch(/\.preferences-range-input::-webkit-slider-thumb\s*\{[^}]*width:\s*14px[^}]*height:\s*14px/u)
  })
})
