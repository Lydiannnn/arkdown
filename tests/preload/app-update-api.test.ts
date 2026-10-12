import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'
it('exposes fixed update actions and rejects malformed state and About input', async () => {
  const state = { revision: 2, status: 'available', currentVersion: '1.0.4', candidate: { version: '1.0.5', required: false, mode: 'optional', message: 'new' }, bubbleVisible: true, requiredPrompt: 'hidden' }
  const invoke = vi.fn(async () => ({ ok: true, value: state })); const api = createArkdownApi(invoke)
  expect(await api.getAppUpdateState!()).toEqual({ ok: true, value: state })
  invoke.mockResolvedValueOnce({ ok: true, value: { ...state, candidate: { ...state.candidate, required: 'yes' } } } as never)
  expect(await api.getAppUpdateState!()).toMatchObject({ ok: false })
  expect(await api.notifyUpdateAbout!({ interactionId: 'safe', open: true, url: 'evil' } as never)).toMatchObject({ ok: false })
  invoke.mockResolvedValue({ ok: true, value: null } as never)
  await api.requestRequiredUpdateExit!(); expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.requestRequiredUpdateExit)
  await api.protectUpdateWork!(); expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.protectUpdateWork)
})
