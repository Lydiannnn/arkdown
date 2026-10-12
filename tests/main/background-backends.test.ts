import { expect, it, vi } from 'vitest'
import {
  createMainBackgroundBackend,
  createStickyBackgroundBackend,
} from '../../src/main/backgrounds/background-backends'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'
const main = { kind: 'main' as const }
const sticky = { kind: 'sticky-note' as const, noteId: NOTE_ID }

it('binds the main backend to only the main target', async () => {
  const presentation = { settings: DEFAULT_BACKGROUND_SETTINGS, imageUrl: null }
  const service = {
    open: vi.fn(async () => ({ ...presentation, observed: { revision: 0, settings: { ...DEFAULT_BACKGROUND_SETTINGS },
      fieldRevisions: { imageRelativePath: 0, imageOpacityPercent: 0, imageAlignment: 0, maskType: 0,
        maskOpacityPercent: 0, maskTransitionPercent: 0, maskStrengthPercent: 0 } } })),
    get: vi.fn(async () => presentation),
    preview: vi.fn(async (source: string) => `preview:${source}`),
    apply: vi.fn(async () => presentation),
  }
  const backend = createMainBackgroundBackend(service)

  await expect(backend.get(main)).resolves.toEqual(presentation)
  await expect(backend.previewSource(main, 'C:\\wallpaper.png'))
    .resolves.toBe('preview:C:\\wallpaper.png')
  await backend.apply(main, DEFAULT_BACKGROUND_SETTINGS, { kind: 'keep' })
  await expect(backend.get(sticky)).rejects.toThrow('target')
})

it('resolves and atomically applies a per-note background', async () => {
  const background = {
    ...DEFAULT_BACKGROUND_SETTINGS,
    imageRelativePath: 'resources/current.webp',
  }
  const notes = {
    read: vi.fn(async () => ({ record: { background } })),
    resolveBackgroundImagePath: vi.fn(async () => 'C:\\notes\\current.webp'),
    applyBackground: vi.fn(async () => ({ background: {
      ...background,
      imageOpacityPercent: 44,
    } })),
  }
  const urlFor = vi.fn(async (source: string) => `asset:${source}`)
  const backend = createStickyBackgroundBackend(notes as never, urlFor)

  await expect(backend.get(sticky)).resolves.toEqual({
    settings: background,
    imageUrl: 'asset:C:\\notes\\current.webp',
  })
  await expect(backend.previewSource(sticky, 'C:\\pictures\\new.avif'))
    .resolves.toBe('asset:C:\\pictures\\new.avif')
  await expect(backend.previewSource(sticky, 'C:\\pictures\\new.svg'))
    .resolves.toBe('asset:C:\\pictures\\new.svg')
  await expect(backend.previewSource(sticky, 'C:\\pictures\\animated.gif'))
    .rejects.toThrow('static')
  await expect(backend.apply(sticky, {
    ...background,
    imageOpacityPercent: 44,
  }, { kind: 'keep' })).resolves.toEqual({
    settings: { ...background, imageOpacityPercent: 44 },
    imageUrl: 'asset:C:\\notes\\current.webp',
  })
  expect(notes.applyBackground).toHaveBeenCalledWith(
    NOTE_ID,
    { ...background, imageOpacityPercent: 44 },
    { kind: 'keep' },
    undefined,
  )
})

it('carries session invalidation into both persistence adapters', async () => {
  const assertCurrent = () => { throw new Error('stale session') }
  const service = {
    open: async () => { throw new Error('unused') },
    get: async () => ({ settings: DEFAULT_BACKGROUND_SETTINGS, imageUrl: null }),
    preview: async () => 'asset:source',
    apply: async (_settings: unknown, _update: unknown, guard?: () => void) => {
      guard?.()
      return { settings: DEFAULT_BACKGROUND_SETTINGS, imageUrl: null }
    },
  }
  await expect(createMainBackgroundBackend(service).apply(main, DEFAULT_BACKGROUND_SETTINGS,
    { kind: 'keep' }, assertCurrent)).rejects.toThrow('stale session')
  const notes = {
    read: async () => ({ record: { background: DEFAULT_BACKGROUND_SETTINGS } }),
    resolveBackgroundImagePath: async () => null,
    applyBackground: async (_id: string, _settings: unknown, _update: unknown, guard?: () => void) => {
      guard?.()
      return { background: DEFAULT_BACKGROUND_SETTINGS }
    },
  }
  await expect(createStickyBackgroundBackend(notes as never, async () => 'asset:source').apply(
    sticky, DEFAULT_BACKGROUND_SETTINGS, { kind: 'keep' }, assertCurrent)).rejects.toThrow('stale session')
})
