import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'

const observed = { settings: structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), observation: { version: 1 as const, revision: 2, minimumBaseRevision: 0, fields: {}, connections: {} } }

it('exposes only validated login status and captured settings observation, with no caller-controlled login commands', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: { status: 'cancelled' } })
  const api = createArkdownApi(invoke)
  expect(await api.startCodexCliLogin!(observed)).toEqual({ ok: true, value: { status: 'cancelled' } })
  expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.startCodexCliLogin, { observed })
  const completed = { status: 'completed', connection: { status: 'not-logged-in', mutation: { status: 'committed', snapshot: observed } } }
  invoke.mockResolvedValue({ ok: true, value: completed })
  expect(await api.startCodexCliLogin!(observed)).toEqual({ ok: true, value: completed })
  for (const value of [{ status: 'completed' }, { status: 'cancelled', authUrl: 'secret' }, { status: 'unknown' },
    Object.assign(Object.create({ status: 'cancelled' }), { token: 'secret' })]) {
    invoke.mockResolvedValue({ ok: true, value })
    expect(await api.startCodexCliLogin!(observed)).toMatchObject({ ok: false })
  }
  invoke.mockResolvedValue({ ok: true, value: null })
  expect(await api.cancelCodexCliLogin!()).toEqual({ ok: true, value: null })
  expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.cancelCodexCliLogin)
})
