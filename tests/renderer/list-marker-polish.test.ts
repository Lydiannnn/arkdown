import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.join(process.cwd(), 'src/renderer/app/styles.css'), 'utf8')

describe('unordered-list marker polish', () => {
  it('moves the first-level Arkdown bullet one pixel right and one pixel down', () => {
    expect(css).toMatch(/\.visual-editor \.ProseMirror > ul[\s\S]*?> \.label\.bullet\s*\{\s*transform:\s*translate\(4px,\s*0\)/u)
  })
})
