import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CloseRecoverySurface } from '../../src/renderer/close/CloseRecoverySurface'
import type { CloseRecoveryState } from '../../src/shared/close-recovery'

const state: CloseRecoveryState = { attemptId: '00000000-0000-4000-8000-000000000001', generation: 1,
  stage: 'settle-document', error: null, feedback: 'long-wait', rendererUnavailable: false, elapsedMs: 35000,
  canReturn: false, canRetry: false, confirmAi: false, dark: true, themeColor: '#c82929' }
function setup(initial = state) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 490, 210))
  let changed!: (value: CloseRecoveryState) => void
  const api = { get: vi.fn(async () => initial), ready: vi.fn(async () => true), subscribe: (handler: typeof changed) => { changed = handler; return vi.fn() }, act: vi.fn(async () => true) }
  render(<CloseRecoverySurface api={api} />)
  return { api, changed: (value: CloseRecoveryState) => act(() => changed(value)) }
}
afterEach(() => vi.restoreAllMocks())
it('explains long pending work without offering destructive shortcuts or false retries', async () => {
  const s = setup()
  expect(await screen.findByText(/这一阶段等待较久/)).toBeInTheDocument()
  expect(s.api.ready).toHaveBeenCalledWith({ attemptId: state.attemptId, generation: state.generation, height: 210 })
  expect(screen.getByRole('button', { name: '返回编辑' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '重试关闭' })).toBeDisabled()
  expect(screen.queryByRole('button', { name: /强制/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '复制诊断' }))
  expect(await screen.findByText('诊断已复制。')).toBeInTheDocument()
  expect(s.api.act).toHaveBeenCalledWith({ attemptId: state.attemptId, generation: 1, action: 'copy' })
})
it('shows a distinct saved-body/draft failure and uses main-provided recovery gates', async () => {
  const s = setup({ ...state, error: 'draft-end-failed', canReturn: true, canRetry: true })
  expect(await screen.findByText('草稿处理未能完成，当前内容保留。')).toBeInTheDocument()
  expect(screen.queryByText(/文档保存失败/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '返回编辑' })).toBeEnabled()
  s.changed({ ...state, error: 'restore-failed' })
  expect(screen.getByRole('button', { name: '返回编辑' })).toBeDisabled()
})
it('requires an explicit AI stop choice and does not automatically approve it', async () => {
  const s = setup({ ...state, confirmAi: true })
  const stop = await screen.findByRole('button', { name: '停止任务并关闭' })
  expect(s.api.act).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '重试关闭' })).not.toBeInTheDocument()
  fireEvent.click(stop)
  expect(s.api.act).toHaveBeenCalledExactlyOnceWith({ attemptId: state.attemptId, generation: 1, action: 'stop-ai-and-close' })
})
