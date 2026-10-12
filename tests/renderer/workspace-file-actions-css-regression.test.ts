import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  path.join(process.cwd(), 'src/renderer/workspace/workspace-file-actions.css'),
  'utf8',
)

describe('workspace file action CSS syntax regressions', () => {
  it('closes the document preview line rule before the load-more rule', () => {
    const previewRule = css.lastIndexOf('.document-preview > span {')
    const loadMoreRule = css.indexOf('.document-load-more {')
    const previewClose = css.indexOf('}', previewRule)

    expect(previewRule).toBeGreaterThanOrEqual(0)
    expect(loadMoreRule).toBeGreaterThan(previewRule)
    expect(previewClose).toBeGreaterThan(previewRule)
    expect(previewClose).toBeLessThan(loadMoreRule)
  })
})
