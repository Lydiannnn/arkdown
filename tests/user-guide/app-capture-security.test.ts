import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('application screenshot privacy', () => {
  it('renders the Arkdown window directly instead of copying the desktop', async () => {
    const script = await readFile('scripts/capture-app-windows.ps1', 'utf8')

    expect(script).toContain('PrintWindow')
    expect(script).not.toContain('CopyFromScreen')
  })

  it('uses fixed client-area clicks instead of fragile tab traversal', async () => {
    const script = await readFile('scripts/capture-app-windows.ps1', 'utf8')

    expect(script).toContain('function Click-ClientPoint')
    expect(script).toContain('SetCursorPos')
    expect(script).not.toContain("SendWait('{TAB}{TAB}{ENTER}')")
  })

  it('builds the save-state illustration from three real app captures', async () => {
    const script = await readFile('scripts/capture-app-windows.ps1', 'utf8')

    for (const state of ['save-unsaved.png', 'save-saving.png', 'save-saved.png']) {
      expect(script).toContain(state)
    }
    expect(script).toContain('Save-SaveStateMontage')
  })
})
