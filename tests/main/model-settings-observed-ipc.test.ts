import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import type { PublicModelSettingsSnapshot, PublicModelMutationResult } from '../../src/shared/settings-observation'

const observed: PublicModelSettingsSnapshot = { settings: structuredClone(DEFAULT_LARGE_MODEL_SETTINGS),
  observation: { version: 1, revision: 7, minimumBaseRevision: 0, fields: {}, connections: {} } }
const mutation: PublicModelMutationResult = { status: 'unchanged', snapshot: observed }
function harness() {
  const observedModelConnections = {
    getSettings: vi.fn(async () => observed), connect: vi.fn(async () => mutation), listModels: vi.fn(),
    test: vi.fn(), delete: vi.fn(), setFeature: vi.fn(async () => mutation), acceptTranslationPrivacyNotice: vi.fn(),
  }
  const observedCodexCliConnections = { test: vi.fn(async () => ({ status: 'connected' as const, mutation })), remove: vi.fn() }
  const operations = createIpcOperations({ chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never,
    getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(), observedModelConnections, observedCodexCliConnections })
  return { operations, observedModelConnections, observedCodexCliConnections }
}

it('reads authoritative display and observed snapshots through the same awaited service', async () => {
  const h = harness()
  expect(await h.operations.getModelSettingsSnapshot()).toEqual({ ok: true, value: observed })
  expect(await h.operations.getLargeModelSettings()).toEqual({ ok: true, value: observed.settings })
  expect(h.observedModelConnections.getSettings).toHaveBeenCalledTimes(2)
})

it('submits only the original observed patch and never reads fresh to bless it', async () => {
  const h = harness()
  expect(await h.operations.setAiConversationSettings({ observed, input: { writePolicy: 'workspace-grant' } }))
    .toEqual({ ok: true, value: mutation })
  expect(h.observedModelConnections.setFeature).toHaveBeenCalledExactlyOnceWith(observed, 'aiConversation', { writePolicy: 'workspace-grant' })
  expect(h.observedModelConnections.getSettings).not.toHaveBeenCalled()
  for (const input of [{ writePolicy: 'workspace-grant' }, { observed, input: { privacyNoticeAccepted: true } },
    { observed, input: { writePolicy: undefined } }, { observed, input: { writePolicy: 'workspace-grant' }, retry: true }]) {
    expect((await h.operations.setAiConversationSettings(input)).ok).toBe(false)
  }
  expect(h.observedModelConnections.setFeature).toHaveBeenCalledOnce()
})

it('requires an explicit original observation for Codex probes and preserves conflicts as values', async () => {
  const h = harness()
  expect((await h.operations.testCodexCliConnection()).ok).toBe(false)
  expect(h.observedCodexCliConnections.test).not.toHaveBeenCalled()
  expect((await h.operations.testCodexCliConnection({ observed })).ok).toBe(true)
  expect(h.observedCodexCliConnections.test).toHaveBeenCalledExactlyOnceWith(observed)
  const conflict: PublicModelMutationResult = { status: 'conflict', snapshot: observed, reason: 'field-changed', conflicts: [] }
  h.observedModelConnections.setFeature.mockResolvedValue(conflict)
  expect(await h.operations.setAiConversationSettings({ observed, input: { writePolicy: 'document-grant' } })).toEqual({ ok: true, value: conflict })
})
