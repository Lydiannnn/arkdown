import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { DocumentFindBar } from '../../src/renderer/editor/DocumentFindBar'

it('leaves empty search on outside blur, but preserves a query or internal focus', () => {
  const onClose = vi.fn()
  const props = { current: 0, total: 0, focusRequest: 1, onClose, onNavigate: vi.fn(), onQuery: vi.fn() }
  const view = render(<DocumentFindBar {...props} query="" />)
  const input = screen.getByRole('searchbox')
  fireEvent.blur(input, { relatedTarget: screen.getByRole('button', { name: '关闭文档搜索' }) })
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.blur(input, { relatedTarget: document.body })
  expect(onClose).toHaveBeenCalledTimes(1)
  view.rerender(<DocumentFindBar {...props} query="needle" />)
  fireEvent.blur(input, { relatedTarget: document.body })
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('shows m/n and provides toolbar-standard previous and next controls', () => {
  const onNavigate = vi.fn()
  const view = render(<DocumentFindBar
    current={0}
    focusRequest={1}
    onClose={vi.fn()}
    onNavigate={onNavigate}
    onQuery={vi.fn()}
    query="needle"
    total={0}
  />)
  expect(screen.getByText('0/0')).toBeVisible()
  expect(screen.getByRole('button', { name: '上一条搜索结果' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '下一条搜索结果' })).toBeDisabled()

  view.rerender(<DocumentFindBar
    current={2}
    focusRequest={1}
    onClose={vi.fn()}
    onNavigate={onNavigate}
    onQuery={vi.fn()}
    query="needle"
    total={5}
  />)
  const previous = screen.getByRole('button', { name: '上一条搜索结果' })
  const next = screen.getByRole('button', { name: '下一条搜索结果' })
  const count = screen.getByText('2/5')
  expect(count).toHaveAttribute('aria-label', '当前第 2 条，共 5 条搜索结果')
  expect(previous.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(next.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(previous).toHaveAttribute('data-tooltip', '上一条')
  expect(next).toHaveAttribute('data-tooltip', '下一条')
  fireEvent.click(previous)
  fireEvent.click(next)
  expect(onNavigate.mock.calls).toEqual([['previous'], ['next']])
})

it('uses Enter and Shift+Enter without moving focus out of the query', () => {
  const onNavigate = vi.fn()
  render(<DocumentFindBar
    current={1}
    focusRequest={1}
    onClose={vi.fn()}
    onNavigate={onNavigate}
    onQuery={vi.fn()}
    query="needle"
    total={2}
  />)
  const input = screen.getByRole('searchbox', { name: '在文档中搜索' })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(onNavigate.mock.calls).toEqual([['next'], ['previous']])
  expect(input).toHaveFocus()
})
