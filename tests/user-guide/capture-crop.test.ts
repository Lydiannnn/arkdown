import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('portable-folder screenshot crop', () => {
  it('removes the Explorer navigation pane that may contain personal shortcuts', async () => {
    const script = await readFile('scripts/capture-portable-folder.ps1', 'utf8')

    expect(script).toContain('$cropLeft = 360')
    expect(script).toContain('$croppedBitmap')
  })
})
