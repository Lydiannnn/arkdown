import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import type { BackgroundSettings } from '../../src/shared/background-settings'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'
import { BackgroundSettingsSurface } from '../../src/renderer/backgrounds/BackgroundSettingsSurface'
import { DEFAULT_EDITOR_APPEARANCE, type EditorAppearanceSnapshot } from '../../src/shared/editor-appearance-preferences'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'

it('preserves a conflicting background draft and explains explicit reload without retrying against a new observation', async () => {
  configureApi({ applyBackground: vi.fn(async () => ({ ok: true as const, value: { status: 'conflict' as const } })) })
  render(<BackgroundSettingsSurface route={{ target: 'main' }} />)
  await waitFor(() => expect(window.arkdown.getBackgroundPresentation).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByText('preview'))
  fireEvent.click(screen.getByText('apply'))
  expect(await screen.findByRole('alert')).toHaveTextContent('背景设置已在其他窗口修改')
  expect(screen.getByTestId('opacity')).toHaveTextContent('71')
  expect(window.arkdown.cancelBackgroundSettings).not.toHaveBeenCalled()
  expect(window.arkdown.getBackgroundPresentation).toHaveBeenCalledOnce()
})

it('applies the latest Arkdown theme and ignores a stale initial read after a theme event', async () => {
  let finishRead!: (value: { ok: true; value: EditorAppearanceSnapshot }) => void
  let changed!: (value: EditorAppearanceSnapshot) => void
  const unsubscribe = vi.fn()
  const snapshot = (editorTheme: 'dark' | 'minimal'): EditorAppearanceSnapshot => ({
    revision: 1, appearance: { ...DEFAULT_EDITOR_APPEARANCE, editorTheme },
  })
  configureApi({
    getEditorAppearancePreferences: vi.fn(() => new Promise<{ ok: true; value: EditorAppearanceSnapshot }>(resolve => { finishRead = resolve })),
    onEditorAppearancePreferencesChanged: vi.fn(listener => { changed = listener; return unsubscribe }),
  })
  const view = render(<BackgroundSettingsSurface route={{ target: 'main' }} />)
  act(() => changed(snapshot('dark')))
  expect(document.documentElement.dataset.arkdownTheme).toBe('dark')
  await act(async () => finishRead({ ok: true, value: snapshot('minimal') }))
  expect(document.documentElement.dataset.arkdownTheme).toBe('dark')
  act(() => changed(snapshot('minimal')))
  expect(document.documentElement.dataset.arkdownTheme).toBe('minimal')
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
  delete document.documentElement.dataset.arkdownTheme
})

let latestProps: {
  imageUrl: string | null
  settings: BackgroundSettings
  onApply(settings: BackgroundSettings): void
  onCancel(): void
  onChooseImage(): void
  onPreview(settings: BackgroundSettings): void
  onRemoveImage(): void
} | null = null

vi.mock('../../src/renderer/backgrounds/BackgroundSettingsPage', () => ({
  BackgroundSettingsPage: (props: typeof latestProps) => {
    latestProps = props
    return <main aria-label="surface">
      <output data-testid="image-url">{props?.imageUrl ?? 'none'}</output>
      <output data-testid="opacity">{props?.settings.imageOpacityPercent}</output>
      <button onClick={() => props?.onChooseImage()} type="button">choose</button>
      <button onClick={() => props?.onRemoveImage()} type="button">remove</button>
      <button onClick={() => props?.onPreview({
        ...props.settings,
        imageOpacityPercent: 71,
      })} type="button">preview</button>
      <button onClick={() => props?.onApply(props.settings)} type="button">apply</button>
      <button onClick={() => props?.onCancel()} type="button">cancel</button>
    </main>
  },
}))

function presentation(settings: BackgroundSettings = DEFAULT_BACKGROUND_SETTINGS, imageUrl: string | null = null) {
  return { settings: { ...settings }, imageUrl }
}

function configureApi(overrides: Partial<typeof window.arkdown> = {}) {
  window.arkdown = {
    getBackgroundPresentation: vi.fn(async () => ({ ok: true as const, value: presentation() })),
    chooseBackgroundImage: vi.fn(async () => ({ ok: true as const, value: null })),
    removeBackgroundImage: vi.fn(async () => ({ ok: true as const, value: presentation() })),
    previewBackground: vi.fn(async () => ({ ok: true as const, value: null })),
    applyBackground: vi.fn(async () => ({ ok: true as const, value: presentation() })),
    cancelBackgroundSettings: vi.fn(async () => ({ ok: true as const, value: null })),
    ...overrides,
  } as unknown as typeof window.arkdown
}

it('loads the main presentation without target-specific preview placement', async () => {
  const getBackgroundPresentation = vi.fn(async () => ({
    ok: true as const,
    value: presentation({ ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 32 }, 'arkdown://main'),
  }))
  configureApi({ getBackgroundPresentation })

  render(<BackgroundSettingsSurface route={{ target: 'main' }} />)

  await waitFor(() => expect(getBackgroundPresentation).toHaveBeenCalledWith({ kind: 'main' }))
  await waitFor(() => {
    expect(screen.getByTestId('image-url')).toHaveTextContent('arkdown://main')
    expect(screen.getByTestId('opacity')).toHaveTextContent('32')
  })
})

it('loads a sticky-note presentation for the routed note', async () => {
  const getBackgroundPresentation = vi.fn(async () => ({ ok: true as const, value: presentation() }))
  configureApi({ getBackgroundPresentation })

  render(<BackgroundSettingsSurface route={{ target: 'sticky-note', noteId: NOTE_ID }} />)

  await waitFor(() => expect(getBackgroundPresentation).toHaveBeenCalledWith({
    kind: 'sticky-note', noteId: NOTE_ID,
  }))
})

it('keeps edited settings and exposes retry when preview fails', async () => {
  const previewBackground = vi.fn()
    .mockResolvedValueOnce({ ok: false as const, error: { code: 'OPERATION_FAILED' as const, message: 'preview failed' } })
    .mockResolvedValueOnce({ ok: true as const, value: null })
  configureApi({ previewBackground })

  render(<BackgroundSettingsSurface route={{ target: 'main' }} />)
  await screen.findByTestId('opacity')
  fireEvent.click(screen.getByRole('button', { name: 'preview' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('preview failed')
  expect(screen.getByTestId('opacity')).toHaveTextContent('71')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(previewBackground).toHaveBeenCalledTimes(2))
  expect(screen.getByTestId('opacity')).toHaveTextContent('71')
})

it('styles operation failures as a visible error notification', async () => {
  const css = await readFile(path.join(
    process.cwd(),
    'src/renderer/backgrounds/background-settings-page.css',
  ), 'utf8')

  expect(css).toMatch(/\.background-settings-surface__error\s*\{[\s\S]*?color:\s*#b42318/u)
})

it('uses choose, remove, apply, and cancel with the routed target', async () => {
  const target = { kind: 'sticky-note' as const, noteId: NOTE_ID }
  const selected = presentation({ ...DEFAULT_BACKGROUND_SETTINGS, imageRelativePath: 'resources/new.png' }, 'arkdown://new')
  const removed = presentation()
  const chooseBackgroundImage = vi.fn(async () => ({ ok: true as const, value: selected }))
  const removeBackgroundImage = vi.fn(async () => ({ ok: true as const, value: removed }))
  const applyBackground = vi.fn(async () => ({ ok: true as const, value: removed }))
  const cancelBackgroundSettings = vi.fn(async () => ({ ok: true as const, value: null }))
  configureApi({ chooseBackgroundImage, removeBackgroundImage, applyBackground, cancelBackgroundSettings })

  render(<BackgroundSettingsSurface route={{ target: 'sticky-note', noteId: NOTE_ID }} />)
  await screen.findByTestId('opacity')
  fireEvent.click(screen.getByRole('button', { name: 'choose' }))
  await waitFor(() => expect(screen.getByTestId('image-url')).toHaveTextContent('arkdown://new'))
  fireEvent.click(screen.getByRole('button', { name: 'remove' }))
  await waitFor(() => expect(screen.getByTestId('image-url')).toHaveTextContent('none'))
  fireEvent.click(screen.getByRole('button', { name: 'apply' }))
  await waitFor(() => expect(applyBackground).toHaveBeenCalledWith(target, DEFAULT_BACKGROUND_SETTINGS))
  await waitFor(() => expect(cancelBackgroundSettings).toHaveBeenCalledWith(target))
  fireEvent.click(screen.getByRole('button', { name: 'cancel' }))
  await waitFor(() => expect(cancelBackgroundSettings).toHaveBeenCalledTimes(2))
})
