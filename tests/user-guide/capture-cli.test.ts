import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('user-guide screenshot capture command', () => {
  it('captures both application states and the portable folder', async () => {
    const script = await readFile('scripts/capture-user-guide-screenshots.ts', 'utf8')

    expect(script).toContain('capture-app-windows.ps1')
    expect(script).toContain('capture-portable-folder.ps1')
    expect(script).toContain('capture-sticky-note-box.ts')
  })
})
