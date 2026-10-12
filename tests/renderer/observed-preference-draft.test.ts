import { expect, it } from 'vitest'
import { ObservedPreferenceDraft } from '../../src/renderer/settings/observed-preference-draft'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import type { PublicPreferenceSnapshot } from '../../src/shared/preference-observation'

const initial = (revision = 1): PublicPreferenceSnapshot<'appearance'> => ({
  group: 'appearance', values: { ...DEFAULT_EDITOR_APPEARANCE },
  observation: { version: 1, revision, minimumBaseRevision: 0, fields: { bodyLatinFont: revision } },
})
function setup() {
  const draft = new ObservedPreferenceDraft('appearance')
  draft.adopt(initial())
  return draft
}

it('retains the original edited observation when a newer remote value is adopted', () => {
  const draft = setup()
  draft.edit({ bodyLatinFont: 'Arial' })
  const remote = initial(3)
  remote.values.bodyLatinFont = 'Calibri'
  remote.values.maximumContentWidthPx = 900
  draft.adopt(remote)
  expect(draft.view()).toMatchObject({ bodyLatinFont: 'Arial', maximumContentWidthPx: 900 })
  const [attempt] = draft.begin({ bodyLatinFont: 'Arial' })
  expect(attempt!.observed).toEqual(initial())
  expect(attempt!.changes).toEqual({ bodyLatinFont: 'Arial' })
})

it('keeps conflicting input and does not advance its baseline on another edit', () => {
  const draft = setup()
  draft.edit({ bodyLatinFont: 'Arial' })
  const [attempt] = draft.begin({ bodyLatinFont: 'Arial' })
  draft.finish(attempt!, { status: 'conflict', snapshot: initial(3), reason: 'field-changed', fields: ['bodyLatinFont'] })
  expect(draft.hasFailures()).toBe(true)
  expect(draft.view().bodyLatinFont).toBe('Arial')
  draft.edit({ bodyLatinFont: 'Verdana' })
  expect(draft.begin({ bodyLatinFont: 'Verdana' })[0]!.observed).toEqual(initial())
})

it('advances a queued A to B to A edit only through its exact acknowledged own write', () => {
  const draft = setup()
  draft.edit({ bodyLatinFont: 'Arial' })
  const [attempt] = draft.begin({ bodyLatinFont: 'Arial' })
  draft.edit({ bodyLatinFont: DEFAULT_EDITOR_APPEARANCE.bodyLatinFont })
  const committed = initial(2)
  committed.values.bodyLatinFont = 'Arial'
  draft.finish(attempt!, { status: 'committed', snapshot: committed })
  expect(draft.view().bodyLatinFont).toBe(DEFAULT_EDITOR_APPEARANCE.bodyLatinFont)
  expect(draft.begin({ bodyLatinFont: DEFAULT_EDITOR_APPEARANCE.bodyLatinFont })[0]!.observed).toEqual(committed)
})

it('does not replace other dirty origins with the response to an own write', () => {
  const draft = setup()
  draft.edit({ bodyLatinFont: 'Arial' })
  const [attempt] = draft.begin({ bodyLatinFont: 'Arial' })
  draft.adopt(initial(3))
  draft.edit({ maximumContentWidthPx: 900 })
  const committed = initial(2)
  committed.values.bodyLatinFont = 'Arial'
  draft.finish(attempt!, { status: 'committed', snapshot: committed })
  expect(draft.snapshot().observation.revision).toBe(3)
  expect(draft.begin({ maximumContentWidthPx: 900 })[0]!.observed.observation.revision).toBe(3)
})

it('buckets fields with distinct main-issued origins without fabricating an observation', () => {
  const draft = setup()
  draft.edit({ bodyLatinFont: 'Arial' })
  draft.adopt(initial(3))
  draft.edit({ maximumContentWidthPx: 900 })
  const attempts = draft.begin({ bodyLatinFont: 'Arial', maximumContentWidthPx: 900 })
  expect(attempts.map(item => item.observed.observation.revision)).toEqual([1, 3])
  expect(attempts.map(item => item.changes)).toEqual([{ bodyLatinFont: 'Arial' }, { maximumContentWidthPx: 900 }])
})

it('keeps failed fields after an unrelated field succeeds and supports explicit saved-state reload', () => {
  const draft = setup()
  draft.edit({ bodyLatinFont: 'Arial' })
  const [failed] = draft.begin({ bodyLatinFont: 'Arial' })
  draft.fail(failed!)
  draft.edit({ maximumContentWidthPx: 900 })
  const [other] = draft.begin({ maximumContentWidthPx: 900 })
  const current = initial(2)
  current.values.maximumContentWidthPx = 900
  draft.finish(other!, { status: 'committed', snapshot: current })
  expect(draft.hasFailures()).toBe(true)
  const reloaded = draft.reload(current)
  expect(reloaded).toEqual({ bodyLatinFont: current.values.bodyLatinFont })
  expect(draft.view()).toEqual(current.values)
  const [confirmation] = draft.begin(reloaded)
  draft.finish(confirmation!, { status: 'unchanged', snapshot: current })
  expect(draft.hasFailures()).toBe(false)
  expect(draft.dirty()).toEqual({})
})

it('clones every observation and edit and refuses edits before authoritative loading', () => {
  const draft = new ObservedPreferenceDraft('appearance')
  expect(() => draft.edit({ bodyLatinFont: 'Arial' })).toThrow('PREFERENCE_NOT_LOADED')
  const snapshot = initial()
  draft.adopt(snapshot)
  snapshot.values.bodyLatinFont = 'mutated'
  draft.edit({ bodyLatinFont: 'Arial' })
  const [attempt] = draft.begin({ bodyLatinFont: 'Arial' })
  attempt!.observed.values.bodyLatinFont = 'mutated'
  expect(draft.snapshot()).toEqual(initial())
  expect(draft.begin({ bodyLatinFont: 'Arial' })[0]!.observed).toEqual(initial())
})
