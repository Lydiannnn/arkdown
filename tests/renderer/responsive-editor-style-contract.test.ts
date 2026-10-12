import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const styles = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/app/styles.css'),
  'utf8',
)

it('uses independent logical-pixel constraints without the legacy Milkdown padding', () => {
  expect(styles).toContain('var(--editor-maximum-width, 1200px)')
  expect(styles).toContain('var(--editor-minimum-margin, 30px)')
  expect(styles).toContain('padding: 90px 0 160px')
  expect(styles).not.toContain('--editor-content-scale')
  expect(styles).not.toContain('padding: 30px 30px 100px')
})

it('contains tables and media inside the responsive body', () => {
  expect(styles).toContain('overflow-wrap: anywhere')
  expect(styles).toContain('.visual-editor .ProseMirror img { max-width: 100%; height: auto; }')
  expect(styles).toMatch(/\.visual-editor \.ProseMirror \.tableWrapper \{[^}]*width: 100%;[^}]*overflow-x: hidden;/s)
})
