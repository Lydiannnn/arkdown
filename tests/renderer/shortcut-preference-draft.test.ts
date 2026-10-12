import { expect, it, vi } from 'vitest'
import { ShortcutPreferenceDraft } from '../../src/renderer/settings/shortcut-preference-draft'
import { createPreferencePersistence } from '../../src/renderer/settings/preference-update-queue'
import type { ArkdownApi } from '../../src/shared/contracts'
import type { ObservedShortcutSnapshot } from '../../src/shared/keyboard-shortcuts'

const snapshot = (revision = 0): ObservedShortcutSnapshot => ({ bindings: {}, revision,
  observation: { version: 1, minimumBaseRevision: 0, fields: {} } })
function fixture() {
  const owner = createPreferencePersistence(), draft = new ShortcutPreferenceDraft(owner)
  const api = { getKeyboardShortcuts: vi.fn(async () => ({ ok: true as const, value: snapshot() })),
    updateKeyboardShortcuts: vi.fn<NonNullable<ArkdownApi['updateKeyboardShortcuts']>>(async () =>
      ({ ok: true, value: { snapshot: snapshot(4), error: 'same action conflict' } })) }
  return { owner, draft, api }
}

it('retains failed action intent and its original observation across a later authoritative refresh', async () => {
  const test = fixture()
  await test.draft.refresh(test.api)
  const original = test.draft.getSnapshot().observed!
  await test.draft.change({ id: 'file.save', accelerator: 'Ctrl+Alt+S' }, original, test.api)
  test.api.getKeyboardShortcuts.mockResolvedValueOnce({ ok: true, value: snapshot(8) })
  await test.draft.refresh(test.api)
  expect(test.draft.getSnapshot().bindings['file.save']).toBe('Ctrl+Alt+S')
  expect((await test.owner.drain()).ok).toBe(false)
  await test.draft.change({ id: 'file.save', accelerator: 'Ctrl+Alt+R' }, snapshot(8), test.api)
  expect(test.api.updateKeyboardShortcuts.mock.calls[1]?.[0].observed.revision).toBe(0)
})

it('keeps an unrelated action failure after success, and rejects reset-all over mixed dirty observations', async () => {
  const test = fixture()
  await test.draft.refresh(test.api)
  await test.draft.change({ id: 'file.save', accelerator: 'Ctrl+Alt+S' }, snapshot(), test.api)
  test.api.updateKeyboardShortcuts.mockResolvedValueOnce({ ok: true, value: {
    snapshot: { ...snapshot(5), bindings: { 'edit.find': 'Ctrl+Alt+F' } }, error: null,
  } })
  await test.draft.change({ id: 'edit.find', accelerator: 'Ctrl+Alt+F' }, snapshot(4), test.api)
  expect(await test.owner.drain()).toEqual({ ok: false, failedCategories: ['shortcut.file.save'] })
  await test.draft.change({ resetAll: true }, snapshot(5), test.api)
  expect(test.api.updateKeyboardShortcuts).toHaveBeenCalledTimes(2)
  expect(test.draft.getSnapshot().bindings['file.save']).toBe('Ctrl+Alt+S')
})

it('retains failure through reload errors and acknowledges an explicit successful discard without replay', async () => {
  const test = fixture()
  await test.draft.refresh(test.api)
  await test.draft.change({ id: 'file.save', accelerator: 'Ctrl+Alt+S' }, snapshot(), test.api)
  test.api.getKeyboardShortcuts.mockRejectedValueOnce(new Error('authority unreadable'))
  await test.draft.reload(test.api)
  expect(test.draft.getSnapshot().bindings['file.save']).toBe('Ctrl+Alt+S')
  expect((await test.owner.drain()).ok).toBe(false)
  test.api.getKeyboardShortcuts.mockResolvedValueOnce({ ok: true, value: snapshot(6) })
  await test.draft.reload(test.api)
  expect(test.draft.getSnapshot().bindings).toEqual({})
  expect(await test.owner.drain()).toEqual({ ok: true })
  expect(test.api.updateKeyboardShortcuts).toHaveBeenCalledOnce()
})

it('registers an in-flight action before native work begins and owns completion without subscribers', async () => {
  const test = fixture()
  await test.draft.refresh(test.api)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  test.api.updateKeyboardShortcuts.mockImplementationOnce(async () => {
    await held
    return { ok: false, error: { code: 'OPERATION_FAILED', message: 'save failed' } }
  })
  const pending = test.draft.change({ id: 'file.save', accelerator: 'Ctrl+Alt+S' }, snapshot(), test.api)
  expect(test.owner.snapshot().outstandingCategories).toBe(1)
  release(); await pending
  expect(test.draft.getSnapshot().error).toBe('save failed')
  expect((await test.owner.drain()).ok).toBe(false)
})
