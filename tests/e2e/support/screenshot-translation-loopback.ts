import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'

const MAX_REQUEST_BODY_BYTES = 64 * 1024
const FIXED_TEST_MESSAGE = 'Reply with OK only.'
const ALWAYS_FORBIDDEN = ['data:image', 'iVBOR', 'base64,'] as const

interface ScreenshotLoopbackBlock {
  id: string
  text: string
}

export interface ScreenshotTranslationLoopbackOptions {
  allowedOcrTokens?: readonly string[]
  apiKey: string
  expectedBlocks?: readonly ScreenshotLoopbackBlock[]
  forbiddenMarkers: readonly string[]
  holdTranslationRequest?: number
  modelId: string
  requiredOcrTextMarkers?: readonly string[]
  translations: readonly ScreenshotLoopbackBlock[]
  translationPrefix?: string
}

function exactOwnKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function parseBlocks(value: unknown): ScreenshotLoopbackBlock[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) return undefined
  const blocks: ScreenshotLoopbackBlock[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!exactOwnKeys(item, ['id', 'text'])
      || typeof item.id !== 'string'
      || !/^line-[1-9][0-9]*$/u.test(item.id)
      || ids.has(item.id)
      || typeof item.text !== 'string'
      || item.text.length === 0) return undefined
    ids.add(item.id)
    blocks.push({ id: item.id, text: item.text })
  }
  return blocks
}

function blocksEqual(
  actual: readonly ScreenshotLoopbackBlock[],
  expected: readonly ScreenshotLoopbackBlock[],
): boolean {
  return actual.length === expected.length
    && actual.every((block, index) => (
      block.id === expected[index]?.id && block.text === expected[index]?.text
    ))
}

export class ScreenshotTranslationLoopbackServer {
  private server: Server | undefined
  private readonly failures = new Set<string>()
  private readonly records: ScreenshotLoopbackBlock[][] = []
  private heldResponse: ServerResponse | undefined
  private heldReadyResolve: (() => void) | undefined
  private heldReady = new Promise<void>((resolve) => { this.heldReadyResolve = resolve })
  private closing = false
  heldRequestClosed = false
  fixedRequestCount = 0
  port = 0

  constructor(private readonly options: ScreenshotTranslationLoopbackOptions) {}

  get translationRequestCount(): number {
    return this.records.length
  }

  requestRecords(): readonly (readonly ScreenshotLoopbackBlock[])[] {
    return this.records.map((record) => record.map((block) => ({ ...block })))
  }

  assertHealthy(): void {
    if (this.failures.size > 0) {
      throw new Error(`Screenshot loopback rejected: ${[...this.failures].sort().join(',')}`)
    }
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('Screenshot loopback is already running')
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        this.failures.add('handler')
        if (!response.destroyed) {
          if (!response.headersSent) response.writeHead(500)
          response.end()
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      const server = this.server!
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    this.port = (this.server.address() as AddressInfo).port
  }

  async waitForHeldRequest(timeoutMs = 5_000): Promise<void> {
    await Promise.race([
      this.heldReady,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Held screenshot request was not observed')), timeoutMs)
        timer.unref?.()
      }),
    ])
  }

  cancelHeldResponseForTest(): void {
    this.heldResponse?.destroy()
  }

  releaseLateBytes(): boolean {
    const response = this.heldResponse
    if (!response || response.destroyed || response.writableEnded) return false
    this.writeDelta(response, JSON.stringify({ translations: this.options.translations }))
    response.end('data: [DONE]\n\n')
    return true
  }

  async close(): Promise<void> {
    this.closing = true
    this.heldResponse?.destroy()
    this.heldResponse = undefined
    const server = this.server
    this.server = undefined
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000)
      timer.unref?.()
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      this.failures.add('route')
      response.writeHead(404).end()
      return
    }
    if (request.headers.authorization !== `Bearer ${this.options.apiKey}`) {
      this.failures.add('authorization')
      response.writeHead(401).end()
      return
    }

    const chunks: Buffer[] = []
    let byteLength = 0
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      byteLength += bytes.byteLength
      if (byteLength > MAX_REQUEST_BODY_BYTES) {
        this.failures.add('request-size')
        response.writeHead(413).end()
        return
      }
      chunks.push(bytes)
    }
    let raw = Buffer.concat(chunks, byteLength).toString('utf8')
    chunks.length = 0
    const privacyMarkers = [
      ...ALWAYS_FORBIDDEN,
      this.options.apiKey,
      ...this.options.forbiddenMarkers,
    ].filter((marker) => marker.length > 0)
    if (privacyMarkers.some((marker) => raw.includes(marker))) {
      raw = ''
      this.failures.add('privacy-marker')
      response.writeHead(400).end()
      return
    }

    let payload: unknown
    try { payload = JSON.parse(raw) as unknown } catch {
      raw = ''
      this.failures.add('request-json')
      response.writeHead(400).end()
      return
    }
    raw = ''
    if (typeof payload !== 'object'
      || payload === null
      || Array.isArray(payload)
      || !Object.prototype.hasOwnProperty.call(payload, 'model')
      || !Object.prototype.hasOwnProperty.call(payload, 'messages')
      || !Object.prototype.hasOwnProperty.call(payload, 'stream')) {
      this.failures.add('envelope')
      response.writeHead(400).end()
      return
    }
    const envelope = payload as Record<string, unknown>
    if (envelope.model !== this.options.modelId
      || envelope.stream !== true
      || !Array.isArray(envelope.messages)) {
      this.failures.add('envelope')
      response.writeHead(400).end()
      return
    }
    const messages = envelope.messages
    if (!messages.every((message) => exactOwnKeys(message, ['role', 'content']))) {
      this.failures.add('messages')
      response.writeHead(400).end()
      return
    }
    if (messages.length === 1
      && messages[0]?.role === 'user'
      && messages[0].content === FIXED_TEST_MESSAGE) {
      if (!exactOwnKeys(envelope, ['model', 'messages', 'stream', 'max_tokens'])
        || envelope.max_tokens !== 2) {
        this.failures.add('envelope')
        response.writeHead(400).end()
        return
      }
      this.fixedRequestCount += 1
      this.writeHeaders(response)
      this.writeDelta(response, 'OK')
      response.end('data: [DONE]\n\n')
      return
    }
    if (!exactOwnKeys(envelope, ['model', 'messages', 'stream'])) {
      this.failures.add('envelope')
      response.writeHead(400).end()
      return
    }
    if (messages.length !== 2
      || messages[0]?.role !== 'system'
      || typeof messages[0].content !== 'string'
      || messages[1]?.role !== 'user'
      || typeof messages[1].content !== 'string') {
      this.failures.add('messages')
      response.writeHead(400).end()
      return
    }

    let userPayload: unknown
    try { userPayload = JSON.parse(messages[1].content) as unknown } catch {
      this.failures.add('blocks-json')
      response.writeHead(400).end()
      return
    }
    const blocks = exactOwnKeys(userPayload, ['blocks']) ? parseBlocks(userPayload.blocks) : undefined
    const combinedText = blocks?.map(({ text }) => text).join('\n') ?? ''
    const allowedTokens = this.options.allowedOcrTokens?.map((token) => token.toLocaleUpperCase('en-US'))
    const unrelatedTokens = allowedTokens === undefined
      ? []
      : (combinedText.match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter((token) => {
          const normalized = token.toLocaleUpperCase('en-US')
          return !allowedTokens.some((allowed) => allowed === normalized || allowed.includes(normalized))
        })
    const hasUnrelatedText = unrelatedTokens.length > 0
    if (!blocks
      || (this.options.expectedBlocks && !blocksEqual(blocks, this.options.expectedBlocks))
      || this.options.requiredOcrTextMarkers?.some((marker) => !combinedText.includes(marker))) {
      this.failures.add('blocks')
      response.writeHead(400).end()
      return
    }
    if (hasUnrelatedText) {
      this.failures.add('unrelated-text')
      response.writeHead(400).end()
      return
    }
    this.records.push(blocks)
    this.writeHeaders(response)
    if (this.options.holdTranslationRequest === this.records.length) {
      this.heldResponse = response
      this.heldRequestClosed = false
      response.once('close', () => {
        if (!this.closing) this.heldRequestClosed = true
      })
      response.write(': held\n\n')
      this.heldReadyResolve?.()
      this.heldReadyResolve = undefined
      return
    }
    const translations = this.options.translations.length > 0
      ? this.options.translations
      : blocks.map(({ id, text }) => ({ id, text: `${this.options.translationPrefix ?? ''}${text}` }))
    this.writeDelta(response, JSON.stringify({ translations }))
    response.end('data: [DONE]\n\n')
  }

  private writeHeaders(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'close',
    })
  }

  private writeDelta(response: ServerResponse, content: string): void {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
  }
}
