import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'

it('exposes fixed image context calls and validates returned paths', async () => {
  const invoke = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: true, value: 'C:\\copies\\photo.png' })
    .mockResolvedValueOnce({ ok: true, value: 'C:\\assets\\photo.png' })
  const api = createArkdownApi(invoke)
  const source = 'C:\\photos\\photo.png'

  await api.revealImage?.(source)
  await api.copyImage?.(source)
  await expect(api.saveImageCopy?.(source)).resolves.toEqual({
    ok: true,
    value: 'C:\\copies\\photo.png',
  })
  await expect(api.copyImageTo?.(source)).resolves.toEqual({
    ok: true,
    value: 'C:\\assets\\photo.png',
  })

  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.revealImage, { source }],
    [IPC_CHANNELS.copyImage, { source }],
    [IPC_CHANNELS.saveImageCopy, { source }],
    [IPC_CHANNELS.copyImageTo, { source }],
  ])

  const malformed = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: 'relative.png',
  }))
  await expect(malformed.copyImageTo?.(source)).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })
})
