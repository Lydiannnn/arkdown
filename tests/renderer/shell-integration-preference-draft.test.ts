import { expect, it, vi } from 'vitest'
import { ShellIntegrationPreferenceDraft } from '../../src/renderer/settings/shell-integration-preference-draft'
import { createPreferencePersistence } from '../../src/renderer/settings/preference-update-queue'
import type { ArkdownApi } from '../../src/shared/contracts'
import type { ShellIntegrationSnapshot } from '../../src/shared/shell-integration-preferences'

const observed = (revision = 0): ShellIntegrationSnapshot => ({ values: { documentOpenMenu: false, markdownShellNew: false },
  unavailable: [], observation: { version: 1, revision, minimumBaseRevision: 0, fields: { documentOpenMenu: revision } } })
function fixture() {
  const persistence = createPreferencePersistence()
  const draft = new ShellIntegrationPreferenceDraft(persistence)
  const api = {
    getShellIntegrationPreferences: vi.fn(async () => ({ ok: true as const, value: observed() })),
    updateShellIntegrationPreference: vi.fn<NonNullable<ArkdownApi['updateShellIntegrationPreference']>>(async () =>
      ({ ok: false, error: { code: 'SHELL_INTEGRATION_CONFLICT', message: 'conflict' } })),
  }
  return { persistence, draft, api }
}

it('keeps failed choices and original revision across a new section refresh and blocks successful close', async () => {
  const test = fixture()
  await test.draft.refresh(test.api)
  await test.draft.change('documentOpenMenu', true, test.api)
  test.api.getShellIntegrationPreferences.mockResolvedValueOnce({ ok: true, value: observed(6) })
  await test.draft.refresh(test.api)
  expect(test.draft.getSnapshot().values.documentOpenMenu).toBe(true)
  expect(test.draft.getSnapshot().errors.documentOpenMenu).toBe('conflict')
  expect(await test.persistence.drain()).toEqual({ ok: false, failedCategories: ['shell.documentOpenMenu'] })
  await test.draft.change('documentOpenMenu', false, test.api)
  expect(test.api.updateShellIntegrationPreference.mock.calls[1]?.[0].observed.observation.revision).toBe(0)
})

it('clears an explicitly discarded draft only after successful authoritative reload, without native replay', async () => {
  const test = fixture()
  await test.draft.refresh(test.api)
  await test.draft.change('documentOpenMenu', true, test.api)
  test.api.getShellIntegrationPreferences.mockRejectedValueOnce(new Error('read failed'))
  await test.draft.reload(test.api)
  expect(test.draft.getSnapshot().values.documentOpenMenu).toBe(true)
  expect((await test.persistence.drain()).ok).toBe(false)
  await test.draft.reload(test.api)
  expect(test.draft.getSnapshot().values.documentOpenMenu).toBe(false)
  expect(await test.persistence.drain()).toEqual({ ok: true })
  expect(test.api.updateShellIntegrationPreference).toHaveBeenCalledOnce()
})

it('owns in-flight persistence without any mounted subscriber and exposes its final failure', async () => {
  const test = fixture()
  await test.draft.refresh(test.api)
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  test.api.updateShellIntegrationPreference.mockImplementationOnce(async () => {
    await held
    return { ok: false, error: { code: 'OPERATION_FAILED', message: 'save failed' } }
  })
  const change = test.draft.change('documentOpenMenu', true, test.api)
  expect(test.persistence.snapshot().outstandingCategories).toBe(1)
  let drained = false
  const close = test.persistence.drain().then(result => { drained = true; return result })
  await Promise.resolve()
  expect(drained).toBe(false)
  finish()
  await change
  expect((await close).ok).toBe(false)
  expect(test.draft.getSnapshot()).toMatchObject({ values: { documentOpenMenu: true }, errors: { documentOpenMenu: 'save failed' } })
})

it('does not let reopening supersede an explicit discard already awaiting authority', async () => {
  const test = fixture()
  await test.draft.refresh(test.api)
  await test.draft.change('documentOpenMenu', true, test.api)
  let finish!: () => void
  test.api.getShellIntegrationPreferences.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { finish = resolve })
    return { ok: true, value: observed(3) }
  })
  const reload = test.draft.reload(test.api)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await test.draft.refresh(test.api)
  finish(); await reload
  expect(test.draft.getSnapshot().values.documentOpenMenu).toBe(false)
  expect(await test.persistence.drain()).toEqual({ ok: true })
})
