import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'
import { connectionEditRequest, modelFeatureRequest, observeModelSettings } from '../../src/main/settings/settings-command-adapter'
import { TranslationSessionService } from '../../src/main/models/translation-session-service'
import type { ModelConnectionSummary } from '../../src/shared/large-model-settings'
import type { TranslationEvent } from '../../src/shared/selection-translation'
import type { ModelProtocolClient } from '../../src/main/models/model-protocol-client'
import { createScreenshotTranslationService } from '../../src/main/screenshot-translation/screenshot-translation-service'
import type { ScreenshotTranslationEvent } from '../../src/shared/screenshot-translation'
import { ScreenModelTranslator } from '../../src/main/screen-translation/model-translator'
import { DEFAULT_SCREEN_TRANSLATION } from '../../src/shared/screen-translation'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const id = '550e8400-e29b-41d4-a716-446655440000'
const cipher = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(`synthetic:${value}`), decrypt: (value: Buffer) => value.toString().slice(10) }
const connection: ModelConnectionSummary = { id, name: 'Synthetic', provider: 'other', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://example.com/v1', modelId: 'synthetic', apiKeyHint: '••••test', status: 'connected', lastTestedAt: null, capabilityOverride: null }
const result = { toolCalls: [], reasoningContent: '', providerReplay: null, usage: null }
const input = { documentKey: 'synthetic.md', content: { markdown: 'Hello', plainText: 'Hello' }, mode: 'visual' as const }
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-translation-authority-')); roots.push(root)
  const store = new SettingsTransactionStore(root, cipher)
  await store.apply({ baseRevision: 0, operations: [{ kind: 'model-connection.add', connection, expectedAbsentRevision: 0 }] }, { id, ciphertext: store.encryptCredential('original-test') })
  await store.apply(modelFeatureRequest(observeModelSettings(await store.readSnapshot()), 'selectionTranslation', { connectionId: id, targetLanguage: 'fr' }))
  await store.apply(modelFeatureRequest(observeModelSettings(await store.readSnapshot()), 'screenshotTranslation', { connectionId: id, targetLanguage: 'fr' }))
  expect(await store.apply(modelFeatureRequest(observeModelSettings(await store.readSnapshot()), 'floatingTranslation', { connectionId: id, target: 'fra' }))).toMatchObject({ status: 'committed' })
  const authority = new SettingsAuthority(store)
  await authority.readFresh()
  const events: TranslationEvent[] = []
  const streamChat = vi.fn<ModelProtocolClient['streamChat']>(async () => result)
  const service = new TranslationSessionService({ authority, client: { streamChat, testConnection: async () => undefined }, events: { emit: event => events.push(event) } })
  return { authority, second: new SettingsTransactionStore(root, cipher, {}, 500), streamChat, service, events }
}

describe('selection translation authoritative request admission', () => {
  it('uses the latest paired endpoint, key and feature even when the display cache is stale', async () => {
    const { authority, second, streamChat, service, events } = await fixture()
    const observed = observeModelSettings(await second.readSnapshot())
    await second.apply(connectionEditRequest(observed, { ...connection, baseUrl: 'https://updated.example/v1' }, true), { id, ciphertext: second.encryptCredential('replacement-test') })
    await second.apply(modelFeatureRequest(observeModelSettings(await second.readSnapshot()), 'selectionTranslation', { targetLanguage: 'de' }))
    expect(authority.getDisplaySnapshot().settings.models!.connections[0]!.baseUrl).toBe(connection.baseUrl)
    expect(await service.start(input)).toMatchObject({ targetLanguage: 'de' })
    await vi.waitFor(() => expect(events.some(event => event.type === 'completed')).toBe(true))
    expect(streamChat.mock.calls[0]![0]).toMatchObject({ baseUrl: 'https://updated.example/v1', apiKey: 'replacement-test' })
    service.dispose()
  })

  it('does not start a request when credentials changed after the paired read', async () => {
    const { authority, second, streamChat, service, events } = await fixture()
    const read = authority.readExecution.bind(authority)
    vi.spyOn(authority, 'readExecution').mockImplementationOnce(async target => {
      const paired = await read(target)
      await second.apply(connectionEditRequest(paired.observed, connection, true), { id, ciphertext: second.encryptCredential('replacement-test') })
      return paired
    })
    await expect(service.start(input)).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(streamChat).not.toHaveBeenCalled()
    expect(events).toEqual([])
    service.dispose()
  })

  it('registers the request synchronously but releases the settings lease before streaming finishes', async () => {
    const { second, streamChat, service, events } = await fixture()
    let finish!: () => void
    streamChat.mockImplementationOnce(async () => { await new Promise<void>(resolve => { finish = resolve }); return result })
    const started = await service.start(input)
    expect(events).toContainEqual({ requestId: started.requestId, type: 'started' })
    expect(await second.apply({ baseRevision: (await second.readSnapshot()).revision, operations: [{ kind: 'workspace.set', value: 'next', mode: 'last-writer-wins' }] })).toMatchObject({ status: 'committed' })
    finish()
    await vi.waitFor(() => expect(events.some(event => event.type === 'completed')).toBe(true))
    service.dispose()
  })
})

describe('floating translation model request admission', () => {
  it('stops after a credential change between batches without caching a partial frame', async () => {
    const { authority, second } = await fixture()
    const paired = await authority.readExecution({ feature: 'floatingTranslation' })
    const streamChat = vi.fn<ModelProtocolClient['streamChat']>(async input => {
      const items = JSON.parse(input.messages[1]!.content) as Array<{ id: number }>
      input.onDelta(JSON.stringify({ translations: items.map(item => ({ id: item.id, text: 'translated' })) }))
      await second.apply(connectionEditRequest(observeModelSettings(await second.readSnapshot()), connection, true), { id, ciphertext: second.encryptCredential('replacement-test') })
      return result
    })
    const translator = new ScreenModelTranslator({ streamChat, testConnection: async () => undefined })
    const blocks = Array.from({ length: 33 }, (_, index) => ({ text: `source-${index}`, box: [index, 0, index + 1, 1] as [number, number, number, number], background: '#ffffff', foreground: '#000000' }))
    await expect(translator.translate(blocks, paired.connection, paired.apiKey!, { ...DEFAULT_SCREEN_TRANSLATION, connectionId: id, backend: 'model', target: 'fra' }, new AbortController().signal, { authority, observed: paired.observed })).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_AUTHORITY_CHANGED' })
    expect(streamChat).toHaveBeenCalledOnce()
  })

  it('partitions cached output by observed settings revision and validates a cache hit before publishing', async () => {
    const { authority, second } = await fixture()
    const paired = await authority.readExecution({ feature: 'floatingTranslation' })
    const streamChat = vi.fn<ModelProtocolClient['streamChat']>(async input => { input.onDelta(JSON.stringify({ translations: [{ id: 0, text: 'translated' }] })); return result })
    const translator = new ScreenModelTranslator({ streamChat, testConnection: async () => undefined })
    const blocks = [{ text: 'source', box: [0, 0, 1, 1] as [number, number, number, number], background: '#ffffff', foreground: '#000000' }]
    const preferences = { ...DEFAULT_SCREEN_TRANSLATION, connectionId: id, backend: 'model' as const, target: 'fra' }
    await translator.translate(blocks, paired.connection, paired.apiKey!, preferences, new AbortController().signal, { authority, observed: paired.observed })
    await second.apply(connectionEditRequest(paired.observed, connection, true), { id, ciphertext: second.encryptCredential('replacement-test') })
    await expect(translator.translate(blocks, paired.connection, paired.apiKey!, preferences, new AbortController().signal, { authority, observed: paired.observed })).rejects.toMatchObject({ code: 'SETTINGS_TRANSACTION_AUTHORITY_CHANGED' })
    const fresh = await authority.readExecution({ feature: 'floatingTranslation' })
    await translator.translate(blocks, fresh.connection, fresh.apiKey!, preferences, new AbortController().signal, { authority, observed: fresh.observed })
    expect(streamChat).toHaveBeenCalledTimes(2)
  })
})

const sessionId = '650e8400-e29b-41d4-a716-446655440000'
const screenshotInput = (count = 1) => ({ sessionId, generation: 1, blocks: Array.from({ length: count }, (_, index) => ({ id: `line-${index + 1}`, text: `source-${index}`, rectPx: { x: index, y: 0, width: 1, height: 1 }, words: [{ text: `source-${index}`, rectPx: { x: index, y: 0, width: 1, height: 1 } }] })) })
describe('screenshot translation authority admission', () => {
  it('checks the original paired generation before each batch and does not publish a partial result', async () => {
    const { authority, second } = await fixture()
    const events: ScreenshotTranslationEvent[] = []
    const streamChat = vi.fn<ModelProtocolClient['streamChat']>(async input => {
      const blocks = (JSON.parse(input.messages[1]!.content) as { blocks: Array<{ id: string }> }).blocks
      input.onDelta(JSON.stringify({ translations: blocks.map(block => ({ id: block.id, text: 'translated' })) }))
      const observed = observeModelSettings(await second.readSnapshot())
      await second.apply(connectionEditRequest(observed, connection, true), { id, ciphertext: second.encryptCredential('replacement-test') })
      return result
    })
    const service = createScreenshotTranslationService({ authority, client: { streamChat }, events: { emit: event => events.push(event) } })
    await service.start(screenshotInput(129))
    await service.whenSettled({ sessionId, generation: 1 })
    expect(streamChat).toHaveBeenCalledOnce()
    expect(events.some(event => event.type === 'translation-completed')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'MODEL_UNAVAILABLE' })
    await service.dispose()
  })

  it('keeps cancellation and settlement ownership during the paired read', async () => {
    const { authority } = await fixture()
    const read = authority.readExecution.bind(authority)
    let release!: () => void
    vi.spyOn(authority, 'readExecution').mockImplementationOnce(async target => {
      const paired = await read(target)
      await new Promise<void>(resolve => { release = resolve })
      return paired
    })
    const events: ScreenshotTranslationEvent[] = []
    const streamChat = vi.fn<ModelProtocolClient['streamChat']>(async () => result)
    const service = createScreenshotTranslationService({ authority, client: { streamChat }, events: { emit: event => events.push(event) } })
    const starting = service.start(screenshotInput())
    void starting.catch(() => undefined)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    let settled = false
    const cancellation = service.cancel({ sessionId, generation: 1 }).then(() => { settled = true })
    expect(events.at(-1)).toMatchObject({ type: 'translation-cancelled' })
    expect(settled).toBe(false)
    release(); await starting; await cancellation
    expect(streamChat).not.toHaveBeenCalled()
    await service.dispose()
  })
})
