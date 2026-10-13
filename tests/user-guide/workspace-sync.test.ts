import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'

it('publishes the same ten source chapters, with browser links and no removed content', async () => {
  // The source loader, rather than a hand-maintained second copy, feeds HTML and search.
  const { chapters } = await import('../../guide-web/content.mjs')
  const names = (await readdir('initial-workspace')).filter(name => name.endsWith('.md')).sort()
  expect(names).toHaveLength(10)
  expect(chapters.map(chapter => chapter.sourceFile)).toEqual(names)
  for (const chapter of chapters) {
    expect(chapter.markdown).toBe(await readFile(path.join('initial-workspace', chapter.sourceFile), 'utf8'))
    const published = await readFile(path.join('guide-web', `${chapter.id}.html`), 'utf8')
    expect(published).toContain(chapter.introHtml)
    for (const section of chapter.sections) expect(published).toContain(section.body)
    const html = chapter.sections.map(section => section.body).join('')
    expect(html).not.toContain('arkdown:')
    expect(html).not.toContain('.md"')
    expect(html).not.toContain('把夏天骑进海风里')
    expect(html).not.toContain('发现新版本后')
  }
  expect(chapters[0].sections.map(section => section.body).join('')).toContain('href="ai.html"')
})
