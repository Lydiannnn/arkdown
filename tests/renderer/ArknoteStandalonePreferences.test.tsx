import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ArknoteSettingsPage } from '../../src/renderer/settings/ArknoteSettingsPage'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../src/shared/arknote-preferences'
import type { ArkdownApi } from '../../src/shared/contracts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function setup(save = vi.fn(async (value) => ({ ok: true as const, value: { ...DEFAULT_ARKNOTE_PREFERENCES, ...value } }))) {
  const initial = structuredClone(DEFAULT_ARKNOTE_PREFERENCES)
  const preview = vi.fn()
  const onClose = vi.fn()
  window.arkdown = { getArknotePreferences: async () => ({ ok: true, value: initial }),
    previewStickyNoteWallpaperAppearances: preview, setArknotePreferences: save } as unknown as ArkdownApi
  render(<ArknoteSettingsPage onClose={onClose} />)
  return { initial, save, preview, onClose }
}

it('saves changes immediately in order and closes only after the final draft is saved', async () => {
  const first = deferred<any>(); const second = deferred<any>()
  const save = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  const { initial, onClose, preview } = setup(save)
  fireEvent.click(await screen.findByRole('button', { name: '材质设置' }))
  fireEvent.change(screen.getByRole('slider', { name: '暖雾玻璃 模拟透明度' }), { target: { value: '28' } })
  expect(save).toHaveBeenCalledOnce()
  expect(screen.getByRole('slider', { name: '深色玻璃 内发光范围' })).toBeEnabled()
  fireEvent.change(screen.getByRole('slider', { name: '深色玻璃 内发光范围' }), { target: { value: '42' } })
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  expect(save).toHaveBeenCalledOnce()
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled()
  await act(async () => first.resolve({ ok: true, value: { ...initial, ...save.mock.calls[0]![0] } }))
  expect(save).toHaveBeenCalledTimes(2)
  expect(save.mock.calls[1]![0].materialEffects['warm-frosted-glass'].transparency).toBe(.28)
  expect(save.mock.calls[1]![0].materialEffects['clear-glass'].innerGlowRangePx).toBe(42)
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => second.resolve({ ok: true, value: { ...initial, ...save.mock.calls[1]![0] } }))
  expect(onClose).toHaveBeenCalledOnce()
  expect(preview).not.toHaveBeenCalled()
})

it('retains failed edits, shows the failure, and retries the tail before closing', async () => {
  const save = vi.fn().mockResolvedValueOnce({ ok: false, error: { message: 'disk failure' } })
    .mockResolvedValueOnce({ ok: false, error: { message: 'still unavailable' } })
    .mockImplementationOnce(async value => ({ ok: true, value }))
  const { onClose } = setup(save)
  fireEvent.click(await screen.findByRole('button', { name: '材质设置' }))
  fireEvent.change(screen.getByRole('slider', { name: 'Mica 饱和度' }), { target: { value: '37' } })
  expect(await screen.findByRole('alert')).toHaveTextContent('设置未能保存')
  expect(screen.getByRole('slider', { name: 'Mica 饱和度' })).toHaveValue('37')
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled())
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent('设置未能保存')
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(save.mock.calls[2]![0].micaAppearance.saturation).toBe(.37)
})

it('intercepts native close until the accepted save finishes', async () => {
  const pending = deferred<any>()
  const { initial, onClose, save } = setup(vi.fn(() => pending.promise))
  fireEvent.click(await screen.findByRole('checkbox', { name: '开机启动' }))
  const closing = new Event('beforeunload', { cancelable: true })
  act(() => { window.dispatchEvent(closing) })
  expect(closing.defaultPrevented).toBe(true)
  expect(onClose).not.toHaveBeenCalled()
  await act(async () => pending.resolve({ ok: true, value: { ...initial, ...save.mock.calls[0]![0] } }))
  expect(onClose).toHaveBeenCalledOnce()
  const closed = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(closed)
  expect(closed.defaultPrevented).toBe(false)
})

it('returns from material settings on Escape and retains only a close action', async () => {
  const { onClose, save } = setup()
  fireEvent.click(await screen.findByRole('button', { name: '材质设置' }))
  expect(screen.getByRole('heading', { name: '材质设置', level: 1 })).toBeVisible()
  expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.getByRole('heading', { name: 'Arknote 设置', level: 1 })).toBeVisible()
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(save).not.toHaveBeenCalled()
})

it('preserves legacy presets and omits unmodified material recipes in future default updates', async () => {
  const { initial, save, onClose } = setup()
  initial.stickyNotes.colorPresets[7]!.value = '#654321'
  initial.stickyNotes.texturePresets[2]!.opacityPercent = 42
  fireEvent.click(await screen.findByRole('radio', { name: '颜色' }))
  fireEvent.change(screen.getByLabelText('自定义颜色'), { target: { value: '#123456' } })
  fireEvent.click(screen.getByRole('button', { name: '关闭' }))
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  const last = save.mock.calls.at(-1)![0]
  expect(last.stickyNotes).toEqual({ ...initial.stickyNotes, defaultAppearance: 'color', defaultColor: '#123456' })
  expect(last).not.toHaveProperty('materialEffects')
})
