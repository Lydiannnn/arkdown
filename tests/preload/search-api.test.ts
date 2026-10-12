import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'

it('exposes fixed search preference, search and external-open calls', async () => {
  const invoke = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      value: { provider: 'bing', customTemplate: '' },
    })
    .mockResolvedValueOnce({
      ok: true,
      value: { provider: 'google', customTemplate: '' },
    })
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: true, value: null })
  const api = createArkdownApi(invoke)

  await expect(api.getSearchPreferences?.()).resolves.toEqual({
    ok: true,
    value: { provider: 'bing', customTemplate: '' },
  })
  await expect(api.setSearchPreferences?.({
    provider: 'google',
    customTemplate: '',
  })).resolves.toEqual({
    ok: true,
    value: { provider: 'google', customTemplate: '' },
  })
  await api.searchSelection?.('Arkdown')
  await api.openExternal?.('https://example.com')

  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.getSearchPreferences],
    [IPC_CHANNELS.setSearchPreferences, {
      provider: 'google',
      customTemplate: '',
    }],
    [IPC_CHANNELS.searchSelection, { query: 'Arkdown' }],
    [IPC_CHANNELS.openExternal, { target: 'https://example.com' }],
  ])
})

it('rejects malformed search preference success values at the preload boundary', async () => {
  const api = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: {
      provider: 'custom',
      customTemplate: 'javascript:alert(1)?q={query}',
    },
  }))

  await expect(api.getSearchPreferences?.()).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })
})
