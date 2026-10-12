import { describe, expect, it } from 'vitest'
import { GUIDE_PAGES } from '../../user-guide/content'
import { renderGuidePage } from '../../user-guide/template'

describe('user-guide screenshot paths', () => {
  it('resolves root-page screenshots under the guide asset folder', () => {
    const home = renderGuidePage(GUIDE_PAGES[0]!, GUIDE_PAGES)

    expect(home).toContain('data-image-src="使用说明书/assets/images/app-start.png"')
    expect(home).toContain('src="使用说明书/assets/images/app-workspace.png"')
    expect(home).not.toContain('{{assetBase}}')
  })

  it('resolves child-page screenshots relative to the child page', () => {
    const workspace = renderGuidePage(GUIDE_PAGES[1]!, GUIDE_PAGES)

    expect(workspace).toContain('data-image-src="assets/images/file-tree.png"')
    expect(workspace).not.toContain('{{assetBase}}')
  })
})
