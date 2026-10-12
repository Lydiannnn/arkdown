import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  stickyNoteIndexPath,
  stickyNoteBackgroundPath,
  stickyNotePaths,
  stickyNoteRelativePaths,
  stickyNotesRoot,
} from '../../src/main/sticky-notes/sticky-note-paths'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'
import type { StickyNoteRecord } from '../../src/shared/sticky-notes'

const ROOT = path.resolve('C:/portable-data')
const NOTE_ID = '9b6d8d86-7a68-4cab-951c-6a25e09dd14b'

function note(overrides: Partial<StickyNoteRecord> = {}): Pick<
  StickyNoteRecord,
  'id' | 'name' | 'status' | 'background'
> {
  return {
    id: NOTE_ID,
    name: '开发记录',
    status: 'active',
    background: DEFAULT_BACKGROUND_SETTINGS,
    ...overrides,
  }
}

describe('sticky note paths', () => {
  it('places the index under the portable notes root', () => {
    expect(stickyNotesRoot(ROOT)).toBe(path.join(ROOT, 'notes'))
    expect(stickyNoteIndexPath(ROOT)).toBe(path.join(ROOT, 'notes', 'index.json'))
  })

  it('builds active absolute and registry-relative paths', () => {
    expect(stickyNotePaths(ROOT, note())).toEqual({
      directory: path.join(ROOT, 'notes', 'active', NOTE_ID),
      markdown: path.join(ROOT, 'notes', 'active', NOTE_ID, '开发记录.md'),
      resources: path.join(ROOT, 'notes', 'active', NOTE_ID, 'resources'),
    })
    expect(stickyNoteRelativePaths(note())).toEqual({
      directory: `active/${NOTE_ID}`,
      markdown: `active/${NOTE_ID}/开发记录.md`,
      resources: `active/${NOTE_ID}/resources`,
    })
  })

  it('uses the archive directory for archived notes', () => {
    expect(stickyNoteRelativePaths(note({ status: 'archived' }))).toEqual({
      directory: `archive/${NOTE_ID}`,
      markdown: `archive/${NOTE_ID}/开发记录.md`,
      resources: `archive/${NOTE_ID}/resources`,
    })
  })

  it('resolves a background only from the owning note resources directory', () => {
    expect(stickyNoteBackgroundPath(ROOT, note({
      background: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        imageRelativePath: 'resources/wallpaper.webp',
      },
    }))).toBe(path.join(ROOT, 'notes', 'active', NOTE_ID, 'resources', 'wallpaper.webp'))
    expect(stickyNoteBackgroundPath(ROOT, note())).toBeNull()
  })

  it.each(['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'svg'])(
    'accepts a supported static background extension: %s',
    (extension) => {
      expect(stickyNoteBackgroundPath(ROOT, note({
        background: {
          ...DEFAULT_BACKGROUND_SETTINGS,
          imageRelativePath: `resources/wallpaper.${extension}`,
        },
      }))).toBe(path.join(
        ROOT, 'notes', 'active', NOTE_ID, 'resources', `wallpaper.${extension}`,
      ))
    },
  )

  it.each([
    'wallpaper.webp',
    'resources/../wallpaper.webp',
    'resources/nested/wallpaper.webp',
    'resources/../../outside.webp',
    'resources/wallpaper.gif',
  ])('rejects unsafe background resource path %s', (imageRelativePath) => {
    expect(() => stickyNoteBackgroundPath(ROOT, note({
      background: { ...DEFAULT_BACKGROUND_SETTINGS, imageRelativePath },
    }))).toThrow()
  })

  it.each([
    ['non-absolute root', 'portable-data', note()],
    ['invalid uuid', ROOT, note({ id: '../escape' })],
    ['invalid status', ROOT, note({ status: 'deleted' as 'active' })],
    ['traversing name', ROOT, note({ name: '../escape' })],
    ['reserved name', ROOT, note({ name: 'CON' })],
  ] as const)('rejects %s', (_label, root, target) => {
    expect(() => stickyNotePaths(root, target)).toThrow()
  })

  it('keeps every generated absolute path inside the note root', () => {
    const generated = stickyNotePaths(ROOT, note({ name: '合法名称' }))
    const notesRoot = `${path.resolve(stickyNotesRoot(ROOT))}${path.sep}`
    expect(Object.values(generated).every((candidate) => (
      path.resolve(candidate).startsWith(notesRoot)
    ))).toBe(true)
  })
})
