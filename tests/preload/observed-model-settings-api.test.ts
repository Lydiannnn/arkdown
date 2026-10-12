import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import type { PublicModelSettingsSnapshot } from '../../src/shared/settings-observation'

const observed: PublicModelSettingsSnapshot = { settings: structuredClone(DEFAULT_LARGE_MODEL_SETTINGS),
  observation: { version: 1, revision: 2, minimumBaseRevision: 0, fields: {}, connections: {} } }

it('passes the captured observation unchanged beside a finite feature patch', async () => {
  const mutation = { status: 'committed', snapshot: observed }
  const invoke = vi.fn().mockResolvedValueOnce({ ok: true, value: observed }).mockResolvedValue({ ok: true, value: mutation })
  const api = createArkdownApi(invoke)
  expect(await api.getModelSettingsSnapshot()).toEqual({ ok: true, value: observed })
  expect(await api.setAiConversationSettings({ writePolicy: 'document-grant' }, observed)).toEqual({ ok: true, value: mutation })
  expect(invoke.mock.calls).toEqual([[IPC_CHANNELS.getModelSettingsSnapshot], [IPC_CHANNELS.setAiConversationSettings,
    { observed, input: { writePolicy: 'document-grant' } }]])
})

it('rejects missing observations and arbitrary feature paths before invoke', async () => {
  const invoke = vi.fn(), api = createArkdownApi(invoke)
  expect((await api.setAiConversationSettings({ writePolicy: 'document-grant' }, undefined as never)).ok).toBe(false)
  expect((await api.setAiConversationSettings({ path: 'models.aiConversation.writePolicy', value: 'document-grant' } as never, observed)).ok).toBe(false)
  expect((await api.testCodexCliConnection(undefined as never)).ok).toBe(false)
  expect(invoke).not.toHaveBeenCalled()
})

it('returns a validated catalog conflict and rejects a bare legacy successful response', async () => {
  const conflict = { status: 'conflict', snapshot: observed, reason: 'field-changed', conflicts: [] }
  const invoke = vi.fn().mockResolvedValueOnce({ ok: true, value: conflict }).mockResolvedValue({ ok: true, value: DEFAULT_LARGE_MODEL_SETTINGS })
  const api = createArkdownApi(invoke)
  expect(await api.listModels({ provider: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic' }, observed))
    .toEqual({ ok: true, value: conflict })
  expect((await api.setSelectionTranslationSettings({ targetLanguage: 'ja' }, observed)).ok).toBe(false)
})
