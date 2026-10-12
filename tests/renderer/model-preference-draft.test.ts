import { expect, it, vi } from 'vitest'
import { ModelPreferenceDraft } from '../../src/renderer/settings/model-preference-draft'
import { createPreferencePersistence } from '../../src/renderer/settings/preference-update-queue'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import type { ApiResult } from '../../src/shared/contracts'
import type { PublicModelMutationResult, PublicModelSettingsSnapshot } from '../../src/shared/settings-observation'

const snapshot = (revision = 1): PublicModelSettingsSnapshot => ({ settings: structuredClone(DEFAULT_LARGE_MODEL_SETTINGS),
  observation: { version: 1, revision, minimumBaseRevision: 0, fields: {}, connections: {} } })
const conflict = (revision = 3): ApiResult<PublicModelMutationResult> => ({ ok: true, value: {
  status: 'conflict', snapshot: snapshot(revision), reason: 'field-changed', conflicts: [],
} })
const success = (revision = 4): ApiResult<PublicModelMutationResult> => ({ ok: true, value: { status: 'committed', snapshot: snapshot(revision) } })

it('retains a failed model field and original observation while unrelated writes remain usable', async () => {
  const persistence = createPreferencePersistence(), draft = new ModelPreferenceDraft(persistence)
  draft.accept(snapshot())
  const call = vi.fn(async (_observed: PublicModelSettingsSnapshot): Promise<ApiResult<PublicModelMutationResult>> => conflict())
  await draft.mutate('feature.aiConversation.writePolicy', snapshot(), call, { feature: 'aiConversation', patch: { writePolicy: 'workspace-grant' } })
  draft.accept(snapshot(8))
  expect(draft.getSnapshot().settings?.aiConversation.writePolicy).toBe('workspace-grant')
  await draft.mutate('feature.selectionTranslation.targetLanguage', snapshot(8), async () => success(9))
  expect(await persistence.drain()).toEqual({ ok: false, failedCategories: ['models'] })
  await draft.mutate('feature.aiConversation.writePolicy', snapshot(9), call)
  expect(call.mock.calls[1]?.[0].observation.revision).toBe(1)
  await draft.mutate('feature.aiConversation.writePolicy', snapshot(9), async () => success(10))
  expect(await persistence.drain()).toEqual({ ok: true })
})

it('aggregates overlapping model outcomes so later unrelated success never masks earlier failure', async () => {
  const persistence = createPreferencePersistence(), draft = new ModelPreferenceDraft(persistence)
  let release!: (value: ApiResult<PublicModelMutationResult>) => void
  const first = draft.mutate('feature.aiConversation.writePolicy', snapshot(), () => new Promise(resolve => { release = resolve }))
  expect(persistence.snapshot().outstandingCategories).toBe(1)
  await draft.mutate('feature.selectionTranslation.targetLanguage', snapshot(), async () => success())
  release(conflict()); await first
  expect((await persistence.drain()).ok).toBe(false)
})

it('retains form values and their original snapshot across hide, refresh and reopen', () => {
  const draft = new ModelPreferenceDraft(createPreferencePersistence())
  draft.accept(snapshot())
  draft.openDialog()
  draft.updateDialogFields({ name: 'unfinished', apiKey: 'synthetic', baseUrl: 'https://api.example.test' })
  draft.updateDialogCodexObservation(snapshot(2))
  draft.hideDialog()
  draft.accept(snapshot(8))
  draft.openDialog()
  expect(draft.getSnapshot().dialog?.fields.name).toBe('unfinished')
  expect(draft.getSnapshot().dialog?.observed.observation.revision).toBe(1)
  expect(draft.getSnapshot().dialog?.codexObserved?.observation.revision).toBe(2)
})

it('blocks only the feature with unsettled intent, retaining the block until a save or explicit reload succeeds', async () => {
  const draft = new ModelPreferenceDraft(createPreferencePersistence())
  draft.accept(snapshot())
  let release!: (value: ApiResult<PublicModelMutationResult>) => void
  const saving = draft.mutate('feature.aiConversation.writePolicy', snapshot(), () => new Promise(resolve => { release = resolve }),
    { feature: 'aiConversation', patch: { writePolicy: 'workspace-grant' } })
  expect(draft.hasUnsettledFeature('aiConversation')).toBe(true)
  expect(draft.hasUnsettledFeature('selectionTranslation')).toBe(false)
  await Promise.resolve()
  release(conflict()); await saving
  draft.accept(snapshot(8))
  await draft.mutate('test.unrelated', snapshot(8), async () => conflict(9))
  expect(draft.hasUnsettledFeature('aiConversation')).toBe(true)
  expect(draft.hasUnsettledFeature('selectionTranslation')).toBe(false)
  await draft.mutate('feature.aiConversation.writePolicy', snapshot(9), async () => success(10))
  expect(draft.hasUnsettledFeature('aiConversation')).toBe(false)
  expect(draft.getSnapshot().failedKeys).toContain('test.unrelated')
})

it('keeps failures on a read error and explicitly discards them only after authoritative reload', async () => {
  const persistence = createPreferencePersistence(), draft = new ModelPreferenceDraft(persistence)
  await draft.mutate('feature.aiConversation.writePolicy', snapshot(), async () => conflict())
  await draft.reload({ getModelSettingsSnapshot: async () => ({ ok: false, error: { code: 'OPERATION_FAILED', message: 'read failed' } }) })
  expect((await persistence.drain()).ok).toBe(false)
  await draft.reload({ getModelSettingsSnapshot: async () => ({ ok: true, value: snapshot(5) }) })
  expect(await persistence.drain()).toEqual({ ok: true })
})

it('does not acknowledge an older failure merely because a later login was cancelled without a mutation', async () => {
  const persistence = createPreferencePersistence(), draft = new ModelPreferenceDraft(persistence)
  await draft.mutate('codex.login', snapshot(), async () => conflict())
  await draft.perform('codex.login', snapshot(5), async () => ({ ok: true, value: { status: 'cancelled' } }), () => undefined)
  expect((await persistence.drain()).ok).toBe(false)
})

it('does not apply thinking intent to the confirmed model while a different binding draft remains unsaved', async () => {
  const draft = new ModelPreferenceDraft(createPreferencePersistence())
  draft.accept(snapshot())
  await draft.mutate('feature.aiConversation.connectionId', snapshot(), async () => conflict(), {
    feature: 'aiConversation', patch: { connectionId: 'unsaved-model' },
  })
  const run = vi.fn(async () => success())
  const result = await draft.mutate('feature.aiConversation.thinkingMode', snapshot(3), run, {
    feature: 'aiConversation', patch: { thinkingMode: 'enabled' },
  })
  expect(result.ok).toBe(false)
  expect(run).not.toHaveBeenCalled()
  await draft.mutate('feature.aiConversation.writePolicy', snapshot(3), run, {
    feature: 'aiConversation', patch: { writePolicy: 'workspace-grant' },
  })
  expect(run).toHaveBeenCalledOnce()
})


it('explicitly retries retained feature intent against the latest conflict snapshot and releases close', async () => {
  const persistence = createPreferencePersistence(), draft = new ModelPreferenceDraft(persistence)
  const original = snapshot(2)
  draft.accept(original)
  const observedRevisions: number[] = []
  const run = async (observed: PublicModelSettingsSnapshot): Promise<ApiResult<PublicModelMutationResult>> => {
    observedRevisions.push(observed.observation.revision)
    if (observed.observation.revision === 2) return conflict(7)
    const saved = snapshot(8)
    saved.settings.aiConversation.reasoningEffort = 'high'
    return { ok: true, value: { status: 'committed', snapshot: saved } }
  }
  await draft.mutate('feature.aiConversation.reasoningEffort', original, run,
    { feature: 'aiConversation', patch: { reasoningEffort: 'high' } })
  expect(await persistence.drain()).toEqual({ ok: false, failedCategories: ['models'] })
  expect(observedRevisions).toEqual([2])
  expect(await draft.retryFeature('aiConversation')).toBe(true)
  expect(observedRevisions).toEqual([2, 7])
  expect(draft.getSnapshot().settings?.aiConversation.reasoningEffort).toBe('high')
  expect(await persistence.drain()).toEqual({ ok: true })
})

it('keeps unrelated model drafts and close failures after explicitly retrying one feature', async () => {
  const persistence = createPreferencePersistence(), draft = new ModelPreferenceDraft(persistence)
  draft.accept(snapshot())
  await draft.mutate('feature.selectionTranslation.targetLanguage', snapshot(), async () => conflict(2),
    { feature: 'selectionTranslation', patch: { targetLanguage: 'ja' } })
  let attempt = 0
  await draft.mutate('feature.aiConversation.reasoningEffort', snapshot(2), async () => ++attempt === 1 ? conflict(3) : success(4),
    { feature: 'aiConversation', patch: { reasoningEffort: 'high' } })
  draft.openDialog()
  draft.updateDialogFields({ name: 'unfinished' })
  expect(await draft.retryFeature('aiConversation')).toBe(true)
  expect(draft.getSnapshot().failedKeys).toEqual(['feature.selectionTranslation.targetLanguage'])
  expect(draft.getSnapshot().settings?.selectionTranslation.targetLanguage).toBe('ja')
  expect(draft.getSnapshot().dialog?.fields.name).toBe('unfinished')
  expect(await persistence.drain()).toEqual({ ok: false, failedCategories: ['models'] })
})

it('retains feature intent when an explicit retry conflicts again', async () => {
  const persistence = createPreferencePersistence(), draft = new ModelPreferenceDraft(persistence)
  draft.accept(snapshot())
  await draft.mutate('feature.aiConversation.reasoningEffort', snapshot(), async () => conflict(4),
    { feature: 'aiConversation', patch: { reasoningEffort: 'high' } })
  expect(await draft.retryFeature('aiConversation')).toBe(false)
  expect(draft.getSnapshot().settings?.aiConversation.reasoningEffort).toBe('high')
  expect(await persistence.drain()).toEqual({ ok: false, failedCategories: ['models'] })
})

it('does not retarget a retained thinking choice when another window changed the selected model', async () => {
  const persistence = createPreferencePersistence(), draft = new ModelPreferenceDraft(persistence)
  const original = snapshot()
  // The selected model can be removed while this window still displays its retained choice.
  const id = '11111111-1111-4111-8111-111111111111'
  original.settings.connections = [{ id, name: 'Synthetic model', provider: 'deepseek', accessType: 'standard-api',
    protocol: 'openai', baseUrl: 'https://example.test', modelId: 'synthetic', apiKeyHint: '', status: 'connected',
    lastTestedAt: null, capabilityOverride: null }]
  original.observation.connections[id] = { entity: 0 }
  original.settings.aiConversation.connectionId = id
  draft.accept(original)
  const changed = snapshot(4)
  let writes = 0
  await draft.mutate('feature.aiConversation.reasoningEffort', original, async () => {
    writes += 1
    return { ok: true, value: { status: 'conflict', snapshot: changed, reason: 'field-changed', conflicts: [] } }
  }, { feature: 'aiConversation', patch: { reasoningEffort: 'high' } })
  expect(await draft.retryFeature('aiConversation')).toBe(false)
  expect(writes).toBe(1)
  expect(draft.getSnapshot().settings?.aiConversation.reasoningEffort).toBe('high')
  expect(await persistence.drain()).toEqual({ ok: false, failedCategories: ['models'] })
})
