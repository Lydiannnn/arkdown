import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { BusinessMessageSurface } from '../../src/renderer/modal/BusinessMessageSurface'
import type { BusinessMessageState } from '../../src/shared/business-message-dialog'

const state: BusinessMessageState = { requestId: 'test', title: '保留的草稿', message: '是否恢复？', detail: '文档仍保留。',
  buttons: ['恢复', '暂不恢复'], defaultId: 0, cancelId: 1, dark: true }
beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }))
afterEach(() => vi.unstubAllGlobals())
function setup(value = state) {
  const api = { get: vi.fn(async () => value), ready: vi.fn(async () => true), respond: vi.fn(async () => true) }
  render(<BusinessMessageSurface api={api} />)
  return api
}
it('preserves visible content and focuses the explicit default action without auto-accepting', async () => {
  const api = setup()
  const button = await screen.findByRole('button', { name: '恢复' })
  expect(button).toHaveFocus()
  expect(screen.getByText('文档仍保留。')).toBeInTheDocument()
  expect(screen.getByRole('dialog')).toHaveAccessibleDescription('是否恢复？ 文档仍保留。')
  expect(document.documentElement.dataset.arkdownTheme).toBe('dark')
  await waitFor(() => expect(api.ready).toHaveBeenCalledWith({ requestId: state.requestId, height: 120 })) // jsdom has no layout
  expect(api.respond).not.toHaveBeenCalled()
  fireEvent.click(button)
  expect(api.respond).toHaveBeenCalledExactlyOnceWith({ requestId: state.requestId, response: 0 })
})
it('uses the same cancel index for the close button and retains arbitrary button ordering', async () => {
  const api = setup({ ...state, buttons: ['保留窗口', '复制诊断', '重试关闭'], defaultId: 2, cancelId: 0 })
  expect(await screen.findByRole('button', { name: '重试关闭' })).toHaveFocus()
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(api.respond).toHaveBeenCalledWith({ requestId: state.requestId, response: 0 })
})
it('cancels on Escape and does not submit another action', async () => {
  const api = setup()
  await screen.findByRole('dialog')
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(api.respond).toHaveBeenCalledExactlyOnceWith({ requestId: state.requestId, response: 1 }))
})
it('keeps the dialog usable when Escape fails to deliver, allowing an explicit retry', async () => {
  const api = setup()
  api.respond.mockRejectedValueOnce(new Error('connection failed'))
  await screen.findByRole('dialog')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(await screen.findByRole('alert')).toHaveTextContent('操作未能完成，请重试。')
  expect(screen.getByRole('dialog').closest('[data-state]')).toHaveAttribute('data-state', 'open')
  fireEvent.click(screen.getByRole('button', { name: '暂不恢复' }))
  expect(api.respond).toHaveBeenCalledTimes(2)
})
