import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StickyNoteImporter } from '../../src/main/sticky-notes/sticky-note-importer'
import { stickyNotePaths } from '../../src/main/sticky-notes/sticky-note-paths'
import { StickyNoteStore } from '../../src/main/sticky-notes/sticky-note-store'
import type { StickyNoteDocument } from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

let root = ''
let sourceDirectory = ''
let sequence = 0
const NOW = new Date('2026-07-31T03:00:00.000Z')

function nextId(): string {
  sequence += 1
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`
}

function createStore(): StickyNoteStore {
  return new StickyNoteStore({
    root,
    now: () => new Date(NOW),
    createId: nextId,
  })
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arkdown-sticky-import-'))
  sourceDirectory = path.join(root, 'incoming')
  sequence = 0
  await mkdir(sourceDirectory, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('StickyNoteImporter', () => {
  it('persists selected ordered starts, nested task structure and rich content unchanged when reopened', async () => {
    // Representative serialized selected hierarchy; the renderer suite verifies its capture/serialization.
    const markdown = '6. **middle**\n   - [x] nested\n   - [ ] ![remote](https://example.com/image.png)\n7. [last](https://example.com)'
    const store = createStore()
    const importer = new StickyNoteImporter({ root, store })
    const result = await importer.importMarkdown({ suggestedName: 'selected hierarchy', markdown, sourceDirectory: null })
    expect(result.warnings).toEqual([])
    expect(result.note.markdown).toBe(markdown)
    const reopened = await createStore().get(result.note.record.id)
    expect(reopened.markdown).toBe(markdown)
    expect(await readFile(stickyNotePaths(root, result.note.record).markdown, 'utf8')).toBe(markdown)
  })
  it.each([
    ['md', '# Markdown'],
    ['markdown', '# Long Markdown'],
    ['txt', '纯文本'],
  ])('imports a UTF-8 .%s document as an active note', async (extension, contents) => {
    const source = path.join(sourceDirectory, `导入文档.${extension}`)
    await writeFile(source, contents, 'utf8')
    const store = createStore()
    const importer = new StickyNoteImporter({ root, store })

    const result = await importer.importFile(source)

    expect(result.warnings).toEqual([])
    expect(result.note.record).toMatchObject({ name: '导入文档', status: 'active' })
    expect(result.note.markdown).toBe(contents)
  })

  it('copies local image resources and automatically resolves imported name conflicts', async () => {
    const image = path.join(sourceDirectory, 'images', 'photo.png')
    const source = path.join(sourceDirectory, '记录.md')
    await mkdir(path.dirname(image), { recursive: true })
    await writeFile(image, 'image-bytes')
    await writeFile(source, '![照片](images/photo.png)', 'utf8')
    const store = createStore()
    await store.initialize()
    await store.create({ name: '记录', markdown: 'existing' })
    const importer = new StickyNoteImporter({ root, store })

    const result = await importer.importFile(source)
    const paths = stickyNotePaths(root, result.note.record)

    expect(result.note.record.name).toBe('记录（2）')
    expect(result.note.markdown).toBe('![照片](resources/photo.png)')
    await expect(readFile(path.join(paths.resources, 'photo.png'), 'utf8'))
      .resolves.toBe('image-bytes')
  })

  it('rejects unsupported files before creating a note', async () => {
    const source = path.join(sourceDirectory, 'archive.pdf')
    await writeFile(source, 'pdf')
    const store = createStore()
    const importer = new StickyNoteImporter({ root, store })

    await expect(importer.importFile(source)).rejects.toThrow('仅支持导入 Markdown 或 TXT 文档')
    await expect(readdir(path.join(root, 'notes'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deletes a partially created note when resource processing fails', async () => {
    const note: StickyNoteDocument = {
      record: {
        id: '00000000-0000-4000-8000-000000000001',
        name: '失败导入',
        status: 'active',
        markdownRelativePath: 'active/00000000-0000-4000-8000-000000000001/失败导入.md',
        resourcesRelativePath: 'active/00000000-0000-4000-8000-000000000001/resources',
        style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
        background: { ...DEFAULT_BACKGROUND_SETTINGS },
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        archivedAt: null,
        released: false,
        pinned: false,
        windowBounds: null,
        lastOpenedAt: null,
        fontSizePx: 13,
        lineSpacingMode: 'compact',
      },
      markdown: '# 原文',
    }
    const store = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => note),
      writeMarkdown: vi.fn(),
      delete: vi.fn(async () => undefined),
    }
    const importer = new StickyNoteImporter({
      root,
      store,
      resourceRewriter: {
        rewrite: vi.fn(async () => {
          throw new Error('destination write failed')
        }),
      },
    })

    await expect(importer.importMarkdown({
      suggestedName: '失败导入',
      markdown: '# 原文',
      sourceDirectory,
    })).rejects.toThrow('destination write failed')
    expect(store.delete).toHaveBeenCalledWith(note.record.id)
    expect(store.writeMarkdown).not.toHaveBeenCalled()
  })

  it('does not modify the imported source document', async () => {
    const source = path.join(sourceDirectory, '原文.md')
    const bytes = Buffer.from('\uFEFF# 原文\r\n正文', 'utf8')
    await writeFile(source, bytes)
    const before = await stat(source)
    const store = createStore()
    const importer = new StickyNoteImporter({ root, store })

    await importer.importFile(source)

    expect(await readFile(source)).toEqual(bytes)
    expect((await stat(source)).mtimeMs).toBe(before.mtimeMs)
  })
})
