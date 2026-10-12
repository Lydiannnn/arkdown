import { describe, expect, it } from 'vitest'
import {
  SCREENSHOT_TRANSLATION_BATCH_BLOCK_LIMIT,
  SCREENSHOT_TRANSLATION_BATCH_PAYLOAD_MAX_BYTES,
  SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES,
  batchScreenshotTranslationBlocks,
  buildScreenshotDocumentTranslationMessages,
  buildScreenshotTranslationMessages,
  parseScreenshotTranslationResponse,
  resolveScreenshotTargetLanguage,
  removeScreenshotDuplicateNotice,
} from '../../src/main/screenshot-translation/screenshot-translation-prompts'
import { SCREENSHOT_TRANSLATED_TEXT_MAX_LENGTH } from '../../src/shared/screenshot-translation'

const blocks = [
  { id: 'line-1', text: 'Hello' },
  { id: 'line-2', text: 'https://example.com const itemId = 7' },
] as const

describe('screenshot translation prompts', () => {
  const duplicateNotice = '（本行重复并入上一条，请以上一条译文为准。）'

  it('reuses an exact duplicate source translation without copying unrelated preceding lines', () => {
    const requested = [{ id: 'line-1', text: 'Hello' }, { id: 'line-2', text: 'Hello' }, { id: 'line-3', text: 'World' }]
    const response = JSON.stringify({ translations: [
      { id: 'line-3', text: duplicateNotice }, { id: 'line-2', text: duplicateNotice }, { id: 'line-1', text: '你好' },
    ] })
    expect(parseScreenshotTranslationResponse(response, requested)).toEqual([
      { id: 'line-1', text: '你好' }, { id: 'line-2', text: '你好' }, { id: 'line-3', text: 'World' },
    ])
  })

  it('removes only the known generated notice and preserves it when actually present in the source', () => {
    expect(removeScreenshotDuplicateNotice(`第一条译文\n${duplicateNotice}\n下一条译文`, 'source')).toBe('第一条译文\n\n下一条译文')
    expect(removeScreenshotDuplicateNotice(`正文 ${duplicateNotice}`, duplicateNotice)).toBe(`正文 ${duplicateNotice}`)
    expect(removeScreenshotDuplicateNotice('普通的重复内容说明', 'source')).toBe('普通的重复内容说明')
    expect(parseScreenshotTranslationResponse(JSON.stringify({ translations: [{ id: 'line-1', text: duplicateNotice }] }), [{ id: 'line-1', text: duplicateNotice }]))
      .toEqual([{ id: 'line-1', text: duplicateNotice }])
  })

  it('builds a plain document prompt without OCR IDs, geometry, or screenshot metadata', () => {
    const source = 'First paragraph.\n\nSecond paragraph.'
    const messages = buildScreenshotDocumentTranslationMessages({
      text: source,
      targetLanguage: 'zh-CN',
    })

    expect(messages).toEqual([
      {
        role: 'system',
        content: expect.stringContaining('将 OCR 正文译为简体中文，仅输出译文'),
      },
      { role: 'user', content: source },
    ])
    expect(JSON.stringify(messages)).not.toMatch(/line-1|rectPx|words|data:image|window title/u)
  })

  it('sends exactly stable OCR IDs and text while excluding screenshot privacy metadata', () => {
    const privacyCanaries = {
      dataUrl: 'PRIVATE_SCREENSHOT_BYTES',
      rectPx: { x: 19, y: 23, width: 31, height: 37 },
      words: [{ text: 'PRIVATE_GEOMETRY', rectPx: { x: 1, y: 2, width: 3, height: 4 } }],
      title: 'PRIVATE_WINDOW_TITLE',
      path: 'C:\\PRIVATE\\document.md',
    }
    const messages = buildScreenshotTranslationMessages({
      blocks: blocks.map((block) => ({ ...block, ...privacyCanaries })),
      targetLanguage: 'fr',
    })

    expect(messages).toHaveLength(2)
    expect(messages[1]).toEqual({
      role: 'user',
      content: '{"blocks":[{"id":"line-1","text":"Hello"},{"id":"line-2","text":"https://example.com const itemId = 7"}]}',
    })
    const completeRequest = JSON.stringify(messages)
    for (const canary of [
      'PRIVATE_SCREENSHOT_BYTES', 'PRIVATE_GEOMETRY', 'PRIVATE_WINDOW_TITLE',
      'C:\\PRIVATE\\document.md', 'rectPx', 'words', 'dataUrl',
    ]) expect(completeRequest).not.toContain(canary)
  })

  it('requires one strict JSON object, stable supplied IDs, preservation, and no prose', () => {
    const system = buildScreenshotTranslationMessages({ blocks, targetLanguage: 'de' })[0]?.content ?? ''

    for (const contract of [
      '译为德语', '仅返回 {"translations":', 'id 原样且各一次',
      '不合并、拆分或转移内容', '非空单行', 'JSON 转义且无控制字符',
      '不加字段、说明或围栏', 'URL', '代码和标识符',
    ]) expect(system).toContain(contract)
    expect(Array.from(system).length).toBeLessThanOrEqual(240)
    expect(system).not.toContain('Hello')
    expect(system).not.toContain('line-1')
  })

  it('uses explicit targets and sends English or mixed text to Chinese while pure Chinese goes to English', () => {
    expect(resolveScreenshotTargetLanguage(blocks, 'ja')).toBe('ja')
    expect(resolveScreenshotTargetLanguage([{ id: 'line-1', text: 'English' }], 'auto')).toBe('zh-CN')
    expect(resolveScreenshotTargetLanguage([
      { id: 'line-1', text: 'English' },
      { id: 'line-2', text: '中文' },
    ], 'auto')).toBe('zh-CN')
    expect(resolveScreenshotTargetLanguage([
      { id: 'line-1', text: '订单编号 20260817，今天下午交付。' },
    ], 'auto')).toBe('en')
    expect(resolveScreenshotTargetLanguage([
      { id: 'line-1', text: '20260817 — …' },
    ], 'auto')).toBe('zh-CN')
    expect(buildScreenshotTranslationMessages({ blocks, targetLanguage: 'auto' })[0]?.content)
      .toContain('译为简体中文')
  })

  it('creates deterministic serial-ready batches at 128 blocks and 48 KiB user JSON', () => {
    expect(SCREENSHOT_TRANSLATION_BATCH_BLOCK_LIMIT).toBe(128)
    expect(SCREENSHOT_TRANSLATION_BATCH_PAYLOAD_MAX_BYTES).toBe(48 * 1024)
    expect(SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES).toBe(512 * 1024)
    const source = Array.from({ length: 260 }, (_, index) => ({
      id: `line-${index + 1}`,
      text: `text-${index + 1}`,
    }))

    const first = batchScreenshotTranslationBlocks(source)
    const second = batchScreenshotTranslationBlocks(source)

    expect(first).toEqual(second)
    expect(first.map((batch) => batch.length)).toEqual([128, 128, 4])
    expect(first.flat().map((block) => block.id)).toEqual(source.map((block) => block.id))
    for (const batch of first) {
      const payload = JSON.stringify({ blocks: batch })
      expect(new TextEncoder().encode(payload).byteLength)
        .toBeLessThanOrEqual(SCREENSHOT_TRANSLATION_BATCH_PAYLOAD_MAX_BYTES)
    }
  })

  it('splits before a multibyte payload would exceed 48 KiB', () => {
    const source = Array.from({ length: 10 }, (_, index) => ({
      id: `line-${index + 1}`,
      text: '汉'.repeat(2_000),
    }))
    const batches = batchScreenshotTranslationBlocks(source)

    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(source)
    for (const batch of batches) {
      expect(new TextEncoder().encode(JSON.stringify({ blocks: batch })).byteLength)
        .toBeLessThanOrEqual(SCREENSHOT_TRANSLATION_BATCH_PAYLOAD_MAX_BYTES)
    }
  })
})

describe('strict screenshot translation response parser', () => {
  it('accepts an out-of-order complete mapping, rebuilds OCR order, and rejects missing IDs', () => {
    expect(parseScreenshotTranslationResponse(
      '{"translations":[{"id":"line-2","text":"Monde"},{"id":"line-1","text":"Bonjour"}]}',
      blocks,
    )).toEqual([
      { id: 'line-1', text: 'Bonjour' },
      { id: 'line-2', text: 'Monde' },
    ])
    expect(parseScreenshotTranslationResponse(
      '{"translations":[{"id":"line-2","text":"Monde"}]}',
      blocks,
    )).toBeUndefined()
  })

  it('rejects requested and returned line IDs outside the shared safe-integer canonical range', () => {
    const unsafe = [{ id: 'line-9007199254740992', text: 'source' }]
    expect(parseScreenshotTranslationResponse('{"translations":[]}', unsafe)).toBeUndefined()
    expect(parseScreenshotTranslationResponse(
      '{"translations":[{"id":"line-9007199254740992","text":"translated"}]}',
      unsafe,
    )).toBeUndefined()
  })

  it.each([
    '```json\n{"translations":[]}\n```',
    'Here is the result: {"translations":[]}',
    '{"translations":[]} trailing',
    '\ufeff{"translations":[]}',
    '{"translations":[],"extra":true}',
    '{"translations":{}}',
  ])('rejects non-exact terminal JSON: %s', (source) => {
    expect(parseScreenshotTranslationResponse(source, blocks)).toBeUndefined()
  })

  it.each([
    '{"translations":[{"id":"line-1","text":"ok","extra":true},{"id":"line-2","text":"ok"}]}',
    '{"translations":[{"id":"line-1"},{"id":"line-2","text":"ok"}]}',
    '{"translations":[{"id":1,"text":"ok"},{"id":"line-2","text":"ok"}]}',
    '{"translations":[{"id":"line-1","text":1},{"id":"line-2","text":"ok"}]}',
    '{"translations":[{"id":"line-1","text":""},{"id":"line-2","text":"ok"}]}',
  ])('rejects invalid translation items despite complete cardinality: %s', (source) => {
    const payload = JSON.parse(source) as { translations: unknown[] }
    expect(payload.translations).toHaveLength(blocks.length)
    expect(parseScreenshotTranslationResponse(source, blocks)).toBeUndefined()
  })

  it('rejects duplicate top-level JSON keys before parsing the terminal shape', () => {
    expect(parseScreenshotTranslationResponse(
      '{"translations":[],"translations":[]}',
      blocks,
    )).toBeUndefined()
  })

  it.each([
    '{"translations":[{"id":"line-1","id":"line-2","text":"ok"},{"id":"line-2","text":"ok"}]}',
    '{"translations":[{"id":"line-1","text":"one"},{"id":"line-1","text":"two"}]}',
    '{"translations":[{"id":"line-1","text":"ok"},{"id":"line-3","text":"unknown"}]}',
    '{"translations":[{"id":"line-01","text":"noncanonical"},{"id":"line-2","text":"ok"}]}',
    '{"translations":[{"id":"LINE-1","text":"wrong case"},{"id":"line-2","text":"ok"}]}',
  ])('rejects duplicate, unknown, or noncanonical IDs/keys despite complete cardinality: %s', (source) => {
    const payload = JSON.parse(source) as { translations: unknown[] }
    expect(payload.translations).toHaveLength(blocks.length)
    expect(parseScreenshotTranslationResponse(source, blocks)).toBeUndefined()
  })

  it.each([
    '{"translations":[{"id":"line-1","text":"\\u0000"},{"id":"line-2","text":"ok"}]}',
    '{"translations":[{"id":"line-1","text":"\\u000a"},{"id":"line-2","text":"ok"}]}',
    '{"translations":[{"id":"line-1","text":"\\u0085"},{"id":"line-2","text":"ok"}]}',
    '{"translations":[{"id":"line-1","text":"\\ud800"},{"id":"line-2","text":"ok"}]}',
    '{"translations":[{"id":"line-1","text":"é"},{"id":"line-2","text":"ok"}]}',
  ])('rejects controls, malformed Unicode, and non-NFC strings despite complete cardinality: %s', (source) => {
    const payload = JSON.parse(source) as { translations: unknown[] }
    expect(payload.translations).toHaveLength(blocks.length)
    expect(parseScreenshotTranslationResponse(source, blocks)).toBeUndefined()
  })

  it('rejects excessive nesting before accepting the terminal shape', () => {
    const nested = `${'['.repeat(40)}null${']'.repeat(40)}`
    expect(parseScreenshotTranslationResponse(
      `{"translations":[],"nested":${nested}}`,
      blocks,
    )).toBeUndefined()
  })

  it('enforces response bytes, per-text code units, and batch array size exactly', () => {
    const oneBlock = [blocks[0]!]
    const atTextLimit = JSON.stringify({
      translations: [{ id: 'line-1', text: 'a'.repeat(SCREENSHOT_TRANSLATED_TEXT_MAX_LENGTH) }],
    })
    const aboveTextLimit = JSON.stringify({
      translations: [{ id: 'line-1', text: 'a'.repeat(SCREENSHOT_TRANSLATED_TEXT_MAX_LENGTH + 1) }],
    })
    expect(parseScreenshotTranslationResponse(atTextLimit, oneBlock)).toBeDefined()
    expect(parseScreenshotTranslationResponse(aboveTextLimit, oneBlock)).toBeUndefined()

    const oversizedResponse = `${' '.repeat(SCREENSHOT_TRANSLATION_BATCH_RESPONSE_MAX_BYTES)}{"translations":[]}`
    expect(parseScreenshotTranslationResponse(oversizedResponse, blocks)).toBeUndefined()

    const requested = Array.from({ length: SCREENSHOT_TRANSLATION_BATCH_BLOCK_LIMIT + 1 }, (_, index) => ({
      id: `line-${index + 1}`, text: 'source',
    }))
    expect(parseScreenshotTranslationResponse(JSON.stringify({
      translations: requested.map(({ id }) => ({ id, text: 'translated' })),
    }), requested)).toBeUndefined()
  })
})
