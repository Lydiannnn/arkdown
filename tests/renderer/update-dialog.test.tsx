import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { UpdateDialog } from '../../src/renderer/updates/UpdateDialog'
import type { UpdateSnapshot } from '../../src/shared/app-update'
const state: UpdateSnapshot = { revision: 1, currentVersion: '1.0.4', status: 'available', bubbleVisible: true,
  candidate: { version: '1.0.5', mode: 'optional', required: false, message: '新增功能' }, requiredPrompt: 'hidden',
  transfer: { phase: 'idle', received: 0, total: 100, forced: false, error: null, dialog: 'offer' } }
it('offers later, download and exact-version skip as separate actions', () => {
  const action = vi.fn(); render(<UpdateDialog state={state} onAction={action} onExit={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '下载新版本' })); expect(action).toHaveBeenLastCalledWith('download')
  fireEvent.click(screen.getByRole('button', { name: '暂不更新' })); expect(action).toHaveBeenLastCalledWith('later')
  fireEvent.click(screen.getByRole('button', { name: '跳过该版本' })); expect(action).toHaveBeenLastCalledWith('skip')
})
it('continue download only dismisses; cancel is a distinct action', () => {
  const action = vi.fn(); render(<UpdateDialog state={{ ...state, transfer: { ...state.transfer!, phase: 'downloading', received: 45, dialog: 'progress' } }} onAction={action} onExit={() => {}} />)
  expect(screen.getByRole('progressbar')).toHaveAttribute('value', '45')
  fireEvent.click(screen.getByRole('button', { name: '继续下载' })); expect(action).toHaveBeenLastCalledWith('dismiss')
  fireEvent.click(screen.getByRole('button', { name: '取消下载' })); expect(action).toHaveBeenLastCalledWith('cancel-download')
})
it('required download has only cancel-update and never a skip or background-dismiss path', () => {
  const action = vi.fn(), exit = vi.fn(); render(<UpdateDialog state={{ ...state, candidate: { ...state.candidate!, required: true },
    transfer: { ...state.transfer!, phase: 'downloading', forced: true, dialog: 'progress' } }} onAction={action} onExit={exit} />)
  expect(screen.queryByText('继续下载')).not.toBeInTheDocument(); expect(screen.queryByText('跳过该版本')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '取消更新' })); expect(action).toHaveBeenCalledWith('cancel-download')
})
it('ready confirmation cannot start installation on cancel', () => {
  const action = vi.fn(); render(<UpdateDialog state={{ ...state, transfer: { ...state.transfer!, phase: 'ready', received: 100, dialog: 'install' } }} onAction={action} onExit={() => {}} />)
  expect(screen.getByText('现在安装 1.0.5 版本吗？')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '取消' })); expect(action).toHaveBeenLastCalledWith('dismiss')
  fireEvent.click(screen.getByRole('button', { name: '安装' })); expect(action).toHaveBeenLastCalledWith('install')
})
