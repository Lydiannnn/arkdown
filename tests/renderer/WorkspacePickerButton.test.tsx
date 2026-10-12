import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkspacePickerButton } from '../../src/renderer/workspace/WorkspacePickerButton'

const original = window.arkdown
const claim = vi.fn(async (_seen: boolean) => ({ ok: true as const, value: { showIntroduction: true } }))
beforeEach(() => { localStorage.clear(); claim.mockReset().mockResolvedValue({ ok: true, value: { showIntroduction: true } }); window.arkdown = { claimWorkspaceIntroduction: claim } as never })
afterEach(() => { window.arkdown = original; localStorage.clear() })

it('claims only on click and offers one secondary confirmation that opens the chooser once', async () => {
  const choose = vi.fn(async () => {})
  render(<WorkspacePickerButton name="工作区" disabled={false} chooseWorkspace={choose} />)
  expect(claim).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '工作区' }))
  const confirm = await screen.findByRole('button', { name: '好的' })
  expect(confirm).not.toHaveClass('arkdown-dialog__primary')
  expect(screen.queryByRole('button', { name: '稍后' })).toBeNull()
  expect(screen.queryByRole('button', { name: '选择文件夹' })).toBeNull()
  fireEvent.click(confirm); fireEvent.click(confirm)
  await waitFor(() => expect(choose).toHaveBeenCalledTimes(1))
  fireEvent.click(screen.getByRole('button', { name: '工作区' }))
  await waitFor(() => expect(choose).toHaveBeenCalledTimes(2))
  expect(claim).toHaveBeenCalledTimes(1)
})

it('imports a legacy seen marker and never shows the introduction after main confirms it', async () => {
  localStorage.setItem('arkdown.workspace-intro-seen.v1', '1')
  claim.mockResolvedValue({ ok: true, value: { showIntroduction: false } })
  const choose = vi.fn(async () => {})
  render(<WorkspacePickerButton name="工作区" disabled={false} chooseWorkspace={choose} />)
  fireEvent.click(screen.getByRole('button', { name: '工作区' }))
  await waitFor(() => expect(choose).toHaveBeenCalledOnce())
  expect(claim).toHaveBeenCalledExactlyOnceWith(true)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('does not duplicate an in-flight claim and retries a rejected save without marking seen', async () => {
  let reject!: (error: Error) => void
  claim.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no }))
  const choose = vi.fn(async () => {})
  render(<WorkspacePickerButton name="工作区" disabled={false} chooseWorkspace={choose} />)
  const trigger = screen.getByRole('button', { name: '工作区' })
  fireEvent.click(trigger); fireEvent.click(trigger)
  expect(claim).toHaveBeenCalledOnce()
  await act(async () => reject(new Error('private storage detail')))
  expect(screen.getByRole('alert')).toHaveTextContent('引导状态未能保存，请重试')
  expect(screen.queryByText('private storage detail')).toBeNull()
  expect(choose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByRole('button', { name: '好的' })).toBeVisible()
  expect(claim).toHaveBeenCalledTimes(2)
})

it('counts a normally dismissed introduction as seen without opening the chooser', async () => {
  const choose = vi.fn(async () => {})
  render(<WorkspacePickerButton name="工作区" disabled={false} chooseWorkspace={choose} />)
  fireEvent.click(screen.getByRole('button', { name: '工作区' }))
  await screen.findByRole('button', { name: '好的' })
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(choose).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '工作区' }))
  await waitFor(() => expect(choose).toHaveBeenCalledOnce())
  expect(claim).toHaveBeenCalledOnce()
})
