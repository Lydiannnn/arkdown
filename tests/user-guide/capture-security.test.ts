import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('portable-folder screenshot privacy', () => {
  it('renders the Explorer window itself instead of copying the shared desktop', async () => {
    const script = await readFile('scripts/capture-portable-folder.ps1', 'utf8')

    expect(script).toContain('PrintWindow')
    expect(script).not.toContain('CopyFromScreen')
  })

  it('closes only the Explorer window opened for the unique temporary path', async () => {
    const script = await readFile('scripts/capture-portable-folder.ps1', 'utf8')

    expect(script).toContain('$targetUri')
    expect(script).toContain('$openedWindow.Quit()')
    expect(script).not.toContain('EnumWindows')
  })
})
