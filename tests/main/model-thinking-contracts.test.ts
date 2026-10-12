import { describe, expect, it } from 'vitest'
import { createModelProtocolClient, type ModelChatInput } from '../../src/main/models/model-protocol-client'
import { normalizeLargeModelSettings, parseLargeModelSettings } from '../../src/shared/large-model-settings'
import { effectiveModelThinking, resolveModelThinkingCapability, translationThinkingPreference } from '../../src/shared/model-thinking'

async function request(overrides: Record<string, unknown>) {
  let body: Record<string, any> = {}
  const client = createModelProtocolClient(async (_url, init) => {
    body = JSON.parse(String(init?.body))
    const response = overrides.protocol === 'anthropic'
      ? { content: [{ type: 'text', text: 'OK' }] }
      : overrides.modelId === 'gpt-6-astra'
        ? { object: 'response', id: 'resp_test', status: 'completed', output: [{ id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] }] }
      : { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
  })
  await client.streamChat({
    provider: 'other', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-5.6',
    apiKey: 'fixture-only', messages: [{ role: 'user', content: 'test' }],
    reasoningEffort: 'high', thinkingMode: 'enabled', signal: new AbortController().signal,
    onDelta() {}, ...overrides,
  } as ModelChatInput)
  return body
}

describe('verified thinking request contracts', () => {
  it.each([
    ['other', 'https://api.openai.com/v1/', 'gpt-5.6', { reasoning_effort: 'none' }],
    ['deepseek', 'https://api.deepseek.com/', 'deepseek-v4-pro', { thinking: { type: 'disabled' } }],
    ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1/', 'qwen3.8-max', { reasoning_effort: 'none' }],
    ['qwen', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus', { enable_thinking: false }],
    ['kimi', 'https://api.moonshot.ai/v1', 'kimi-k2.6', { thinking: { type: 'disabled' } }],
    ['kimi', 'https://api.moonshot.cn/v1', 'kimi-k2.6', { thinking: { type: 'disabled' } }],
    ['xiaomi-mimo', 'https://api.xiaomimimo.com/v1', 'mimo-v2.5', { thinking: { type: 'disabled' } }],
    ['minimax', 'https://api.minimaxi.com/v1', 'MiniMax-M3', { thinking: { type: 'disabled' } }],
  ])('sends real off for %s %s %s', async (provider, baseUrl, modelId, expected) => {
    const body = await request({ provider, baseUrl, modelId, thinkingMode: 'disabled' })
    expect(body).toMatchObject(expected)
    if (!('reasoning_effort' in expected)) expect(body).not.toHaveProperty('reasoning_effort')
  })

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('sends the OpenAI %s grade', async (reasoningEffort) => {
    expect(await request({ reasoningEffort })).toHaveProperty('reasoning_effort', reasoningEffort)
  })

  it.each([
    ['zhipu', 'https://open.bigmodel.cn/api/paas/v4/', 'glm-5.3', { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
    ['zhipu', 'https://api.z.ai/api/paas/v4', 'glm-5.3-flash', { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
    ['kimi', 'https://api.moonshot.ai/v1', 'kimi-k3', { reasoning_effort: 'max' }],
    ['other', 'https://api.openai.com/v1', 'gpt-6-astra', { reasoning: { effort: 'max' } }],
  ])('keeps fixed thinking legal for %s %s %s', async (provider, baseUrl, modelId, expected) => {
    expect(await request({ provider, baseUrl, modelId, thinkingMode: 'disabled', reasoningEffort: 'max' })).toMatchObject(expected)
  })

  it('does not invent controls for unknown endpoints or models, even with numeric overrides', async () => {
    for (const override of [{ baseUrl: 'https://proxy.example/v1' }, { modelId: 'gpt-5.99' }, { provider: 'doubao', modelId: 'ep-123' }]) {
      const body = await request({ ...override, capabilityOverride: { contextWindowTokens: 100_000 } })
      expect(body).not.toHaveProperty('thinking')
      expect(body).not.toHaveProperty('reasoning_effort')
    }
  })

  it('preserves provider defaults and Qwen alias mapping independently from numeric overrides', async () => {
    expect(await request({ thinkingMode: 'default', reasoningEffort: 'default' })).not.toHaveProperty('reasoning_effort')
    expect(await request({ provider: 'qwen', baseUrl: 'https://w123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3.8-max', capabilityOverride: { contextWindowTokens: 100_000 } })).toHaveProperty('reasoning_effort', 'xhigh')
  })

  it('keeps Claude effort effective while disabled and clamps forbidden Opus 5 combinations', async () => {
    const body = await request({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-opus-5', thinkingMode: 'disabled', reasoningEffort: 'max' })
    expect(body).toMatchObject({ thinking: { type: 'disabled' }, output_config: { effort: 'high' } })
  })

  it.each([
    ['deepseek', 'https://api.deepseek.com', 'deepseek-v4-flash', ['low', 'high', 'max']],
    ['zhipu', 'https://open.bigmodel.cn/api/coding/paas/v4', 'glm-5.3', ['low', 'high', 'max']],
    ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-27b', ['low', 'medium', 'xhigh']],
    ['kimi', 'https://api.moonshot.ai/v1', 'kimi-k3', ['low', 'high', 'max']],
  ] as const)('encodes every distinct grade for %s', async (provider, baseUrl, modelId, efforts) => {
    for (const reasoningEffort of efforts) expect(await request({ provider, baseUrl, modelId, reasoningEffort })).toHaveProperty('reasoning_effort', reasoningEffort)
  })

  it.each([
    ['claude-fable-5-1', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-mythos-preview', ['low', 'medium', 'high', 'max']],
    ['claude-opus-4-6', ['low', 'medium', 'high', 'max']],
    ['claude-opus-4-5-20251101', ['low', 'medium', 'high']],
  ] as const)('encodes every verified Claude grade for %s', async (modelId, efforts) => {
    for (const reasoningEffort of efforts) expect(await request({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/', modelId, reasoningEffort })).toHaveProperty('output_config.effort', reasoningEffort)
  })

  it('preserves default omission independently from explicit effort and legal alias fallback', async () => {
    expect(await request({ thinkingMode: 'default', reasoningEffort: 'xhigh' })).toHaveProperty('reasoning_effort', 'xhigh')
    const deepseek = await request({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-v4-pro', thinkingMode: 'default', reasoningEffort: 'medium' })
    expect(deepseek).toHaveProperty('reasoning_effort', 'high')
    expect(deepseek).not.toHaveProperty('thinking')
    const fable = await request({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-fable-5-1', thinkingMode: 'default', reasoningEffort: 'default' })
    expect(fable).toHaveProperty('thinking', { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
    expect(fable).not.toHaveProperty('output_config')
  })

  it('uses manual Claude budgets as budgets and MiniMax protocol-specific toggle encodings', async () => {
    expect(await request({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-haiku-4-5', reasoningEffort: 'max' })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 1024 } })
    for (const [protocol, baseUrl] of [['openai', 'https://api.minimaxi.com/v1'], ['anthropic', 'https://api.minimaxi.com/anthropic/v1']]) {
      expect(await request({ provider: 'minimax', protocol, baseUrl, modelId: 'MiniMax-M3' })).toHaveProperty('thinking.type', 'adaptive')
      const fixed = await request({ provider: 'minimax', protocol, baseUrl, modelId: 'MiniMax-M2.7', thinkingMode: 'disabled' })
      expect(fixed).not.toHaveProperty('thinking')
      expect(fixed).not.toHaveProperty('reasoning_effort')
    }
  })

  it('retains disabled effort preferences while deriving legal effective controls', () => {
    const opus = { provider: 'other' as const, protocol: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-opus-5' }
    const preference = { thinkingMode: 'disabled' as const, reasoningEffort: 'max' as const }
    expect(effectiveModelThinking(opus, preference)).toEqual({ thinkingMode: 'disabled', reasoningEffort: 'high' })
    expect(preference.reasoningEffort).toBe('max')
    const glm = { ...opus, provider: 'zhipu' as const, protocol: 'openai' as const, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-5.3' }
    expect(translationThinkingPreference(glm)).toEqual({ thinkingMode: 'enabled', reasoningEffort: 'low' })
    expect(resolveModelThinkingCapability({ ...glm, modelId: 'glm-future-unknown' }).thinking).toBe('unknown')
    expect(resolveModelThinkingCapability({ ...glm, provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3.7-max-preview' })).toMatchObject({ thinking: 'fixed', efforts: [] })
  })

  it('uses current native OpenAI output-token fields without changing compatible providers', async () => {
    const native = await request({ requestedOutputTokens: 4096 })
    expect(native).toHaveProperty('max_completion_tokens', 4096)
    expect(native).not.toHaveProperty('max_tokens')
    expect(await request({ baseUrl: 'https://proxy.example/v1', requestedOutputTokens: 4096 })).toHaveProperty('max_tokens', 4096)
  })

  it('sends native Astra tools through the Responses adapter without dropping them', async () => {
    const body = await request({ modelId: 'gpt-6-astra', tools: [{ name: 'read_doc', description: 'read', inputSchema: {} }] })
    expect(body.tools).toEqual([{ type: 'function', name: 'read_doc', description: 'read', parameters: {}, strict: false }])
    expect(body).toMatchObject({ store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'high' } })
    expect(body).not.toHaveProperty('messages')
  })
})

describe('v5 thinking migration', () => {
  const connection = { id: '11111111-1111-4111-8111-111111111111', name: 'Qwen', provider: 'qwen', accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3.8-max', apiKeyHint: '••••test', status: 'untested', lastTestedAt: null, capabilityOverride: null }
  const legacy = { version: 5, codexCli: null, connections: [connection], selectionTranslation: { connectionId: connection.id, reasoningEffort: 'off', targetLanguage: 'auto', privacyNoticeAccepted: false }, screenshotTranslation: { connectionId: null, reasoningEffort: 'off', targetLanguage: 'auto' }, aiConversation: { connectionId: connection.id, reasoningEffort: 'off', writePolicy: 'ask-every-time' } }
  it('preserves AI omission and migrates translation off to disabled with lowest preference', () => {
    const result = normalizeLargeModelSettings(legacy)
    expect(result.version).toBe(6)
    expect(result.aiConversation).toMatchObject({ thinkingMode: 'default', reasoningEffort: 'default' })
    expect(result.selectionTranslation).toMatchObject({ thinkingMode: 'disabled', reasoningEffort: 'low' })
    expect(result.screenshotTranslation).toMatchObject({ thinkingMode: 'disabled', reasoningEffort: 'low' })
    expect(parseLargeModelSettings(result)).toEqual(result)
  })
  it('retains explicit selection with official aliases and rejects extra current keys', () => {
    const result = normalizeLargeModelSettings({ ...legacy, aiConversation: { ...legacy.aiConversation, reasoningEffort: 'high' } })
    expect(result.aiConversation).toMatchObject({ thinkingMode: 'enabled', reasoningEffort: 'xhigh' })
    expect(parseLargeModelSettings({ ...result, aiConversation: { ...result.aiConversation, surprise: true } })).toBeUndefined()
  })
})

it.each(['json', 'sse'] as const)('replays complete ordered Claude %s content without duplicating text or tools', async (format) => {
  const blocks = [
    { type: 'text', text: 'first' },
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'tool_use', id: 'call_1', name: 'read_doc', input: {} },
    { type: 'text', text: 'last' },
  ]
  const requests: Record<string, any>[] = []
  const client = createModelProtocolClient(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    if (requests.length === 1 && format === 'sse') {
      const events = [
        ...blocks.flatMap((block, index) => [
          { type: 'content_block_start', index, content_block: block.type === 'text' ? { ...block, text: '' } : block },
          ...(block.type === 'text' ? [{ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }] : []),
          ...(block.type === 'tool_use' ? [{ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }] : []),
          { type: 'content_block_stop', index },
        ]),
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(JSON.stringify({ stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn', content: requests.length === 1 ? blocks : [{ type: 'text', text: 'done' }] }), { headers: { 'content-type': 'application/json' } })
  })
  const input: ModelChatInput = { provider: 'other', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-fable-5-1', apiKey: 'fixture', thinkingMode: 'enabled', reasoningEffort: 'low', tools: [{ name: 'read_doc', description: 'read', inputSchema: { type: 'object' } }], messages: [{ role: 'user', content: 'go' }], signal: new AbortController().signal, onDelta() {} }
  const result = await client.streamChat(input)
  await client.streamChat({ ...input, messages: [...input.messages, { role: 'assistant', content: 'firstlast', toolCalls: result.toolCalls, providerReplay: result.providerReplay! }, { role: 'tool', name: 'read_doc', toolCallId: 'call_1', content: '{}' }] })
  expect(requests[1].messages[1].content).toEqual(blocks)
})

it.each(['eof', 'message_stop'] as const)('rejects an unclosed Claude text block at %s instead of returning lossy replay', async (ending) => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'inspect', signature: 'signed' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Already visible answer' } },
    ...(ending === 'message_stop' ? [{ type: 'message_stop' }] : []),
  ]
  const visible: string[] = []
  const client = createModelProtocolClient(async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }))
  await expect(client.streamChat({ provider: 'other', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-fable-5-1', apiKey: 'fixture', thinkingMode: 'enabled', reasoningEffort: 'low', messages: [], signal: new AbortController().signal, onDelta: (text) => visible.push(text) })).rejects.toMatchObject({ status: 'incompatible-response' })
  expect(visible).toEqual(['Already visible answer'])
})

it('allows a connection probe to finish after legitimate partial Claude thinking without constructing replay', async () => {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Connected and reasoning' } },
  ]
  const client = createModelProtocolClient(async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }))
  await expect(client.testConnection({ provider: 'other', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-fable-5-1', apiKey: 'fixture', thinkingMode: 'enabled', reasoningEffort: 'low', signal: new AbortController().signal })).resolves.toBeUndefined()
})

it('retains ordered streamed Claude blocks and bounded validated binding transformations', async () => {
  const events = [
    { type: 'message_start', message: { input_transformations: [{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }, { type: 'future', path: 'private', reason: 'unknown' }] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'opaque' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'last' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, input_transformations: [{ type: 'thinking_dropped', path: 'messages.2.content.1', reason: 'model_binding_mismatch' }] },
    { type: 'message_stop' },
  ]
  let headers: Headers | undefined
  const client = createModelProtocolClient(async (_url, init) => {
    headers = new Headers(init?.headers)
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  })
  const result = await client.streamChat({ provider: 'other', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-fable-5-1', apiKey: 'fixture', thinkingMode: 'default', reasoningEffort: 'default', messages: [], signal: new AbortController().signal, onDelta() {} })
  expect(headers?.get('anthropic-beta')).toBe('thinking-binding-controls-2026-08-01')
  expect(result.providerReplay?.protocol === 'anthropic' && result.providerReplay.contentBlocks).toEqual([{ type: 'text', text: 'first' }, { type: 'thinking', thinking: '', signature: 'opaque' }, { type: 'text', text: 'last' }])
  expect(result.inputTransformations).toEqual([{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' }, { type: 'thinking_dropped', path: 'messages.2.content.1', reason: 'model_binding_mismatch' }])
})

it.each([
  ['deepseek', 'https://api.deepseek.com', 'deepseek-v4-pro'],
  ['kimi', 'https://api.moonshot.ai/v1', 'kimi-k2.6'],
  ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-max'],
] as const)('preserves all historical reasoning_content during %s tool loops', async (provider, baseUrl, modelId) => {
  const body = await request({ provider, baseUrl, modelId, messages: [
    { role: 'user', content: 'earlier' }, { role: 'assistant', content: 'answer', reasoningContent: 'old reasoning' },
    { role: 'user', content: 'current' }, { role: 'assistant', content: '', reasoningContent: 'current reasoning', toolCalls: [{ id: 'call_1', name: 'read_doc', argumentsJson: '{}' }] },
    { role: 'tool', toolCallId: 'call_1', name: 'read_doc', content: '{}' },
  ] })
  expect(body.messages[1]).toHaveProperty('reasoning_content', 'old reasoning')
  expect(body.messages[3]).toHaveProperty('reasoning_content', 'current reasoning')
})
