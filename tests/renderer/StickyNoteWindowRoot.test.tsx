import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import type { StickyNoteEditorProps } from '../../src/renderer/sticky-notes/StickyNoteEditor'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { StickyNoteWindowRoot } from '../../src/renderer/sticky-notes/StickyNoteWindowRoot'
import { stickyNoteRouteFromLocation } from '../../src/renderer/sticky-notes/sticky-note-route'
import { DEFAULT_STICKY_NOTE_FONT_SIZE_PX } from '../../src/shared/sticky-notes'
import {
  DEFAULT_BACKGROUND_SETTINGS,
  type BackgroundPresentation,
} from '../../src/shared/background-settings'
import type { ApiResult, BackgroundPresentationEvent } from '../../src/shared/contracts'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../src/shared/arknote-preferences'
import { BusinessDialogProvider } from '../../src/renderer/modal/BusinessDialogProvider'
import type { StickyNoteStyleReference } from '../../src/shared/sticky-note-preferences'

let latestEditorProps: StickyNoteEditorProps | null = null

vi.mock('../../src/renderer/sticky-notes/StickyNoteEditor', () => ({
  StickyNoteEditor: forwardRef<
    { flush(): string | null },
    { markdown: string; onChange(markdown: string): void }
  >(function FakeStickyNoteEditor({ markdown, onChange, ...props }, ref) {
    latestEditorProps = { markdown, onChange, ...props }
    useImperativeHandle(ref, () => ({ flush: () => markdown }))
    return (
      <textarea
        aria-label="便签内容"
        onChange={(event) => onChange(event.target.value)}
        value={markdown}
      />
    )
  }),
}))

const NOTE_ID = '00000000-0000-4000-8000-000000000001'

it('provides a position-specific clipboard reader bound to the actual note identity', async () => {
  const pasteClipboardImage = vi.fn(async () => ({ ok: true as const, value: '![](resources/clip.png)' }))
  window.arkdown = { ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    pasteClipboardImage,
  } as unknown as typeof window.arkdown
  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '测试便签' })
  expect(latestEditorProps?.documentKey).toBe(NOTE_ID)
  expect(await latestEditorProps?.readClipboardImage?.()).toBe('![](resources/clip.png)')
  expect(pasteClipboardImage).toHaveBeenCalledWith({ noteId: NOTE_ID })
})

const UNSUPPORTED_MATERIAL_COLOR_FUNCTION =
  /(?:^|[^\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk)\s*\(/i
const HEX_COLOR = /#[0-9a-f]{3,8}\b/i
const ALLOWED_BARE_COLOR_KEYWORDS = new Set([
  'inherit',
  'initial',
  'revert',
  'revert-layer',
  'transparent',
  'unset',
])

function materialDeclarationValuesBeforeForcedColors(css: string): string[] {
  const forcedColorsStart = css.indexOf('@media (forced-colors: active)')
  const preForcedColors = forcedColorsStart < 0 ? css : css.slice(0, forcedColorsStart)
  const values: string[] = []

  for (const match of preForcedColors.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1] ?? ''
    if (!selector.includes('[data-material-preset')
      && !selector.includes('[data-color-scheme')) continue

    for (const declaration of (match[2] ?? '').split(';')) {
      const colon = declaration.indexOf(':')
      if (colon < 0) continue
      const value = declaration.slice(colon + 1).trim()
      if (value) values.push(value)
    }
  }

  return values
}

function unsupportedMaterialColorValues(css: string): string[] {
  const colorProbe = document.createElement('span')
  return materialDeclarationValuesBeforeForcedColors(css).filter((value) => {
    const tokens = value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '')
    if (HEX_COLOR.test(tokens) || UNSUPPORTED_MATERIAL_COLOR_FUNCTION.test(tokens)) return true

    for (const match of tokens.matchAll(/(?:^|[^\w-])([a-z][a-z0-9-]*)(?=$|[^\w-])/gi)) {
      const keyword = match[1]!.toLowerCase()
      if (ALLOWED_BARE_COLOR_KEYWORDS.has(keyword)) continue
      colorProbe.style.color = ''
      colorProbe.style.color = keyword
      if (colorProbe.style.color) return true
    }
    return false
  })
}

function stickyDocument(
  lineSpacingMode: 'compact' | 'standard' = 'compact',
  style: StickyNoteStyleReference = {
    mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain',
  },
) {
  return {
    record: {
      id: NOTE_ID,
      name: '测试便签',
      status: 'active' as const,
      markdownRelativePath: `active/${NOTE_ID}/测试便签.md`,
      resourcesRelativePath: `active/${NOTE_ID}/resources`,
      style,
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: '2026-07-31T03:00:00.000Z',
      updatedAt: '2026-07-31T03:00:00.000Z',
      archivedAt: null,
      released: false,
      pinned: false,
      windowBounds: null,
      lastOpenedAt: null,
      fontSizePx: 14,
      lineSpacingMode,
    },
    markdown: '# 正文',
  }
}

it('strictly selects the sticky-note surface from URL parameters', () => {
  expect(stickyNoteRouteFromLocation(`?surface=sticky-note&noteId=${NOTE_ID}`))
    .toEqual({ noteId: NOTE_ID })
  expect(stickyNoteRouteFromLocation('?surface=sticky-note&noteId=../bad')).toBeNull()
  expect(stickyNoteRouteFromLocation(`?surface=other&noteId=${NOTE_ID}`)).toBeNull()
  expect(stickyNoteRouteFromLocation(`?surface=sticky-note&noteId=${NOTE_ID}&extra=1`))
    .toBeNull()
})

it('loads, edits and subscribes to persistence state', async () => {
  const eventHandlers: Array<(event: import('../../src/shared/sticky-notes').StickyNoteEvent) => void> = []
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    stageStickyNoteSave: vi.fn(async () => ({ ok: true as const, value: null })),
    flushStickyNoteSave: vi.fn(async () => ({ ok: true as const, value: { status: 'idle' as const } })),
    closeStickyNote: vi.fn(async () => ({ ok: true as const, value: null })),
    setStickyNotePinned: vi.fn(async () => ({ ok: true as const, value: null })),
    onStickyNoteEvent: vi.fn((handler) => {
      eventHandlers.push(handler)
      return () => undefined
    }),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)

  expect(screen.getByText('正在读取便签...')).toBeVisible()
  expect(await screen.findByRole('heading', { name: '测试便签' })).toBeVisible()
  expect(screen.getByRole('button', { name: '置顶便签' }).querySelector('.app-icon'))
    .toBeInTheDocument()
  expect(screen.getByRole('button', { name: '置顶便签' }))
    .toHaveAttribute('data-tooltip', '置顶便签')
  expect(screen.getByRole('textbox', { name: '便签内容' })).toHaveValue('# 正文')
  expect(screen.getByRole('main')).toHaveAttribute('data-line-spacing-mode', 'compact')
  expect(latestEditorProps?.lineSpacingMode).toBe('compact')
  fireEvent.change(screen.getByRole('textbox', { name: '便签内容' }), {
    target: { value: '修改内容' },
  })
  await waitFor(() => expect(window.arkdown.stageStickyNoteSave)
    .toHaveBeenCalledWith(NOTE_ID, '修改内容'))

  eventHandlers[0]?.({ type: 'save-state', noteId: NOTE_ID, state: { status: 'saving', revision: 1 } })
  expect(screen.queryByRole('status')).toBeNull()
})

it('loads and applies only this sticky note background presentation', async () => {
  let backgroundListener: ((event: {
    target: { kind: 'main' } | { kind: 'sticky-note'; noteId: string }
    presentation: import('../../src/shared/background-settings').BackgroundPresentation
    phase: 'preview' | 'applied' | 'restore'
  }) => void) | undefined
  const initial = {
    settings: {
      ...DEFAULT_BACKGROUND_SETTINGS,
      imageRelativePath: 'resources/first.webp',
      imageOpacityPercent: 40,
      imageAlignment: 'right-top' as const,
      maskType: 'diagonal-bottom-right' as const,
    },
    imageUrl: 'arkdown-background://first',
  }
  const getBackgroundPresentation = vi.fn(async () => ({ ok: true as const, value: initial }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    getBackgroundPresentation,
    onBackgroundPresentation: vi.fn((listener) => {
      backgroundListener = listener
      return () => undefined
    }),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)

  await screen.findByRole('heading', { name: '测试便签' })
  await waitFor(() => expect(getBackgroundPresentation).toHaveBeenCalledWith({
    kind: 'sticky-note', noteId: NOTE_ID,
  }))
  const image = await screen.findByTestId('background-image-layer-image')
  expect(image).toHaveAttribute('src', 'arkdown-background://first')
  expect(image).toHaveAttribute('data-mask-type', 'diagonal-bottom-right')
  const layer = screen.getByTestId('background-image-layer')
  expect(layer).toHaveAttribute('data-alignment', 'right-top')
  expect(document.querySelector('.sticky-note-editor-region')).toContainElement(layer)
  expect(document.querySelector('.sticky-note-titlebar')).not.toContainElement(layer)

  act(() => backgroundListener?.({
    target: { kind: 'sticky-note', noteId: '00000000-0000-4000-8000-000000000099' },
    presentation: { ...initial, imageUrl: 'arkdown-background://other' },
    phase: 'preview',
  }))
  expect(image).toHaveAttribute('src', 'arkdown-background://first')

  act(() => backgroundListener?.({
    target: { kind: 'sticky-note', noteId: NOTE_ID },
    presentation: { ...initial, imageUrl: 'arkdown-background://updated' },
    phase: 'applied',
  }))
  await waitFor(() => expect(screen.getByTestId('background-image-layer-image'))
    .toHaveAttribute('src', 'arkdown-background://updated'))
})

it('clips the sticky background and editor together below the titlebar', () => {
  const css = readFileSync(path.join(
    process.cwd(),
    'src/renderer/sticky-notes/sticky-note-window.css',
  ), 'utf8')

  expect(css).toMatch(/\.sticky-note-editor-region\s*\{[^}]*position:\s*relative/u)
  expect(css).toMatch(/\.sticky-note-editor-region\s*\{[^}]*overflow:\s*hidden/u)
})

it('does not let a late initial background response overwrite a live preview event', async () => {
  let backgroundListener: ((event: BackgroundPresentationEvent) => void) | undefined
  let resolveInitial!: (value: ApiResult<BackgroundPresentation>) => void
  const initialRequest = new Promise<ApiResult<BackgroundPresentation>>((resolve) => {
    resolveInitial = resolve
  })
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    getBackgroundPresentation: vi.fn(() => initialRequest),
    onBackgroundPresentation: vi.fn((listener) => {
      backgroundListener = listener
      return () => undefined
    }),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '测试便签' })
  await waitFor(() => expect(window.arkdown.getBackgroundPresentation).toHaveBeenCalled())

  act(() => backgroundListener?.({
    target: { kind: 'sticky-note', noteId: NOTE_ID },
    presentation: {
      settings: { ...DEFAULT_BACKGROUND_SETTINGS, imageRelativePath: 'resources/live.webp' },
      imageUrl: 'arkdown-background://live',
    },
    phase: 'preview',
  }))
  await waitFor(() => expect(screen.getByTestId('background-image-layer-image'))
    .toHaveAttribute('src', 'arkdown-background://live'))

  await act(async () => resolveInitial({
    ok: true,
    value: {
      settings: { ...DEFAULT_BACKGROUND_SETTINGS, imageRelativePath: 'resources/stale.webp' },
      imageUrl: 'arkdown-background://stale',
    },
  }))
  expect(screen.getByTestId('background-image-layer-image'))
    .toHaveAttribute('src', 'arkdown-background://live')
})

it('opens sticky background settings from the editor command', async () => {
  const openBackgroundSettings = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    openBackgroundSettings,
  } as unknown as typeof window.arkdown
  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '测试便签' })

  await latestEditorProps?.onOpenBackgroundSettings?.()

  expect(openBackgroundSettings).toHaveBeenCalledWith({ kind: 'sticky-note', noteId: NOTE_ID })
})

it('renders a persisted standard line-spacing mode on the root and editor', async () => {
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument('standard') })),
  } as unknown as typeof window.arkdown

  latestEditorProps = null
  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)

  await waitFor(() => expect(latestEditorProps).not.toBeNull())
  const editorProps = latestEditorProps as StickyNoteEditorProps | null
  expect.soft(screen.getByRole('main')).toHaveAttribute('data-line-spacing-mode', 'standard')
  expect.soft(editorProps?.lineSpacingMode).toBe('standard')
})

it('applies the persisted Arknote theme and live transient theme updates', async () => {
  let themeListener: ((themeColor: string) => void) | undefined
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    getArknotePreferences: vi.fn(async () => ({
      ok: true as const,
      value: { ...DEFAULT_ARKNOTE_PREFERENCES, themeColor: '#2563EB' },
    })),
    onArknoteThemeColorChanged: vi.fn((listener) => {
      themeListener = listener
      return () => undefined
    }),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)

  await screen.findByRole('heading')
  const root = screen.getByRole('main')
  await waitFor(() =>
    expect(root.style.getPropertyValue('--theme-color-rgb')).toBe('37 99 235'))
  themeListener?.('#18864B')
  await waitFor(() =>
    expect(root.style.getPropertyValue('--theme-color-rgb')).toBe('24 134 75'))
})

it('does not let a stale initial theme read overwrite a newer preview event', async () => {
  let themeListener: ((themeColor: string) => void) | undefined
  let resolvePreferences!: (result: {
    ok: true
    value: import('../../src/shared/arknote-preferences').ArknotePreferences
  }) => void
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    getArknotePreferences: vi.fn(() => new Promise((resolve) => {
      resolvePreferences = resolve
    })),
    onArknoteThemeColorChanged: vi.fn((listener) => {
      themeListener = listener
      return () => undefined
    }),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)

  await screen.findByRole('heading')
  const root = screen.getByRole('main')
  act(() => themeListener?.('#18864B'))
  expect(root.style.getPropertyValue('--theme-color-rgb')).toBe('24 134 75')

  await act(async () => resolvePreferences({
    ok: true,
    value: { ...DEFAULT_ARKNOTE_PREFERENCES, themeColor: '#2563EB' },
  }))
  expect(root.style.getPropertyValue('--theme-color-rgb')).toBe('24 134 75')
})

it('saves the selected line spacing mode through the fixed note setter', async () => {
  const setStickyNoteLineSpacingMode = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    setStickyNoteLineSpacingMode,
  } as unknown as typeof window.arkdown

  latestEditorProps = null
  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await waitFor(() => expect(latestEditorProps).not.toBeNull())
  const editorProps = latestEditorProps as StickyNoteEditorProps | null
  await editorProps?.onSetLineSpacingMode?.('standard')

  expect(setStickyNoteLineSpacingMode).toHaveBeenCalledWith(NOTE_ID, 'standard')
})

it('flushes before close and keeps the window open when saving fails', async () => {
  const flushStickyNoteSave = vi.fn()
    .mockResolvedValueOnce({
      ok: true as const,
      value: { status: 'error' as const, revision: 1, message: '磁盘已满' },
    })
    .mockResolvedValueOnce({
      ok: true as const,
      value: { status: 'saved' as const, revision: 1, savedAt: 'now' },
    })
  const closeStickyNote = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    stageStickyNoteSave: vi.fn(async () => ({ ok: true as const, value: null })),
    flushStickyNoteSave,
    closeStickyNote,
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '测试便签' })
  screen.getByRole('button', { name: '关闭便签' }).click()

  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败：磁盘已满')
  expect(closeStickyNote).not.toHaveBeenCalled()
  screen.getByRole('button', { name: '重试' }).click()
  await waitFor(() => expect(closeStickyNote).toHaveBeenCalledWith(NOTE_ID))
})

it('cancels archive confirmation without calling save or archive IPC', async () => {
  const stageStickyNoteSave = vi.fn(async () => ({ ok: true as const, value: null }))
  const flushStickyNoteSave = vi.fn(async () => ({
    ok: true as const,
    value: { status: 'saved' as const, revision: 1, savedAt: 'now' },
  }))
  const archiveStickyNote = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    stageStickyNoteSave,
    flushStickyNoteSave,
    archiveStickyNote,
  } as unknown as typeof window.arkdown

  render(<BusinessDialogProvider><StickyNoteWindowRoot noteId={NOTE_ID} /></BusinessDialogProvider>)
  await screen.findByRole('heading', { name: '测试便签' })
  const archive = latestEditorProps?.onArchive?.()
  const dialog = await screen.findByRole('dialog', { name: '归档便签' })
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await archive

  expect(dialog).toHaveTextContent('确定归档这张便签吗？')
  expect(stageStickyNoteSave).not.toHaveBeenCalled()
  expect(flushStickyNoteSave).not.toHaveBeenCalled()
  expect(archiveStickyNote).not.toHaveBeenCalled()
})

it('forces a save after confirmation and retries before archiving', async () => {
  const order: string[] = []
  const flushStickyNoteSave = vi.fn()
    .mockImplementationOnce(async () => {
      order.push('flush')
      return {
        ok: true as const,
        value: { status: 'error' as const, revision: 1, message: '磁盘已满' },
      }
    })
    .mockImplementationOnce(async () => {
      order.push('flush')
      return {
        ok: true as const,
        value: { status: 'saved' as const, revision: 2, savedAt: 'now' },
      }
    })
  const archiveStickyNote = vi.fn(async () => {
    order.push('archive')
    return { ok: true as const, value: null }
  })
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    flushStickyNoteSave,
    archiveStickyNote,
  } as unknown as typeof window.arkdown

  render(<BusinessDialogProvider><StickyNoteWindowRoot noteId={NOTE_ID} /></BusinessDialogProvider>)
  await screen.findByRole('heading', { name: '测试便签' })
  const archive = latestEditorProps?.onArchive?.()
  const dialog = await screen.findByRole('dialog', { name: '归档便签' })
  fireEvent.click(within(dialog).getByRole('button', { name: '归档' }))
  await archive

  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败：磁盘已满')
  expect(archiveStickyNote).not.toHaveBeenCalled()
  screen.getByRole('button', { name: '重试' }).click()
  await waitFor(() => expect(archiveStickyNote).toHaveBeenCalledWith(NOTE_ID))
  expect(order).toEqual(['flush', 'flush', 'archive'])
})

it('saves material choices, leaves material through classic choices, and applies style events in place', async () => {
  const handlers: Array<(event: import('../../src/shared/sticky-notes').StickyNoteEvent) => void> = []
  const setStickyNoteStyle = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    onStickyNoteEvent: vi.fn((handler) => { handlers.push(handler); return () => undefined }),
    setStickyNoteStyle,
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '测试便签' })
  const root = screen.getByRole('main')
  await latestEditorProps?.onSetMaterial?.('mica-light')
  expect(setStickyNoteStyle).toHaveBeenLastCalledWith(NOTE_ID, {
    mode: 'material', materialPresetId: 'mica-light',
  })

  handlers[0]?.({
    type: 'note-style-changed', noteId: NOTE_ID, revision: 1,
    style: { mode: 'material', materialPresetId: 'mica-light' },
  })
  await waitFor(() => expect(latestEditorProps?.style).toEqual({
    mode: 'material', materialPresetId: 'mica-light',
  }))
  expect(screen.getByRole('main')).toBe(root)
  expect(root).toHaveAttribute('data-material-preset', 'mica-light')

  await latestEditorProps?.onSetColor?.('blue')
  expect(setStickyNoteStyle).toHaveBeenLastCalledWith(NOTE_ID, {
    mode: 'preset', colorPresetId: 'blue', texturePresetId: 'plain',
  })

  handlers[0]?.({
    type: 'note-style-changed', noteId: NOTE_ID, revision: 2,
    style: { mode: 'material', materialPresetId: 'flowing-glass' },
  })
  await waitFor(() => expect(latestEditorProps?.style).toEqual({
    mode: 'material', materialPresetId: 'flowing-glass',
  }))
  await latestEditorProps?.onSetTexture?.('fabric')
  expect(setStickyNoteStyle).toHaveBeenLastCalledWith(NOTE_ID, {
    mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'fabric',
  })
})

it('toggles the focus state used by toolbar padding and scrollbar visibility', async () => {
  const getStickyNotePreferences = vi.fn(stickyNoteApiStubs.getStickyNotePreferences)
  window.arkdown = {
    ...stickyNoteApiStubs,
    getStickyNotePreferences,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
  } as unknown as typeof window.arkdown
  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '测试便签' })
  await waitFor(() => expect(getStickyNotePreferences).toHaveBeenCalledOnce())
  const root = screen.getByRole('main')
  expect(root).toHaveAttribute('data-focused', 'true')
  fireEvent.blur(window)
  expect(root).toHaveAttribute('data-focused', 'false')
  fireEvent.focus(window)
  await waitFor(() => expect(getStickyNotePreferences).toHaveBeenCalledTimes(2))
  expect(root).toHaveAttribute('data-focused', 'true')
})

it('keeps soft-glass rendering independent from pointer movement', async () => {
  const stageStickyNoteSave = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({
      ok: true as const,
      value: stickyDocument('compact', {
        mode: 'material', materialPresetId: 'flowing-glass',
      }),
    })),
    stageStickyNoteSave,
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)

  await screen.findByRole('heading', { name: '测试便签' })
  const surface = screen.getByRole('main')
  expect(surface).toHaveAttribute('data-material-preset', 'flowing-glass')
  expect(surface).toHaveAttribute('data-color-scheme', 'light')

  fireEvent.pointerMove(surface, { clientX: 80, clientY: 120 })
  expect(surface.style.getPropertyValue('--flowing-glass-pointer-x')).toBe('')
  expect(surface.style.getPropertyValue('--flowing-glass-pointer-y')).toBe('')
  expect(screen.getByRole('textbox', { name: '便签内容' })).toHaveValue('# 正文')
  expect(stageStickyNoteSave).not.toHaveBeenCalled()

  fireEvent.pointerLeave(surface)
  expect(surface.style.getPropertyValue('--flowing-glass-pointer-x')).toBe('')
  expect(surface.style.getPropertyValue('--flowing-glass-pointer-y')).toBe('')
})

it('does not expose material identity or pointer tracking for classic notes', async () => {
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
  } as unknown as typeof window.arkdown

  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)

  await screen.findByRole('heading', { name: '测试便签' })
  const surface = screen.getByRole('main')
  fireEvent.pointerMove(surface, { clientX: 80, clientY: 120 })
  expect(surface).not.toHaveAttribute('data-material-preset')
  expect(surface).not.toHaveAttribute('data-color-scheme')
  expect(surface.style.getPropertyValue('--flowing-glass-pointer-x')).toBe('')
  expect(surface.style.getPropertyValue('--flowing-glass-pointer-y')).toBe('')
})

it('lets the native material show through the renderer root', () => {
  const windowCss = readFileSync(path.join(
    process.cwd(),
    'src/renderer/sticky-notes/sticky-note-window.css',
  ), 'utf8')
  const style = document.createElement('style')
  style.textContent = windowCss
  document.head.append(style)
  const surface = document.createElement('main')
  surface.className = 'sticky-note-window'
  surface.dataset.materialPreset = 'mica-light'
  document.body.append(surface)
  expect(getComputedStyle(surface).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  surface.remove()
  style.remove()
})

it('keeps native glass contours and the live inner glow non-interactive without changing editor tokens', () => {
  const css = readFileSync(path.join(
    process.cwd(),
    'src/renderer/sticky-notes/sticky-note-window.css',
  ), 'utf8')
  expect(css).toMatch(
    /\.sticky-note-window:is\([^\n]+\)::after\s*\{[^}]*pointer-events:\s*none[^}]*box-shadow:\s*var\(--sticky-note-inner-glow, none\)/s,
  )
  expect(css).not.toMatch(/\.sticky-note-window\[data-material-preset="flowing-glass"\]::before\s*\{[^}]*border:/s)

  const materialStart = css.indexOf('.sticky-note-window[data-material-preset]')
  const materialEnd = css.indexOf('.sticky-note-titlebar {', materialStart)
  const materialEffects = css.slice(materialStart, materialEnd)
  expect(unsupportedMaterialColorValues(css).filter((value) => !['1px solid rgb(255 251 241 / 64%)', 'rgb(255 255 255 / 72%)'].includes(value))).toEqual([])
  expect(materialEffects).not.toContain('--control-disabled-opacity:')
  for (const token of [
    '--sticky-note-surface-layer',
    '--sticky-note-text-color',
    '--sticky-note-muted-text-color',
    '--sticky-note-border-color',
    '--sticky-note-hover-layer',
    '--sticky-note-pressed-layer',
    '--sticky-note-selection-layer',
  ]) {
    expect(materialEffects).not.toMatch(new RegExp(`var\\(${token}\\s*,`))
  }
  expect(materialEffects).toMatch(
    /\.sticky-note-window\[data-color-scheme="dark"\] \.sticky-note-save-status\.is-error\s*\{[^}]*color:\s*color-mix\([^}]*var\(--sticky-note-text-color\)[^}]*var\(--sticky-note-background-color\)/s,
  )
  expect(materialEffects).not.toContain('--flowing-glass-pointer-')
  expect(materialEffects).not.toContain('--sticky-note-highlight-strength')
  expect(materialEffects).not.toMatch(/\[data-material-preset="flowing-glass"\]\[data-focused="false"\]/)
  expect(materialEffects).toMatch(
    /\.sticky-note-editor \.ProseMirror ::selection\s*\{[^}]*background:\s*var\(--sticky-note-selection-layer\);/s,
  )
})

it('screens only pre-forced material declaration values for every literal color syntax', () => {
  const forbiddenValues = [
    '#fff',
    'rgb(255 255 255)',
    'rgba(255, 255, 255, .5)',
    'hsl(0 0% 100%)',
    'hsla(0, 0%, 100%, .5)',
    'hwb(0 0% 0%)',
    'lab(100% 0 0)',
    'lch(100% 0 0)',
    'oklab(1 0 0)',
    'oklch(1 0 0)',
    'color(display-p3 1 1 1)',
    'device-cmyk(0 0 0 0)',
    'white',
    'rebeccapurple',
    'CanvasText',
    'ButtonFace',
    'currentColor',
  ]
  for (const value of forbiddenValues) {
    const mutation = `.sticky-note-window[data-material-preset] { outline-color: ${value}; }`
    expect(unsupportedMaterialColorValues(mutation), value).toEqual([value])
  }

  const allowed = `
    .sticky-note-window[data-material-preset="white"] {
      --named-color-property: var(--sticky-note-border-color);
      border-color: var(--sticky-note-border-color);
      background: color-mix(in srgb, var(--sticky-note-border-color) 66%, transparent);
    }
    @media (forced-colors: active) {
      .sticky-note-window[data-material-preset] {
        color: CanvasText;
        background: color(display-p3 1 1 1);
      }
    }
  `
  expect(unsupportedMaterialColorValues(allowed)).toEqual([])
})

it('uses catalog-backed variables for controls and platform colors only in forced-colors fallback', () => {
  const css = readFileSync(path.join(
    process.cwd(),
    'src/renderer/sticky-notes/sticky-note-window.css',
  ), 'utf8')

  expect(css).toMatch(
    /\.sticky-note-titlebar button:hover:not\(:disabled\),[\s\S]*?\{[^}]*background:\s*var\(--control-hover-layer\);/,
  )
  expect(css).toMatch(
    /\.sticky-note-titlebar button:active:not\(:disabled\),[\s\S]*?\{[^}]*background:\s*var\(--control-pressed-layer\);/,
  )

  const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'))
  expect(forcedColors).toMatch(/\.sticky-note-window,[^}]*background:\s*Canvas;/s)
  expect(forcedColors).toMatch(
    /\[data-material-preset\]::before,\s*\.sticky-note-window\[data-material-preset\]::after\s*\{[^}]*display:\s*none;/,
  )
  expect(forcedColors).toMatch(/color:\s*ButtonText;/)
  expect(forcedColors).toMatch(/background:\s*ButtonFace;/)
})

it('does not add motion-specific overrides for the static soft-glass layer', () => {
  const css = readFileSync(path.join(
    process.cwd(),
    'src/renderer/sticky-notes/sticky-note-window.css',
  ), 'utf8')
  const reducedMotion = css.slice(
    css.indexOf('@media (prefers-reduced-motion: reduce)'),
    css.indexOf('@media (forced-colors: active)'),
  )

  expect(reducedMotion).not.toContain('flowing-glass')
})

it('uses focus-only toolbar padding and thumb-only scrollbar hover styles', () => {
  const css = readFileSync(path.join(process.cwd(), 'src/renderer/sticky-notes/sticky-note-window.css'), 'utf8')
  expect(css).toMatch(/\.sticky-note-editor\s*\{[^}]*background(?:-color)?:\s*transparent/s)
  expect(css).toMatch(/\.sticky-note-editor \.ProseMirror\s*\{[^}]*padding:\s*8px 12px;/s)
  expect(css).toMatch(/\.sticky-note-window\[data-focused="true"\] \.sticky-note-editor \.ProseMirror\s*\{[^}]*padding-bottom:\s*46px/s)
  expect(css).toMatch(/font-size:\s*var\(--sticky-note-font-size,\s*14px\)/)
  expect(css).toMatch(/\.sticky-note-editor\s*\{[^}]*scrollbar-width:\s*none/s)
  expect(css).toMatch(/\.sticky-note-editor::\-webkit-scrollbar\s*\{[^}]*width:\s*0[^}]*display:\s*none/s)
  expect(css).toMatch(/\.sticky-note-overlay-scrollbar\s*\{[^}]*position:\s*absolute[^}]*width:\s*5px[^}]*pointer-events:\s*none/s)
  expect(css).toMatch(/\.sticky-note-overlay-scrollbar-thumb\s*\{[^}]*width:\s*5px[^}]*pointer-events:\s*auto/s)
  expect(css).toMatch(/\.sticky-note-overlay-scrollbar-thumb:hover\s*\{[^}]*background:\s*rgba\(0, 0, 0, 0\.58\)/s)
})

it('isolates the sticky-note canvas from Arkdown editor backgrounds and layout margins', () => {
  const css = readFileSync(path.join(process.cwd(), 'src/renderer/sticky-notes/sticky-note-window.css'), 'utf8')

  expect(css).toMatch(/\.sticky-note-editor \.visual-editor,[\s\S]*\.sticky-note-editor \.milkdown,[\s\S]*\.sticky-note-editor \.ProseMirror\s*\{[^}]*background-color:\s*transparent\s*!important/s)
  expect(css).toMatch(/\.sticky-note-editor \.milkdown\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none[^}]*margin:\s*0/s)
  expect(css).toMatch(/\.sticky-note-editor \.ProseMirror\s*\{[^}]*padding:\s*8px 12px/s)
})

it('uses a 14px default sticky-note font and lets paragraph text inherit it', () => {
  const css = readFileSync(path.join(process.cwd(), 'src/renderer/sticky-notes/sticky-note-window.css'), 'utf8')

  expect(DEFAULT_STICKY_NOTE_FONT_SIZE_PX).toBe(14)
  expect(css).toMatch(/font-size:\s*var\(--sticky-note-font-size,\s*14px\)/)
  expect(css).toMatch(/\.sticky-note-editor \.ProseMirror p\s*\{[^}]*font-size:\s*inherit[^}]*line-height:\s*inherit/s)
})

it('retries an operation failure without attempting to close the note', async () => {
  const closeStickyNote = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    closeStickyNote,
    setStickyNoteFontSize: vi.fn(async () => ({ ok: false as const, error: { code: 'OPERATION_FAILED' as const, message: 'font write failed' } })),
  } as unknown as typeof window.arkdown
  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '测试便签' })
  await latestEditorProps?.onAdjustFontSize?.('increase')
  expect(await screen.findByRole('alert')).toHaveTextContent('font write failed')
  screen.getByRole('button', { name: '重试' }).click()
  await waitFor(() => expect(window.arkdown.setStickyNoteFontSize).toHaveBeenCalledTimes(2))
  expect(closeStickyNote).not.toHaveBeenCalled()
})

it('shows one actionable overlay when save and operation failures overlap', async () => {
  const handlers: Array<(event: import('../../src/shared/sticky-notes').StickyNoteEvent) => void> = []
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    onStickyNoteEvent: vi.fn((handler) => { handlers.push(handler); return () => undefined }),
    setStickyNoteFontSize: vi.fn(async () => ({ ok: false as const, error: { code: 'OPERATION_FAILED' as const, message: 'font write failed' } })),
  } as unknown as typeof window.arkdown
  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '测试便签' })
  handlers[0]?.({ type: 'save-state', noteId: NOTE_ID, state: { status: 'error', revision: 3, message: 'save failed' } })
  await latestEditorProps?.onAdjustFontSize?.('increase')
  const alert = await screen.findByRole('alert')
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(alert).toHaveTextContent('font write failed')
})


it('chooses and copies an image through native Arknote IPC before inserting markdown', async () => {
  const markdown = '![](resources/00000000-0000-4000-8000-000000000099.png)'
  const chooseStickyNoteImage = vi.fn(async () => ({ ok: true as const, value: markdown }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    chooseStickyNoteImage,
  } as unknown as typeof window.arkdown
  const inserted: string[] = []
  const listener = (event: Event) => inserted.push((event as CustomEvent<string>).detail)
  window.addEventListener('arkdown:insert-markdown', listener)
  try {
    render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
    await screen.findByRole('heading', { name: '测试便签' })
    await latestEditorProps?.onInsertImage?.()

    expect(chooseStickyNoteImage).toHaveBeenCalledWith(NOTE_ID)
    expect(inserted).toEqual([markdown])
  } finally {
    window.removeEventListener('arkdown:insert-markdown', listener)
  }
})

it('preserves an independent snapshot when Custom is selected again', async () => {
  const note = stickyDocument()
  note.record.style = { mode: 'independent', color: '#123456', texture: { pattern: 'none', foregroundColor: '#000000', opacityPercent: 0, scalePx: 16 } }
  const setStickyNoteStyle = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = { ...stickyNoteApiStubs, readStickyNote: vi.fn(async () => ({ ok: true as const, value: note })), setStickyNoteStyle } as unknown as typeof window.arkdown
  render(<StickyNoteWindowRoot noteId={NOTE_ID} />)
  await screen.findByRole('heading', { name: '测试便签' })
  await latestEditorProps?.onSetColor?.('custom')
  await latestEditorProps?.onSetColor?.('custom')
  expect(setStickyNoteStyle).toHaveBeenLastCalledWith(NOTE_ID, note.record.style)
  await latestEditorProps?.onSetColor?.('blue')
  expect(setStickyNoteStyle).toHaveBeenLastCalledWith(NOTE_ID, { mode: 'preset', colorPresetId: 'blue', texturePresetId: 'plain' })
})

it('opens one rename prompt from repeated title double-clicks and cancels without writing', async () => {
  const renameStickyNote = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    renameStickyNote,
  } as unknown as typeof window.arkdown
  render(<BusinessDialogProvider><StickyNoteWindowRoot noteId={NOTE_ID} /></BusinessDialogProvider>)
  const title = await screen.findByText('测试便签')
  fireEvent.doubleClick(screen.getByRole('button', { name: '置顶便签' }))
  fireEvent.doubleClick(screen.getByRole('button', { name: '关闭便签' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.doubleClick(title)
  fireEvent.doubleClick(title)
  const dialog = await screen.findByRole('dialog', { name: '重命名便签' })
  expect(within(dialog).getByRole('textbox', { name: '便签名' })).toHaveValue('测试便签')
  expect(within(dialog).getByRole('textbox', { name: '便签名' }).closest('label')).toHaveClass('arkdown-dialog__prompt-field')
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(renameStickyNote).not.toHaveBeenCalled()
  expect(screen.getByRole('heading', { name: '测试便签' })).toBeVisible()
  fireEvent.doubleClick(title)
  expect(await screen.findByRole('dialog', { name: '重命名便签' })).toBeVisible()
})

it('renames by title double-click through the existing service and authoritative name event', async () => {
  const handlers: Array<(event: import('../../src/shared/sticky-notes').StickyNoteEvent) => void> = []
  const renameStickyNote = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    renameStickyNote,
    onStickyNoteEvent: vi.fn((handler) => { handlers.push(handler); return () => undefined }),
  } as unknown as typeof window.arkdown
  render(<BusinessDialogProvider><StickyNoteWindowRoot noteId={NOTE_ID} /></BusinessDialogProvider>)
  fireEvent.doubleClick(await screen.findByText('测试便签'))
  const dialog = await screen.findByRole('dialog', { name: '重命名便签' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: '便签名' }), { target: { value: '  新便签名称  ' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '重命名' }))
  await waitFor(() => expect(renameStickyNote).toHaveBeenCalledExactlyOnceWith(NOTE_ID, '新便签名称'))
  expect(screen.getByRole('heading', { name: '测试便签' })).toBeVisible()
  act(() => handlers.forEach((handler) => handler({
    type: 'note-name-changed', noteId: NOTE_ID, revision: 1, name: '新便签名称',
  })))
  expect(screen.getByRole('heading', { name: '新便签名称' })).toBeVisible()
})

it('keeps the old title after double-click rename fails and allows retry', async () => {
  const renameStickyNote = vi.fn(async () => ({
    ok: false as const, error: { code: 'OPERATION_FAILED' as const, message: '无法保存便签名' },
  }))
  window.arkdown = {
    ...stickyNoteApiStubs,
    readStickyNote: vi.fn(async () => ({ ok: true as const, value: stickyDocument() })),
    renameStickyNote,
  } as unknown as typeof window.arkdown
  render(<BusinessDialogProvider><StickyNoteWindowRoot noteId={NOTE_ID} /></BusinessDialogProvider>)
  fireEvent.doubleClick(await screen.findByText('测试便签'))
  const dialog = await screen.findByRole('dialog', { name: '重命名便签' })
  fireEvent.change(within(dialog).getByRole('textbox', { name: '便签名' }), { target: { value: '不能保存的名字' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '重命名' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('无法保存便签名')
  expect(screen.getByRole('heading', { name: '测试便签' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  const retryDialog = await screen.findByRole('dialog', { name: '重命名便签' })
  expect(within(retryDialog).getByRole('textbox', { name: '便签名' })).toHaveValue('测试便签')
  expect(renameStickyNote).toHaveBeenCalledTimes(1)
})
