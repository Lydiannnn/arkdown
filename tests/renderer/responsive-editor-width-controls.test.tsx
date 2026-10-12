import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { PreferencesPage } from '../../src/renderer/settings/PreferencesPage'

const responsiveAppearance = {
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

it('persists independent minimum-margin and maximum-width controls immediately', () => {
  const change = vi.fn()
  render(
    <PreferencesPage
      initialAppearance={responsiveAppearance}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={change}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={['Microsoft YaHei']}
    />,
  )

  const margin = screen.getByLabelText('最小边距')
  const width = screen.getByLabelText('正文宽度')
  expect(margin).toHaveAttribute('min', '30')
  expect(margin).toHaveAttribute('max', '150')
  expect(width).toHaveAttribute('min', '600')
  expect(width).toHaveAttribute('max', '1200')

  fireEvent.change(margin, { target: { value: '72' } })
  fireEvent.change(width, { target: { value: '980' } })
  expect(screen.getByText('72px')).toBeVisible()
  expect(screen.getByText('980px')).toBeVisible()
  expect(change.mock.calls.map(([patch]) => patch)).toEqual([
    { minimumContentMarginPx: 72 },
    { maximumContentWidthPx: 980 },
  ])
})
