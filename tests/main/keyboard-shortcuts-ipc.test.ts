import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'

it('validates shortcut commands before forwarding them to the owner-bound service', async () => {
  const snapshot = { bindings: {}, revision: 0, observation: { version: 1 as const, minimumBaseRevision: 0, fields: {} } }
  const update = vi.fn(async () => ({ snapshot, error: null }))
  const recording = vi.fn()
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never,
    getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(),
    getKeyboardShortcuts: async () => snapshot, updateKeyboardShortcuts: update, setShortcutRecording: recording,
  })
  expect(await operations.getKeyboardShortcuts()).toEqual({ ok: true, value: snapshot })
  expect(await operations.updateKeyboardShortcuts({ observed: snapshot, change: { id: 'file.save', accelerator: null } })).toEqual({ ok: true, value: { snapshot, error: null } })
  expect(update).toHaveBeenCalledWith({ observed: snapshot, change: { id: 'file.save', accelerator: null } })
  expect((await operations.updateKeyboardShortcuts({ id: 'file.save', accelerator: 8 })).ok).toBe(false)
  expect(update).toHaveBeenCalledTimes(1)
  expect(await operations.setShortcutRecording({ active: true })).toEqual({ ok: true, value: null })
  expect(recording).toHaveBeenCalledWith(true)
  expect((await operations.setShortcutRecording({ active: true, ownerId: 99 })).ok).toBe(false)
  expect(recording).toHaveBeenCalledTimes(1)
})
