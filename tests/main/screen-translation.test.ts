import { afterEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import { DEFAULT_SCREEN_TRANSLATION, parseScreenTranslationBlocks, parseScreenTranslationPatch } from '../../src/shared/screen-translation'
import { parseScreenModelTranslations, ScreenModelTranslator } from '../../src/main/screen-translation/model-translator'
import { ScreenTranslationWorker } from '../../src/main/screen-translation/worker-client'
import { ScreenTranslationSettingsStore } from '../../src/main/screen-translation/settings-store'
import { ScreenScopedShortcut } from '../../src/main/screen-translation/scoped-shortcut'
import type { ModelConnectionSummary } from '../../src/shared/large-model-settings'
import type { ModelProtocolClient } from '../../src/main/models/model-protocol-client'

const connection = { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', name: 'test', provider: 'other', protocol: 'openai',
  baseUrl: 'http://127.0.0.1:9999/v1', modelId: 'test', capabilityOverride: null } as ModelConnectionSummary
const block = { box: [20, 30, 100, 90] as [number, number, number, number], text: 'Good morning', background: '#FFFFFF', foreground: '#333333' }
const signal = () => new AbortController().signal
describe('screen translation protocol and model mapping', () => {
  it('defaults new preferences to model and automatic target while rejecting arbitrary options and impossible geometry', () => {
    expect(DEFAULT_SCREEN_TRANSLATION).toMatchObject({ backend: 'model', target: 'auto' })
    expect(parseScreenTranslationPatch({ target: 'auto' })).toEqual({ target: 'auto' })
    expect(parseScreenTranslationPatch({ command: 'exec' })).toBeUndefined()
    expect(parseScreenTranslationPatch({ connectionId: 'codex-cli:synthetic-model', reasoningEffort: 'ultra' })).toEqual({ connectionId: 'codex-cli:synthetic-model', reasoningEffort: 'ultra' })
    expect(parseScreenTranslationPatch({ connectionId: 'codex-cli:' })).toBeUndefined()
    expect(parseScreenTranslationPatch({ connectionId: {} })).toBeUndefined()
    expect(parseScreenTranslationPatch({ reasoningEffort: 'unsupported' })).toBeUndefined()
    expect(parseScreenTranslationPatch({ bounds: { x: -200, y: 10, width: 300, height: 100 } })).toBeDefined()
    expect(parseScreenTranslationPatch({ bounds: { x: 0, y: 0, width: 10000, height: 10000 } })).toBeUndefined()
    expect(parseScreenTranslationBlocks([{ ...block, box: [50, 40, 20, 90] }])).toBeUndefined()
    expect(parseScreenTranslationBlocks([{ ...block, background: 'url(secret)' }])).toBeUndefined()
  })
  it('maps out-of-order IDs and refuses missing/duplicated/noninteger entries', () => {
    expect(parseScreenModelTranslations('{"translations":[{"id":1,"text":"乙"},{"id":0,"text":"甲"}]}', 2)).toEqual(['甲', '乙'])
    for (const text of ['{"translations":[]}', '{"translations":[{"id":0,"text":"甲"},{"id":0,"text":"乙"}]}', '{"translations":[{"id":0.5,"text":"甲"},{"id":1,"text":"乙"}]}']) {
      expect(() => parseScreenModelTranslations(text, 2)).toThrow()
    }
  })
  it('deduplicates text, keeps coordinates and caches by target and model identity', async () => {
    const streamChat = vi.fn(async input => { input.onDelta('{"translations":[{"id":0,"text":"早上好"}]}'); return {} })
    const translator = new ScreenModelTranslator({ streamChat } as unknown as ModelProtocolClient)
    const duplicate = { ...block, box: [200, 300, 500, 400] as typeof block.box }
    const preferences = { ...DEFAULT_SCREEN_TRANSLATION, backend: 'model' as const, connectionId: connection.id }
    const translated = await translator.translate([block, duplicate], connection, 'synthetic-test-key', preferences, signal())
    expect(translated.map(value => value.text)).toEqual(['早上好', '早上好'])
    expect(translated.map(value => value.box)).toEqual([block.box, duplicate.box])
    await translator.translate([block], connection, 'synthetic-test-key', preferences, signal())
    expect(streamChat).toHaveBeenCalledTimes(1)
    await translator.translate([block], connection, 'synthetic-test-key', { ...preferences, target: 'jp' }, signal())
    await translator.translate([block], { ...connection, modelId: 'different' }, 'synthetic-test-key', preferences, signal())
    expect(streamChat).toHaveBeenCalledTimes(3)
    expect(streamChat.mock.calls[0]![0].messages[1].content).toBe('[{"id":0,"text":"Good morning"}]')
    expect(streamChat.mock.calls[0]![0].messages[0].content).toContain('简体中文')
  })
  it('does not call a provider for blank OCR or canceled work', async () => {
    const streamChat = vi.fn()
    const translator = new ScreenModelTranslator({ streamChat } as unknown as ModelProtocolClient)
    expect(await translator.translate([], connection, 'test', DEFAULT_SCREEN_TRANSLATION, signal())).toEqual([])
    const controller = new AbortController(); controller.abort()
    await expect(translator.translate([block], connection, 'test', DEFAULT_SCREEN_TRANSLATION, controller.signal)).rejects.toThrow()
    expect(streamChat).not.toHaveBeenCalled()
  })
  it('resolves one automatic direction from all OCR text and partitions cache by the resolved target', async () => {
    const streamChat = vi.fn(async input => {
      const entries = JSON.parse(input.messages[1].content) as { id: number; text: string }[]
      const english = input.messages[0].content.includes('翻译为英语')
      input.onDelta(JSON.stringify({ translations: entries.map(entry => ({ id: entry.id, text: `${english ? 'en' : 'zh'}:${entry.text}` })) }))
      return {}
    })
    const translator = new ScreenModelTranslator({ streamChat } as unknown as ModelProtocolClient)
    const preferences = { ...DEFAULT_SCREEN_TRANSLATION, target: 'auto' }
    const chinese = { ...block, text: '今天我们一起学习中文，这是一段以中文为主的完整句子。' }
    const mixed = await translator.translate([chinese, block], connection, 'test', preferences, signal())
    expect(mixed.every(item => item.text.startsWith('en:'))).toBe(true)
    const english = await translator.translate([block], connection, 'test', preferences, signal())
    expect(english[0]!.text).toBe('zh:Good morning')
    expect(streamChat).toHaveBeenCalledTimes(2)
    await translator.translate([block], connection, 'test', { ...preferences, target: 'zh' }, signal())
    expect(streamChat).toHaveBeenCalledTimes(2)
    await translator.translate([chinese], connection, 'test', { ...preferences, target: 'jp' }, signal())
    expect(streamChat.mock.calls.at(-1)![0].messages[0].content).toContain('翻译为日语')
  })
})

const workers: ScreenTranslationWorker[] = []
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.dispose())) })
function worker(timeoutMs = 3000) {
  const value = new ScreenTranslationWorker({ executable: process.execPath,
    args: [path.resolve('tests/fixtures/screen-translation-worker.mjs')], credentialsFile: path.join(os.tmpdir(), 'synthetic-unused-credentials'), timeoutMs })
  workers.push(value); return value
}
describe('screen worker real process pipe', () => {
  it('preserves UTF-8 and reuses one child for queued requests', async () => {
    const engine = worker()
    const [one, two] = await Promise.all([engine.request({ mode: 'echo' }), engine.request({ mode: 'echo' })])
    expect(one.text).toBe('中文与日本語'); expect(one.pid).toBe(two.pid)
  })
  it('cancels a running child and recovers without replaying canceled data', async () => {
    const engine = worker(); const first = await engine.request({ mode: 'echo' })
    const controller = new AbortController()
    const pending = engine.request({ mode: 'hang' }, controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    setTimeout(() => controller.abort(), 40)
    await rejected
    const next = await engine.request({ mode: 'echo' })
    expect(next.pid).not.toBe(first.pid)
  })
  it('rejects wrong response IDs and starts a clean worker after failure', async () => {
    const engine = worker()
    await expect(engine.request({ mode: 'wrong' })).rejects.toThrow('响应不匹配')
    expect((await engine.request({ mode: 'echo' })).text).toBe('中文与日本語')
  })
  it('bounds request time and closes a silent child', async () => {
    const engine = worker(800)
    await expect(engine.request({ mode: 'hang' })).rejects.toThrow('超时')
    expect((await engine.request({ mode: 'echo' })).configured).toBe(true)
  })
})

describe('screen translation independent preferences', () => {
  it('serializes concurrent updates without losing fields or storing runtime state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ark-screen-settings-'))
    try {
      const store = new ScreenTranslationSettingsStore(root); await store.load()
      await Promise.all([store.update({ target: 'en' }), store.update({ triggerMode: 'hotkey' })])
      const reopened = new ScreenTranslationSettingsStore(root); await reopened.load()
      expect(reopened.get()).toMatchObject({ target: 'en', triggerMode: 'hotkey' })
      const raw = await readFile(path.join(root, 'settings.json'), 'utf8')
      expect(raw).not.toMatch(/apiKey|secretKey|automatic.*true|blocks/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('scoped global shortcuts', () => {
  it('is idle when the tool is closed and keeps recording independent of module activity', async () => {
    const keys = new Set<string>()
    const adapter = { register: vi.fn((key: string) => { keys.add(key); return true }), unregister: vi.fn((key: string) => { keys.delete(key) }), isRegistered: (key: string) => keys.has(key) }
    const shortcut = new ScreenScopedShortcut(adapter, 'Ctrl+Shift+A', vi.fn(), vi.fn())
    await shortcut.replace('Ctrl+Shift+B', async () => undefined)
    expect(keys.size).toBe(0)
    shortcut.suspend(); shortcut.activate(); expect(keys.size).toBe(0)
    shortcut.resume(); expect(keys.has('Ctrl+Shift+B')).toBe(true)
    shortcut.deactivate(); shortcut.resume(); expect(keys.size).toBe(0)
  })
  it('rolls registration back if persistence fails', async () => {
    const keys = new Set<string>()
    const adapter = { register: (key: string) => { keys.add(key); return true }, unregister: (key: string) => { keys.delete(key) }, isRegistered: (key: string) => keys.has(key) }
    const shortcut = new ScreenScopedShortcut(adapter, 'Ctrl+Shift+A', vi.fn(), vi.fn()); shortcut.activate()
    await expect(shortcut.replace('Ctrl+Shift+B', async () => { throw new Error('disk') })).rejects.toThrow()
    expect([...keys]).toEqual(['Ctrl+Shift+A']); shortcut.dispose()
  })
})
