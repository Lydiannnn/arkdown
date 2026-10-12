import { render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { PreferencesPage } from '../../src/renderer/settings/PreferencesPage'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'

const initialAppearance = {
  minimumContentMarginPx: 30,
  maximumContentWidthPx: 1200,
  preserveSingleLineBreaks: true,
  spellCheckEnabled: false,
  showEditIndicators: false,
  editorTheme: 'minimal' as const,
  headingLatinFont: 'Arial',
  headingCjkFont: 'Microsoft YaHei',
  bodyLatinFont: 'Arial',
  bodyCjkFont: 'Microsoft YaHei',
  themeColor: '#c62828',
  micaOpacityPercent: 0 as const,
}

it('indexes only primary and secondary preferences in their semantic groups', () => {
  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={['Arial', 'Microsoft YaHei']}
    />,
  )

  const directory = screen.getByRole('navigation', { name: '偏好设置目录' })
  const primaryLinks = Array.from(directory.querySelectorAll<HTMLAnchorElement>(
    '.preferences-toc-primary',
  ))
  expect(primaryLinks.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['浏览器搜索', '#preferences-search-heading'],
    ['主题', '#preferences-theme-heading'],
    ['编辑器', '#preferences-editor-heading'],
    ['Arknote', '#preferences-arknote-heading'],
    ['右键菜单', '#preferences-context-menu-heading'],
    ['大模型设置', '#preferences-large-model-heading'],
    ['截图OCR识别', '#preferences-screenshot-heading'],
    ['文档转换', '#preferences-document-conversion-heading'],
  ])
  for (const [name, target] of [
    ['浏览器搜索', '#preferences-search-heading'],
    ['主题', '#preferences-theme-heading'],
    ['编辑器', '#preferences-editor-heading'],
    ['右键菜单', '#preferences-context-menu-heading'],
    ['大模型设置', '#preferences-large-model-heading'],
    ['截图OCR识别', '#preferences-screenshot-heading'],
    ['文档转换', '#preferences-document-conversion-heading'],
  ] as const) {
    const link = within(directory).getByRole('link', { name })
    expect(link).toHaveAttribute('href', target)
    expect(link).toHaveClass('preferences-toc-primary')
  }
  for (const [name, target] of [
    ['主题颜色', '#preferences-theme-color-heading'],
    ['设置背景', '#preferences-background-heading'],
    ['字体选择', '#preferences-font-heading'],
    ['编辑器版面', '#preferences-editor-layout-heading'],
    ['保留单个换行', '#preferences-single-line-breaks-heading'],
    ['默认材质', '#preferences-arknote-materials-heading'],
    ['默认颜色', '#preferences-arknote-colors-heading'],
    ['管理大模型', '#preferences-large-model-manager'],
  ] as const) {
    const link = within(directory).getByRole('link', { name })
    expect(link).toHaveAttribute('href', target)
    expect(link).toHaveClass('preferences-toc-secondary')
  }
  expect(within(directory).queryByRole('link', { name: '最小边距' }))
    .not.toBeInTheDocument()
  expect(within(directory).queryByRole('link', { name: '正文宽度' }))
    .not.toBeInTheDocument()
  expect(within(directory).queryByRole('link', { name: 'Mica不透明度' }))
    .not.toBeInTheDocument()
  expect(screen.queryByLabelText('Mica不透明度')).not.toBeInTheDocument()

  expect(screen.getByRole('heading', { level: 2, name: '主题' })).toBeVisible()
  expect(screen.getByRole('heading', { level: 2, name: '编辑器' })).toBeVisible()
  expect(screen.getByRole('heading', { level: 2, name: '截图OCR识别' })).toBeVisible()
  expect(screen.getByRole('heading', { level: 2, name: '文档转换' })).toBeVisible()
  expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
    '浏览器搜索', '主题', '编辑器', 'Arknote', '右键菜单', '大模型设置', '截图OCR识别',
    '文档转换',
  ])
  for (const [name, headings] of [
    ['主题', ['主题颜色', '设置背景']],
    ['Arknote', ['开机启动', '默认材质', '默认颜色']],
  ] as const) {
    const section = screen.getByRole('region', { name })
    expect(within(section).getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)).toEqual(headings)
  }
  const editorLayout = screen.getByRole('group', { name: '编辑器版面' })
  expect(within(editorLayout).getByLabelText('最小边距')).toBeVisible()
  expect(within(editorLayout).getByLabelText('正文宽度')).toBeVisible()
  expect(within(editorLayout).getByText('最小边距')).toHaveClass(
    'preferences-tertiary-title',
  )
  expect(within(editorLayout).getByText('正文宽度')).toHaveClass(
    'preferences-tertiary-title',
  )

  expect(screen.getByRole('group', { name: '划词翻译' })).toBeVisible()
  expect(screen.getByRole('button', { name: '管理大模型' })).toBeVisible()
})
