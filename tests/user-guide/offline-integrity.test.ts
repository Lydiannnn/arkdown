import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildUserGuide } from '../../scripts/build-user-guide'

const LOCAL_REFERENCE = /(?:href|src|data-image-src)="([^"]+)"/g

describe('offline user-guide integrity', () => {
  it('resolves every page, stylesheet, script, image, and local navigation link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arkdown-guide-offline-'))
    await buildUserGuide(root)
    const guideRoot = join(root, '使用说明书')
    const pages = (await readdir(guideRoot)).filter((name) => name.endsWith('.html'))

    expect(pages).toHaveLength(10)
    for (const page of pages) {
      const pagePath = join(guideRoot, page)
      const html = await readFile(pagePath, 'utf8')
      const references = [...html.matchAll(LOCAL_REFERENCE)].map((match) => match[1]!)

      expect(references.length).toBeGreaterThan(5)
      for (const reference of references) {
        expect(reference).not.toMatch(/^(?:https?:|file:|\/\/)/i)
        if (reference.startsWith('#') || reference.startsWith('data:')) continue

        const localPath = reference.split(/[?#]/, 1)[0]!
        const target = resolve(dirname(pagePath), localPath)
        await expect(stat(target), `${page} -> ${reference}`)
          .resolves.toMatchObject({ isFile: expect.any(Function) })
      }
    }
  })
})
