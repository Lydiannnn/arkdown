import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StickyNoteImporter } from '../../src/main/sticky-notes/sticky-note-importer'
import { StickyNoteStore } from '../../src/main/sticky-notes/sticky-note-store'
import { stickyNotePaths } from '../../src/main/sticky-notes/sticky-note-paths'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-selection-note-'))
  roots.push(root)
  const store = new StickyNoteStore({
    root,
    now: () => new Date('2026-07-30T08:00:00.000Z'),
  })
  await store.initialize()
  return {
    root,
    store,
    importer: new StickyNoteImporter({
      root,
      store,
      now: () => new Date('2026-07-30T08:00:00.000Z'),
    }),
  }
}

describe('sticky note selection resource import', () => {
  it('copies an absolute image, rewrites Markdown and leaves the source unchanged', async () => {
    const { root, importer } = await fixture()
    const source = path.join(root, 'source-image.png')
    const bytes = Buffer.from('selection-image-bytes')
    await writeFile(source, bytes)
    const before = createHash('sha256').update(await readFile(source)).digest('hex')

    const result = await importer.importMarkdown({
      suggestedName: '',
      markdown: `![图片](${source})`,
      sourceDirectory: null,
    })

    expect(result.note.record.name).toBe('便签260730-贰')
    expect(result.note.markdown).toBe('![图片](resources/source-image.png)')
    const copied = path.join(
      stickyNotePaths(root, result.note.record).resources,
      'source-image.png',
    )
    expect(await readFile(copied)).toEqual(bytes)
    expect(createHash('sha256').update(await readFile(source)).digest('hex')).toBe(before)
  })

  it('keeps a readable original reference and warning when the image is missing', async () => {
    const { root, importer } = await fixture()
    const missing = path.join(root, 'missing.png')
    const markdown = `![缺失图片](${missing})`

    const result = await importer.importMarkdown({
      suggestedName: '',
      markdown,
      sourceDirectory: null,
    })

    expect(result.note.markdown).toBe(markdown)
    expect(result.warnings).toEqual([{ source: missing, reason: 'missing' }])
  })
})
