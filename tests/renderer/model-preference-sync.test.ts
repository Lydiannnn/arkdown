import { expect, it, vi } from 'vitest'
import { startModelPreferenceSync } from '../../src/renderer/settings/model-preference-sync'
import { ModelPreferenceDraft } from '../../src/renderer/settings/model-preference-draft'
import { createPreferencePersistence } from '../../src/renderer/settings/preference-update-queue'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import type { PublicModelSettingsSnapshot } from '../../src/shared/settings-observation'

const snapshot = (revision: number): PublicModelSettingsSnapshot => ({ settings: structuredClone(DEFAULT_LARGE_MODEL_SETTINGS),
  observation: { version: 1, revision, minimumBaseRevision: 0, fields: {}, connections: {} } })

it('refreshes other-window saved choices on focus and periodically without blocking local edits or clearing drafts', async () => {
  vi.useFakeTimers()
  try {
    const persistence = createPreferencePersistence(), draft = new ModelPreferenceDraft(persistence), events = new EventTarget()
    draft.accept(snapshot(1)); draft.openDialog(); draft.updateDialogFields({ name: 'unsaved form' })
    const changed = snapshot(2); changed.settings.aiConversation.reasoningEffort = 'high'
    const read = vi.fn(async () => ({ ok: true as const, value: changed }))
    const stop = startModelPreferenceSync(draft, { getModelSettingsSnapshot: read }, events)
    await vi.advanceTimersByTimeAsync(0)
    expect(draft.getSnapshot().settings?.aiConversation.reasoningEffort).toBe('high')
    expect(draft.getSnapshot().dialog?.fields.name).toBe('unsaved form')
    expect(draft.getSnapshot().dialog?.observed.observation.revision).toBe(1)
    expect(draft.getSnapshot().loading).toBe(false)
    events.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(3)
    stop(); events.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(4000)
    expect(read).toHaveBeenCalledTimes(3)
    expect(await persistence.drain()).toEqual({ ok: true })
  } finally { vi.useRealTimers() }
})

it('coalesces slow reads and rejects late observations after disposal', async () => {
  vi.useFakeTimers()
  try {
    const draft = new ModelPreferenceDraft(createPreferencePersistence()), events = new EventTarget()
    let finish!: (value: { ok: true; value: PublicModelSettingsSnapshot }) => void
    const read = vi.fn(() => new Promise<{ ok: true; value: PublicModelSettingsSnapshot }>(resolve => { finish = resolve }))
    const stop = startModelPreferenceSync(draft, { getModelSettingsSnapshot: read }, events)
    events.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(4000)
    expect(read).toHaveBeenCalledOnce()
    stop(); finish({ ok: true, value: snapshot(3) }); await vi.advanceTimersByTimeAsync(0)
    expect(draft.getSnapshot().observed).toBeUndefined()
  } finally { vi.useRealTimers() }
})
