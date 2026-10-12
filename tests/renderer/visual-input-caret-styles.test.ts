import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(resolve(process.cwd(), 'src/renderer/app/styles.css'), 'utf8')
const caretCss = readFileSync(
  resolve(process.cwd(), 'src/renderer/editor/visual-drop-caret.css'),
  'utf8',
)

describe('editor input caret styling', () => {
  it('uses a two-pixel caret in CodeMirror editors', () => {
    expect(appCss).toMatch(/\.source-editor\s+:is\(\.cm-cursor,\s*\.cm-dropCursor\)[\s\S]*border-left:\s*2px solid currentColor/)
    expect(appCss).toMatch(/\.milkdown-code-block\s+:is\(\.cm-cursor,\s*\.cm-dropCursor\)[\s\S]*border-left:\s*2px solid currentColor/)
    expect(appCss).toMatch(/margin-left:\s*-1px/)
    expect(appCss).toMatch(/box-sizing:\s*border-box/)
    expect(appCss).toMatch(/animation:\s*arkdown-visual-caret-blink\s+1\.06s\s+step-end\s+infinite/)
  })

  it('uses the same two-pixel visual style for ProseMirror input and drop carets', () => {
    expect(caretCss).toMatch(/\.arkdown-visual-input-caret\s*\{[\s\S]*width:\s*2px/)
    expect(caretCss).toMatch(/\.arkdown-visual-drop-caret[\s\S]*width:\s*2px/)
    expect(caretCss).toMatch(/animation:\s*arkdown-visual-caret-blink\s+1\.06s\s+step-end\s+infinite/)
  })
})
