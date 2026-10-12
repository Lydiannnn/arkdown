import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AppTitleBar } from '../../src/renderer/chrome/AppTitleBar'
import { AboutDialog } from '../../src/renderer/about/AboutDialog'
import { useAppUpdate } from '../../src/renderer/updates/use-app-update'
import type { UpdateSnapshot } from '../../src/shared/app-update'
const snapshot: UpdateSnapshot = { revision: 3, status: 'available', currentVersion: '1.0.4', candidate: { version: '1.0.5', required: false, mode: 'optional', message: 'update' }, bubbleVisible: true, requiredPrompt: 'hidden' }
it('places the update button after Help and opens existing About via keyboard/click', () => {
  const open = vi.fn(); render(<AppTitleBar windowState={{ revision: 0, maximized: false, fullscreen: false }} onExecuteItem={() => {}} updateLabel="发现新版本" onOpenUpdate={open} />)
  const button = screen.getByRole('button', { name: '发现新版本' }); button.focus(); expect(button).toHaveFocus(); fireEvent.click(button); expect(open).toHaveBeenCalledOnce()
  expect(button.previousElementSibling).toHaveTextContent('帮助')
})
it('shows current installed version separately and routes the candidate link through a fixed callback', () => {
  const open = vi.fn(); render(<AboutDialog onClose={() => {}} update={snapshot} onOpenUpdateWebsite={open} />)
  expect(screen.getByText('版本 1.0.4')).toBeVisible(); fireEvent.click(screen.getByRole('button', { name: '新版本 1.0.5，前往官网下载' })); expect(open).toHaveBeenCalledOnce()
})
it('rejects late lower-revision reads, detaches subscriptions and notifies About only per interaction', async () => {
  let listener!: (s: UpdateSnapshot) => void; let resolve!: (result: unknown) => void
  const stop = vi.fn(), about = vi.fn(async () => ({ ok: true, value: null }))
  window.arkdown = { getAppUpdateState: () => new Promise(r => { resolve = r }), onAppUpdateChanged: (fn: (s: UpdateSnapshot) => void) => { listener = fn; return stop }, notifyUpdateAbout: about } as never
  const hook = renderHook(({ open }) => useAppUpdate(open), { initialProps: { open: false } })
  act(() => listener(snapshot)); await act(async () => resolve({ ok: true, value: { ...snapshot, revision: 1, candidate: null } }))
  expect(hook.result.current.state?.candidate?.version).toBe('1.0.5')
  hook.rerender({ open: true }); await waitFor(() => expect(about).toHaveBeenCalledTimes(1)); hook.rerender({ open: true }); expect(about).toHaveBeenCalledTimes(1)
  hook.rerender({ open: false }); expect(about).toHaveBeenCalledTimes(2); hook.unmount(); expect(stop).toHaveBeenCalledOnce()
})
it('defers required gating when composition begins before a pending gate claim', async () => {
  const perform = vi.fn(async () => ({ ok: true, value: null }))
  let listener!: (s: UpdateSnapshot) => void
  window.arkdown = { performUpdateAction: perform, onAppUpdateChanged: (fn: (s: UpdateSnapshot) => void) => { listener = fn; return () => {} } } as never
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const hook = renderHook(() => useAppUpdate(false))
  act(() => {
    listener({ ...snapshot, requiredPrompt: 'visible', candidate: { ...snapshot.candidate!, required: true, mode: 'required' } })
    fireEvent.compositionStart(document.body)
  })
  await waitFor(() => expect(perform).toHaveBeenCalledWith('work-started'))
  expect(perform).not.toHaveBeenCalledWith('claim-gate')
  hook.unmount(); focus.mockRestore()
})
