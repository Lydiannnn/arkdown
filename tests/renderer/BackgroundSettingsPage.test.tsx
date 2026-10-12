import { fireEvent, render, screen } from '@testing-library/react'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { BackgroundSettingsPage } from '../../src/renderer/backgrounds/BackgroundSettingsPage'
import { DEFAULT_BACKGROUND_SETTINGS, type BackgroundSettings } from '../../src/shared/background-settings'

vi.mock('../../src/renderer/backgrounds/BackgroundImageLayer', () => ({
  BackgroundImageLayer: ({
    anchor,
    imageUrl,
    onImageCoverageChange,
  }: {
    anchor: string
    imageUrl: string | null
    onImageCoverageChange?(coverage: 'covered' | 'undersized'): void
  }) => {
    useEffect(() => {
      onImageCoverageChange?.(imageUrl === '/undersized.webp' ? 'undersized' : 'covered')
    }, [imageUrl, onImageCoverageChange])
    return <div aria-hidden="true" data-anchor={anchor} data-testid="settings-preview-layer" />
  },
}))

const withImage: BackgroundSettings = {
  ...DEFAULT_BACKGROUND_SETTINGS,
  imageRelativePath: 'backgrounds/forest.webp',
}

function renderPage(overrides: Partial<{
  imageUrl: string | null
  onApply(settings: BackgroundSettings): void
  onCancel(): void
  onChooseImage(): void
  onPreview(settings: BackgroundSettings): void
  onRemoveImage(): void
  settings: BackgroundSettings
}> = {}) {
  const props = {
    imageUrl: '/forest.webp',
    onApply: vi.fn(),
    onCancel: vi.fn(),
    onChooseImage: vi.fn(),
    onPreview: vi.fn(),
    onRemoveImage: vi.fn(),
    settings: withImage,
    ...overrides,
  }
  render(<BackgroundSettingsPage {...props} />)
  return props
}

describe('BackgroundSettingsPage', () => {
  it('uses the close-button cancel path for an unhandled Escape after a preview edit', () => {
    const { onCancel, onPreview, onApply } = renderPage()
    fireEvent.change(screen.getByLabelText('图片不透明度'), { target: { value: '71' } })
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ imageOpacityPercent: 71 }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onApply).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('leaves handled Escape, IME composition and key repeats to their current interaction', () => {
    const { onCancel } = renderPage()
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    handled.preventDefault()
    fireEvent(window, handled)
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true })
    fireEvent.keyDown(window, { key: 'Escape', keyCode: 229 })
    fireEvent.keyDown(window, { key: 'Escape', repeat: true })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it.each(['menu', 'listbox', 'dialog'])('lets an open %s handle Escape before closing the page', (role) => {
    const { onCancel } = renderPage()
    const popup = render(<div role={role} aria-modal={role === 'dialog' ? 'true' : undefined} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    popup.unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('provides a draggable header for the hidden-title-bar settings window', async () => {
    const css = await readFile(path.join(
      process.cwd(),
      'src/renderer/backgrounds/background-settings-page.css',
    ), 'utf8')

    expect(css).toMatch(/\.background-settings-page__header\s*\{[^}]*-webkit-app-region:\s*drag/u)
  })

  it('uses a compact title bar with the shared close icon and no explanatory copy', () => {
    const { onCancel } = renderPage()

    expect(screen.queryByText('背景图片会显示在原有底板之上、正文和控件之下。')).not.toBeInTheDocument()
    const close = screen.getByRole('button', { name: '关闭' })
    expect(close.querySelector('.app-icon')).not.toBeNull()
    fireEvent.click(close)
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('renders the requested defaults, five alignments, and eight mask choices in product order', () => {
    renderPage()

    expect(screen.getByRole('main', { name: '背景设置' })).toBeVisible()
    expect(screen.getByRole('button', { name: '更换图片' })).toBeVisible()
    expect(screen.getByRole('button', { name: '移除背景' })).toBeEnabled()
    expect(screen.getByLabelText('图片不透明度')).toHaveValue('50')
    expect(screen.getByLabelText('图片对齐方式')).toHaveValue('right-bottom')
    expect(screen.getByLabelText('遮罩类型')).toHaveValue('diagonal-top-left')
    expect(screen.getByLabelText('遮罩区域不透明度')).toHaveValue('0')
    expect(screen.getByLabelText('遮罩过渡速度')).toHaveValue('30')
    expect(screen.getByLabelText('遮罩强度')).toHaveValue('80')
    expect(screen.getByLabelText('遮罩区域不透明度')).toBeEnabled()
    expect(screen.getByLabelText('遮罩过渡速度')).toBeEnabled()
    expect(screen.getByLabelText('遮罩强度')).toBeEnabled()
    expect(screen.getByLabelText('图片对齐方式').querySelectorAll('option')).toHaveLength(5)
    expect(Array.from(screen.getByLabelText('图片对齐方式').querySelectorAll('option')).map(
      (option) => option.textContent,
    )).toEqual([
      '右下对齐',
      '左上对齐',
      '右上对齐',
      '左下对齐',
      '居中对齐',
    ])
    expect(Array.from(screen.getByLabelText('遮罩类型').querySelectorAll('option')).map(
      (option) => option.textContent,
    )).toEqual([
      '右下对角',
      '无遮罩',
      '圆形',
      '左上对角',
      '右上对角',
      '左下对角',
      '水平中央带',
      '垂直中央带',
    ])
  })

  it('emits copied preview settings for opacity and enabled mask controls', () => {
    const { onPreview } = renderPage()

    fireEvent.change(screen.getByLabelText('图片不透明度'), { target: { value: '73' } })
    expect(onPreview).toHaveBeenLastCalledWith({ ...withImage, imageOpacityPercent: 73 })

    fireEvent.change(screen.getByLabelText('图片对齐方式'), { target: { value: 'center' } })
    expect(onPreview).toHaveBeenLastCalledWith({ ...withImage, imageAlignment: 'center' })

    fireEvent.change(screen.getByLabelText('遮罩类型'), { target: { value: 'circle' } })
    expect(onPreview).toHaveBeenLastCalledWith({ ...withImage, maskType: 'circle' })

    fireEvent.change(screen.getByLabelText('遮罩区域不透明度'), { target: { value: '42' } })
    expect(onPreview).toHaveBeenLastCalledWith({ ...withImage, maskOpacityPercent: 42 })

    fireEvent.change(screen.getByLabelText('遮罩过渡速度'), { target: { value: '80' } })
    expect(onPreview).toHaveBeenLastCalledWith({ ...withImage, maskTransitionPercent: 80 })

    fireEvent.change(screen.getByLabelText('遮罩强度'), { target: { value: '64' } })
    expect(onPreview).toHaveBeenLastCalledWith({ ...withImage, maskStrengthPercent: 64 })
    expect(withImage).toEqual({ ...DEFAULT_BACKGROUND_SETTINGS, imageRelativePath: 'backgrounds/forest.webp' })
  })

  it('delegates image replacement and removal without performing IPC itself', () => {
    const { onChooseImage, onRemoveImage } = renderPage()

    fireEvent.click(screen.getByRole('button', { name: '更换图片' }))
    fireEvent.click(screen.getByRole('button', { name: '移除背景' }))

    expect(onChooseImage).toHaveBeenCalledOnce()
    expect(onRemoveImage).toHaveBeenCalledOnce()
  })

  it('makes the complete 16:9 preview keyboard-accessible for choosing an image', async () => {
    const { onChooseImage } = renderPage()
    const preview = screen.getByRole('button', { name: '更换背景图片' })

    fireEvent.click(preview)
    expect(onChooseImage).toHaveBeenCalledOnce()
    expect(screen.getByTestId('settings-preview-layer')).toHaveAttribute('data-anchor', 'right-bottom')

    const css = await readFile(path.join(
      process.cwd(),
      'src/renderer/backgrounds/background-settings-page.css',
    ), 'utf8')
    expect(css).toMatch(/\.background-settings-page__preview\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*9/u)
    expect(css).toMatch(/\.background-settings-page__preview\s*\{[\s\S]*?max-width:\s*520px/u)
  })

  it('uses add-image wording and disables removal without an image', () => {
    renderPage({
      imageUrl: null,
      settings: { ...withImage, imageRelativePath: null },
    })

    expect(screen.getByRole('button', { name: '添加图片' })).toBeVisible()
    expect(screen.getByRole('button', { name: '移除背景' })).toBeDisabled()
  })

  it('shows the undersized-image warning reported by the preview layer', () => {
    renderPage({ imageUrl: '/undersized.webp' })

    expect(screen.getByText(
      '图片尺寸较小，放大窗口后可能出现未覆盖区域',
    )).toHaveAttribute('role', 'status')
  })

  it.each(['left-top', 'right-top', 'left-bottom', 'center'] as const)(
    'previews the current %s alignment rather than a fixed anchor', (imageAlignment) => {
      renderPage({ settings: { ...withImage, imageAlignment } })
      expect(screen.getByTestId('settings-preview-layer')).toHaveAttribute('data-anchor', imageAlignment)
    },
  )

  it('uses a readable semantic warning color in light and dark modes', async () => {
    const css = await readFile(path.join(
      process.cwd(),
      'src/renderer/backgrounds/background-settings-page.css',
    ), 'utf8')

    expect(css).toMatch(/--background-settings-warning:\s*#b42318/u)
    expect(css).toMatch(/:root\[data-arkdown-theme="dark"\][\s\S]*?--background-settings-warning:\s*#ffb4ab/u)
    expect(css).toMatch(/\.background-settings-page__warning\s*\{[^}]*color:\s*var\(--background-settings-warning\)/u)
  })

  it('applies the controlled value and cancels independently', () => {
    const { onApply, onCancel } = renderPage()

    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(onApply).toHaveBeenCalledWith(withImage)
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
