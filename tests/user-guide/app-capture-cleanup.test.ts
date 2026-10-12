import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('application screenshot cleanup', () => {
  it('removes the unique parent of the sanitized workspace', async () => {
    const script = await readFile('scripts/capture-app-windows.ps1', 'utf8')

    expect(script).toContain('Remove-Item -LiteralPath $workspaceParent -Recurse')
    expect(script).not.toContain("Join-Path $env:TEMP 'Arkdown-示例-'")
  })
})
