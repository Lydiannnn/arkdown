import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LARGE_MODEL_SETTINGS, CODEX_CLI_CONNECTION_ID, CODEX_CLI_BASE_URL, featureModelConnections, parseLargeModelSettings, parseModelConnectionSummary } from '../../src/shared/large-model-settings'
import { ModelConnectionService } from '../../src/main/models/model-connection-service'
import { CodexCliConnectionService } from '../../src/main/codex/codex-cli-connection-service'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import type { ModelSecretVault } from '../../src/main/models/model-secret-vault'
import { TranslationSessionService } from '../../src/main/models/translation-session-service'
import { createScreenshotTranslationService } from '../../src/main/screenshot-translation/screenshot-translation-service'
import type { ModelChatInput } from '../../src/main/models/model-protocol-client'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { modelThinkingControlState } from '../../src/shared/model-thinking'
import { transactionalModelFixture } from '../helpers/transactional-model-service'

it('preserves discovered CLI model selections and their exact reasoning capabilities across persistence and IPC', async () => {
  const h = harness()
  const catalog = [{ modelId: 'account-model', displayName: 'Account model', supportedReasoningEfforts: ['low', 'ultra'], defaultReasoningEffort: 'low', isDefault: true }]
  await h.settings.update(current => ({ ...current, models: { ...models(), codexCli: { ...models().codexCli, models: catalog } } } as any))
  const choice = featureModelConnections(h.service.getSettings()).find(item => item.modelId === 'account-model')!
  expect(choice).toBeDefined()
  expect(modelThinkingControlState(choice, { thinkingMode: 'default', reasoningEffort: 'ultra' as any }).efforts).toEqual(['low', 'ultra'])
  await h.service.setAiConversation({ connectionId: choice.id, thinkingMode: 'default', reasoningEffort: 'ultra' as any, writePolicy: 'ask-every-time' })
  expect(parseLargeModelSettings(h.service.getSettings())?.aiConversation).toMatchObject({ connectionId: choice.id, reasoningEffort: 'ultra' })
  expect(await h.service.getCredentialSnapshot(choice.id)).toMatchObject({ connection: { modelId: 'account-model' }, apiKey: '' })
  const cli = new CodexCliConnectionService(h.settings, { test: async () => ({ status: 'timeout' }), dispose: async () => {} })
  await cli.test()
  expect(h.service.getSettings().aiConversation.connectionId).toBe(choice.id)
  expect(featureModelConnections(h.service.getSettings()).some(item => item.id === choice.id)).toBe(true)
  const refreshed = new CodexCliConnectionService(h.settings, { test: async () => ({ status: 'connected', cliVersion: 'new', models: [{ ...catalog[0], modelId: 'replacement-model' }] } as any), dispose: async () => {} })
  await refreshed.test()
  expect(h.service.getSettings().aiConversation.connectionId).toBe(choice.id)
  expect(featureModelConnections(h.service.getSettings()).find(item => item.id === choice.id)?.status).toBe('model-not-found')
  await cli.remove()
  expect(h.service.getSettings().aiConversation.connectionId).toBeNull()
})

function models() { return { ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS),codexCli:{status:'connected' as const,cliVersion:'codex-cli test',lastTestedAt:'2026-09-13T00:00:00.000Z'} } }
function harness() {
  const settings=new SettingsCoordinator({save:vi.fn(async()=>{})},{lastWorkspace:null,models:models()})
  const vault={get:vi.fn(async()=>{throw Error('CLI must never access API vault')}),set:vi.fn(),delete:vi.fn(),snapshot:vi.fn(),restore:vi.fn()}
  const streamChat=vi.fn(async(input:ModelChatInput)=>{input.onDelta('译文'); return {toolCalls:[],reasoningContent:'',providerReplay:null,usage:null}})
  const client={streamChat,testConnection:vi.fn()}
  const service=new ModelConnectionService(settings,vault,client)
  return {settings,vault,client,service}
}
describe('Codex feature bindings',()=>{
  it('persists only the independent CLI summary and accepts feature references, never an API connection',()=>{
    const settings=models(); settings.aiConversation.connectionId=CODEX_CLI_CONNECTION_ID
    expect(parseLargeModelSettings(settings)?.aiConversation.connectionId).toBe(CODEX_CLI_CONNECTION_ID)
    expect(settings.connections).toEqual([])
    expect(parseModelConnectionSummary(featureModelConnections(settings)[0])).toBeUndefined()
    expect(parseLargeModelSettings({...settings,codexCli:null})).toBeUndefined()
  })
  it('binds all three features through the real service and retrieves CLI credentials without vault access',async()=>{
    const h=harness()
    const preference={connectionId:CODEX_CLI_CONNECTION_ID,thinkingMode:'default' as const,reasoningEffort:'default' as const}
    await h.service.setSelectionTranslation({...preference,targetLanguage:'en'})
    await h.service.setScreenshotTranslation({...preference,targetLanguage:'zh-CN'})
    await h.service.setAiConversation({...preference,writePolicy:'ask-every-time'})
    const settings=h.service.getSettings()
    for(const feature of ['selectionTranslation','screenshotTranslation','aiConversation'] as const) expect(settings[feature].connectionId).toBe(CODEX_CLI_CONNECTION_ID)
    expect(await h.service.getCredentialSnapshot(CODEX_CLI_CONNECTION_ID)).toMatchObject({connection:{baseUrl:CODEX_CLI_BASE_URL},apiKey:''})
    expect(h.vault.get).not.toHaveBeenCalled()
  })
  it('passes feature references through preload and IPC but refuses API test/delete for the CLI ID',async()=>{
    const h=harness()
    const { service } = await transactionalModelFixture(models(), h.client)
    const testConnection = vi.spyOn(service, 'test')
    const deleteConnection = vi.spyOn(service, 'delete')
    const operations=createIpcOperations({chooseDirectory:vi.fn(),workspace:{} as never,documents:{} as never,observedModelConnections:service,getLastWorkspace:()=>null,setLastWorkspace:vi.fn(),reportError:vi.fn()})
    const api=createArkdownApi(async(channel,input)=>{
      if(channel===IPC_CHANNELS.setSelectionTranslationSettings) return operations.setSelectionTranslationSettings(input)
      if(channel===IPC_CHANNELS.setScreenshotTranslationSettings) return operations.setScreenshotTranslationSettings(input)
      if(channel===IPC_CHANNELS.setAiConversationSettings) return operations.setAiConversationSettings(input)
      if(channel===IPC_CHANNELS.testModel) return operations.testModel(input)
      if(channel===IPC_CHANNELS.deleteModel) return operations.deleteModel(input)
      throw Error('Unexpected test IPC')
    })
    const preference={connectionId:CODEX_CLI_CONNECTION_ID,thinkingMode:'default' as const,reasoningEffort:'default' as const}
    await expect(api.setSelectionTranslationSettings({...preference,targetLanguage:'en'}, await service.getSettings())).resolves.toMatchObject({ok:true,value:{snapshot:{settings:{selectionTranslation:preference}}}})
    await expect(api.setScreenshotTranslationSettings({...preference,targetLanguage:'en'}, await service.getSettings())).resolves.toMatchObject({ok:true,value:{snapshot:{settings:{screenshotTranslation:preference}}}})
    await expect(api.setAiConversationSettings({...preference,writePolicy:'ask-every-time'}, await service.getSettings())).resolves.toMatchObject({ok:true,value:{snapshot:{settings:{aiConversation:preference}}}})
    await expect(api.testModel(CODEX_CLI_CONNECTION_ID, await service.getSettings())).resolves.toMatchObject({ok:false})
    await expect(api.deleteModel(CODEX_CLI_CONNECTION_ID, await service.getSettings())).resolves.toMatchObject({ok:false})
    expect(testConnection).not.toHaveBeenCalled()
    expect(deleteConnection).not.toHaveBeenCalled()
  })
  it('removal clears every CLI binding atomically and invalidates the AI model revision',async()=>{
    const h=harness()
    await h.settings.update(settings=>({ ...settings,models:{...models(),selectionTranslation:{...models().selectionTranslation,connectionId:CODEX_CLI_CONNECTION_ID},screenshotTranslation:{...models().screenshotTranslation,connectionId:CODEX_CLI_CONNECTION_ID},aiConversation:{...models().aiConversation,connectionId:CODEX_CLI_CONNECTION_ID}} }))
    const before=h.settings.getAiConversationModelSelectionSnapshot().revision
    const service=new CodexCliConnectionService(h.settings,{test:vi.fn(),dispose:vi.fn()})
    const result=await service.remove()
    expect(result.codexCli).toBeNull()
    for(const feature of ['selectionTranslation','screenshotTranslation','aiConversation'] as const) expect(result[feature].connectionId).toBeNull()
    expect(h.settings.getAiConversationModelSelectionSnapshot().revision).toBeGreaterThan(before)
  })
  it('sends selection and screenshot translation through the CLI transport without looking up a key',async()=>{
    const h=harness()
    await h.settings.update(settings=>({...settings,models:{...models(),selectionTranslation:{...models().selectionTranslation,connectionId:CODEX_CLI_CONNECTION_ID},screenshotTranslation:{...models().screenshotTranslation,connectionId:CODEX_CLI_CONNECTION_ID}}}))
    const selection=new TranslationSessionService({settings:h.settings,secrets:h.vault as unknown as ModelSecretVault,client:h.client,events:{emit:vi.fn()}})
    await selection.start({documentKey:'test.md',content:{plainText:'hello',markdown:'hello'},mode:'source'})
    await vi.waitFor(()=>expect(h.client.streamChat).toHaveBeenCalledTimes(1))
    expect(h.client.streamChat.mock.calls[0]![0]).toMatchObject({baseUrl:CODEX_CLI_BASE_URL,apiKey:''})
    const screenshotClient={streamChat:vi.fn(async(input:ModelChatInput)=>{input.onDelta('{"translations":[{"id":"line-1","text":"译文"}]}');return {toolCalls:[],reasoningContent:'',providerReplay:null,usage:null}})}
    const screenshot=createScreenshotTranslationService({settings:h.settings,secrets:h.vault,client:screenshotClient,events:{emit:vi.fn()}})
    const start={sessionId:'123e4567-e89b-42d3-a456-426614174000',generation:1,blocks:[{id:'line-1',text:'hello',rectPx:{x:0,y:0,width:100,height:20},words:[{text:'hello',rectPx:{x:0,y:0,width:100,height:20}}]}]}
    await screenshot.start(start);await screenshot.whenSettled(start)
    expect(screenshotClient.streamChat.mock.calls[0]![0]).toMatchObject({baseUrl:CODEX_CLI_BASE_URL,apiKey:''})
    expect(h.vault.get).not.toHaveBeenCalled()
    selection.dispose();await screenshot.dispose()
  })
})
