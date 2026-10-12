import { describe, expect, it, vi } from 'vitest'
import type {
  ModelChatInput,
  ModelToolDefinition,
} from '../../src/main/models/model-protocol-client'
import {
  createModelProtocolClient,
  MODEL_REQUEST_INITIAL_INACTIVITY_TIMEOUT_MS,
  MODEL_REQUEST_INACTIVITY_TIMEOUT_MS,
} from '../../src/main/models/model-protocol-client'
import { ModelProtocolError } from '../../src/main/models/model-errors'

describe('bounded Chat stream failures', () => {
  it('accepts 96k-output Chat envelope overhead above the old 32 MiB cap', async () => {
    const response = streamResponse([exactTotalSseBody('openai', 33_554_433)])
    const deltas: string[] = []
    const result = await createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({
      requestedOutputTokens: 98_304, onDelta: delta => deltas.push(delta),
    }))
    expect(deltas).toHaveLength(1)
    expect(result.toolCalls).toEqual([])
  })
  it.each(['aborted', 'insufficient_system_resource'])('rejects provider %s after partial text in SSE and JSON', async finishReason => {
    for (const response of [
      openAiSse([{ choices: [{ delta: { content: 'partial' }, finish_reason: finishReason }] }]),
      new Response(JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: finishReason }] })),
    ]) {
      const error = await captureError(() => createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput()))
      expect(error).toMatchObject({ detail: { reason: 'provider-interrupted', stage: 'receive' } })
    }
  })

  it('rejects provider interruption during connection probes despite reasoning activity', async () => {
    const response = openAiSse([{ choices: [{ delta: { reasoning_content: 'thinking' }, finish_reason: 'aborted' }] }])
    await expect(createModelProtocolClient(fetchStub(response).fetchImpl).testConnection(chatInput()))
      .rejects.toMatchObject({ detail: { reason: 'provider-interrupted' } })
  })

  it.each(['done', 'eof'] as const)('reports incomplete tool streams at %s instead of returning calls', async ending => {
    const event = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_doc', arguments: '{' } }] } }] }
    const response = ending === 'done' ? openAiSse([event])
      : streamResponse([new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)])
    await expect(createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({ recognizedToolNames: ['read_doc'] })))
      .rejects.toMatchObject({ detail: { reason: 'tool-stream-incomplete', stage: 'receive' } })
  })

  it.each(['done', 'eof'] as const)('returns complete tool calls after an explicit tool finish at %s', async ending => {
    const event = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_doc', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
    const response = ending === 'done' ? openAiSse([event])
      : streamResponse([new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)])
    const result = await createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({ recognizedToolNames: ['read_doc'] }))
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_doc', argumentsJson: '{}' }])
  })

  it('reports incomplete Anthropic tool block completion without returning partial calls', async () => {
    const response = anthropicSse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'read_doc', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])
    await expect(createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({ protocol: 'anthropic', recognizedToolNames: ['read_doc'] })))
      .rejects.toMatchObject({ detail: { reason: 'tool-stream-incomplete', stage: 'receive' } })
  })

  it('accepts SSE wire overhead above 8 MiB when Chat content remains small', async () => {
    const response = streamResponse([exactTotalSseBody('openai', 8_388_609)])
    const deltas: string[] = []
    const result = await createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({ onDelta: delta => deltas.push(delta) }))
    expect(deltas).toHaveLength(1)
    expect(result.toolCalls).toEqual([])
  })

  it('preserves the 8 MiB wire cap for the separate Responses adapter', async () => {
    const response = streamResponse([exactTotalSseBody('openai', 8_388_609)])
    await expect(createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({
      baseUrl: 'https://api.openai.com/v1/', modelId: 'gpt-6-astra',
    }))).rejects.toMatchObject({ detail: { reason: 'response-size-limit' } })
  })

  it('accepts exactly 8 MiB of UTF-8 Chat content and stops before publishing an excess delta', async () => {
    const content = '片'.repeat(21_845) + 'x' // Exactly 65,536 UTF-8 bytes.
    const events = Array.from({ length: 128 }, () => ({ choices: [{ delta: { content } }] }))
    let receivedBytes = 0
    await createModelProtocolClient(fetchStub(openAiSse(events)).fetchImpl).streamChat(chatInput({
      onDelta: delta => { receivedBytes += new TextEncoder().encode(delta).byteLength },
    }))
    expect(receivedBytes).toBe(8_388_608)
    receivedBytes = 0
    const error = await captureError(() => createModelProtocolClient(fetchStub(openAiSse([
      ...events, { choices: [{ delta: { content: 'x' } }] },
    ])).fetchImpl).streamChat(chatInput({ onDelta: delta => { receivedBytes += new TextEncoder().encode(delta).byteLength } })))
    expect(error).toMatchObject({ detail: { reason: 'response-size-limit', stage: 'receive' } })
    expect(receivedBytes).toBe(8_388_608)
  })

  it.each(['reasoning', 'tool', 'replay'] as const)('bounds aggregate Chat %s and visible text together', async kind => {
    const chunk = 'x'.repeat(65_536)
    const prefix = { choices: [{ delta: { content: 'x'.repeat(196_608) } }] }
    const events = Array.from({ length: 128 }, (_, index) => ({ choices: [{ delta: kind === 'reasoning'
      ? { reasoning_content: chunk }
      : kind === 'tool' ? { tool_calls: [{ index: 0, ...(index === 0 ? { id: 'call_1' } : {}), function: { ...(index === 0 ? { name: 'read_doc' } : {}), arguments: chunk } }] }
        : { encrypted_content: chunk, content: chunk } }] }))
    const error = await captureError(() => createModelProtocolClient(fetchStub(openAiSse([prefix, ...events])).fetchImpl)
      .streamChat(chatInput({ recognizedToolNames: ['read_doc'] })))
    expect(error).toMatchObject({ detail: { reason: 'response-size-limit', stage: 'receive' } })
  })

  it('charges repeated identical encrypted replay only once at the aggregate content boundary', async () => {
    const chunk = 'x'.repeat(65_536)
    const events = Array.from({ length: 127 }, () => ({ choices: [{ delta: { encrypted_content: chunk, content: chunk } }] }))
    const result = await createModelProtocolClient(fetchStub(openAiSse(events)).fetchImpl).streamChat(chatInput())
    expect(result.providerReplay).toMatchObject({ protocol: 'openai-chat', encryptedContent: chunk })
  })
})

it('separates readable Chat process deltas from answer and full replay', async () => {
  const onProcess = vi.fn(), onDelta = vi.fn()
  const result = await createModelProtocolClient(fetchStub(openAiSse([
    { choices: [{ delta: { reasoning_content: 'Think ' } }] },
    { choices: [{ delta: { reasoning_content: 'more', content: 'Answer' } }] },
  ])).fetchImpl).streamChat(chatInput({ onProcess, onDelta }))
  expect(onProcess.mock.calls.map(([event]) => event)).toEqual([
    { kind: 'reasoning-text', itemId: 'chat-choice-0', segmentIndex: 0, delta: 'Think ', delivery: 'stream' },
    { kind: 'reasoning-text', itemId: 'chat-choice-0', segmentIndex: 0, delta: 'more', delivery: 'stream' },
  ])
  expect(onDelta.mock.calls).toEqual([['Answer']])
  expect(result.reasoningContent).toBe('Think more')
})

it('emits complete Anthropic readable blocks separately without signatures or redacted payloads', async () => {
  const onProcess = vi.fn()
  const content = [{ type: 'thinking', thinking: 'first', signature: 'PRIVATE_SIGNATURE' },
    { type: 'redacted_thinking', data: 'PRIVATE_REDACTED' }, { type: 'thinking', thinking: 'second', signature: 'PRIVATE_SECOND' }, { type: 'text', text: 'Answer' }]
  const result = await createModelProtocolClient(fetchStub(new Response(JSON.stringify({ content }))).fetchImpl)
    .streamChat(chatInput({ protocol: 'anthropic', onProcess }))
  expect(onProcess.mock.calls.map(([event]) => event)).toEqual([
    { kind: 'reasoning-text', itemId: 'anthropic-block-0', segmentIndex: 0, delta: 'first', delivery: 'complete' },
    { kind: 'reasoning-text', itemId: 'anthropic-block-2', segmentIndex: 0, delta: 'second', delivery: 'complete' },
  ])
  expect(result.providerReplay).toMatchObject({ contentBlocks: content })
})

it('streams Anthropic block starts and deltas with stable identities and keeps signed replay intact', async () => {
  const onProcess = vi.fn(), onDelta = vi.fn()
  const result = await createModelProtocolClient(fetchStub(anthropicSse([
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'A' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'B' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'PRIVATE_SIGNATURE' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'PRIVATE_REDACTED' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Answer' } },
    { type: 'content_block_stop', index: 2 }, { type: 'message_stop' },
  ])).fetchImpl).streamChat(chatInput({ protocol: 'anthropic', onProcess, onDelta }))
  expect(onProcess.mock.calls.map(([event]) => [event.itemId, event.delta, event.delivery])).toEqual([
    ['anthropic-block-0', 'A', 'stream'], ['anthropic-block-0', 'B', 'stream'],
  ])
  expect(onDelta).toHaveBeenCalledExactlyOnceWith('Answer')
  expect(result.providerReplay).toMatchObject({ blocks: [{ type: 'thinking', thinking: 'AB', signature: 'PRIVATE_SIGNATURE' }, { type: 'redacted_thinking', data: 'PRIVATE_REDACTED' }] })
})

it.each(['throw', 'abort'] as const)('isolates process consumer %s with cancellation taking precedence', async action => {
  const controller = new AbortController(), onDelta = vi.fn()
  const onProcess = vi.fn(() => { if (action === 'abort') controller.abort(); throw new Error('display consumer') })
  const work = createModelProtocolClient(fetchStub(openAiSse([
    { choices: [{ delta: { reasoning_content: 'A' } }] }, { choices: [{ delta: { reasoning_content: 'B', content: 'Answer' } }] },
  ])).fetchImpl).streamChat(chatInput({ onProcess, onDelta, signal: controller.signal }))
  if (action === 'abort') { await expect(work).rejects.toMatchObject({ name: 'AbortError' }); expect(onDelta).not.toHaveBeenCalled() }
  else { await work; expect(onDelta).toHaveBeenCalledExactlyOnceWith('Answer') }
  expect(onProcess).toHaveBeenCalledOnce()
})

it('does not expose process text during connection probes even if a callback is supplied', async () => {
  const onProcess = vi.fn()
  await createModelProtocolClient(fetchStub(openAiSse([{ choices: [{ delta: { reasoning_content: 'probe' } }] }])).fetchImpl)
    .testConnection(chatInput({ onProcess }))
  expect(onProcess).not.toHaveBeenCalled()
})

it('rejects unsafe Anthropic block indexes before publishing process identity', async () => {
  const onProcess = vi.fn()
  const work = createModelProtocolClient(fetchStub(anthropicSse([
    { type: 'content_block_start', index: Number.MAX_SAFE_INTEGER + 1, content_block: { type: 'thinking', thinking: 'unsafe', signature: 'sig' } },
    { type: 'content_block_stop', index: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answer' } }, { type: 'message_stop' },
  ])).fetchImpl).streamChat(chatInput({ protocol: 'anthropic', onProcess }))
  await expect(work).rejects.toMatchObject({ status: 'incompatible-response' })
  expect(onProcess).not.toHaveBeenCalled()
})

it.each([
  [403, '{"error":{"message":"invalid key quota"}}', 'access-denied'],
  [404, '{"error":{"message":"model missing"}}', 'not-found'],
  [503, 'x'.repeat(65_537), 'service-unavailable'],
  [429, 'x'.repeat(65_537), 'rate-limited'],
  [400, '{"error":{"code":"context_length_exceeded"}}', 'context-limit'],
  [200, '{"error":{"code":"context_length_exceeded"}}', 'context-limit'],
] as const)('preserves semantic HTTP %s evidence independently from raw body prose/size', async (status, body, reason) => {
  const error = await captureError(() => createModelProtocolClient(fetchStub(new Response(body, { status })).fetchImpl).streamChat(chatInput()))
  expect(error).toMatchObject({ detail: { reason, httpStatus: status, stage: 'provider', source: 'http' } })
})

it.each(['text/event-stream', 'application/json'])('retains a structured receive failure for %s', async contentType => {
  const response = new Response(new ReadableStream({ start(controller) {
    controller.error(Object.assign(new Error('PRIVATE_RECEIVE_PATH'), { cause: { code: 'UND_ERR_SOCKET' } }))
  } }), { headers: { 'content-type': contentType } })
  const error = await captureError(() => createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput()))
  expect(error).toMatchObject({ detail: { reason: 'stream-interrupted', stage: 'receive' } })
  expect(JSON.stringify(error)).not.toContain('PRIVATE_RECEIVE_PATH')
})

it('does not call a local consumer exception a transport failure', async () => {
  const error = await captureError(() => createModelProtocolClient(fetchStub(openAiSse([
    { choices: [{ delta: { content: 'partial' } }] },
  ])).fetchImpl).streamChat(chatInput({ onDelta: () => { throw Object.assign(new Error('PRIVATE_CALLBACK'), { code: 'ECONNREFUSED' }) } })))
  expect(error).toMatchObject({ detail: { reason: 'unknown', stage: 'receive' } })
})

it.each(['openai', 'anthropic'] as const)('classifies explicit %s output limits independently from protocol shape', async protocol => {
  const response = protocol === 'openai'
    ? openAiSse([{ choices: [{ delta: { content: 'partial' }, finish_reason: 'length' }] }])
    : anthropicSse([{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }])
  const error = await captureError(() => createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({ protocol })))
  expect(error).toMatchObject({ detail: { reason: 'output-limit', stage: 'receive' } })
})

it('retains only a bounded numeric retry delay without enabling an automatic retry', async () => {
  const fetchImpl = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '12' } }))
  const error = await captureError(() => createModelProtocolClient(fetchImpl as typeof fetch).streamChat(chatInput()))
  expect(error).toMatchObject({ detail: { reason: 'rate-limited', retryAfterSeconds: 12 } })
  expect(fetchImpl).toHaveBeenCalledOnce()
})

it.each([
  ['bad id', 'read_current_document', '{}', 'tool-invalid-identity'],
  ['call_1', 'unknown_tool', '{}', 'tool-invalid-name'],
  ['call_1', 'read_current_document', '{', 'tool-invalid-arguments'],
] as const)('separates tool validation from wire parsing: %s/%s', async (id, name, argumentsJson, reason) => {
  const error = await captureError(() => createModelProtocolClient(fetchStub(openAiToolCallsSse([{ id, name, argumentsJson }])).fetchImpl)
    .streamChat(chatInput({ tools: [readDocumentTool] })))
  expect(error).toMatchObject({ status: 'incompatible-response', detail: { reason, stage: 'tool-validation' } })
})

function streamResponse(chunks: readonly Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  })
}

function openAiSse(events: readonly Record<string, unknown>[]): Response {
  const body = [
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    'data: [DONE]\n\n',
  ].join('')
  return streamResponse([new TextEncoder().encode(body)])
}

function anthropicSse(events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  return streamResponse([new TextEncoder().encode(body)])
}

function anthropicToolUseSse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Response {
  return anthropicSse([
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ])
}

interface ToolCallFixture {
  id: string
  name: string
  argumentsJson?: string
}

function openAiToolCallsSse(calls: readonly ToolCallFixture[]): Response {
  return openAiSse([{
    choices: [{
      delta: {
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          function: {
            name: call.name,
            arguments: call.argumentsJson ?? '{}',
          },
        })),
      },
      finish_reason: 'tool_calls',
    }],
  }])
}

function anthropicToolCallsSse(calls: readonly ToolCallFixture[]): Response {
  return anthropicSse([
    ...calls.flatMap((call, index) => ([
      {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: call.argumentsJson ?? '{}',
        },
      },
      { type: 'content_block_stop', index },
    ])),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ])
}

function utf8Chunks(value: string, splitAt: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(value)
  return [bytes.slice(0, splitAt), bytes.slice(splitAt)]
}

function controlledResponse(
  chunks: readonly Uint8Array[],
  options: {
    status?: number
    contentType?: string
    close?: boolean
  } = {},
): { response: Response; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (options.close !== false) controller.close()
    },
    cancel,
  })
  return {
    response: new Response(body, {
      status: options.status ?? 200,
      headers: { 'content-type': options.contentType ?? 'text/event-stream' },
    }),
    cancel,
  }
}

function controllableSseResponse(): {
  response: Response
  enqueue(value: string): void
  close(): void
  cancel: ReturnType<typeof vi.fn>
} {
  let active = true
  const cancel = vi.fn(() => { active = false })
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel,
  })
  const encoder = new TextEncoder()
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    enqueue(value) {
      if (active) controller?.enqueue(encoder.encode(value))
    },
    close() {
      if (!active) return
      active = false
      controller?.close()
    },
    cancel,
  }
}

function jsonBody(protocol: 'openai' | 'anthropic', byteLength: number): Uint8Array {
  const prefix = protocol === 'openai'
    ? '{"choices":[{"message":{"content":"'
    : '{"content":[{"type":"text","text":"'
  const suffix = protocol === 'openai' ? '"}}]}' : '"}]}'
  const marker = '片'
  const encoder = new TextEncoder()
  const fixedLength = encoder.encode(`${prefix}${marker}${suffix}`).byteLength
  return encoder.encode(`${prefix}${marker}${'x'.repeat(byteLength - fixedLength)}${suffix}`)
}

function sseDataLine(protocol: 'openai' | 'anthropic', byteLength: number): string {
  const prefix = protocol === 'openai'
    ? 'data: {"choices":[{"delta":{"content":"'
    : 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"'
  const suffix = protocol === 'openai' ? '"}}]}' : '"}}'
  const marker = '片'
  const encoder = new TextEncoder()
  const fixedLength = encoder.encode(`${prefix}${marker}${suffix}`).byteLength
  return `${prefix}${marker}${'x'.repeat(byteLength - fixedLength)}${suffix}`
}

function terminalEvent(protocol: 'openai' | 'anthropic'): string {
  return protocol === 'openai' ? 'data: [DONE]\n\n' : 'data: {"type":"message_stop"}\n\n'
}

function exactTotalSseBody(protocol: 'openai' | 'anthropic', byteLength: number): Uint8Array {
  const encoder = new TextEncoder()
  const delta = `${sseDataLine(protocol, 128)}\n\n`
  const terminal = `${terminalEvent(protocol).trimEnd()}\n`
  let remaining = byteLength - encoder.encode(delta + terminal).byteLength
  const fillers: string[] = []
  while (remaining > 0) {
    if (remaining === 1) {
      fillers.push('\n')
      remaining -= 1
      continue
    }
    let chunkLength = Math.min(remaining, 262_145)
    if (remaining - chunkLength === 1) chunkLength -= 1
    fillers.push(`:${'x'.repeat(chunkLength - 2)}\n`)
    remaining -= chunkLength
  }
  return encoder.encode(`${delta}${fillers.join('')}${terminal}`)
}

function fetchStub(response: Response): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return response
  }) as typeof fetch
  return { fetchImpl, calls }
}

function chatInput(overrides: Partial<ModelChatInput> = {}): ModelChatInput {
  return {
    provider: 'other',
    protocol: 'openai',
    baseUrl: 'https://api.example.com/v1/',
    modelId: 'model-1',
    apiKey: 'sk-test-secret',
    messages: [
      { role: 'system', content: 'Translate accurately.' },
      { role: 'user', content: 'Text' },
    ],
    thinkingMode: 'default' as const, reasoningEffort: 'default',
    signal: new AbortController().signal,
    onDelta: () => undefined,
    ...overrides,
  }
}

const readDocumentTool: ModelToolDefinition = {
  name: 'read_current_document',
  description: 'Read the current document.',
  inputSchema: {
    type: 'object',
    properties: {
      cursor: { type: 'integer' },
      maxChars: { type: 'integer' },
    },
    required: ['cursor', 'maxChars'],
  },
}

const listWorkspaceTool: ModelToolDefinition = {
  name: 'list_workspace_entries',
  description: 'List workspace entries.',
  inputSchema: {
    type: 'object',
    properties: {
      relativePath: { type: 'string' },
    },
    required: ['relativePath'],
  },
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation()
  } catch (error) {
    return error
  }
  throw new Error('Expected operation to reject')
}

describe('model protocol client', () => {
  it('uses a 15,000 ms model request inactivity timeout by default', () => {
    expect(MODEL_REQUEST_INACTIVITY_TIMEOUT_MS).toBe(15_000)
    expect(MODEL_REQUEST_INITIAL_INACTIVITY_TIMEOUT_MS).toBe(30_000)
  })

  it('uses the longer per-request first-response budget then returns to stream inactivity', async () => {
    vi.useFakeTimers()
    try {
      const stream = controllableSseResponse()
      const client = createModelProtocolClient(fetchStub(stream.response).fetchImpl, 100)
      const pending = client.streamChat(chatInput({ initialInactivityTimeoutMs: 200 }))
      const error = captureError(() => pending)

      await vi.advanceTimersByTimeAsync(199)
      expect(stream.cancel).not.toHaveBeenCalled()
      stream.enqueue('data: {"choices":[{"delta":{"content":"A"}}]}\n\n')
      await vi.advanceTimersByTimeAsync(99)
      expect(stream.cancel).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await error).toMatchObject({ status: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refreshes the inactivity deadline only when non-empty model content arrives', async () => {
    vi.useFakeTimers()
    try {
      const stream = controllableSseResponse()
      const client = createModelProtocolClient(fetchStub(stream.response).fetchImpl, 100)
      const pending = client.streamChat(chatInput())
      const error = captureError(() => pending)

      await vi.advanceTimersByTimeAsync(80)
      stream.enqueue('data: {"choices":[{"delta":{"content":"A"}}]}\n\n')
      await vi.advanceTimersByTimeAsync(20)
      expect(stream.cancel).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(80)

      expect(await error).toMatchObject({ status: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a stream alive when non-empty deltas arrive before each inactivity deadline', async () => {
    vi.useFakeTimers()
    try {
      const stream = controllableSseResponse()
      const client = createModelProtocolClient(fetchStub(stream.response).fetchImpl, 100)
      const pending = client.streamChat(chatInput())

      await vi.advanceTimersByTimeAsync(80)
      stream.enqueue('data: {"choices":[{"delta":{"content":"A"}}]}\n\n')
      await vi.advanceTimersByTimeAsync(80)
      stream.enqueue('data: {"choices":[{"delta":{"content":"B"}}]}\n\n')
      await vi.advanceTimersByTimeAsync(80)
      stream.enqueue('data: {"choices":[{"delta":{"content":"C"}}]}\n\ndata: [DONE]\n\n')

      await expect(pending).resolves.toEqual({
        toolCalls: [],
        reasoningContent: '',
        providerReplay: null,
        usage: null,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not refresh the inactivity deadline for an SSE heartbeat', async () => {
    vi.useFakeTimers()
    try {
      const stream = controllableSseResponse()
      const client = createModelProtocolClient(fetchStub(stream.response).fetchImpl, 100)
      const pending = client.streamChat(chatInput())
      const error = captureError(() => pending)

      await vi.advanceTimersByTimeAsync(80)
      stream.enqueue(': heartbeat\n\n')
      await vi.advanceTimersByTimeAsync(20)

      expect(await error).toMatchObject({ status: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('connection request times out without valid model content', async () => {
    vi.useFakeTimers()
    try {
      const stream = controllableSseResponse()
      const client = createModelProtocolClient(fetchStub(stream.response).fetchImpl, 100)
      const pending = client.testConnection({
        provider: 'other',
        protocol: 'openai',
        baseUrl: 'https://api.example.com/v1',
        modelId: 'model-1',
        apiKey: 'sk-test-secret',
        thinkingMode: 'default' as const, reasoningEffort: 'default',
        signal: new AbortController().signal,
      })
      const error = captureError(() => pending)

      await vi.advanceTimersByTimeAsync(100)

      expect(await error).toMatchObject({ status: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts reasoning-only DeepSeek output as valid connection-probe activity', async () => {
    vi.useFakeTimers()
    try {
      const stream = controllableSseResponse()
      const client = createModelProtocolClient(fetchStub(stream.response).fetchImpl, 100)
      const pending = client.testConnection({
        provider: 'deepseek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        modelId: 'deepseek-reasoner',
        apiKey: 'sk-test-secret',
        thinkingMode: 'default' as const, reasoningEffort: 'default',
        signal: new AbortController().signal,
      })
      const outcome = pending.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )

      await vi.advanceTimersByTimeAsync(80)
      stream.enqueue('data: {"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":"Checking the connection."}}]}\n\n')
      await vi.advanceTimersByTimeAsync(80)
      stream.enqueue('data: {"choices":[{"delta":{"content":null,"reasoning_content":"Done thinking."},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n')

      await expect(outcome).resolves.toEqual({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not expose reasoning-only output as visible stream-chat content', async () => {
    const { fetchImpl } = fetchStub(openAiSse([{
      choices: [{
        delta: {
          role: 'assistant',
          content: null,
          reasoning_content: 'Hidden reasoning.',
        },
        finish_reason: 'length',
      }],
    }]))

    const error = await captureError(() => (
      createModelProtocolClient(fetchImpl).streamChat(chatInput({ provider: 'deepseek' }))
    ))

    expect(error).toMatchObject({ status: 'incompatible-response' })
  })

  it('collects hidden OpenAI reasoning and usage without emitting the reasoning', async () => {
    const deltas: string[] = []
    const { fetchImpl } = fetchStub(openAiSse([
      { choices: [{ delta: { reasoning_content: 'inspect ' } }] },
      { choices: [{ delta: { reasoning_content: 'carefully' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      },
    ]))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      onDelta: (delta) => deltas.push(delta),
    }))

    expect(deltas).toEqual(['answer'])
    expect(result).toEqual({
      toolCalls: [],
      reasoningContent: 'inspect carefully',
      providerReplay: null,
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
        cachedInputTokens: 5,
        estimated: false,
      },
    })
  })

  it.each([
    ['negative', { prompt_tokens: -1, completion_tokens: 4, total_tokens: 3 }],
    ['unsafe', { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 0, total_tokens: Number.MAX_SAFE_INTEGER + 1 }],
    ['mismatched', { prompt_tokens: 12, completion_tokens: 4, total_tokens: 99 }],
    ['invalid cached detail', {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 13 },
    }],
  ])('ignores %s OpenAI usage without failing valid content', async (_name, usage) => {
    const { fetchImpl } = fetchStub(openAiSse([
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
      { choices: [], usage },
    ]))

    await expect(createModelProtocolClient(fetchImpl).streamChat(chatInput())).resolves.toEqual({
      toolCalls: [],
      reasoningContent: '',
      providerReplay: null,
      usage: null,
    })
  })

  it('tolerates duplicate identical OpenAI usage terminal frames', async () => {
    const usage = {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
    }
    const { fetchImpl } = fetchStub(openAiSse([
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }], usage },
      { choices: [], usage },
    ]))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput())

    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      cachedInputTokens: null,
      estimated: false,
    })
  })

  it('keeps the last monotonic OpenAI usage when a later frame decreases', async () => {
    const { fetchImpl } = fetchStub(openAiSse([
      {
        choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      },
      {
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      },
    ]))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput())

    expect(result.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
    })
  })

  it.each([
    ['omits cache detail', undefined],
    ['reports a smaller cache detail', 3],
  ])('preserves prior cache usage when a same-total duplicate %s', async (_name, cachedTokens) => {
    const duplicateUsage: Record<string, unknown> = {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
    }
    if (cachedTokens !== undefined) {
      duplicateUsage.prompt_tokens_details = { cached_tokens: cachedTokens }
    }
    const { fetchImpl } = fetchStub(openAiSse([
      {
        choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
          prompt_tokens_details: { cached_tokens: 5 },
        },
      },
      { choices: [], usage: duplicateUsage },
    ]))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput())

    expect(result.usage?.cachedInputTokens).toBe(5)
  })

  it('parses the DeepSeek prompt cache hit detail without subtracting it from input', async () => {
    const { fetchImpl } = fetchStub(openAiSse([{
      choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
        prompt_cache_hit_tokens: 5,
        prompt_cache_miss_tokens: 7,
      },
    }]))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      provider: 'deepseek',
    }))

    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      cachedInputTokens: 5,
      estimated: false,
    })
  })

  it('parses hidden reasoning and usage from a complete OpenAI JSON response', async () => {
    const { fetchImpl } = fetchStub(new Response(JSON.stringify({
      choices: [{ message: { content: 'answer', reasoning_content: 'inspect' } }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 3,
        total_tokens: 11,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput())

    expect(result.reasoningContent).toBe('inspect')
    expect(result.usage).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
      cachedInputTokens: 2,
      estimated: false,
    })
  })

  it('normalizes Anthropic input, output, cache creation, and cache-read usage', async () => {
    const deltas: string[] = []
    const { fetchImpl } = fetchStub(anthropicSse([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'inspect' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-inspect' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'answer' },
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      protocol: 'anthropic',
      onDelta: (delta) => deltas.push(delta),
    }))

    expect(deltas).toEqual(['answer'])
    expect(result).toEqual({
      toolCalls: [],
      reasoningContent: 'inspect',
      providerReplay: {
        protocol: 'anthropic',
        blocks: [{ type: 'thinking', thinking: 'inspect', signature: 'sig-inspect' }],
        contentBlocks: [{ type: 'thinking', thinking: 'inspect', signature: 'sig-inspect' }],
      },
      usage: {
        inputTokens: 17,
        outputTokens: 5,
        totalTokens: 22,
        cachedInputTokens: 4,
        estimated: false,
      },
    })
  })

  it('ignores malformed Anthropic usage without failing valid content', async () => {
    const { fetchImpl } = fetchStub(anthropicSse([
      {
        type: 'message_start',
        message: { usage: { input_tokens: -1, output_tokens: 0 } },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'answer' },
      },
      { type: 'message_stop' },
    ]))

    await expect(createModelProtocolClient(fetchImpl).streamChat(chatInput({
      protocol: 'anthropic',
    }))).resolves.toMatchObject({ usage: null })
  })

  it('parses hidden reasoning and usage from a complete Anthropic JSON response', async () => {
    const { fetchImpl } = fetchStub(new Response(JSON.stringify({
      content: [
        { type: 'thinking', thinking: 'inspect' },
        { type: 'text', text: 'answer' },
      ],
      usage: {
        input_tokens: 7,
        output_tokens: 2,
        cache_read_input_tokens: 3,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      protocol: 'anthropic',
    }))

    expect(result.reasoningContent).toBe('inspect')
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cachedInputTokens: 3,
      estimated: false,
    })
  })

  it('rejects malformed visible content in a reasoning-only OpenAI JSON probe', async () => {
    const response = new Response(JSON.stringify({
      choices: [{
        message: {
          content: { invalid: true },
          reasoning_content: 'connected',
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

    const error = await captureError(() => (
      createModelProtocolClient(fetchStub(response).fetchImpl).testConnection({
        provider: 'deepseek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        modelId: 'deepseek-v4-pro',
        apiKey: 'sk-test-secret',
        thinkingMode: 'default' as const, reasoningEffort: 'default',
        signal: new AbortController().signal,
      })
    ))

    expect(error).toMatchObject({ status: 'incompatible-response' })
  })

  it('accepts a reasoning-only complete JSON response only for a connection probe', async () => {
    const response = () => new Response(JSON.stringify({
      choices: [{ message: { content: null, reasoning_content: 'connected' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

    const chatError = await captureError(() => (
      createModelProtocolClient(fetchStub(response()).fetchImpl).streamChat(chatInput())
    ))
    expect(chatError).toMatchObject({ status: 'incompatible-response' })

    await expect(createModelProtocolClient(fetchStub(response()).fetchImpl).testConnection({
      provider: 'deepseek',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-v4-pro',
      apiKey: 'sk-test-secret',
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      signal: new AbortController().signal,
    })).resolves.toBeUndefined()
  })

  it('refreshes ordinary stream inactivity for hidden reasoning before visible content', async () => {
    vi.useFakeTimers()
    try {
      const stream = controllableSseResponse()
      const pending = createModelProtocolClient(fetchStub(stream.response).fetchImpl, 100)
        .streamChat(chatInput())

      await vi.advanceTimersByTimeAsync(80)
      stream.enqueue('data: {"choices":[{"delta":{"reasoning_content":"inspect"}}]}\n\n')
      await vi.advanceTimersByTimeAsync(80)
      stream.enqueue('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n')

      await expect(pending).resolves.toMatchObject({
        reasoningContent: 'inspect',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects invalid visible content even when a connection probe receives reasoning activity', async () => {
    const { fetchImpl } = fetchStub(openAiSse([{
      choices: [{
        delta: {
          content: { invalid: true },
          reasoning_content: 'Hidden reasoning.',
        },
        finish_reason: 'length',
      }],
    }]))

    const error = await captureError(() => (
      createModelProtocolClient(fetchImpl).testConnection({
        provider: 'deepseek',
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com',
        modelId: 'deepseek-reasoner',
        apiKey: 'sk-test-secret',
        thinkingMode: 'default' as const, reasoningEffort: 'default',
        signal: new AbortController().signal,
      })
    ))

    expect(error).toMatchObject({ status: 'incompatible-response' })
  })

  it('parses visible OpenAI content when an unused tool_calls field is null', async () => {
    const deltas: string[] = []
    const { fetchImpl } = fetchStub(openAiSse([{
      choices: [{
        delta: { content: 'OK', tool_calls: null },
        finish_reason: 'stop',
      }],
    }]))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      onDelta: (delta) => deltas.push(delta),
    }))

    expect(deltas).toEqual(['OK'])
    expect(result).toEqual({
      toolCalls: [], reasoningContent: '', providerReplay: null, usage: null,
    })
  })

  it('parses visible OpenAI content when tools are enabled and tool_calls is empty', async () => {
    const deltas: string[] = []
    const { fetchImpl } = fetchStub(openAiSse([{
      choices: [{
        delta: { content: 'OK', tool_calls: [] },
        finish_reason: 'stop',
      }],
    }]))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      tools: [readDocumentTool],
      onDelta: (delta) => deltas.push(delta),
    }))

    expect(deltas).toEqual(['OK'])
    expect(result).toEqual({
      toolCalls: [], reasoningContent: '', providerReplay: null, usage: null,
    })
  })

  it('rejects an empty tool call payload that claims a tool-call finish', async () => {
    const { fetchImpl } = fetchStub(openAiSse([{
      choices: [{
        delta: { content: 'OK', tool_calls: [] },
        finish_reason: 'tool_calls',
      }],
    }]))

    const error = await captureError(() => (
      createModelProtocolClient(fetchImpl).streamChat(chatInput({
        tools: [readDocumentTool],
      }))
    ))

    expect(error).toMatchObject({ status: 'incompatible-response' })
  })

  it('constructs an OpenAI request and decodes SSE deltas split across UTF-8 chunks', async () => {
    const event = 'data: {"choices":[{"delta":{"content":"片段"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
    const encoded = new TextEncoder().encode(event)
    const splitInsideText = encoded.indexOf(0xe7) + 1
    const { fetchImpl, calls } = fetchStub(streamResponse(utf8Chunks(event, splitInsideText)))
    const deltas: string[] = []

    await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      onDelta: (delta) => deltas.push(delta),
    }))

    expect(deltas).toEqual(['片段'])
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions')
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.redirect).toBe('manual')
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer sk-test-secret')
    const openAiTranslationBody = JSON.parse(String(calls[0].init?.body))
    expect(openAiTranslationBody).toEqual({
      model: 'model-1',
      messages: [
        { role: 'system', content: 'Translate accurately.' },
        { role: 'user', content: 'Text' },
      ],
      stream: true,
    })
    expect(openAiTranslationBody).not.toHaveProperty('tools')
    expect(openAiTranslationBody).not.toHaveProperty('tool_choice')
  })

  it('assembles streamed OpenAI tool call arguments without emitting them as text', async () => {
    const onDelta = vi.fn()
    const { fetchImpl, calls } = fetchStub(openAiSse([
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: {
                name: 'read_current_document',
                arguments: '{"cursor":',
              },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '0,"maxChars":48000}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    ]))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      tools: [readDocumentTool],
      onDelta,
    }))

    expect(result.toolCalls).toEqual([{
      id: 'call_1',
      name: 'read_current_document',
      argumentsJson: '{"cursor":0,"maxChars":48000}',
    }])
    expect(onDelta).not.toHaveBeenCalled()
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      tools: [{
        type: 'function',
        function: {
          name: 'read_current_document',
          description: 'Read the current document.',
          parameters: readDocumentTool.inputSchema,
        },
      }],
      tool_choice: 'auto',
    })
  })

  it.each(['other', 'deepseek'] as const)('returns validated %s non-stream tool calls just like SSE', async (provider) => {
    const response = new Response(JSON.stringify({
      id: 'chatcmpl-123', object: 'chat.completion', model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{
        id: 'call_1', type: 'function', function: { name: 'read_current_document', arguments: '{"cursor":0,"maxChars":48000}' },
      }] }, finish_reason: 'tool_calls' }],
    }), { headers: { 'content-type': 'application/json' } })
    const onDelta = vi.fn()
    const result = await createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({
      provider, tools: [readDocumentTool], onDelta,
    }))
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_current_document', argumentsJson: '{"cursor":0,"maxChars":48000}' }])
    expect(onDelta).not.toHaveBeenCalled()
  })

  it.each([
    ['duplicate IDs', [{ id: 'call_1', type: 'function', function: { name: 'read_current_document', arguments: '{}' } }, { id: 'call_1', type: 'function', function: { name: 'read_current_document', arguments: '{}' } }], 'tool_calls'],
    ['unknown name', [{ id: 'call_1', type: 'function', function: { name: 'execute_shell', arguments: '{}' } }], 'tool_calls'],
    ['malformed JSON', [{ id: 'call_1', type: 'function', function: { name: 'read_current_document', arguments: '{' } }], 'tool_calls'],
    ['non-object arguments', [{ id: 'call_1', type: 'function', function: { name: 'read_current_document', arguments: '[]' } }], 'tool_calls'],
    ['partial call', [{ id: 'call_1', type: 'function', function: { name: 'read_current_document' } }], 'tool_calls'],
    ['noncanonical ID', [{ id: ' call_1', type: 'function', function: { name: 'read_current_document', arguments: '{}' } }], 'tool_calls'],
    ['wrong call type', [{ id: 'call_1', type: 'custom', function: { name: 'read_current_document', arguments: '{}' } }], 'tool_calls'],
    ['unrelated finish reason', [{ id: 'call_1', type: 'function', function: { name: 'read_current_document', arguments: '{}' } }], 'stop'],
    ['empty calls with tool finish', [], 'tool_calls'],
  ])('rejects JSON tool responses with %s even alongside visible content', async (_label, calls, finishReason) => {
    const response = new Response(JSON.stringify({ choices: [{
      message: { role: 'assistant', content: 'Please wait.', tool_calls: calls }, finish_reason: finishReason,
    }] }), { headers: { 'content-type': 'application/json' } })
    await expect(createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({
      provider: 'deepseek', tools: [readDocumentTool],
    }))).rejects.toMatchObject({ status: 'incompatible-response' })
  })

  it.each(['{', '[]', 'null', '"text"'])('rejects malformed or non-object SSE tool arguments %s', async (argumentsJson) => {
    const response = openAiToolCallsSse([{ id: 'call_1', name: 'read_current_document', argumentsJson }])
    await expect(createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({
      tools: [readDocumentTool],
    }))).rejects.toMatchObject({ status: 'incompatible-response' })
  })

  it.each(['json', 'sse'] as const)('validates a recognized but unadvertised %s tool response without granting capability', async (format) => {
    const response = format === 'sse'
      ? openAiToolCallsSse([{ id: 'call_known', name: 'read_current_document', argumentsJson: '{"cursor":0,"maxChars":10}' }])
      : new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
        id: 'call_known', type: 'function', function: { name: 'read_current_document', arguments: '{"cursor":0,"maxChars":10}' },
      }] }, finish_reason: 'tool_calls' }] }), { headers: { 'content-type': 'application/json' } })
    const { fetchImpl, calls } = fetchStub(response)
    const parsed = await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      tools: [], recognizedToolNames: ['read_current_document'],
    }))
    expect(parsed.toolCalls).toEqual([{ id: 'call_known', name: 'read_current_document', argumentsJson: '{"cursor":0,"maxChars":10}' }])
    const body = JSON.parse(String(calls[0]!.init?.body))
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('recognizedToolNames')
  })

  it.each([
    ['unknown name', [{ id: 'call_1', name: 'execute_shell', argumentsJson: '{}' }]],
    ['malformed arguments', [{ id: 'call_1', name: 'read_current_document', argumentsJson: '{' }]],
    ['duplicate IDs', [{ id: 'call_1', name: 'read_current_document', argumentsJson: '{}' }, { id: 'call_1', name: 'read_current_document', argumentsJson: '{}' }]],
  ])('still rejects %s in unadvertised SSE tool responses', async (_label, calls) => {
    const response = openAiToolCallsSse(calls)
    await expect(createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({
      tools: [], recognizedToolNames: ['read_current_document'],
    }))).rejects.toMatchObject({ status: 'incompatible-response' })
  })

  it('serializes OpenAI tool continuation messages in native format', async () => {
    const { fetchImpl, calls } = fetchStub(openAiSse([
      { choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] },
    ]))

    await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'call_1',
            name: 'read_current_document',
            argumentsJson: '{"cursor":0,"maxChars":48000}',
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call_1',
          name: 'read_current_document',
          content: '{"content":"doc"}',
        },
      ],
    }))

    expect(JSON.parse(String(calls[0].init?.body)).messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: 'read_current_document',
            arguments: '{"cursor":0,"maxChars":48000}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"content":"doc"}',
      },
    ])
  })

  it('replays hidden reasoning in OpenAI assistant tool-continuation history', async () => {
    const { fetchImpl, calls } = fetchStub(openAiSse([
      { choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] },
    ]))

    await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      messages: [
        {
          role: 'assistant',
          content: '',
          reasoningContent: 'inspect the document',
          toolCalls: [{
            id: 'call_1',
            name: 'read_current_document',
            argumentsJson: '{"cursor":0,"maxChars":48000}',
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call_1',
          name: 'read_current_document',
          content: '{"content":"doc"}',
        },
      ],
    } as Partial<ModelChatInput>))

    expect(JSON.parse(String(calls[0].init?.body)).messages[0]).toEqual({
      role: 'assistant',
      content: '',
      reasoning_content: 'inspect the document',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'read_current_document',
          arguments: '{"cursor":0,"maxChars":48000}',
        },
      }],
    })
  })

  it('preserves reasoning interleaved with fragmented OpenAI tool arguments', async () => {
    const { fetchImpl } = fetchStub(openAiSse([
      {
        choices: [{
          delta: {
            reasoning_content: 'inspect ',
            tool_calls: [{
              index: 0,
              id: 'call_1',
              function: {
                name: 'read_current_document',
                arguments: '{"cursor":',
              },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            reasoning_content: 'then read',
            tool_calls: [{
              index: 0,
              function: { arguments: '0,"maxChars":48000}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
    ]))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      tools: [readDocumentTool],
    }))

    expect(result.reasoningContent).toBe('inspect then read')
    expect(result.toolCalls[0]?.argumentsJson).toBe('{"cursor":0,"maxChars":48000}')
  })

  it('accepts any tool name declared by the request instead of one hardcoded tool', async () => {
    const { fetchImpl } = fetchStub(openAiToolCallsSse([{
      id: 'call_1',
      name: 'list_workspace_entries',
      argumentsJson: '{"relativePath":"notes"}',
    }]))

    const result = await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      tools: [listWorkspaceTool],
    }))

    expect(result.toolCalls).toEqual([{
      id: 'call_1',
      name: 'list_workspace_entries',
      argumentsJson: '{"relativePath":"notes"}',
    }])
  })

  it('constructs an Anthropic request and dispatches only text content deltas', async () => {
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"message-1"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"片段"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    const { fetchImpl, calls } = fetchStub(streamResponse([
      new TextEncoder().encode(events),
    ]))
    const deltas: string[] = []

    await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      protocol: 'anthropic',
      onDelta: (delta) => deltas.push(delta),
    }))

    expect(deltas).toEqual(['片段'])
    expect(calls[0].url).toBe('https://api.example.com/v1/messages')
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get('x-api-key')).toBe('sk-test-secret')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.has('authorization')).toBe(false)
    const anthropicTranslationBody = JSON.parse(String(calls[0].init?.body))
    expect(anthropicTranslationBody).toEqual({
      model: 'model-1',
      system: 'Translate accurately.',
      messages: [{ role: 'user', content: 'Text' }],
      stream: true,
      max_tokens: 4096,
    })
    expect(anthropicTranslationBody).not.toHaveProperty('tools')
  })

  it('returns Anthropic tool_use blocks and sends tool_result continuations', async () => {
    const firstRequest = fetchStub(anthropicToolUseSse(
      'toolu_1',
      'read_current_document',
      { cursor: 0, maxChars: 48_000 },
    ))
    const first = await createModelProtocolClient(firstRequest.fetchImpl).streamChat(chatInput({
      protocol: 'anthropic',
      tools: [readDocumentTool],
    }))

    expect(first.toolCalls).toEqual([{
      id: 'toolu_1',
      name: 'read_current_document',
      argumentsJson: '{"cursor":0,"maxChars":48000}',
    }])
    expect(JSON.parse(String(firstRequest.calls[0].init?.body)).tools).toEqual([{
      name: 'read_current_document',
      description: 'Read the current document.',
      input_schema: readDocumentTool.inputSchema,
    }])

    const continuationRequest = fetchStub(anthropicSse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done' } },
      { type: 'message_stop' },
    ]))
    await createModelProtocolClient(continuationRequest.fetchImpl).streamChat(chatInput({
      protocol: 'anthropic',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [first.toolCalls[0]],
        },
        {
          role: 'tool',
          toolCallId: 'toolu_1',
          name: 'read_current_document',
          content: '{"content":"doc"}',
        },
      ],
    }))

    expect(JSON.parse(String(continuationRequest.calls[0].init?.body)).messages).toEqual([
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_1',
          name: 'read_current_document',
          input: { cursor: 0, maxChars: 48_000 },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: '{"content":"doc"}',
        }],
      },
    ])
  })

  it('groups a mixed Anthropic tool-result batch into one user message with error metadata', async () => {
    const { fetchImpl, calls } = fetchStub(anthropicSse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done' } },
      { type: 'message_stop' },
    ]))

    await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      protocol: 'anthropic',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'toolu_1',
              name: 'read_current_document',
              argumentsJson: '{"cursor":0,"maxChars":24000}',
            },
            {
              id: 'toolu_2',
              name: 'read_current_document',
              argumentsJson: '{"cursor":24000,"maxChars":24000}',
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'toolu_1',
          name: 'read_current_document',
          content: '{"content":"page one"}',
        },
        {
          role: 'tool',
          toolCallId: 'toolu_2',
          name: 'read_current_document',
          content: '{"error":"document_access_denied"}',
          isError: true,
        },
        { role: 'user', content: 'Continue without the denied page.' },
      ],
    }))

    expect(JSON.parse(String(calls[0].init?.body)).messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'read_current_document',
            input: { cursor: 0, maxChars: 24_000 },
          },
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'read_current_document',
            input: { cursor: 24_000, maxChars: 24_000 },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: '{"content":"page one"}',
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: '{"error":"document_access_denied"}',
            is_error: true,
          },
        ],
      },
      { role: 'user', content: 'Continue without the denied page.' },
    ])
  })

  it.each([
    ['openai' as const, 'leading whitespace', ' call_1'],
    ['openai' as const, 'a forbidden slash', 'call/1'],
    ['openai' as const, 'more than 256 characters', 'a'.repeat(257)],
    ['anthropic' as const, 'leading whitespace', ' toolu_1'],
    ['anthropic' as const, 'a forbidden slash', 'toolu/1'],
    ['anthropic' as const, 'more than 256 characters', 'a'.repeat(257)],
  ])('rejects %s tool-call IDs with %s', async (protocol, _caseName, id) => {
    const response = protocol === 'openai'
      ? openAiToolCallsSse([{ id, name: 'read_current_document' }])
      : anthropicToolCallsSse([{ id, name: 'read_current_document' }])

    const error = await captureError(() => (
      createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({
        protocol,
        tools: [readDocumentTool],
      }))
    ))

    expect(error).toMatchObject({ status: 'incompatible-response' })
  })

  it.each(['openai', 'anthropic'] as const)(
    'rejects duplicate %s tool-call IDs across separate calls',
    async (protocol) => {
      const calls = [
        { id: 'duplicate_call_1', name: 'read_current_document' },
        { id: 'duplicate_call_1', name: 'read_current_document' },
      ]
      const response = protocol === 'openai'
        ? openAiToolCallsSse(calls)
        : anthropicToolCallsSse(calls)

      const error = await captureError(() => (
        createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({
          protocol,
          tools: [readDocumentTool],
        }))
      ))

      expect(error).toMatchObject({ status: 'incompatible-response' })
    },
  )

  it.each(['openai', 'anthropic'] as const)(
    'rejects an unregistered %s tool name before returning tool calls',
    async (protocol) => {
      const calls = [{ id: 'call_1', name: 'delete_current_document' }]
      const response = protocol === 'openai'
        ? openAiToolCallsSse(calls)
        : anthropicToolCallsSse(calls)

      const error = await captureError(() => (
        createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({
          protocol,
          tools: [readDocumentTool],
        }))
      ))

      expect(error).toMatchObject({ status: 'incompatible-response' })
    },
  )

  it('rejects duplicate Anthropic tool block starts for the same index', async () => {
    const response = anthropicSse([
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'read_current_document',
          input: {},
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_conflict',
          name: 'conflicting_tool',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])

    const error = await captureError(() => (
      createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({
        protocol: 'anthropic',
        tools: [readDocumentTool],
      }))
    ))

    expect(error).toMatchObject({ status: 'incompatible-response' })
  })

  it('rejects an Anthropic tool block missing its content_block_stop event', async () => {
    const response = anthropicSse([
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'read_current_document',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])

    const error = await captureError(() => (
      createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput({
        protocol: 'anthropic',
        tools: [readDocumentTool],
      }))
    ))

    expect(error).toMatchObject({ status: 'incompatible-response' })
  })

  it.each([
    {
      protocol: 'openai' as const,
      response: { choices: [{ message: { content: 'Complete OpenAI text' } }] },
      expected: 'Complete OpenAI text',
    },
    {
      protocol: 'anthropic' as const,
      response: { content: [{ type: 'text', text: 'Complete Anthropic text' }] },
      expected: 'Complete Anthropic text',
    },
  ])('accepts a non-SSE JSON success from $protocol', async ({ protocol, response, expected }) => {
    const { fetchImpl } = fetchStub(new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const deltas: string[] = []

    await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      protocol,
      onDelta: (delta) => deltas.push(delta),
    }))

    expect(deltas).toEqual([expected])
  })

  it('sends reasoning_effort only for conservatively supported OpenAI models', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      const response = 'max_tokens' in body && body.max_tokens === 4096
        ? { content: [{ type: 'text', text: 'OK' }] }
        : { choices: [{ message: { content: 'OK' } }] }
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const client = createModelProtocolClient(fetchImpl)

    await client.streamChat(chatInput({
      provider: 'other', modelId: 'gpt-5-mini', thinkingMode: 'enabled' as const, reasoningEffort: 'high',
    }))
    await client.streamChat(chatInput({
      provider: 'deepseek', modelId: 'gpt-5-mini', thinkingMode: 'enabled' as const, reasoningEffort: 'high',
    }))
    await client.streamChat(chatInput({
      provider: 'other', modelId: 'gpt-5-mini', thinkingMode: 'default' as const, reasoningEffort: 'default',
    }))
    await client.streamChat(chatInput({
      provider: 'other', protocol: 'anthropic', modelId: 'gpt-5-mini', thinkingMode: 'enabled' as const, reasoningEffort: 'high',
    }))

    expect(bodies.map((body) => body.reasoning_effort)).toEqual([
      'high', undefined, undefined, undefined,
    ])
  })

  it('replays exact signed Anthropic SSE thinking blocks on tool continuation', async () => {
    const firstRequest = fetchStub(anthropicSse([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'inspect' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'one' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'opaque-data' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'read_current_document',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"cursor":0,"maxChars":48000}',
        },
      },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]))

    const first = await createModelProtocolClient(firstRequest.fetchImpl).streamChat(chatInput({
      protocol: 'anthropic',
      tools: [readDocumentTool],
    }))

    expect(first.reasoningContent).toBe('inspect')
    expect(first.providerReplay).toMatchObject({
      protocol: 'anthropic',
      blocks: [
        { type: 'thinking', thinking: 'inspect', signature: 'sig-one' },
        { type: 'redacted_thinking', data: 'opaque-data' },
      ],
    })

    const continuation = fetchStub(anthropicSse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done' } },
      { type: 'message_stop' },
    ]))
    await createModelProtocolClient(continuation.fetchImpl).streamChat(chatInput({
      protocol: 'anthropic',
      tools: [readDocumentTool],
      messages: [
        {
          role: 'assistant',
          content: '',
          reasoningContent: first.reasoningContent,
          providerReplay: first.providerReplay,
          toolCalls: first.toolCalls,
        },
        {
          role: 'tool',
          toolCallId: 'toolu_1',
          name: 'read_current_document',
          content: '{"content":"doc"}',
        },
      ],
    } as Partial<ModelChatInput>))

    expect(JSON.parse(String(continuation.calls[0].init?.body)).messages[0].content).toEqual([
      { type: 'thinking', thinking: 'inspect', signature: 'sig-one' },
      { type: 'redacted_thinking', data: 'opaque-data' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'read_current_document',
        input: { cursor: 0, maxChars: 48_000 },
      },
    ])
  })

  it('parses and replays exact Anthropic JSON thinking around a tool continuation', async () => {
    const firstResponse = new Response(JSON.stringify({
      content: [
        { type: 'thinking', thinking: 'inspect', signature: 'sig-json' },
        { type: 'redacted_thinking', data: 'opaque-json' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'read_current_document',
          input: { cursor: 0, maxChars: 48_000 },
        },
      ],
      stop_reason: 'tool_use',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const first = await createModelProtocolClient(fetchStub(firstResponse).fetchImpl).streamChat(
      chatInput({ protocol: 'anthropic', tools: [readDocumentTool] }),
    )

    expect(first.toolCalls).toEqual([{
      id: 'toolu_1',
      name: 'read_current_document',
      argumentsJson: '{"cursor":0,"maxChars":48000}',
    }])
    expect(first.providerReplay).toMatchObject({
      protocol: 'anthropic',
      blocks: [
        { type: 'thinking', thinking: 'inspect', signature: 'sig-json' },
        { type: 'redacted_thinking', data: 'opaque-json' },
      ],
    })

    const continuation = fetchStub(anthropicSse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done' } },
      { type: 'message_stop' },
    ]))
    await createModelProtocolClient(continuation.fetchImpl).streamChat(chatInput({
      protocol: 'anthropic',
      tools: [readDocumentTool],
      messages: [
        {
          role: 'assistant',
          content: '',
          reasoningContent: first.reasoningContent,
          providerReplay: first.providerReplay,
          toolCalls: first.toolCalls,
        },
        {
          role: 'tool',
          toolCallId: 'toolu_1',
          name: 'read_current_document',
          content: '{"content":"doc"}',
        },
      ],
    } as Partial<ModelChatInput>))

    expect(JSON.parse(String(continuation.calls[0].init?.body)).messages[0].content).toEqual([
      { type: 'thinking', thinking: 'inspect', signature: 'sig-json' },
      { type: 'redacted_thinking', data: 'opaque-json' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'read_current_document',
        input: { cursor: 0, maxChars: 48_000 },
      },
    ])
  })

  it('preserves signature-only Anthropic thinking and drops unsigned replay blocks', async () => {
    const response = anthropicSse([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'not replayable' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'thinking', thinking: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'sig-empty' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'read_current_document',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ])

    const result = await createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(
      chatInput({ protocol: 'anthropic', tools: [readDocumentTool] }),
    )

    expect(result.reasoningContent).toBe('not replayable')
    expect(result.providerReplay).toMatchObject({
      protocol: 'anthropic',
      blocks: [{ type: 'thinking', thinking: '', signature: 'sig-empty' }],
    })
  })

  it('encodes GLM reasoning, tool streaming, and capability-clamped output tokens', async () => {
    const { fetchImpl, calls } = fetchStub(openAiSse([
      { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] },
    ]))

    await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      modelId: 'glm-5.3',
      thinkingMode: 'enabled' as const, reasoningEffort: 'max',
      requestedOutputTokens: 200_000,
      tools: [listWorkspaceTool],
    } as Partial<ModelChatInput>))

    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      model: 'glm-5.3',
      max_tokens: 131_072,
      thinking: { type: 'enabled' },
      tool_stream: true,
    })
    expect(JSON.parse(String(calls[0].init?.body))).toHaveProperty('reasoning_effort', 'max')
  })

  it('requests usage from exact Qwen Chat models and preserves max output requests', async () => {
    const { fetchImpl, calls } = fetchStub(openAiSse([
      { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] },
    ]))

    await createModelProtocolClient(fetchImpl).streamChat(chatInput({
      provider: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      modelId: 'qwen3.8-max',
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      requestedOutputTokens: 32_768,
    } as Partial<ModelChatInput>))

    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      model: 'qwen3.8-max',
      max_completion_tokens: 32_768,
      reasoning_effort: 'xhigh',
      stream_options: { include_usage: true },
    })
  })

  it.each([
    ['openai' as const, 2],
    ['anthropic' as const, 8],
  ])('uses the fixed minimal connection request for %s', async (protocol, maxTokens) => {
    const response = protocol === 'openai'
      ? { choices: [{ message: { content: 'OK' } }] }
      : { content: [{ type: 'text', text: 'OK' }] }
    const { fetchImpl, calls } = fetchStub(new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    await createModelProtocolClient(fetchImpl).testConnection({
      provider: 'other',
      protocol,
      baseUrl: 'https://api.example.com/v1',
      modelId: 'model-1',
      apiKey: 'sk-test-secret',
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      signal: new AbortController().signal,
    })

    const body = JSON.parse(String(calls[0].init?.body)) as {
      messages: Array<{ content: string }>
      max_tokens: number
    }
    expect(body.messages).toEqual([{ role: 'user', content: 'Reply with OK only.' }])
    expect(body.max_tokens).toBe(maxTokens)
  })

  it.each([301, 302, 307, 308])(
    'rejects HTTP %s redirects without making a second authenticated request',
    async (status) => {
      const { fetchImpl, calls } = fetchStub(new Response(null, {
        status,
        headers: { location: 'https://attacker.example/collect' },
      }))
      const error = await captureError(() => (
        createModelProtocolClient(fetchImpl).streamChat(chatInput())
      ))

      expect(calls).toHaveLength(1)
      expect(error).toMatchObject({ status: 'invalid-endpoint' })
    },
  )

  it.each([
    [401, '{"error":"do not expose auth response"}', 'authentication-failed'],
    [404, '{"error":"do not expose model details"}', 'model-not-found'],
    [429, '{"error":"slow down"}', 'rate-limited'],
    [429, '{"error":{"code":"insufficient_quota","message":"billing secret"}}', 'quota-exceeded'],
    [429, '{"error":{"message":"You exceeded your current quota."}}', 'rate-limited'],
    [400, '{"error":{"message":"account balance is exhausted"}}', 'incompatible-response'],
    [500, '{"error":"private upstream failure"}', 'incompatible-response'],
  ] as const)('maps HTTP %s to %s without leaking response text', async (status, body, expected) => {
    const { fetchImpl } = fetchStub(new Response(body, { status }))
    const error = await captureError(() => (
      createModelProtocolClient(fetchImpl).streamChat(chatInput())
    ))

    expect(error).toBeInstanceOf(ModelProtocolError)
    expect(error).toMatchObject({ status: expected })
    expect((error as Error).message).not.toContain(body)
    expect((error as Error).message).not.toContain('sk-test-secret')
  })

  it('marks a recognizable endpoint rejection of native tools for safe degradation', async () => {
    const response = new Response(JSON.stringify({
      error: { code: 'unsupported_parameter', param: 'tools', message: 'Unrecognized request argument supplied: tools' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
    const { fetchImpl } = fetchStub(response)

    const error = await captureError(() => (
      createModelProtocolClient(fetchImpl).streamChat(chatInput({
        tools: [readDocumentTool],
      }))
    ))

    expect(error).toMatchObject({
      status: 'incompatible-response',
      capability: 'tools',
    })
  })

  it.each([
    [408, 'quota-shaped', '{"error":{"code":"insufficient_quota"}}'],
    [504, 'quota-shaped', '{"error":{"message":"account balance is exhausted"}}'],
    [408, 'over-limit', 'x'.repeat(65_537)],
    [504, 'over-limit', 'x'.repeat(65_537)],
  ] as const)(
    'maps HTTP %s to timeout before reading its %s error body',
    async (status, _bodyKind, body) => {
      const response = new Response(body, { status })
      const cancel = vi.spyOn(response.body!, 'cancel')
      const error = await captureError(() => (
        createModelProtocolClient(fetchStub(response).fetchImpl).streamChat(chatInput())
      ))

      expect(error).toBeInstanceOf(ModelProtocolError)
      expect(error).toMatchObject({ status: 'timeout' })
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it('maps a network failure to invalid-endpoint without exposing its message', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('connect ECONNREFUSED with private host details')
    }) as typeof fetch

    const error = await captureError(() => (
      createModelProtocolClient(fetchImpl).streamChat(chatInput())
    ))

    expect(error).toMatchObject({ status: 'invalid-endpoint' })
    expect((error as Error).message).not.toContain('private host')
  })

  it('classifies an internal deadline as timeout with an injected short duration', async () => {
    const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => (
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason)
        }, { once: true })
      })
    )) as typeof fetch

    const error = await captureError(() => (
      createModelProtocolClient(fetchImpl, 5).streamChat(chatInput())
    ))

    expect(error).toMatchObject({ status: 'timeout' })
  })

  it('preserves external cancellation distinctly from timeout', async () => {
    const controller = new AbortController()
    const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => (
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason)
        }, { once: true })
        controller.abort(new DOMException('User cancelled', 'AbortError'))
      })
    )) as typeof fetch

    const error = await captureError(() => (
      createModelProtocolClient(fetchImpl, 1_000).streamChat(chatInput({
        signal: controller.signal,
      }))
    ))

    expect(error).toBeInstanceOf(DOMException)
    expect((error as DOMException).name).toBe('AbortError')
    expect(error).not.toBeInstanceOf(ModelProtocolError)
  })

  it.each([
    {
      name: 'OpenAI error-only',
      protocol: 'openai' as const,
      events: [
        { error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'upstream secret auth detail' } },
        { choices: [{ delta: { content: 'after error' } }] },
      ],
      expectedStatus: 'authentication-failed',
      expectedDeltas: [],
    },
    {
      name: 'OpenAI delta then error',
      protocol: 'openai' as const,
      events: [
        { choices: [{ delta: { content: 'before error' } }] },
        { error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'upstream secret quota detail' } },
        { choices: [{ delta: { content: 'after error' } }] },
      ],
      expectedStatus: 'quota-exceeded',
      expectedDeltas: ['before error'],
    },
    {
      name: 'Anthropic error-only',
      protocol: 'anthropic' as const,
      events: [
        { type: 'error', error: { type: 'rate_limit_error', message: 'upstream secret rate detail' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'after error' } },
      ],
      expectedStatus: 'rate-limited',
      expectedDeltas: [],
    },
    {
      name: 'Anthropic delta then error',
      protocol: 'anthropic' as const,
      events: [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'before error' } },
        { type: 'error', error: { type: 'authentication_error', message: 'upstream secret auth detail' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'after error' } },
      ],
      expectedStatus: 'authentication-failed',
      expectedDeltas: ['before error'],
    },
  ])('rejects $name SSE envelopes without emitting a post-error delta', async ({
    protocol, events, expectedStatus, expectedDeltas,
  }) => {
    const responseBody = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    const { fetchImpl } = fetchStub(new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    const deltas: string[] = []

    const error = await captureError(() => (
      createModelProtocolClient(fetchImpl).streamChat(chatInput({
        protocol,
        onDelta: (delta) => deltas.push(delta),
      }))
    ))

    expect(error).toBeInstanceOf(ModelProtocolError)
    expect(error).toMatchObject({ status: expectedStatus })
    expect(deltas).toEqual(expectedDeltas)
    expect((error as Error).message).not.toContain('upstream secret')
    expect((error as Error).message).not.toContain(responseBody)
  })

  it.each([
    new Response('data: {not-json}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
    new Response('{"choices":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ])('maps malformed successful responses to incompatible-response', async (response) => {
    const { fetchImpl } = fetchStub(response)

    const error = await captureError(() => (
      createModelProtocolClient(fetchImpl).streamChat(chatInput())
    ))

    expect(error).toMatchObject({ status: 'incompatible-response' })
  })
})

  it.each(['openai', 'anthropic'] as const)(
    'enforces the 4 MiB JSON byte limit for %s at the exact boundary',
    async (protocol) => {
      const exact = jsonBody(protocol, 4_194_304)
      const exactBody = controlledResponse([
        exact.slice(0, exact.indexOf(0xe7) + 1),
        exact.slice(exact.indexOf(0xe7) + 1),
      ], { contentType: 'application/json' })
      const deltas: string[] = []

      await createModelProtocolClient(fetchStub(exactBody.response).fetchImpl).streamChat(chatInput({
        protocol,
        onDelta: (delta) => deltas.push(delta),
      }))
      expect(deltas).toHaveLength(1)
      expect(deltas[0]?.startsWith('片')).toBe(true)

      const over = controlledResponse(
        [jsonBody(protocol, 4_194_305)],
        { contentType: 'application/json', close: false },
      )
      const error = await captureError(() => (
        createModelProtocolClient(fetchStub(over.response).fetchImpl).streamChat(chatInput({ protocol }))
      ))
      expect(error).toMatchObject({ status: 'incompatible-response', detail: { reason: 'response-size-limit', source: 'http' } })
      expect(over.cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(['openai', 'anthropic'] as const)(
    'bounds error bodies at 64 KiB for %s without leaking or retaining an over-limit body',
    async (protocol) => {
      const marker = '{"error":{"code":"insufficient_quota","message":"quota exceeded"}}'
      const exactText = marker + ' '.repeat(65_536 - new TextEncoder().encode(marker).byteLength)
      const exact = controlledResponse(
        [new TextEncoder().encode(exactText)],
        { status: 429, contentType: 'application/json' },
      )
      const exactError = await captureError(() => (
        createModelProtocolClient(fetchStub(exact.response).fetchImpl).streamChat(chatInput({ protocol }))
      ))
      expect(exactError).toMatchObject({ status: 'quota-exceeded' })

      const over = controlledResponse(
        [new TextEncoder().encode(`${exactText}x`)],
        { status: 429, contentType: 'application/json', close: false },
      )
      const overError = await captureError(() => (
        createModelProtocolClient(fetchStub(over.response).fetchImpl).streamChat(chatInput({ protocol }))
      ))
      expect(overError).toMatchObject({ status: 'rate-limited', detail: { reason: 'rate-limited', httpStatus: 429 } })
      expect((overError as Error).message).not.toContain('quota exceeded')
      expect(over.cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(['openai', 'anthropic'] as const)(
    'enforces the 256 KiB SSE line byte limit for %s with split multibyte UTF-8',
    async (protocol) => {
      const exactLine = new TextEncoder().encode(`${sseDataLine(protocol, 262_144)}\n\n${terminalEvent(protocol)}`)
      const split = exactLine.indexOf(0xe7) + 1
      const exact = controlledResponse([exactLine.slice(0, split), exactLine.slice(split)])
      const deltas: string[] = []
      await createModelProtocolClient(fetchStub(exact.response).fetchImpl).streamChat(chatInput({
        protocol,
        onDelta: (delta) => deltas.push(delta),
      }))
      expect(deltas).toHaveLength(1)
      expect(deltas[0]?.startsWith('片')).toBe(true)

      const overLine = new TextEncoder().encode(`${sseDataLine(protocol, 262_145)}\n`)
      const over = controlledResponse([overLine], { close: false })
      const error = await captureError(() => (
        createModelProtocolClient(fetchStub(over.response).fetchImpl).streamChat(chatInput({ protocol }))
      ))
      expect(error).toMatchObject({ status: 'incompatible-response' })
      expect(over.cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(['openai', 'anthropic'] as const)(
    'enforces the finite total SSE wire byte limit for %s at the exact boundary',
    async (protocol) => {
      const wireLimit = protocol === 'openai' ? 67_108_864 : 8_388_608
      const exactBytes = exactTotalSseBody(protocol, wireLimit)
      expect(exactBytes.byteLength).toBe(wireLimit)
      const exact = controlledResponse([exactBytes])
      await createModelProtocolClient(fetchStub(exact.response).fetchImpl).streamChat(chatInput({ protocol }))

      const terminalBytes = new TextEncoder().encode(`${terminalEvent(protocol).trimEnd()}\n`)
      const overBytes = new Uint8Array(exactBytes.byteLength + 1)
      const terminalOffset = exactBytes.byteLength - terminalBytes.byteLength
      overBytes.set(exactBytes.slice(0, terminalOffset), 0)
      overBytes[terminalOffset] = 0x0a
      overBytes.set(terminalBytes, terminalOffset + 1)
      const over = controlledResponse([overBytes], { close: false })
      const error = await captureError(() => (
        createModelProtocolClient(fetchStub(over.response).fetchImpl).streamChat(chatInput({ protocol }))
      ))
      expect(error).toMatchObject({ status: 'incompatible-response', detail: { reason: 'response-size-limit' } })
      expect(over.cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(['openai', 'anthropic'] as const)(
    'cancels an over-limit unterminated SSE line for %s',
    async (protocol) => {
      const prefix = new TextEncoder().encode('data: 片')
      const line = new Uint8Array(262_145)
      line.set(prefix)
      line.fill(0x78, prefix.byteLength)
      const split = prefix.indexOf(0xe7) + 1
      const response = controlledResponse(
        [line.slice(0, split), line.slice(split)],
        { close: false },
      )
      const error = await captureError(() => (
        createModelProtocolClient(fetchStub(response.response).fetchImpl)
          .streamChat(chatInput({ protocol }))
      ))
      expect(error).toMatchObject({ status: 'incompatible-response' })
      expect(response.cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(['openai', 'anthropic'] as const)(
    'treats the terminal SSE event as success and cancels an open stream for %s',
    async (protocol) => {
      const delta = `${sseDataLine(protocol, 128)}\n\n`
      const malformedAfterTerminal = 'data: {upstream-private-invalid-json}\n\n'
      const response = controlledResponse(
        [new TextEncoder().encode(`${delta}${terminalEvent(protocol)}${malformedAfterTerminal}`)],
        { close: false },
      )
      const deltas: string[] = []

      await createModelProtocolClient(fetchStub(response.response).fetchImpl).streamChat(chatInput({
        protocol,
        onDelta: (value) => deltas.push(value),
      }))

      expect(deltas).toHaveLength(1)
      expect(response.cancel).toHaveBeenCalledOnce()
    },
  )


describe('observed streaming reasoning phase signals', () => {
  it('starts on nonempty Chat reasoning and closes on tool arguments, never on metadata alone', async () => {
    const onReasoning = vi.fn(), onDelta = vi.fn()
    const response = openAiSse([
      { choices: [{ delta: { role: 'assistant', reasoning_content: '' } }] },
      { choices: [{ delta: { reasoning_content: 'PRIVATE_THINKING' } }] },
      { choices: [{ delta: { reasoning_content: 'MORE_PRIVATE_THINKING' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_doc', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    await createModelProtocolClient(async () => response).streamChat(chatInput({ onReasoning, onDelta, recognizedToolNames: ['read_doc'] }))
    expect(onReasoning.mock.calls).toEqual([[true], [false]])
    expect(onDelta).not.toHaveBeenCalled()
  })
  it('recognizes an empty Anthropic thinking block start and its explicit stop', async () => {
    const onReasoning = vi.fn()
    await createModelProtocolClient(async () => anthropicSse([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ])).streamChat(chatInput({ protocol: 'anthropic', onReasoning }))
    expect(onReasoning.mock.calls).toEqual([[true], [false]])
  })
  it.each(['json', 'plain'])('does not invent an interval for %s output', async mode => {
    const onReasoning = vi.fn()
    const response = mode === 'json' ? new Response(JSON.stringify({ choices: [{ message: { content: 'Answer', reasoning_content: 'PRIVATE_THINKING' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
      : openAiSse([{ choices: [{ delta: { content: 'Answer' } }] }])
    await createModelProtocolClient(async () => response).streamChat(chatInput({ onReasoning }))
    expect(onReasoning).not.toHaveBeenCalled()
  })
  it.each(['failure', 'abort'])('closes reasoning on %s even without the provider end event', async ending => {
    const controller = new AbortController(), onReasoning = vi.fn((active: boolean) => { if (active && ending === 'abort') controller.abort() })
    const response = openAiSse([
      { choices: [{ delta: { reasoning_content: 'PRIVATE_THINKING' } }] },
      { error: { message: 'error', type: 'server_error' } },
    ])
    await expect(createModelProtocolClient(async () => response).streamChat(chatInput({ signal: controller.signal, onReasoning }))).rejects.toBeDefined()
    expect(onReasoning.mock.calls).toEqual([[true], [false]])
  })
})
