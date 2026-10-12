import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelProtocolClient, type ModelChatInput } from '../../src/main/models/model-protocol-client'

type Item = Record<string, unknown>
const message = (text = '你好', id = 'msg_1'): Item => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
const reasoning: Item = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'fixture-private-replay' }
const call = (id = 'call_1', name = 'read_doc', args = '{"path":"文档"}', itemId = 'fc_1'): Item => ({ type: 'function_call', id: itemId, call_id: id, name, arguments: args, status: 'completed' })
const usage = { input_tokens: 30, output_tokens: 10, total_tokens: 40, input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 7 } }
const response = (output: Item[], status = 'completed', extras: Item = {}) => ({ object: 'response', id: 'resp_1', status, output, usage, ...extras })
const terminal = (output: Item[], status = 'completed', extras: Item = {}) => ({ type: `response.${status}`, response: response(output, status, extras) })
function sse(events: Item[], fragment = 0): Response {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''))
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += fragment || bytes.length) controller.enqueue(bytes.slice(i, i + (fragment || bytes.length)))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } })
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const input = (overrides: Partial<ModelChatInput> = {}): ModelChatInput => ({
  provider: 'other', protocol: 'openai', baseUrl: 'https://api.openai.com/v1/', modelId: 'gpt-6-astra', apiKey: 'fixture-only',
  messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Read' }],
  tools: [{ name: 'read_doc', description: 'Read document', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
  reasoningEffort: 'high', thinkingMode: 'enabled', requestedOutputTokens: 4096, signal: new AbortController().signal, onDelta() {}, ...overrides,
})
afterEach(() => vi.useRealTimers())

describe('native Astra Responses', () => {
  it.each(['wrong-index', 'divergent', 'missing-segment', 'missing-item', 'late-delta'] as const)('rejects contradictory process evidence: %s', async fault => {
    const events: Item[] = [{ type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_1',
      ...(fault === 'wrong-index' ? { content_index: 0 } : { summary_index: 0 }), delta: 'prefix' }]
    if (fault === 'late-delta') events.push(
      { type: 'response.reasoning_summary_text.done', output_index: 0, item_id: 'rs_1', summary_index: 0, text: 'prefix' },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_1', summary_index: 0, delta: 'late' })
    const item = { ...reasoning, summary: fault === 'missing-segment' ? [] : [{ type: 'summary_text', text: fault === 'divergent' ? 'changed' : 'prefix' }] }
    events.push(terminal(fault === 'missing-item' ? [message()] : [item, message()]))
    await expect(createModelProtocolClient(async () => sse(events)).streamChat(input({ onProcess: vi.fn() })))
      .rejects.toMatchObject({ detail: { reason: 'protocol-malformed', source: 'responses' } })
  })
  it('reconciles multiple summary segments and part completion without leaking encrypted replay', async () => {
    const onProcess = vi.fn(), onReasoning = vi.fn()
    const item = { ...reasoning, summary: [{ type: 'summary_text', text: 'First' }, { type: 'summary_text', text: 'Second' }] }
    await createModelProtocolClient(async () => sse([
      { type: 'response.reasoning_summary_part.done', output_index: 0, item_id: 'rs_1', summary_index: 0, part: item.summary[0] },
      terminal([item, message()]),
    ])).streamChat(input({ onProcess, onReasoning }))
    expect(onProcess.mock.calls.map(([event]) => [event.segmentIndex, event.delta, event.delivery])).toEqual([[0, 'First', 'complete'], [1, 'Second', 'complete']])
    expect(JSON.stringify(onProcess.mock.calls)).not.toContain('fixture-private-replay')
    expect(onReasoning).not.toHaveBeenCalled()
  })
  it('preserves request parameters and final-only encrypted replay with or without a display consumer', async () => {
    const bodies: unknown[] = [], onProcess = vi.fn()
    const client = createModelProtocolClient(async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return json(response([reasoning, message()])) })
    const first = await client.streamChat(input())
    const second = await client.streamChat(input({ onProcess }))
    expect(bodies[0]).toEqual(bodies[1]); expect(first).toEqual(second)
    expect(onProcess).not.toHaveBeenCalled()
    expect(bodies[0]).not.toHaveProperty('reasoning.summary')
  })
  it('honors an abort from process display before any final answer callback', async () => {
    const controller = new AbortController(), onDelta = vi.fn()
    const work = createModelProtocolClient(async () => json(response([{ ...reasoning, summary: [{ type: 'summary_text', text: 'Summary' }] }, message()])))
      .streamChat(input({ signal: controller.signal, onProcess: () => controller.abort(), onDelta }))
    await expect(work).rejects.toMatchObject({ name: 'AbortError' })
    expect(onDelta).not.toHaveBeenCalled()
  })
  it('emits independent summary/text suffixes once across all completion layers', async () => {
    const onProcess = vi.fn(), onDelta = vi.fn()
    const item = { ...reasoning, summary: [{ type: 'summary_text', text: 'Summary done' }] }
    const result = await createModelProtocolClient(async () => sse([
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_1', summary_index: 0, delta: 'Summary' },
      { type: 'response.reasoning_text.delta', output_index: 0, item_id: 'rs_1', content_index: 0, delta: 'Readable' },
      { type: 'response.reasoning_summary_text.done', output_index: 0, item_id: 'rs_1', summary_index: 0, text: 'Summary done' },
      { type: 'response.output_item.done', output_index: 0, item }, terminal([item, message()]),
    ])).streamChat(input({ onProcess, onDelta }))
    expect(onProcess.mock.calls.map(([event]) => event)).toEqual([
      { kind: 'reasoning-summary', itemId: 'rs_1', segmentIndex: 0, delta: 'Summary', delivery: 'stream' },
      { kind: 'reasoning-text', itemId: 'rs_1', segmentIndex: 0, delta: 'Readable', delivery: 'stream' },
      { kind: 'reasoning-summary', itemId: 'rs_1', segmentIndex: 0, delta: ' done', delivery: 'complete' },
    ])
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('你好')
    expect(result.providerReplay).toMatchObject({ outputItems: [item, message()] })
  })
  it('emits final-only summary as complete and isolates optional consumer errors', async () => {
    const onProcess = vi.fn(() => { throw new Error('optional display failed') }), onDelta = vi.fn()
    await createModelProtocolClient(async () => json(response([{ ...reasoning, summary: [{ type: 'summary_text', text: 'Summary' }] }, message()])))
      .streamChat(input({ onProcess, onDelta }))
    expect(onProcess).toHaveBeenCalledExactlyOnceWith({ kind: 'reasoning-summary', itemId: 'rs_1', segmentIndex: 0, delta: 'Summary', delivery: 'complete' })
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('你好')
  })
  it.each(['json', 'sse'] as const)('retains explicit failed context errors in %s without raw provider data', async format => {
    const failed = response([], 'failed', { error: { code: 'context_length_exceeded', message: 'PRIVATE_DOCUMENT_KEY_PATH' } })
    await expect(createModelProtocolClient(async () => format === 'json' ? json(failed) : sse([{ type: 'response.failed', response: failed }]))
      .streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response', detail: { reason: 'context-limit', source: 'responses', stage: 'provider' } })
  })
  it.each([['max_output_tokens', 'output-limit'], ['content_filter', 'content-filtered'], ['future_reason', 'stream-interrupted']] as const)(
    'distinguishes incomplete response %s from malformed protocol', async (reason, expected) => {
      await expect(createModelProtocolClient(async () => json(response([message('partial')], 'incomplete', { incomplete_details: { reason } })))
        .streamChat(input())).rejects.toMatchObject({ detail: { reason: expected, source: 'responses' } })
    },
  )
  it.each(['json', 'sse-delta', 'sse-final'])('emits a refusal-only completed response (%s)', async format => {
    const item = { ...message(), content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }
    const events: Item[] = format === 'sse-delta' ? [
      { type: 'response.refusal.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'I cannot ' },
      { type: 'response.refusal.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'help with that.' },
    ] : []
    const onDelta = vi.fn()
    const result = await createModelProtocolClient(async () => format === 'json' ? json(response([item])) : sse([...events, terminal([item])])).streamChat(input({ onDelta }))
    expect(onDelta.mock.calls.flat().join('')).toBe('I cannot help with that.')
    expect(result.providerReplay).toMatchObject({ outputItems: [item] })
    expect(result.reasoningContent).toBe('')
  })

  it.each(['json', 'sse-done', 'sse-suffix'])('emits mixed text/refusal/text once in provider order (%s)', async format => {
    const item = { ...message(), content: [
      { type: 'output_text', text: 'Before. ' }, { type: 'refusal', refusal: 'Cannot comply. ' }, { type: 'output_text', text: 'After.' },
    ] }
    const events: Item[] = [{ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'Before. ' }]
    if (format === 'sse-done') events.push({ type: 'response.output_text.done', output_index: 0, item_id: 'msg_1', content_index: 0, text: 'Before. ' })
    events.push({ type: 'response.refusal.delta', output_index: 0, item_id: 'msg_1', content_index: 1, delta: 'Cannot ' })
    if (format === 'sse-done') events.push({ type: 'response.refusal.done', output_index: 0, item_id: 'msg_1', content_index: 1, refusal: 'Cannot comply. ' })
    events.push({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 2, delta: 'After.' },
      { type: 'response.output_item.done', output_index: 0, item }, terminal([item]))
    const onDelta = vi.fn()
    await createModelProtocolClient(async () => format === 'json' ? json(response([item])) : sse(events, 3)).streamChat(input({ onDelta }))
    expect(onDelta.mock.calls.flat().join('')).toBe('Before. Cannot comply. After.')
  })

  it('keeps a final refusal suffix before text from a subsequent output message', async () => {
    const first = { ...message(), content: [{ type: 'refusal', refusal: 'Cannot comply. ' }] }
    const output = [first, message('Alternative.', 'msg_2')]
    const onDelta = vi.fn()
    await createModelProtocolClient(async () => sse([
      { type: 'response.refusal.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'Cannot ' },
      { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_2', content_index: 0, delta: 'Alternative.' },
      terminal(output),
    ])).streamChat(input({ onDelta }))
    expect(onDelta.mock.calls.flat().join('')).toBe('Cannot comply. Alternative.')
  })

  it.each(['json', 'sse'])('requires nonblank summary text as the only reasoning evidence (%s)', async format => {
    for (const status of ['completed', 'incomplete']) for (const text of ['', ' \n\t', 'Valid reasoning summary.']) {
      const item = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text }] }
      const extra = { usage: null, incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null }
      const client = createModelProtocolClient(async () => format === 'json' ? json(response([item], status, extra)) : sse([terminal([item], status, extra)]))
      const probe = client.testConnection(input())
      if (text.trim() === '') await expect(probe).rejects.toMatchObject({ status: 'incompatible-response' })
      else await expect(probe).resolves.toBeUndefined()
    }
  })

  it('routes text and flattened tools to stateless Responses with real effort and output limit', async () => {
    const fetcher = vi.fn(async () => json(response([message()])))
    const onDelta = vi.fn()
    const result = await createModelProtocolClient(fetcher).streamChat(input({ thinkingMode: 'disabled', onDelta }))
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.toString()).toBe('https://api.openai.com/v1/responses')
    expect(JSON.parse(String(init.body))).toEqual({ model: 'gpt-6-astra', stream: true, store: false, include: ['reasoning.encrypted_content'], input: input().messages,
      reasoning: { effort: 'high' }, max_output_tokens: 4096,
      tools: [{ type: 'function', name: 'read_doc', description: 'Read document', parameters: input().tools![0]!.inputSchema, strict: false }], tool_choice: 'auto' })
    expect(onDelta).toHaveBeenCalledExactlyOnceWith('你好')
    expect(result).toMatchObject({ reasoningContent: '', toolCalls: [], usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40, cachedInputTokens: 12, estimated: false } })
  })

  it.each(['json', 'sse'])('replays ordered encrypted reasoning and multiple function calls by call_id across rounds (%s)', async format => {
    const output = [message('Before'), reasoning, call(), call('call_2', 'read_doc', '{}', 'fc_2'), message('After', 'msg_2')]
    const events: Item[] = [{ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'Before' }]
    output.forEach((item, output_index) => {
      if (item.type === 'function_call') {
        events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', arguments: '' } },
          { type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: String(item.arguments).slice(0, 5) },
          { type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: String(item.arguments).slice(5) },
          { type: 'response.function_call_arguments.done', output_index, item_id: item.id, arguments: item.arguments })
      }
      events.push({ type: 'response.output_item.done', output_index, item })
    })
    events.push(terminal(output))
    const requests: Item[] = []
    const fetcher: typeof fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return requests.length === 1 ? format === 'sse' ? sse(events, 3) : json(response(output)) : json(response([message('Final')])) }
    const client = createModelProtocolClient(fetcher)
    let text = ''
    const first = await client.streamChat(input({ onDelta(delta) { text += delta } }))
    expect(text).toBe('BeforeAfter')
    expect(first.toolCalls.map(tool => tool.id)).toEqual(['call_1', 'call_2'])
    expect(first.providerReplay).toMatchObject({ protocol: 'openai-responses', outputItems: output })
    expect(first.reasoningContent).toBe('')
    await client.streamChat(input({ messages: [...input().messages, { role: 'assistant', content: text, toolCalls: first.toolCalls, providerReplay: first.providerReplay! },
      ...first.toolCalls.map(tool => ({ role: 'tool' as const, name: tool.name, toolCallId: tool.id, content: 'result' })), { role: 'user', content: 'Continue' }] }))
    expect(requests[1]!.input).toEqual([...input().messages, ...output,
      { type: 'function_call_output', call_id: 'call_1', output: 'result' }, { type: 'function_call_output', call_id: 'call_2', output: 'result' }, { role: 'user', content: 'Continue' }])
  })

  it.each(['failed', 'incomplete', 'missing'])('rejects %s completion even after visible streamed text', async status => {
    const events: Item[] = [{ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'partial' }]
    if (status !== 'missing') events.push(terminal([message('partial')], status, { incomplete_details: { reason: 'max_output_tokens' } }))
    await expect(createModelProtocolClient(async () => sse(events)).streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it.each([call('call_1', 'unknown'), call('call_1', 'read_doc', '[]'), call('call_1', 'read_doc', '{'), call(' bad '), { ...message(), status: 'in_progress' }])('rejects invalid completed output %#', async item => {
    await expect(createModelProtocolClient(async () => json(response([item]))).streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it('rejects duplicate call IDs and conflicting streamed arguments', async () => {
    for (const value of [json(response([call(), call('call_1', 'read_doc', '{}', 'fc_2')])), sse([
      { type: 'response.output_item.added', output_index: 0, item: { ...call(), arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{}' }, terminal([call()]),
    ])]) await expect(createModelProtocolClient(async () => value).streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it('preserves the main-owned recognized tool allowlist without advertising disabled tools', async () => {
    await expect(createModelProtocolClient(async () => json(response([call('call_1', 'known_disabled')]))).streamChat(input({ recognizedToolNames: ['known_disabled'] }))).resolves.toMatchObject({ toolCalls: [{ name: 'known_disabled' }] })
  })
  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'default'] as const)('encodes native text-only effort %s without fake off', async reasoningEffort => {
    let body: Item = {}
    await createModelProtocolClient(async (_url, init) => { body = JSON.parse(String(init?.body)); return json(response([message()])) }).streamChat(input({ reasoningEffort, thinkingMode: 'default', tools: undefined }))
    expect(body).not.toHaveProperty('tools')
    expect(body.reasoning).toEqual(reasoningEffort === 'default' ? undefined : { effort: reasoningEffort })
    expect(body).not.toHaveProperty('reasoning_effort')
  })
  it.each([{ modelId: 'gpt-5.6' }, { baseUrl: 'https://proxy.example/v1' }])('retains Chat for other identities %#', async overrides => {
    let url = ''
    let body: Item = {}
    await createModelProtocolClient(async (requestUrl, init) => { url = String(requestUrl); body = JSON.parse(String(init?.body)); return json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }) }).streamChat(input(overrides))
    expect(url).toMatch(/\/chat\/completions$/)
    expect(body).toHaveProperty('messages')
    expect(body).not.toHaveProperty('store')
  })
  it.each(['json', 'sse'])('uses a cheap legal probe cap and accepts token-limited valid reasoning (%s)', async format => {
    let body: Item = {}
    const value = response([], 'incomplete', { incomplete_details: { reason: 'max_output_tokens' } })
    const client = createModelProtocolClient(async (_url, init) => { body = JSON.parse(String(init?.body)); return format === 'json' ? json(value) : sse([{ type: 'response.incomplete', response: value }]) })
    await expect(client.testConnection(input({ tools: undefined, reasoningEffort: 'low' }))).resolves.toBeUndefined()
    expect(body.max_output_tokens).toBe(64)
    expect(body.reasoning).toEqual({ effort: 'low' })
  })
  it('accepts a probe whose reasoning item closes incomplete before its token-limit terminal', async () => {
    const item = { ...reasoning, status: 'incomplete' }
    const events = [{ type: 'response.output_item.done', output_index: 0, item }, terminal([item], 'incomplete', { usage: null, incomplete_details: { reason: 'max_output_tokens' } })]
    await expect(createModelProtocolClient(async () => sse(events)).testConnection(input())).resolves.toBeUndefined()
    await expect(createModelProtocolClient(async () => sse(events)).streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it('rejects invented output status even on a token-limited probe', async () => {
    await expect(createModelProtocolClient(async () => json(response([{ ...message(), status: 'bogus' }], 'incomplete', { incomplete_details: { reason: 'max_output_tokens' } }))).testConnection(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it.each([
    response([], 'incomplete', { usage: null, incomplete_details: { reason: 'max_output_tokens' } }),
    response([reasoning], 'incomplete', { incomplete_details: { reason: 'content_filter' } }),
    response([reasoning], 'failed'),
  ])('does not accept unsuccessful or empty probes %#', async value => {
    await expect(createModelProtocolClient(async () => json(value)).testConnection(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it('keeps tools errors visible without the silent-tool-removal capability marker', async () => {
    await expect(createModelProtocolClient(async () => new Response('tools unsupported', { status: 400 })).streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response', capability: undefined })
  })
  it('maps provider stream errors without exposing private payloads', async () => {
    await expect(createModelProtocolClient(async () => sse([{ type: 'response.failed', response: { error: { code: 'insufficient_quota', message: 'fixture-private-replay' } } }])).streamChat(input())).rejects.toMatchObject({ status: 'quota-exceeded', message: 'The model account quota is exhausted' })
  })
  it('classifies flat Responses error events', async () => {
    await expect(createModelProtocolClient(async () => sse([{ type: 'error', code: 'rate_limit_exceeded', message: 'private' }])).streamChat(input())).rejects.toMatchObject({ status: 'rate-limited' })
  })
  it('accepts terminal output with different property ordering from item.done', async () => {
    const item = message()
    const reordered = Object.fromEntries(Object.entries(item).reverse())
    await expect(createModelProtocolClient(async () => sse([{ type: 'response.output_item.done', output_index: 0, item }, terminal([reordered])])).streamChat(input())).resolves.toMatchObject({ toolCalls: [] })
  })
  it('cancels a stalled JSON body on timeout', async () => {
    vi.useFakeTimers()
    const cancelled = vi.fn()
    const pending = createModelProtocolClient(async () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-type': 'application/json' } }), 10).streamChat(input())
    let settled = false
    const outcome = pending.then(() => 'unexpected success', error => { settled = true; return error.status })
    await vi.advanceTimersByTimeAsync(11)
    expect(settled).toBe(true)
    expect(await outcome).toBe('timeout')
    expect(cancelled).toHaveBeenCalled()
  })
  it('honors cancellation from the terminal text callback', async () => {
    const controller = new AbortController()
    await expect(createModelProtocolClient(async () => sse([terminal([message()])])).streamChat(input({ signal: controller.signal, onDelta() { controller.abort() } }))).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('rejects response-level errors even when terminal status claims completion', async () => {
    await expect(createModelProtocolClient(async () => sse([terminal([message()], 'completed', { error: { code: 'server_error' } })])).streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it.each([
    [{ type: 'response.output_item.done', output_index: 0, item: reasoning }, terminal([message()])],
    [{ type: 'response.output_item.done', output_index: 0, item: call() }, { type: 'response.output_item.done', output_index: 1, item: call('call_2') }, terminal([call()])],
    [{ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: '{}' }, { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{}' }, terminal([call()])],
    [{ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'wrong' }, terminal([message()])],
  ])('rejects inconsistent item/argument/text state %#', async (...events) => {
    await expect(createModelProtocolClient(async () => sse(events)).streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it('bounds fragmented arguments independently from total stream size', async () => {
    const events = Array.from({ length: 3 }, () => ({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: 'x'.repeat(100 * 1024) }))
    await expect(createModelProtocolClient(async () => sse([...events, terminal([call()])])).streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it('rejects malformed UTF-8 and Chat DONE as Responses completion', async () => {
    for (const bytes of [new Uint8Array([100, 97, 116, 97, 58, 0xff, 10]), new TextEncoder().encode('data: [DONE]\n\n')]) {
      await expect(createModelProtocolClient(async () => new Response(bytes, { headers: { 'content-type': 'text/event-stream' } })).streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
    }
  })
  it('does not leak Responses replay to Chat or Anthropic when switching model', async () => {
    const first = await createModelProtocolClient(async () => json(response([reasoning, message()]))).streamChat(input())
    for (const protocol of ['openai', 'anthropic'] as const) {
      let body: Item = {}
      await createModelProtocolClient(async (_url, init) => { body = JSON.parse(String(init?.body)); return json(protocol === 'openai' ? { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } : { content: [{ type: 'text', text: 'ok' }] }) }).streamChat(input({ protocol, modelId: 'another-model', messages: [{ role: 'assistant', content: '你好', providerReplay: first.providerReplay! }] }))
      expect(JSON.stringify(body)).not.toContain('fixture-private-replay')
      expect(JSON.stringify(body)).not.toContain('encrypted_content')
    }
  })
  it('cancels pending reads for external abort and both inactivity deadlines', async () => {
    vi.useFakeTimers()
    for (const mode of ['external', 'initial', 'activity']) {
      const controller = new AbortController()
      const cancelled = vi.fn()
      const client = createModelProtocolClient(async () => new Response(new ReadableStream({ start(stream) {
        if (mode === 'activity') stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: reasoning })}\n\n`))
      }, cancel: cancelled }), { headers: { 'content-type': 'text/event-stream' } }), 15)
      const pending = client.streamChat(input({ signal: controller.signal, initialInactivityTimeoutMs: 30 }))
      const rejected = expect(pending).rejects.toMatchObject(mode === 'external' ? { name: 'AbortError' } : { status: 'timeout' })
      await vi.advanceTimersByTimeAsync(1)
      if (mode === 'external') controller.abort()
      else await vi.advanceTimersByTimeAsync(mode === 'initial' ? 30 : 15)
      await rejected
      expect(cancelled).toHaveBeenCalled()
    }
  })
  it('rejects oversized JSON, SSE lines and aggregate streams', async () => {
    const oversized = 'x'.repeat(4 * 1024 * 1024)
    for (const value of [json(response([message(oversized)])), sse([{ type: 'unknown', padding: 'x'.repeat(256 * 1024) }]),
      new Response((':' + 'x'.repeat(200 * 1024) + '\n').repeat(42), { headers: { 'content-type': 'text/event-stream' } })]) {
      await expect(createModelProtocolClient(async () => value).streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
    }
  })
})


describe('Responses observed reasoning transitions', () => {
  it('uses live reasoning item boundaries and excludes subsequent function-call streaming', async () => {
    const onReasoning = vi.fn()
    const completedReasoning = { ...reasoning, summary: [{ type: 'summary_text', text: 'PRIVATE_THINKING' }] }
    await createModelProtocolClient(async () => sse([
      { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, status: 'in_progress' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_1', summary_index: 0, delta: 'PRIVATE_THINKING' },
      { type: 'response.output_item.done', output_index: 0, item: completedReasoning },
      { type: 'response.output_item.added', output_index: 1, item: call() },
      { type: 'response.output_item.done', output_index: 1, item: call() },
      terminal([completedReasoning, call()]),
    ])).streamChat(input({ onReasoning }))
    expect(onReasoning.mock.calls).toEqual([[true], [false]])
  })
  it('does not time final-only reasoning replay or JSON', async () => {
    for (const wire of [json(response([reasoning, message()])), sse([{ type: 'response.output_item.done', output_index: 0, item: reasoning }, terminal([reasoning, message()])])]) {
      const onReasoning = vi.fn()
      await createModelProtocolClient(async () => wire).streamChat(input({ onReasoning }))
      expect(onReasoning).not.toHaveBeenCalled()
    }
  })
})
