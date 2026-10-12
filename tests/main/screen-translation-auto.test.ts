import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SCREEN_TRANSLATION, type ScreenTranslationBlock } from '../../src/shared/screen-translation'
import { readScreenTranslationBlocks } from '../../src/main/screen-translation/translation-pipeline'
import { resolveScreenTranslationTarget } from '../../src/main/screen-translation/target-language'

const block = (text: string): ScreenTranslationBlock => ({ box: [0, 0, 100, 100], text, background: '#ffffff', foreground: '#333333' })
const preferences = { ...DEFAULT_SCREEN_TRANSLATION, target: 'auto' }
const image = 'synthetic-png'

describe('floating translation automatic target execution', () => {
  it.each([
    [['这是一段完整的中文内容，我们一起学习自然语言。', 'OK'], 'en'],
    [['English source text'], 'zh'],
    [['こんにちは東京', '日本語です'], 'zh'],
    [['오늘 서울에서 만나요'], 'zh'],
    [['https://example.com/path'], 'zh'],
    [[], 'zh'],
  ])('uses the shared plain-text direction for the whole OCR result %j', (text, target) => {
    expect(resolveScreenTranslationTarget(text.map(block), 'auto')).toBe(target)
  })
  it('keeps explicit Baidu fixed language codes unchanged', () => {
    for (const target of ['zh', 'cht', 'en', 'jp', 'th', 'vie']) expect(resolveScreenTranslationTarget([block('中文')], target)).toBe(target)
  })
  it('sends model OCR through the unchanged worker fixed-target contract without translating', async () => {
    const blocks = [block('中文')]
    const worker = { request: vi.fn(async () => ({ blocks })) }
    expect(await readScreenTranslationBlocks(worker, image, { ...preferences, backend: 'model' }, new AbortController().signal)).toEqual(blocks)
    expect(worker.request).toHaveBeenCalledExactlyOnceWith({ mode: 'ocr', image, target: 'zh' }, expect.any(AbortSignal))
  })
  it.each([['这是一段完整的中文内容，我们一起学习自然语言。', 'en'], ['Read this English sentence.', 'zh']])('resolves Baidu auto before issuing fixed-target translation: %s', async (source, target) => {
    const result = [block('translated')]
    const worker = { request: vi.fn().mockResolvedValueOnce({ blocks: [block(source)] }).mockResolvedValueOnce({ blocks: result }) }
    expect(await readScreenTranslationBlocks(worker, image, { ...preferences, backend: 'baidu' }, new AbortController().signal)).toEqual(result)
    expect(worker.request.mock.calls.map(call => call[0])).toEqual([{ mode: 'ocr', image, target: 'zh' }, { mode: 'translate', image, target }])
  })
  it('does not make a Baidu network request for blank auto OCR', async () => {
    const worker = { request: vi.fn(async () => ({ blocks: [] })) }
    expect(await readScreenTranslationBlocks(worker, image, { ...preferences, backend: 'baidu' }, new AbortController().signal)).toEqual([])
    expect(worker.request).toHaveBeenCalledTimes(1)
  })
  it('keeps fixed Baidu translation on the single-request path', async () => {
    const worker = { request: vi.fn(async () => ({ blocks: [block('translated')] })) }
    await readScreenTranslationBlocks(worker, image, { ...preferences, backend: 'baidu', target: 'jp' }, new AbortController().signal)
    expect(worker.request).toHaveBeenCalledExactlyOnceWith({ mode: 'translate', image, target: 'jp' }, expect.any(AbortSignal))
  })
  it('rejects malformed or canceled OCR before the second Baidu request', async () => {
    const worker = { request: vi.fn(async () => ({ blocks: [{ text: 'invalid' }] })) }
    await expect(readScreenTranslationBlocks(worker, image, { ...preferences, backend: 'baidu' }, new AbortController().signal)).rejects.toThrow('OCR')
    expect(worker.request).toHaveBeenCalledTimes(1)
    const canceled = new AbortController()
    const delayed = { request: vi.fn(async () => { canceled.abort(); return { blocks: [block('中文')] } }) }
    await expect(readScreenTranslationBlocks(delayed, image, { ...preferences, backend: 'baidu' }, canceled.signal)).rejects.toThrow()
    expect(delayed.request).toHaveBeenCalledTimes(1)
  })
  it('checks model/settings context before automatic Baidu translation', async () => {
    const worker = { request: vi.fn(async () => ({ blocks: [block('中文')] })) }
    const assertCurrent = () => { throw new Error('settings changed') }
    await expect(readScreenTranslationBlocks(worker, image, { ...preferences, backend: 'baidu' }, new AbortController().signal, assertCurrent)).rejects.toThrow('settings changed')
    expect(worker.request).toHaveBeenCalledTimes(1)
  })
})
