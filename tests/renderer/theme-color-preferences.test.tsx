import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PreferencesPage } from '../../src/renderer/settings/PreferencesPage'

const initialAppearance = {
  minimumContentMarginPx: 30,
  maximumContentWidthPx: 1200,
  preserveSingleLineBreaks: true,
  spellCheckEnabled: false,
  showEditIndicators: false,
  editorTheme: 'minimal' as const,
  headingLatinFont: 'Microsoft YaHei',
  headingCjkFont: 'Microsoft YaHei',
  bodyLatinFont: 'Microsoft YaHei',
  bodyCjkFont: 'Microsoft YaHei',
  themeColor: '#C62828',
  micaOpacityPercent: 0 as const,
}

describe('theme color preferences UI', () => {
  it('offers nine presets and immediately persists the selected standard blue preset', () => {
    const save = vi.fn()
    render(
      <PreferencesPage
        initialAppearance={initialAppearance}
        initialSearch={{ provider: 'bing', customTemplate: '' }}
        onAppearanceChange={save}
        onClose={() => undefined}
        onSearchChange={() => undefined}
        onArknoteChange={() => undefined}
        systemFonts={['Microsoft YaHei']}
      />,
    )

    const presets = screen.getAllByRole('button', { name: /主题颜色：/ })
    expect(presets).toHaveLength(9)
    const preferencesPage = screen.getByRole('main', { name: '偏好设置' })
    expect(preferencesPage.style.getPropertyValue('--theme-color-rgb'))
      .toBe('198 40 40')
    expect(screen.getByRole('button', { name: '主题颜色：红色' }))
      .toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: '主题颜色：标准蓝色' }))
    expect(screen.getByText('#3677B7')).toBeVisible()
    expect(preferencesPage.style.getPropertyValue('--theme-color-rgb'))
      .toBe('54 119 183')
    expect(save).toHaveBeenCalledExactlyOnceWith({ themeColor: '#3677B7' })
  })

  it('supports a custom color and then selects the red preset', () => {
    const change = vi.fn()
    render(
      <PreferencesPage
        initialAppearance={{ ...initialAppearance, themeColor: '#123456' }}
        initialSearch={{ provider: 'bing', customTemplate: '' }}
        onAppearanceChange={change}
        onClose={() => undefined}
        onSearchChange={() => undefined}
        onArknoteChange={() => undefined}
        systemFonts={['Microsoft YaHei']}
      />,
    )

    const custom = screen.getByLabelText('自定义主题颜色')
    expect(custom).toHaveValue('#123456')
    fireEvent.change(custom, { target: { value: '#ABCDEF' } })
    expect(screen.getByText('#ABCDEF')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '主题颜色：红色' }))
    expect(screen.getByText('#C62828')).toBeVisible()
    expect(change.mock.calls.map(([patch]) => patch)).toEqual([
      { themeColor: '#ABCDEF' },
      { themeColor: '#C62828' },
    ])
  })
})
