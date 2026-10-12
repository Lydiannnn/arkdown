import { expect, it } from 'vitest'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import type { PublicModelSettingsSnapshot } from '../../src/shared/settings-observation'
import { parseModelFeaturePatch, parseModelObservationRequest, parsePublicModelMutation, parseObservedCodexTestResult } from '../../src/shared/model-settings-commands'

function observed(): PublicModelSettingsSnapshot {
  return { settings: structuredClone(DEFAULT_LARGE_MODEL_SETTINGS),
    observation: { version: 1, revision: 4, minimumBaseRevision: 1, fields: { 'models.aiConversation.writePolicy': 2 }, connections: {} } }
}

it('preserves an exact observed value/revision pair and rejects bare or extended envelopes', () => {
  const original = observed()
  const parsed = parseModelObservationRequest({ observed: original })!
  expect(parsed).toEqual(original)
  original.observation.revision = 9
  expect(parsed.observation.revision).toBe(4)
  for (const value of [original, {}, { observed: original, expectedRevision: 9 }, { observed: { ...original, observation: undefined } }]) {
    expect(parseModelObservationRequest(value)).toBeUndefined()
  }
})

it('accepts only explicitly named feature fields without adding unrelated defaults', () => {
  expect(parseModelFeaturePatch('aiConversation', { writePolicy: 'document-grant' })).toEqual({ writePolicy: 'document-grant' })
  expect(parseModelFeaturePatch('selectionTranslation', { targetLanguage: 'ja' })).toEqual({ targetLanguage: 'ja' })
  expect(parseModelFeaturePatch('floatingTranslation', { target: 'jp' })).toEqual({ target: 'jp' })
  for (const value of [{}, { writePolicy: undefined }, { writePolicy: 'invalid' }, { privacyNoticeAccepted: true }, { connectionId: '../bad' }]) {
    expect(parseModelFeaturePatch('aiConversation', value)).toBeUndefined()
  }
  expect(parseModelFeaturePatch('selectionTranslation', { privacyNoticeAccepted: true })).toBeUndefined()
  expect(parseModelFeaturePatch('screenshotTranslation', { target: 'jp' })).toBeUndefined()
  expect(parseModelFeaturePatch('floatingTranslation', { targetLanguage: 'ja' })).toBeUndefined()
})

it('validates finite conflict results without losing the authoritative snapshot', () => {
  const result = { status: 'conflict', snapshot: observed(), reason: 'field-changed',
    conflicts: [{ kind: 'field', field: 'models.aiConversation.writePolicy' }] }
  expect(parsePublicModelMutation(result)).toEqual(result)
  expect(parsePublicModelMutation({ status: 'committed', snapshot: observed() })?.status).toBe('committed')
  for (const value of [{ ...result, reason: 'retry' }, { ...result, conflicts: [{ kind: 'field', field: '__proto__' }] },
    { ...result, conflicts: [{ kind: 'connection', id: 'arbitrary', field: 'credential' }] },
    { status: 'committed', snapshot: observed(), conflicts: [] }, { status: 'committed', snapshot: DEFAULT_LARGE_MODEL_SETTINGS }]) {
    expect(parsePublicModelMutation(value)).toBeUndefined()
  }
})

it('allows a Codex conflict before a probe and requires a status for a completed mutation', () => {
  const conflict = { status: 'conflict', snapshot: observed(), reason: 'field-changed', conflicts: [] }
  expect(parseObservedCodexTestResult({ mutation: conflict })).toEqual({ mutation: conflict })
  expect(parseObservedCodexTestResult({ status: 'not-found', mutation: { status: 'unchanged', snapshot: observed() } })?.status).toBe('not-found')
  expect(parseObservedCodexTestResult({ mutation: { status: 'committed', snapshot: observed() } })).toBeUndefined()
  expect(parseObservedCodexTestResult({ status: 'unknown', mutation: conflict })).toBeUndefined()
})
