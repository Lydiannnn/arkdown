import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import type { PublicPreferenceSnapshot } from '../../src/shared/preference-observation'

const observed: PublicPreferenceSnapshot<'appearance'> = { group: 'appearance', values: { ...DEFAULT_EDITOR_APPEARANCE }, observation: { version: 1, revision: 4, minimumBaseRevision: 0, fields: { bodyLatinFont: 2 } } }
it('carries the retained observation and validates matching returned group data', async () => {
  const invoke = vi.fn().mockResolvedValueOnce({ ok: true, value: observed }).mockResolvedValueOnce({ ok: true, value: { status: 'committed', snapshot: observed } })
  const api = createArkdownApi(invoke)
  expect(await api.getPreferenceSnapshot?.('appearance')).toEqual({ ok: true, value: observed })
  const input = { observed, changes: { bodyLatinFont: 'Arial' } }
  expect(await api.patchPreferences?.(input)).toEqual({ ok: true, value: { status: 'committed', snapshot: observed } })
  expect(invoke.mock.calls).toEqual([[IPC_CHANNELS.getPreferenceSnapshot, { group: 'appearance' }], [IPC_CHANNELS.patchPreferences, input]])
})

it('does not send incomplete or arbitrary renderer patch paths', async () => {
  const invoke = vi.fn(), api = createArkdownApi(invoke)
  expect(await api.patchPreferences?.({ observed, changes: { password: 'forbidden' } } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(await api.patchPreferences?.({ changes: {} } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(await api.getPreferenceSnapshot?.('unknown' as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(invoke).not.toHaveBeenCalled()
})

it('rejects extra internal data and cross-group responses', async () => {
  const invoke = vi.fn().mockResolvedValueOnce({ ok: true, value: { ...observed, ciphertext: 'private' } })
    .mockResolvedValueOnce({ ok: true, value: { status: 'committed', snapshot: observed, cleanupPath: 'private' } })
    .mockResolvedValueOnce({ ok: true, value: { group: 'search', values: { provider: 'bing', customTemplate: '' }, observation: { version: 1, revision: 4, minimumBaseRevision: 0, fields: {} } } })
  const api = createArkdownApi(invoke)
  expect(await api.getPreferenceSnapshot?.('appearance')).toMatchObject({ ok: false })
  expect(await api.patchPreferences?.({ observed, changes: {} })).toMatchObject({ ok: false })
  expect(await api.getPreferenceSnapshot?.('appearance')).toMatchObject({ ok: false })
})
