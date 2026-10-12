import { expect, it } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { normalizeLargeModelSettings, type ModelConnectionSummary } from '../../src/shared/large-model-settings'
import { transactionalModelFixture } from '../helpers/transactional-model-service'
import { createModelProtocolClient } from '../../src/main/models/model-protocol-client'

it('round-trips all three thinking preferences across preload, strict IPC, coordinator, persistence, and requests', async () => {
  const connection: ModelConnectionSummary = { id: '11111111-1111-4111-8111-111111111111', name: 'Qwen', provider: 'qwen', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/', modelId: 'qwen3.8-max', apiKeyHint: '••••test', status: 'connected', lastTestedAt: null, capabilityOverride: null }
  const models = normalizeLargeModelSettings(undefined)
  models.connections = [connection]
  const bodies: Record<string, unknown>[] = []
  const client = createModelProtocolClient(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  })
  const { service, authority } = await transactionalModelFixture(models, client)
  const operations = createIpcOperations({ observedModelConnections: service, workspace: {} as never, documents: {} as never, chooseDirectory: async () => null, getLastWorkspace: () => null, setLastWorkspace: async () => undefined, reportError() {} })
  let invocations = 0
  const api = createArkdownApi(async (channel, input) => {
    invocations += 1
    if (channel === IPC_CHANNELS.setSelectionTranslationSettings) return operations.setSelectionTranslationSettings(input)
    if (channel === IPC_CHANNELS.setScreenshotTranslationSettings) return operations.setScreenshotTranslationSettings(input)
    if (channel === IPC_CHANNELS.setAiConversationSettings) return operations.setAiConversationSettings(input)
    throw new Error('Unexpected channel')
  })
  const preference = { connectionId: connection.id, thinkingMode: 'disabled' as const, reasoningEffort: 'xhigh' as const }
  expect((await api.setSelectionTranslationSettings!({ ...preference, targetLanguage: 'fr' }, await service.getSettings())).ok).toBe(true)
  expect((await api.setScreenshotTranslationSettings!({ ...preference, targetLanguage: 'ja' }, await service.getSettings())).ok).toBe(true)
  expect((await api.setAiConversationSettings!({ ...preference, writePolicy: 'ask-every-time' }, await service.getSettings())).ok).toBe(true)
  const reloaded = normalizeLargeModelSettings((await authority.readFresh()).settings.models)
  for (const feature of [reloaded.selectionTranslation, reloaded.screenshotTranslation, reloaded.aiConversation]) {
    expect(feature).toMatchObject(preference)
    await client.streamChat({ ...connection, ...feature, apiKey: 'fixture', messages: [{ role: 'user', content: 'go' }], signal: new AbortController().signal, onDelta() {} })
  }
  expect(bodies.map((body) => body.reasoning_effort)).toEqual(['none', 'none', 'none'])
  const count = invocations
  expect((await api.setAiConversationSettings!({ thinkingMode: 'invalid' } as never, await service.getSettings())).ok).toBe(false)
  expect(invocations).toBe(count)
  expect((await operations.setAiConversationSettings({ ...preference, thinkingMode: 'invalid', writePolicy: 'ask-every-time' })).ok).toBe(false)
})
