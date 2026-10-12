import { expect, it, vi } from 'vitest'
import { createBusinessMessageApi } from '../../src/preload/business-message-api'
import { BUSINESS_MESSAGE_CHANNELS as channels } from '../../src/shared/business-message-dialog'
it('rejects malformed state and exposes no arbitrary IPC channel to the renderer', async () => {
  const invoke = vi.fn(async () => ({ buttons: ['确定'], message: 'incomplete' }))
  const api = createBusinessMessageApi({ invoke })
  expect(await api.get()).toBeNull()
  expect(Object.keys(api).sort()).toEqual(['get', 'ready', 'respond'])
  await api.ready({ requestId: 'test', height: 180 })
  expect(invoke).toHaveBeenLastCalledWith(channels.ready, { requestId: 'test', height: 180 })
  await api.respond({ requestId: 'test', response: 0 })
  expect(invoke).toHaveBeenLastCalledWith(channels.respond, { requestId: 'test', response: 0 })
})
