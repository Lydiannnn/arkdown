import { afterEach, describe, expect, it } from 'vitest'
import { ScreenshotTranslationLoopbackServer } from './screenshot-translation-loopback'

const servers: ScreenshotTranslationLoopbackServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()))
})

async function post(server: ScreenshotTranslationLoopbackServer, payload: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

describe('screenshot translation loopback', () => {
  it('accepts the exact bounded OpenAI connection-test envelope', async () => {
    const server = new ScreenshotTranslationLoopbackServer({
      apiKey: 'test-key',
      modelId: 'screenshot-model',
      translations: [],
      forbiddenMarkers: [],
    })
    servers.push(server)
    await server.start()

    const response = await post(server, {
      model: 'screenshot-model',
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
      stream: true,
      max_tokens: 2,
    })
    expect(response.status).toBe(200)
    expect(server.fixedRequestCount).toBe(1)
    expect(() => server.assertHealthy()).not.toThrow()
  })

  it('accepts only exact OCR IDs/text and returns structured translations', async () => {
    const server = new ScreenshotTranslationLoopbackServer({
      apiKey: 'test-key',
      modelId: 'screenshot-model',
      expectedBlocks: [{ id: 'line-1', text: 'OCR SOURCE' }],
      translations: [{ id: 'line-1', text: 'OCR 译文' }],
      forbiddenMarkers: ['ADJACENT SECRET'],
    })
    servers.push(server)
    await server.start()

    const response = await post(server, {
      model: 'screenshot-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Translate supplied OCR blocks.' },
        { role: 'user', content: JSON.stringify({ blocks: [{ id: 'line-1', text: 'OCR SOURCE' }] }) },
      ],
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('OCR 译文')
    expect(server.translationRequestCount).toBe(1)
    expect(server.requestRecords()).toEqual([[{ id: 'line-1', text: 'OCR SOURCE' }]])
    expect(() => server.assertHealthy()).not.toThrow()
  })

  it('can return an incomplete configured provider response for missing-ID failure coverage', async () => {
    const server = new ScreenshotTranslationLoopbackServer({
      apiKey: 'test-key',
      modelId: 'screenshot-model',
      expectedBlocks: [
        { id: 'line-1', text: 'FIRST OCR SOURCE' },
        { id: 'line-2', text: 'SECOND OCR SOURCE' },
      ],
      translations: [{ id: 'line-1', text: 'FIRST OCR TRANSLATION' }],
      forbiddenMarkers: [],
    })
    servers.push(server)
    await server.start()

    const response = await post(server, {
      model: 'screenshot-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Translate supplied OCR blocks.' },
        { role: 'user', content: JSON.stringify({ blocks: [
          { id: 'line-1', text: 'FIRST OCR SOURCE' },
          { id: 'line-2', text: 'SECOND OCR SOURCE' },
        ] }) },
      ],
    })

    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain('line-1')
    expect(body).not.toContain('line-2')
    expect(server.translationRequestCount).toBe(1)
    expect(() => server.assertHealthy()).not.toThrow()
  })

  it('rejects image bytes, paths, keys, adjacent text, and unrelated OCR blocks', async () => {
    const server = new ScreenshotTranslationLoopbackServer({
      apiKey: 'test-key',
      modelId: 'screenshot-model',
      expectedBlocks: [{ id: 'line-1', text: 'OCR SOURCE' }],
      translations: [{ id: 'line-1', text: 'OCR 译文' }],
      forbiddenMarkers: ['ADJACENT SECRET', 'C:\\private\\capture.png'],
    })
    servers.push(server)
    await server.start()

    const response = await post(server, {
      model: 'screenshot-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Translate supplied OCR blocks.' },
        { role: 'user', content: JSON.stringify({ blocks: [{ id: 'line-1', text: 'OCR SOURCE data:image/png;base64,iVBOR ADJACENT SECRET' }] }) },
      ],
    })
    expect(response.status).toBe(400)
    expect(() => server.assertHealthy()).toThrow(/privacy|blocks/u)
  })

  it.each([
    {
      name: 'an unknown request-envelope field',
      mutate: (payload: Record<string, unknown>) => ({
        ...payload,
        screenshotPath: 'C:\\private\\capture.png',
      }),
    },
    {
      name: 'an unknown system-message field',
      mutate: (payload: Record<string, unknown>) => ({
        ...payload,
        messages: [
          { role: 'system', content: 'Translate supplied OCR blocks.', image: 'opaque-image-bytes' },
          { role: 'user', content: JSON.stringify({ blocks: [{ id: 'line-1', text: 'OCR SOURCE' }] }) },
        ],
      }),
    },
  ])('rejects $name before accepting OCR text', async ({ mutate }) => {
    const server = new ScreenshotTranslationLoopbackServer({
      apiKey: 'test-key',
      modelId: 'screenshot-model',
      expectedBlocks: [{ id: 'line-1', text: 'OCR SOURCE' }],
      translations: [{ id: 'line-1', text: 'OCR 译文' }],
      forbiddenMarkers: [],
    })
    servers.push(server)
    await server.start()

    const response = await post(server, mutate({
      model: 'screenshot-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Translate supplied OCR blocks.' },
        { role: 'user', content: JSON.stringify({ blocks: [{ id: 'line-1', text: 'OCR SOURCE' }] }) },
      ],
    }))
    expect(response.status).toBe(400)
    expect(server.translationRequestCount).toBe(0)
    expect(() => server.assertHealthy()).toThrow(/envelope|messages/u)
  })

  it('holds the configured retry stream and observes cancellation before refusing late bytes', async () => {
    const server = new ScreenshotTranslationLoopbackServer({
      apiKey: 'test-key',
      modelId: 'screenshot-model',
      expectedBlocks: [{ id: 'line-1', text: 'OCR SOURCE' }],
      translations: [{ id: 'line-1', text: 'OCR 译文' }],
      forbiddenMarkers: [],
      holdTranslationRequest: 1,
    })
    servers.push(server)
    await server.start()
    const controller = new AbortController()
    const pending = post(server, {
      model: 'screenshot-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Translate supplied OCR blocks.' },
        { role: 'user', content: JSON.stringify({ blocks: [{ id: 'line-1', text: 'OCR SOURCE' }] }) },
      ],
    }).then(async (response) => await response.text())
    await server.waitForHeldRequest()
    controller.abort()
    server.cancelHeldResponseForTest()
    await expect(pending).rejects.toThrow()
    await expect.poll(() => server.heldRequestClosed).toBe(true)
    expect(server.releaseLateBytes()).toBe(false)
  })

  it('captures runtime OCR IDs while requiring target-only marker text and mirrors exact response IDs', async () => {
    const server = new ScreenshotTranslationLoopbackServer({
      apiKey: 'test-key',
      allowedOcrTokens: ['ARKDOWN', 'OCR', 'TARGET', 'LOCAL', 'TEXT', 'ONLY'],
      modelId: 'screenshot-model',
      requiredOcrTextMarkers: ['ARKDOWN OCR TARGET', 'LOCAL OCR TEXT ONLY'],
      translations: [],
      translationPrefix: '译文：',
      forbiddenMarkers: ['ADJACENT SECRET'],
    })
    servers.push(server)
    await server.start()
    const response = await post(server, {
      model: 'screenshot-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Translate supplied OCR blocks.' },
        { role: 'user', content: JSON.stringify({ blocks: [
          { id: 'line-1', text: 'ARKDOWN OCR TARGET' },
          { id: 'line-2', text: 'LOCAL OCR TEXT ONLY' },
        ] }) },
      ],
    })
    const body = await response.text()
    expect(body).toContain('line-1')
    expect(body).toContain('line-2')
    expect(body).toContain('译文：ARKDOWN OCR TARGET')
    expect(() => server.assertHealthy()).not.toThrow()
  })

  it('rejects unrelated screen words even when all required target markers are present', async () => {
    const server = new ScreenshotTranslationLoopbackServer({
      apiKey: 'test-key',
      modelId: 'screenshot-model',
      requiredOcrTextMarkers: ['ARKDOWN OCR TARGET'],
      allowedOcrTokens: ['ARKDOWN', 'OCR', 'TARGET'],
      translations: [],
      forbiddenMarkers: [],
    })
    servers.push(server)
    await server.start()
    const response = await post(server, {
      model: 'screenshot-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Translate supplied OCR blocks.' },
        { role: 'user', content: JSON.stringify({ blocks: [{ id: 'line-1', text: 'ARKDOWN OCR TARGET UNRELATED' }] }) },
      ],
    })
    expect(response.status).toBe(400)
    expect(() => server.assertHealthy()).toThrow('unrelated')
  })

  it('accepts OCR word fragments that remain contained within an allowed source token', async () => {
    const server = new ScreenshotTranslationLoopbackServer({
      apiKey: 'test-key',
      modelId: 'screenshot-model',
      requiredOcrTextMarkers: ['ARKDOWN OCR TARGET'],
      allowedOcrTokens: ['ARKDOWN', 'OCR', 'TARGET', 'LOCAL'],
      translations: [],
      forbiddenMarkers: [],
    })
    servers.push(server)
    await server.start()
    const response = await post(server, {
      model: 'screenshot-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Translate supplied OCR blocks.' },
        { role: 'user', content: JSON.stringify({ blocks: [
          { id: 'line-1', text: 'ARKDOWN OCR TARGET' },
          { id: 'line-2', text: 'LO CA L' },
        ] }) },
      ],
    })
    expect(response.status).toBe(200)
    expect(() => server.assertHealthy()).not.toThrow()
  })
})
