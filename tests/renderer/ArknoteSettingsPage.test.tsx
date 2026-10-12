import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ArknoteSettingsPage } from '../../src/renderer/settings/ArknoteSettingsPage'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../src/shared/arknote-preferences'
import type { ArkdownApi } from '../../src/shared/contracts'

it('answers the service quit handshake only after the latest queued setting is saved', async () => {
  let prepare: (() => Promise<boolean>) | undefined
  let finish!: () => void
  const first = new Promise<void>(resolve => { finish = resolve })
  const set = vi.fn(async input => { if (set.mock.calls.length === 1) await first; return { ok: true as const, value: { ...DEFAULT_ARKNOTE_PREFERENCES, ...input } } })
  const close = vi.fn(), detach = vi.fn()
  window.arkdown = { getArknotePreferences: async () => ({ ok: true, value: DEFAULT_ARKNOTE_PREFERENCES }),
    setArknotePreferences: set, onPrepareClose: (handler: () => Promise<boolean>) => { prepare = handler; return detach } } as unknown as ArkdownApi
  const view = render(<ArknoteSettingsPage onClose={close} />)
  const toggle = await screen.findByRole('checkbox', { name: '开机启动' })
  fireEvent.click(toggle); fireEvent.click(toggle)
  expect(prepare).toBeTypeOf('function')
  const ready = prepare!()
  expect(close).not.toHaveBeenCalled()
  await act(async () => { finish(); expect(await ready).toBe(true) })
  expect(set).toHaveBeenCalledTimes(2)
  expect(set.mock.calls[1][0].launchAtLogin).toBe(false)
  const approvedUnload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(approvedUnload)
  expect(approvedUnload.defaultPrevented).toBe(false)
  // Another resource may cancel quit; a later edit must re-arm the close guard.
  fireEvent.click(toggle)
  const changedUnload = new Event('beforeunload', { cancelable: true })
  await act(async () => { window.dispatchEvent(changedUnload); await Promise.resolve() })
  expect(changedUnload.defaultPrevented).toBe(true)
  view.unmount()
  expect(detach).toHaveBeenCalledOnce()
})

it('shows the exact Arknote settings directory and saves through the service API', async () => {
  const setArknotePreferences = vi.fn(async (value) => ({ ok: true as const, value }))
  window.arkdown = {
    getArknotePreferences: vi.fn(async () => ({
      ok: true,
      value: DEFAULT_ARKNOTE_PREFERENCES,
    })),
    setArknotePreferences,
  } as unknown as ArkdownApi

  document.title = 'Arkdown'
  render(<ArknoteSettingsPage onClose={vi.fn()} />)

  const directory = await screen.findByRole('navigation', { name: 'Arknote 设置目录' })
  const shell = screen.getByRole('main', { name: 'Arknote 设置' })
  expect(shell).toHaveClass('preferences-shell')
  expect(screen.getByLabelText('窗口拖动区域')).toHaveClass('preferences-page-header')
  expect(screen.getByRole('region', { name: '设置内容' })).toHaveClass('preferences-page-content')
  expect(screen.getByLabelText('设置操作')).toHaveClass('preferences-page-actions')
  expect(document.title).toBe('设置 — Arknote')
  expect(within(directory).getByRole('link', { name: 'Arknote' })).toHaveClass('preferences-toc-primary')
  for (const name of ['开机启动', '默认材质', '默认颜色']) {
    expect(within(directory).getByRole('link', { name })).toHaveClass('preferences-toc-secondary')
  }

  expect(screen.queryByText('免安装版启用开机启动时，如果移动了程序文件夹，开机启动将失效')).not.toBeInTheDocument()
  fireEvent.click(await screen.findByRole('checkbox', { name: '开机启动' }))
  expect(screen.getByText('免安装版启用开机启动时，如果移动了程序文件夹，开机启动将失效')).toBeVisible()

  expect(within(directory).getByRole('link', { name: '右键菜单' })).toHaveClass('preferences-toc-primary')
  const traySection = screen.getByRole('region', { name: '右键菜单' })
  expect(within(traySection).getByLabelText('在桌面右键菜单中增加“创建新便签”')).toBeVisible()
  expect(within(traySection).getAllByRole('checkbox')).toHaveLength(1)
  expect(within(traySection).queryByText(/双击|服务状态|注册表路径/u)).not.toBeInTheDocument()

  expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  await waitFor(() => expect(setArknotePreferences).toHaveBeenCalledWith(expect.objectContaining({
    launchAtLogin: true,
    stickyNotes: DEFAULT_ARKNOTE_PREFERENCES.stickyNotes,
    registerDesktopContextMenu: DEFAULT_ARKNOTE_PREFERENCES.registerDesktopContextMenu,
  })))
})

it('marks a load failure as selectable without enabling the settings shell', async () => {
  window.arkdown = {
    getArknotePreferences: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'OPERATION_FAILED' as const, message: '无法读取 Arknote 设置' },
    })),
  } as unknown as ArkdownApi

  render(<ArknoteSettingsPage onClose={vi.fn()} />)

  expect(await screen.findByRole('alert')).toHaveAttribute('data-ui-selectable', 'true')
  expect(screen.getByRole('alert')).toHaveAttribute('tabindex', '0')
  expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled()
})
