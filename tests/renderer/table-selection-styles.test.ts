import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const css = readFileSync(
  path.join(process.cwd(), 'src/renderer/app/styles.css'),
  'utf8',
).replace(/\r\n/g, '\n')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's'))
  if (!match) throw new Error(`Missing CSS rule for ${selector}`)
  return match[1].replace(/\s+/g, ' ')
}

describe('table cell selection styling', () => {
  test('uses a stable ten-percent purple overlay', () => {
    const selectedCell = rule(
      '.visual-editor .milkdown .ProseMirror .selectedCell::after',
    )

    expect(selectedCell).toContain(
      'background: rgb(var(--theme-color-rgb, 198 40 40) / 10%)',
    )
    expect(selectedCell).toContain('opacity: 1')
  })
})
