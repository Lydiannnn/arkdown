import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { DefaultApplicationsSection } from '../../src/renderer/settings/DefaultApplicationsSection'
const label = '将Arkdown设为Markdown文件和文本文档的默认程序'

it('enables and disables directly, displaying only the effective result', async () => {
  const get = vi.fn(async () => ({ ok: true as const, value: { markdown: false, text: false } }))
  const set = vi.fn(async (enabled: boolean) => ({ ok: true as const, value: { markdown: enabled, text: enabled } }))
  const open = vi.fn()
  window.arkdown = { getDefaultApplicationsStatus: get, setDefaultApplicationsEnabled: set, openDefaultApplicationsSettings: open } as never
  render(<DefaultApplicationsSection />)
  const box = screen.getByRole('checkbox', { name: label })
  await waitFor(() => expect(box).toBeEnabled())
  fireEvent.click(box)
  await waitFor(() => expect(box).toBeChecked())
  expect(set).toHaveBeenLastCalledWith(true)
  fireEvent.click(box)
  await waitFor(() => expect(set).toHaveBeenLastCalledWith(false))
  await waitFor(() => expect(box).not.toBeChecked())
  expect(open).not.toHaveBeenCalled()
})

it('shows partial state and opens Settings only after a separate manual click', async () => {
  const get = vi.fn(async () => ({ ok: true as const, value: { markdown: false, text: false } }))
  const set = vi.fn(async () => ({ ok: true as const, value: { markdown: true, text: false } }))
  const open = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = { getDefaultApplicationsStatus: get, setDefaultApplicationsEnabled: set, openDefaultApplicationsSettings: open } as never
  render(<DefaultApplicationsSection />)
  const box = screen.getByRole('checkbox', { name: label })
  await waitFor(() => expect(box).toBeEnabled())
  fireEvent.click(box)
  expect(await screen.findByRole('alert')).toHaveTextContent('.txt')
  expect(box).toBePartiallyChecked()
  expect(open).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '手动设置' }))
  await waitFor(() => expect(open).toHaveBeenCalledOnce())
  get.mockResolvedValue({ ok: true, value: { markdown: true, text: true } })
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  await waitFor(() => expect(box).toBeChecked())
})

it('lets a partial result be disabled on the next click instead of repeatedly enabling', async () => {
  const set = vi.fn(async (enabled: boolean) => ({ ok: true as const, value: { markdown: enabled, text: false } }))
  window.arkdown = {
    getDefaultApplicationsStatus: async () => ({ ok: true, value: { markdown: false, text: false } }),
    setDefaultApplicationsEnabled: set,
  } as never
  render(<DefaultApplicationsSection />)
  const box = screen.getByRole('checkbox', { name: label })
  await waitFor(() => expect(box).toBeEnabled())
  fireEvent.click(box)
  await waitFor(() => expect(box).toBePartiallyChecked())
  fireEvent.click(box)
  await waitFor(() => expect(set).toHaveBeenLastCalledWith(false))
  await waitFor(() => expect(box).not.toBePartiallyChecked())
  expect(box).not.toBeChecked()
  fireEvent.click(box)
  await waitFor(() => expect(set).toHaveBeenLastCalledWith(true))
  await waitFor(() => expect(box).toBePartiallyChecked())
})

it('re-reads actual status after a failed operation without losing the error message', async () => {
  const get = vi.fn(async () => ({ ok: true as const, value: { markdown: true, text: true } }))
  window.arkdown = {
    getDefaultApplicationsStatus: get,
    setDefaultApplicationsEnabled: async () => {
      get.mockResolvedValue({ ok: true, value: { markdown: false, text: true } })
      return { ok: false, error: { code: 'DEFAULT_APPLICATIONS_RELEASE_FAILED', message: '取消关联未完成' } }
    },
  } as never
  render(<DefaultApplicationsSection />)
  const box = screen.getByRole('checkbox', { name: label })
  await waitFor(() => expect(box).toBeChecked())
  fireEvent.click(box)
  expect(await screen.findByRole('alert')).toHaveTextContent('取消关联未完成')
  expect(box).toBePartiallyChecked()
})

it('disables the control if status is unavailable instead of guessing which operation to perform', async () => {
  window.arkdown = {
    getDefaultApplicationsStatus: async () => ({ ok: false, error: { code: 'OPERATION_FAILED', message: '读取失败' } }),
    setDefaultApplicationsEnabled: vi.fn(),
  } as never
  render(<DefaultApplicationsSection />)
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败')
  expect(screen.getByRole('checkbox', { name: label })).toBeDisabled()
})
