import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SearchPreferencesDialog } from '../../src/renderer/settings/SearchPreferencesDialog'
import { choosePreferencesOption } from './preferences-select-test-helpers'

it('saves a built-in browser search provider', async () => {
  const save = vi.fn()
  render(
    <SearchPreferencesDialog
      initial={{ provider: 'bing', customTemplate: '' }}
      onCancel={() => undefined}
      onSave={save}
    />,
  )

  expect(screen.queryByRole('option', { name: 'DuckDuckGo' })).not.toBeInTheDocument()
  expect(screen.getByRole('combobox')).toHaveClass('preferences-compact-select')
  expect(screen.getByRole('combobox').closest('label')).toBeNull()
  choosePreferencesOption('搜索提供商', 'Google')
  fireEvent.click(screen.getByRole('button', { name: '保存' }))

  expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'closing')
  await waitFor(() => expect(save).toHaveBeenCalledWith({
    provider: 'google',
    customTemplate: '',
  }))
})

it('requires a safe HTTPS template for a custom provider', async () => {
  const save = vi.fn()
  render(
    <SearchPreferencesDialog
      initial={{ provider: 'bing', customTemplate: '' }}
      onCancel={() => undefined}
      onSave={save}
    />,
  )

  choosePreferencesOption('搜索提供商', '自定义')
  const template = screen.getByLabelText('自定义搜索地址')
  expect(template.closest('label')).toBeNull()
  expect(template).toHaveAccessibleDescription(/表示搜索内容/)
  expect(screen.getByRole('combobox')).toHaveTextContent('自定义')
  fireEvent.change(template, {
    target: { value: 'http://example.com/?q={query}' },
  })
  expect(screen.getByRole('alert')).toHaveTextContent('必须使用 HTTPS')
  expect(template).toHaveAccessibleDescription(/必须使用 HTTPS/)
  expect(screen.getByRole('alert')).toHaveAttribute('data-ui-selectable', 'true')
  expect(screen.getByRole('alert')).toHaveAttribute('tabindex', '0')
  expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()

  fireEvent.change(template, {
    target: { value: 'https://example.com/?q={query}' },
  })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith({
    provider: 'custom',
    customTemplate: 'https://example.com/?q={query}',
  }))
})

it('marks Baidu as default while preserving saved Bing', () => {
  render(<SearchPreferencesDialog initial={{ provider: 'bing', customTemplate: '' }} onCancel={() => undefined} onSave={() => undefined} />)
  expect(screen.getByRole('combobox')).toHaveTextContent('Bing')
  fireEvent.click(screen.getByRole('combobox'))
  expect(screen.getByRole('option', { name: '百度（默认）' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'Bing' })).toBeInTheDocument()
})
