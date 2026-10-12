import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'

it('passes a single binding update and recording state through validated IPC responses', async () => {
  const snapshot = { bindings: { 'file.save': 'Ctrl+Alt+S' }, revision: 2,
    observation: { version: 1 as const, minimumBaseRevision: 0, fields: { 'file.save': 2 } } }
  const command = { observed: snapshot, change: { id: 'file.save', accelerator: 'Ctrl+Alt+S' } }
  const invoke = vi.fn().mockResolvedValueOnce({ ok: true, value: snapshot })
    .mockResolvedValueOnce({ ok: true, value: { snapshot, error: null } })
    .mockResolvedValueOnce({ ok: true, value: null })
  const api = createArkdownApi(invoke)
  expect(await api.getKeyboardShortcuts!()).toEqual({ ok: true, value: snapshot })
  expect(await api.updateKeyboardShortcuts!(command)).toEqual({ ok: true, value: { snapshot, error: null } })
  expect(await api.setShortcutRecording!(true)).toEqual({ ok: true, value: null })
  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.getKeyboardShortcuts],
    [IPC_CHANNELS.updateKeyboardShortcuts, command],
    [IPC_CHANNELS.setShortcutRecording, { active: true }],
  ])
})

it('rejects malformed updates locally and invalid snapshots from the main process', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: { bindings: { 'file.save': 'Ctrl+B' }, revision: 1 } })
  const api = createArkdownApi(invoke)
  expect((await api.updateKeyboardShortcuts!({ id: 'file.save', accelerator: 4 } as never)).ok).toBe(false)
  expect(invoke).not.toHaveBeenCalled()
  expect((await api.getKeyboardShortcuts!()).ok).toBe(false)
  invoke.mockClear()
  expect((await api.updateKeyboardShortcuts!({ id: 'file.save', accelerator: null } as never)).ok).toBe(false)
  expect(invoke).not.toHaveBeenCalled()
})
