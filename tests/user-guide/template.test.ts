import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUIDE_PAGES } from '../../user-guide/content'
import { buildUserGuide } from '../../scripts/build-user-guide'
import { buildSearchIndex, renderGuidePage } from '../../user-guide/template'

describe('user-guide template', () => {
  it('renders the root entry with root-relative guide assets and navigation', () => {
    const home = renderGuidePage(GUIDE_PAGES[0]!, GUIDE_PAGES)

    expect(home).toContain('<html lang="zh-CN">')
    expect(home).toContain('<title>Arkdown 使用说明书')
    expect(home).toContain('href="使用说明书/assets/css/manual.css"')
    expect(home).toContain('src="使用说明书/assets/js/search-index.js"')
    expect(home).toContain('href="使用说明书/workspace.html"')
    expect(home).toContain('data-guide-base="使用说明书/"')
    expect(home).toContain('aria-label="章节目录"')
    expect(home).toContain('aria-label="本页目录"')
    expect(home).not.toMatch(/(?:href|src)="https?:\/\//)
  })

  it('renders child pages with paths that remain valid under file protocol', () => {
    const child = renderGuidePage(GUIDE_PAGES[1]!, GUIDE_PAGES)

    expect(child).toContain('href="../使用说明书.html"')
    expect(child).toContain('href="assets/css/manual.css"')
    expect(child).toContain('src="assets/js/manual.js"')
    expect(child).toContain('data-guide-base="./"')
    expect(child).toContain('href="editing.html"')
    expect(child).not.toMatch(/(?:href|src)="https?:\/\//)
  })

  it('builds a stable search record for every section', () => {
    const index = buildSearchIndex(GUIDE_PAGES)
    const sections = GUIDE_PAGES.flatMap((page) => page.sections)

    expect(index).toHaveLength(sections.length)
    expect(index[0]).toEqual(expect.objectContaining({
      pageTitle: 'Arkdown 使用说明书',
      sectionTitle: '认识 Arkdown',
      path: '../使用说明书.html',
      hash: '#home-about',
    }))
    expect(index.find((record) => record.hash === '#saving-conflict')).toEqual(
      expect.objectContaining({
        pageTitle: '保存与状态',
        keywords: expect.arrayContaining(['保存冲突', '外部修改']),
      }),
    )
  })

  it('rejects duplicate section ids before rendering', () => {
    const duplicate = structuredClone(GUIDE_PAGES)
    duplicate[1]!.sections[0]!.id = duplicate[0]!.sections[0]!.id
    expect(() => renderGuidePage(duplicate[0]!, duplicate)).toThrow(/duplicate section id/i)
  })

  it('writes the approved twelve-page offline site behind the public guide entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arkdown-guide-build-'))
    await buildUserGuide(root)

    const entry = await readFile(join(root, '使用说明书.html'), 'utf8')
    expect(entry).toContain('使用说明书/index.html')

    const guideRoot = join(root, '使用说明书')
    const pageNames = (await readdir(guideRoot)).filter((name) => name.endsWith('.html')).sort()
    expect(pageNames).toEqual([
      'ai.html',
      'help.html',
      'index.html',
      'media.html',
      'notes.html',
      'saving.html',
      'settings.html',
      'shortcuts.html',
      'start.html',
      'translation.html',
      'workspace.html',
      'writing.html',
    ])
    for (const name of pageNames) {
      const html = await readFile(join(guideRoot, name), 'utf8')
      expect(html).toContain('<!doctype html>')
      expect(html).not.toMatch(/(?:href|src)="https?:\/\//)
    }

    await expect(stat(join(guideRoot, 'guide.css')))
      .resolves.toMatchObject({ isFile: expect.any(Function) })
    await expect(stat(join(guideRoot, 'guide.js')))
      .resolves.toMatchObject({ isFile: expect.any(Function) })
    for (const image of ['background-settings.png', 'editor.png', 'preferences.png']) {
      await expect(stat(join(guideRoot, 'assets', image)))
        .resolves.toMatchObject({ isFile: expect.any(Function) })
    }
    const search = await readFile(join(guideRoot, 'search-index.js'), 'utf8')
    expect(search).toMatch(/^window\.guideIndex=\[/)
  })
})
