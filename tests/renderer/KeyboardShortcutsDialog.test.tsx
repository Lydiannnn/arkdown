import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeyboardShortcutsDialog } from '../../src/renderer/settings/KeyboardShortcutsDialog'
import { applyShortcutUpdate, type ObservedShortcutSnapshot, type ObservedShortcutUpdate } from '../../src/shared/keyboard-shortcuts'
import { ShortcutPreferenceDraft } from '../../src/renderer/settings/shortcut-preference-draft'
import { createPreferencePersistence } from '../../src/renderer/settings/preference-update-queue'

async function setup() {
  let snapshot: ObservedShortcutSnapshot = { bindings: {}, revision: 0, observation: { version: 1, minimumBaseRevision: 0, fields: {} } }
  const draft = new ShortcutPreferenceDraft(createPreferencePersistence())
  const api = {
    setShortcutRecording: vi.fn(async (_active: boolean) => ({ ok: true as const, value: null })),
    getKeyboardShortcuts: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    updateKeyboardShortcuts: vi.fn(async (input: ObservedShortcutUpdate) => {
      try { snapshot = { ...snapshot, bindings: applyShortcutUpdate(snapshot.bindings, input.change), revision: snapshot.revision + 1 }; return { ok: true as const, value: { snapshot, error: null } } }
      catch (error) { return { ok: true as const, value: { snapshot, error: (error as Error).message } } }
    }),
  }
  Object.assign(window, { arkdown: api })
  const close = vi.fn()
  const view = render(<KeyboardShortcutsDialog snapshot={snapshot} draft={draft} onCancel={close} onSnapshot={() => {}} />)
  await waitFor(() => expect(screen.getByRole('button', { name: '修改 保存' })).toBeEnabled())
  const saveRow = () => screen.getByRole('row', { name: /保存 Ctrl\+S/ })
  return { api, close, saveRow, draft, view, original: structuredClone(snapshot) }
}

afterEach(() => vi.restoreAllMocks())

describe('KeyboardShortcutsDialog', () => {
  it('offers Modify and Default but no Clear for builtin actions', async () => {
    const t = await setup()
    const row = screen.getByRole('row', { name: /撤销 Ctrl\+Z/ })
    expect(within(row).queryByRole('button', { name: '清除 撤销' })).toBeNull()
    expect(within(row).getByRole('button', { name: '恢复默认 撤销' })).toBeDisabled()
    fireEvent.click(within(row).getByRole('button', { name: '修改 撤销' }))
    await screen.findByText('请按快捷键…')
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR', ctrlKey: true, altKey: true })
    await waitFor(() => expect(t.api.updateKeyboardShortcuts).toHaveBeenCalledWith({ observed: t.original, change: { id: 'edit.undo', accelerator: 'Ctrl+Alt+R' } }))
  })
  it('keeps recording protection until an asynchronous save settles, including Escape presses', async () => {
    const t = await setup()
    let finish!: (value: Awaited<ReturnType<typeof t.api.updateKeyboardShortcuts>>) => void
    t.api.updateKeyboardShortcuts.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    fireEvent.click(within(t.saveRow()).getByRole('button', { name: '修改 保存' }))
    await screen.findByText('请按快捷键…')
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR', ctrlKey: true, altKey: true })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(t.api.setShortcutRecording.mock.calls.map(call => call[0])).toEqual([true])
    expect(t.close).not.toHaveBeenCalled()
    await act(async () => finish({ ok: true, value: { snapshot: { ...t.original, bindings: { 'file.save': 'Ctrl+Alt+R' }, revision: 1 }, error: null } }))
    await waitFor(() => expect(t.api.setShortcutRecording).toHaveBeenLastCalledWith(false))
  })
  it('captures a combination without dispatching the original window action', async () => {
    const t = await setup()
    const action = vi.fn()
    window.addEventListener('keydown', action)
    fireEvent.click(within(t.saveRow()).getByRole('button', { name: '修改 保存' }))
    await screen.findByText('请按快捷键…')
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR', ctrlKey: true, altKey: true })
    await waitFor(() => expect(t.api.updateKeyboardShortcuts).toHaveBeenCalledWith({ observed: t.original, change: { id: 'file.save', accelerator: 'Ctrl+Alt+R' } }))
    expect(action).not.toHaveBeenCalled()
    expect(t.api.setShortcutRecording.mock.calls.map(call => call[0])).toEqual([true, false])
    window.removeEventListener('keydown', action)
  })
  it('cancels recording on the first Escape and closes only on the next Escape', async () => {
    const t = await setup()
    fireEvent.click(within(t.saveRow()).getByRole('button', { name: '修改 保存' }))
    await screen.findByText('请按快捷键…')
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(t.api.setShortcutRecording).toHaveBeenLastCalledWith(false))
    expect(t.close).not.toHaveBeenCalled()
    expect(t.api.updateKeyboardShortcuts).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(t.close).toHaveBeenCalledOnce())
  })
  it('shows a conflict without overwriting an existing binding and exposes clear/default actions', async () => {
    const t = await setup()
    fireEvent.click(within(t.saveRow()).getByRole('button', { name: '修改 保存' }))
    await screen.findByText('请按快捷键…')
    fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ctrlKey: true })
    expect(await screen.findByRole('alert')).toHaveTextContent('新建文档')
    expect(t.api.updateKeyboardShortcuts).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消录入 保存' }))
    await waitFor(() => expect(t.api.setShortcutRecording).toHaveBeenLastCalledWith(false))
    fireEvent.click(within(t.saveRow()).getByRole('button', { name: '清除 保存' }))
    await waitFor(() => expect(t.api.updateKeyboardShortcuts).toHaveBeenCalledWith({ observed: t.original, change: { id: 'file.save', accelerator: null } }))
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: '恢复全部默认' }))
    await waitFor(() => expect(t.api.updateKeyboardShortcuts).toHaveBeenLastCalledWith({ observed: expect.objectContaining({ revision: 1 }), change: { resetAll: true } }))
  })
  it('keeps the observation from recording start when its parent refreshes during capture', async () => {
    const t = await setup()
    fireEvent.click(screen.getByRole('button', { name: '修改 保存' }))
    await screen.findByText('请按快捷键…')
    const refreshed = { ...t.original, revision: 5, observation: { ...t.original.observation, fields: { 'file.save': 5 } } }
    t.view.rerender(<KeyboardShortcutsDialog snapshot={refreshed} draft={t.draft} onCancel={t.close} onSnapshot={() => {}} />)
    fireEvent.keyDown(window, { key: 'r', code: 'KeyR', ctrlKey: true, altKey: true })
    await waitFor(() => expect(t.api.updateKeyboardShortcuts).toHaveBeenCalledExactlyOnceWith({
      observed: t.original, change: { id: 'file.save', accelerator: 'Ctrl+Alt+R' },
    }))
  })
})
