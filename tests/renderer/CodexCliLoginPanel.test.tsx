import { modelObservation, modelCommit } from '../helpers/model-observation'
import type { ArkdownApi } from '../../src/shared/contracts'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { CodexCliLoginPanel } from '../../src/renderer/settings/CodexCliLoginPanel'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'

it('starts only after an explicit login action and publishes refreshed models', async () => {
  const onConnected = vi.fn()
  const startLogin = vi.fn(async () => ({ ok: true as const, value: { status: 'completed' as const, connection: { status: 'connected' as const, mutation: modelCommit(DEFAULT_LARGE_MODEL_SETTINGS) } } }))
  render(<CodexCliLoginPanel observed={modelObservation(DEFAULT_LARGE_MODEL_SETTINGS)} startLogin={startLogin} cancelLogin={vi.fn()} onConnected={onConnected} />)
  expect(startLogin).not.toHaveBeenCalled()
  expect(screen.getByText('使用你的 ChatGPT 账号连接 Codex。登录将在浏览器中完成。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '登录 ChatGPT' }))
  await waitFor(() => expect(onConnected).toHaveBeenCalledWith(DEFAULT_LARGE_MODEL_SETTINGS))
})
it('cancels without publishing a late successful completion', async () => {
  let resolve!: (value: Awaited<ReturnType<NonNullable<ArkdownApi['startCodexCliLogin']>>>) => void
  const startLogin = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<ArkdownApi['startCodexCliLogin']>>>>(done => { resolve = done }))
  const cancelLogin = vi.fn(async () => ({ ok: true as const, value: null }))
  const onConnected = vi.fn()
  render(<CodexCliLoginPanel observed={modelObservation(DEFAULT_LARGE_MODEL_SETTINGS)} startLogin={startLogin} cancelLogin={cancelLogin} onConnected={onConnected} />)
  fireEvent.click(screen.getByRole('button', { name: '登录 ChatGPT' }))
  fireEvent.click(screen.getByRole('button', { name: '取消登录' }))
  await act(async () => { resolve({ ok: true, value: { status: 'completed', connection: { status: 'connected', mutation: modelCommit(DEFAULT_LARGE_MODEL_SETTINGS) } } }) })
  expect(cancelLogin).toHaveBeenCalledTimes(1)
  expect(onConnected).not.toHaveBeenCalled()
})
it('cancels an active login when its panel closes', () => {
  const cancelLogin = vi.fn(async () => ({ ok: true as const, value: null }))
  const view = render(<CodexCliLoginPanel observed={modelObservation(DEFAULT_LARGE_MODEL_SETTINGS)} startLogin={() => new Promise(() => {})} cancelLogin={cancelLogin} onConnected={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '登录 ChatGPT' }))
  view.unmount()
  expect(cancelLogin).toHaveBeenCalledTimes(1)
})
