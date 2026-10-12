import { expect, it, vi } from 'vitest'
import { settleClosePreferences } from '../../src/renderer/settings/close-model-preferences'
import { ModelPreferenceDraft } from '../../src/renderer/settings/model-preference-draft'
import { createPreferencePersistence } from '../../src/renderer/settings/preference-update-queue'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'

async function fixture() {
  const persistence = createPreferencePersistence(), models = new ModelPreferenceDraft(persistence)
  const snapshot = { settings: structuredClone(DEFAULT_LARGE_MODEL_SETTINGS),
    observation: { version: 1 as const, revision: 3, minimumBaseRevision: 0, fields: {}, connections: {} } }
  models.accept(snapshot)
  await models.mutate('feature.aiConversation.reasoningEffort', snapshot, async () => ({ ok: true,
    value: { status: 'conflict', snapshot, reason: 'field-changed', conflicts: [] } }),
    { feature: 'aiConversation', patch: { reasoningEffort: 'high' } })
  return { persistence, models, snapshot, enter: vi.fn() }
}
it('keeps the window and local intent when the user cancels the settings discard prompt', async () => {
  const f = await fixture(), confirm = vi.fn(async () => 'cancel' as const), read = vi.fn()
  expect(await settleClosePreferences({ ...f, confirm, api: { getModelSettingsSnapshot: read } })).toEqual({ status: 'cancelled' })
  expect(read).not.toHaveBeenCalled()
  expect(f.models.getSnapshot().settings?.aiConversation.reasoningEffort).toBe('high')
  expect(f.enter.mock.calls).toEqual([['settle-preferences'], ['await-preferences']])
})
it('releases close only after explicit discard and a successful authoritative reload', async () => {
  const f = await fixture(), confirm = vi.fn(async () => 'confirm' as const)
  expect(await settleClosePreferences({ ...f, confirm, api: { getModelSettingsSnapshot: async () => ({ ok: true, value: f.snapshot }) } }))
    .toEqual({ status: 'ready' })
  expect(f.models.getSnapshot().failedKeys).toEqual([])
  expect(await f.persistence.drain()).toEqual({ ok: true })
})
it('retains protection and the draft if reloading the saved settings fails', async () => {
  const f = await fixture()
  expect(await settleClosePreferences({ ...f, confirm: async () => 'confirm',
    api: { getModelSettingsSnapshot: async () => ({ ok: false, error: { code: 'OPERATION_FAILED', message: 'offline' } }) } }))
    .toEqual({ status: 'failed', code: 'preferences-save-failed' })
  expect(f.models.getSnapshot().settings?.aiConversation.reasoningEffort).toBe('high')
})
it('does not discard other categories or mistake in-flight work for a discardable failure', async () => {
  const f = await fixture(), confirm = vi.fn()
  await f.persistence.runExternal('shell.documentOpenMenu', async () => { throw new Error('not saved') }).catch(() => {})
  expect(await settleClosePreferences({ ...f, confirm, api: { getModelSettingsSnapshot: vi.fn() } }))
    .toEqual({ status: 'failed', code: 'preferences-save-failed' })
  expect(confirm).not.toHaveBeenCalled()
})
