import { createModelReasoningSignal } from './model-reasoning-timer'
import { resolveModelCapabilityRule } from '../../shared/model-capability-rules'
import { isCodexCliConnection } from '../../shared/large-model-settings'
import { createCodexCliModelAdapter } from '../codex/codex-cli-model-adapter'
import {
  isCanonicalAiToolCallId,
  type ModelUsage,
} from '../../shared/ai-conversation'
import {
  isSafeModelBaseUrl,
  type ModelCapabilityOverride,
  type ModelProtocol,
  type ModelProviderId,
  type ReasoningEffort,
  type ThinkingMode,
} from '../../shared/large-model-settings'
import { requestedOutputWithinLimit, resolveModelCapabilityProfile } from '../../shared/model-capability-profiles'
import { effectiveModelThinking, usesModelResponses, normalizeModelBaseUrl, resolveModelThinkingCapability } from '../../shared/model-thinking'
import {
  ModelProtocolError,
  modelProtocolError,
} from './model-errors'
import { providerModelError, semanticModelError, transportModelError } from './model-provider-errors'
import { ModelResponsesAdapter, responsesRequestBody, RESPONSES_PROBE_OUTPUT_TOKENS } from './model-responses-adapter'
import type { ModelProcessDelta } from './model-process-delta'

export const MODEL_REQUEST_INACTIVITY_TIMEOUT_MS = 15_000
export const MODEL_REQUEST_INITIAL_INACTIVITY_TIMEOUT_MS = 30_000
const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_STREAM_MAX_TOKENS = 4096
const ERROR_BODY_MAX_BYTES = 64 * 1024
const JSON_RESPONSE_MAX_BYTES = 4 * 1024 * 1024
const SSE_LINE_MAX_BYTES = 256 * 1024
const SSE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024
// Chat SSE carries substantial per-token envelope overhead. Other adapters retain
// their existing wire bound until their separate replay accumulators are budgeted.
const CHAT_SSE_WIRE_MAX_BYTES = 64 * 1024 * 1024
const CHAT_SSE_CONTENT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_PROFILE_REQUESTED_OUTPUT_TOKENS = 32_768

export interface ModelToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ModelToolCall {
  id: string
  name: string
  argumentsJson: string
}

export type AnthropicReplayBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

export type ModelProviderReplay = {
  protocol: 'openai-chat'
  encryptedContent: string
  /** Bound by the request owner before storage; never forward to a different endpoint/model. */
  modelId?: string
  baseUrl?: string
} | {
  protocol: 'anthropic'
  blocks: readonly AnthropicReplayBlock[]
  /** Full assistant content in provider order; older in-memory replay may contain only thinking blocks. */
  contentBlocks?: readonly Record<string, unknown>[]
} | {
  protocol: 'openai-responses'
  modelId: string
  /** Main-only complete ordered output, including encrypted reasoning. Never send to UI/logs. */
  outputItems: readonly Record<string, unknown>[]
}

export interface ModelInputTransformation {
  type: 'thinking_dropped'
  path: string
  reason: 'prefix_binding_mismatch' | 'model_binding_mismatch'
}

export type ModelChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
    role: 'assistant'
    content: string
    reasoningContent?: string
    providerReplay?: ModelProviderReplay
    toolCalls?: readonly ModelToolCall[]
  }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean }

export interface ModelChatResult {
  toolCalls: ModelToolCall[]
  reasoningContent: string
  providerReplay: ModelProviderReplay | null
  usage: ModelUsage | null
  inputTransformations?: readonly ModelInputTransformation[]
}

export interface ModelChatInput {
  provider: ModelProviderId
  protocol: ModelProtocol
  baseUrl: string
  modelId: string
  apiKey: string
  messages: readonly ModelChatMessage[]
  tools?: readonly ModelToolDefinition[]
  /** Main-owned response allowlist for known tools whose capability may be disabled. Never sent to the provider. */
  recognizedToolNames?: readonly string[]
  reasoningEffort: ReasoningEffort
  thinkingMode: ThinkingMode
  requestedOutputTokens?: number
  capabilityOverride?: ModelCapabilityOverride | null
  initialInactivityTimeoutMs?: number
  signal: AbortSignal
  /** Phase transitions only; no reasoning text crosses this callback. */
  onReasoning?(active: boolean): void
  /** Optional readable display suffixes; never replay or final answer content. */
  onProcess?(event: ModelProcessDelta): void
  onDelta(delta: string): void
}

export interface ModelProtocolClient {
  streamChat(input: ModelChatInput): Promise<ModelChatResult>
  testConnection(input: Omit<ModelChatInput, 'messages' | 'onDelta'>): Promise<void>
}

interface RequestOptions {
  maxTokens?: number
  acceptReasoningActivity?: boolean
}

function capabilityProfile(input: ModelChatInput) {
  return resolveModelCapabilityProfile({
    provider: input.provider,
    protocol: input.protocol,
    baseUrl: normalizeModelBaseUrl(input.baseUrl),
    modelId: input.modelId,
    capabilityOverride: input.capabilityOverride ?? null,
  }, {
    requestedOutputTokens: input.requestedOutputTokens
      ?? DEFAULT_PROFILE_REQUESTED_OUTPUT_TOKENS,
    reasoningEffort: input.reasoningEffort,
    thinkingMode: input.thinkingMode,
  })
}

function requestedOutputTokens(input: ModelChatInput): number | undefined {
  const requested = input.requestedOutputTokens
  if (!Number.isSafeInteger(requested) || requested === undefined || requested <= 0) {
    return undefined
  }
  const profile = capabilityProfile(input)
  return profile === undefined
    ? requested
    : requestedOutputWithinLimit(requested, profile.contextWindowTokens, profile.maxOutputTokens)
}

interface AbortContext {
  signal: AbortSignal
  didTimeout(): boolean
  refreshTimeout(): void
  dispose(): void
}

export function validateModelBaseUrl(value: string): URL {
  if (!isSafeModelBaseUrl(value)) throw semanticModelError('invalid-endpoint', 'invalid-endpoint', 'configuration', 'local')
  return new URL(value)
}

function appendEndpoint(baseUrl: string, suffix: string): URL {
  const endpoint = validateModelBaseUrl(baseUrl)
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}${suffix}`
  return endpoint
}

function createAbortContext(
  externalSignal: AbortSignal,
  initialTimeoutMs: number,
  inactivityTimeoutMs: number,
): AbortContext {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const externalReason = () => (
    externalSignal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  )
  const abortFromExternal = () => controller.abort(externalReason())
  const armTimeout = (duration: number) => {
    if (controller.signal.aborted || externalSignal.aborted) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('The request timed out', 'TimeoutError'))
    }, duration)
  }

  if (externalSignal.aborted) {
    abortFromExternal()
  } else {
    externalSignal.addEventListener('abort', abortFromExternal, { once: true })
  }
  armTimeout(initialTimeoutMs)

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    refreshTimeout: () => armTimeout(inactivityTimeoutMs),
    dispose() {
      clearTimeout(timer)
      externalSignal.removeEventListener('abort', abortFromExternal)
    },
  }
}

function openAiRequest(input: ModelChatInput, options: RequestOptions): {
  url: URL
  headers: HeadersInit
  body: Record<string, unknown>
} {
  if (usesModelResponses(input)) {
    return {
      url: appendEndpoint(input.baseUrl, '/responses'),
      headers: { accept: 'text/event-stream, application/json', authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
      body: responsesRequestBody(input, options.maxTokens ?? requestedOutputTokens(input)),
    }
  }
  const body: Record<string, unknown> = {
    model: input.modelId,
    messages: input.messages.map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: message.content,
        }
      }
      if (message.role === 'assistant') {
        const assistant: Record<string, unknown> = {
          role: 'assistant',
          content: message.content,
        }
        if (message.providerReplay?.protocol === 'openai-chat'
          && message.providerReplay.modelId === input.modelId
          && message.providerReplay.baseUrl === normalizeModelBaseUrl(input.baseUrl)) {
          assistant.encrypted_content = message.providerReplay.encryptedContent
        }
        if (message.reasoningContent !== undefined) {
          assistant.reasoning_content = message.reasoningContent
        }
        if (message.toolCalls !== undefined) {
          assistant.tool_calls = message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: toolCall.argumentsJson,
            },
          }))
        }
        return assistant
      }
      return { role: message.role, content: message.content }
    }),
    stream: true,
  }
  if (input.tools !== undefined && input.tools.length > 0) {
    body.tools = input.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }))
    body.tool_choice = 'auto'
  }
  const maxTokens = options.maxTokens ?? requestedOutputTokens(input)
  const thinking = resolveModelThinkingCapability(input)
  if (maxTokens !== undefined) {
    const outputField = resolveModelCapabilityRule(input)?.outputTokenField ?? (thinking.encoding === 'openai-effort'
      && normalizeModelBaseUrl(input.baseUrl) === 'https://api.openai.com/v1'
      ? 'max_completion_tokens' : 'max_tokens')
    body[outputField] = maxTokens
  }

  encodeThinking(input, body)
  if (input.provider === 'zhipu' && thinking.encoding === 'thinking-effort'
    && input.tools !== undefined && input.tools.length > 0) body.tool_stream = true
  if (
    input.provider === 'qwen'
    && input.protocol === 'openai'
    && thinking.encoding === 'openai-effort'
  ) {
    body.stream_options = { include_usage: true }
  }

  return {
    url: appendEndpoint(input.baseUrl, '/chat/completions'),
    headers: {
      accept: 'text/event-stream, application/json',
      authorization: `Bearer ${input.apiKey}`,
      'content-type': 'application/json',
    },
    body,
  }
}

function encodeThinking(input: ModelChatInput, body: Record<string, unknown>): void {
  const cap = resolveModelThinkingCapability(input)
  const effective = effectiveModelThinking(input, input)
  const mode = effective.thinkingMode
  const effort = effective.reasoningEffort
  switch (cap.encoding) {
    case 'openai-effort':
      if (mode === 'disabled') body.reasoning_effort = 'none'
      else if (effort !== 'default') body.reasoning_effort = effort
      break
    case 'legacy-openai-effort':
      if (effort !== 'default') body.reasoning_effort = effort
      break
    case 'thinking-effort':
      if (mode !== 'default' || (cap.thinking === 'fixed' && effort !== 'default')) body.thinking = { type: mode === 'disabled' ? 'disabled' : 'enabled' }
      if (mode !== 'disabled' && effort !== 'default') body.reasoning_effort = effort
      break
    case 'thinking':
    case 'adaptive':
      if (mode !== 'default') body.thinking = { type: mode === 'disabled' ? 'disabled' : cap.encoding === 'adaptive' ? 'adaptive' : 'enabled' }
      break
    case 'enable-thinking':
      if (mode !== 'default') body.enable_thinking = mode === 'enabled'
      break
    case 'thinking-output-effort':
      if (mode !== 'default') body.thinking = { type: mode === 'disabled' ? 'disabled' : 'enabled' }
      if (mode !== 'disabled' && effort !== 'default') body.output_config = { effort }
      break
    case 'claude-adaptive':
    case 'claude-budget':
      if (mode !== 'default') {
        body.thinking = mode === 'disabled' ? { type: 'disabled' }
          : cap.encoding === 'claude-budget' ? { type: 'enabled', budget_tokens: 1024 } : { type: 'adaptive' }
        if (mode === 'enabled' && cap.encoding === 'claude-budget') body.max_tokens = Math.max(Number(body.max_tokens), 1025)
      }
      if (effort !== 'default') body.output_config = { effort }
      // Native Fable 5.1 is fixed-on. Explicit adaptive also protects provider-default
      // conversations when Arkdown changes document/tool prefixes between turns.
      if (cap.bindingControls && mode !== 'disabled') body.thinking = {
        ...(body.thinking as Record<string, unknown> ?? { type: 'adaptive' }),
        block_binding: { prefix_mismatch_behavior: 'drop_block' },
      }
      break
  }
}

function anthropicRequestMessages(
  messages: readonly ModelChatMessage[],
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (message.role === 'system') {
      index += 1
      continue
    }
    if (message.role === 'tool') {
      const content: Array<Record<string, unknown>> = []
      while (index < messages.length) {
        const toolMessage = messages[index]
        if (toolMessage.role !== 'tool') break
        const toolResult: Record<string, unknown> = {
          type: 'tool_result',
          tool_use_id: toolMessage.toolCallId,
          content: toolMessage.content,
        }
        if (toolMessage.isError === true) toolResult.is_error = true
        content.push(toolResult)
        index += 1
      }
      result.push({ role: 'user', content })
      continue
    }
    if (message.role === 'assistant') {
      if (message.providerReplay?.protocol === 'anthropic' && message.providerReplay.contentBlocks !== undefined) {
        result.push({ role: 'assistant', content: message.providerReplay.contentBlocks.map((block) => ({ ...block })) })
        index += 1
        continue
      }
      const content: Array<Record<string, unknown>> = []
      if (message.providerReplay?.protocol === 'anthropic') {
        content.push(...message.providerReplay.blocks.map((block) => ({ ...block })))
      }
      if (message.content !== '') content.push({ type: 'text', text: message.content })
      for (const toolCall of message.toolCalls ?? []) {
        let toolInput: unknown
        try {
          toolInput = JSON.parse(toolCall.argumentsJson)
        } catch {
          throw modelProtocolError('incompatible-response')
        }
        if (!isRecord(toolInput)) throw modelProtocolError('incompatible-response')
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolInput,
        })
      }
      result.push({ role: 'assistant', content })
      index += 1
      continue
    }
    result.push({ role: message.role, content: message.content })
    index += 1
  }
  return result
}

function anthropicRequest(input: ModelChatInput, options: RequestOptions): {
  url: URL
  headers: HeadersInit
  body: Record<string, unknown>
} {
  const system = input.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const body: Record<string, unknown> = {
    model: input.modelId,
    messages: anthropicRequestMessages(input.messages),
    stream: true,
    max_tokens: options.maxTokens
      ?? requestedOutputTokens(input)
      ?? ANTHROPIC_STREAM_MAX_TOKENS,
  }
  if (system !== '') body.system = system
  if (input.tools !== undefined && input.tools.length > 0) {
    body.tools = input.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }))
  }

  encodeThinking(input, body)

  return {
    url: appendEndpoint(input.baseUrl, '/messages'),
    headers: {
      accept: 'text/event-stream, application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      'x-api-key': input.apiKey,
      ...(input.provider === 'kimi' ? { authorization: `Bearer ${input.apiKey}` } : {}),
      ...(resolveModelThinkingCapability(input).bindingControls
        ? { 'anthropic-beta': 'thinking-binding-controls-2026-08-01' } : {}),
    },
    body,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function providerSseError(
  protocol: ModelProtocol,
  value: unknown,
): ModelProtocolError | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined
  if (protocol === 'anthropic' && value.type !== 'error') return undefined

  return providerModelError(value.error, { source: 'sse' })
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // Cancellation is best-effort; the public failure remains deterministic.
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null) return
  try {
    await response.body.cancel()
  } catch {
    // Cancellation is best-effort; the public failure remains deterministic.
  }
}

async function readBoundedBytes(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  const cancelOnAbort = () => { void cancelReader(reader) }
  if (signal.aborted) cancelOnAbort()
  else signal.addEventListener('abort', cancelOnAbort, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      if (totalBytes + value.byteLength > maximumBytes) {
        throw responseSizeFailure('http')
      }
      totalBytes += value.byteLength
      chunks.push(value)
    }
  } catch (error) {
    await cancelReader(reader)
    if (signal.aborted || error instanceof ModelProtocolError) throw error
    throw transportModelError(error, 'receive')
  } finally {
    signal.removeEventListener('abort', cancelOnAbort)
  }
  const result = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

async function httpFailure(
  response: Response,
  signal: AbortSignal,
): Promise<ModelProtocolError> {
  if (response.status >= 300 && response.status < 400 || [401, 408, 504].includes(response.status)) {
    await cancelResponseBody(response)
    return providerModelError(undefined, { source: 'http', httpStatus: response.status })
  }

  let responseText = ''
  try {
    const bytes = await readBoundedBytes(response, ERROR_BODY_MAX_BYTES, signal)
    responseText = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    // Classification remains status-based when the upstream body cannot be read.
  }
  let body: unknown
  try { body = JSON.parse(responseText) } catch { /* Status evidence survives non-JSON error bodies. */ }
  const retryHeader = response.headers.get('retry-after')
  const retryAfterSeconds = retryHeader && /^\d{1,5}$/u.test(retryHeader) && Number(retryHeader) <= 86_400 ? Number(retryHeader) : undefined
  return providerModelError(isRecord(body) ? body.error : undefined, { source: 'http', httpStatus: response.status,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) })
}

function openAiDelta(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const choices = (value as { choices?: unknown }).choices
  if (!Array.isArray(choices) || typeof choices[0] !== 'object' || choices[0] === null) {
    return undefined
  }
  const delta = (choices[0] as { delta?: unknown }).delta
  if (typeof delta !== 'object' || delta === null) return undefined
  const content = (delta as { content?: unknown }).content
  if (content !== undefined && content !== null && typeof content !== 'string') {
    throw modelProtocolError('incompatible-response')
  }
  return typeof content === 'string' && content !== '' ? content : undefined
}

function openAiReasoningDelta(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) {
    return undefined
  }
  const delta = value.choices[0].delta
  if (!isRecord(delta)) return undefined
  return typeof delta.reasoning_content === 'string' && delta.reasoning_content !== ''
    ? delta.reasoning_content
    : undefined
}

interface ToolCallAccumulator {
  id?: string
  name?: string
  argumentsJson: string
}

interface ToolStreamState {
  openAiCalls: Map<number, ToolCallAccumulator>
  openAiToolFinish: boolean
  anthropicCalls: Map<number, ToolCallAccumulator>
  anthropicStoppedCalls: Set<number>
  anthropicToolFinish: boolean
}

class ChatContentBudget {
  private bytes = 0

  retain(value: string): void {
    const nextBytes = this.bytes + Buffer.byteLength(value, 'utf8')
    if (nextBytes > CHAT_SSE_CONTENT_MAX_BYTES) throw responseSizeFailure('sse')
    this.bytes = nextBytes
  }
}

function responseSizeFailure(source: 'http' | 'sse') {
  return semanticModelError('incompatible-response', 'response-size-limit', 'receive', source)
}

function incompleteToolStream() {
  return semanticModelError('incompatible-response', 'tool-stream-incomplete', 'receive', 'sse')
}

function assignCanonicalToolField(
  call: ToolCallAccumulator,
  field: 'id' | 'name',
  value: unknown,
  budget?: ChatContentBudget,
): void {
  if (value === undefined) return
  if (typeof value !== 'string' || value.trim() === '') {
    throw semanticModelError('incompatible-response', field === 'id' ? 'tool-invalid-identity' : 'tool-invalid-name', 'tool-validation', 'local')
  }
  if (call[field] !== undefined && call[field] !== value) {
    throw semanticModelError('incompatible-response', field === 'id' ? 'tool-invalid-identity' : 'tool-invalid-name', 'tool-validation', 'local')
  }
  if (call[field] === undefined) budget?.retain(value)
  call[field] = value
}

function accumulateOpenAiToolCalls(
  value: unknown,
  state: ToolStreamState,
  budget: ChatContentBudget,
): boolean {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) {
    return false
  }
  const choice = value.choices[0]
  if (choice.finish_reason === 'tool_calls') state.openAiToolFinish = true
  if (!isRecord(choice.delta)) return false
  const toolCalls = choice.delta.tool_calls
  if (toolCalls === undefined || toolCalls === null) return false
  if (!Array.isArray(toolCalls)) {
    throw modelProtocolError('incompatible-response')
  }
  if (toolCalls.length === 0) return false

  for (const fragment of toolCalls) {
    if (!isRecord(fragment) || !Number.isInteger(fragment.index) || Number(fragment.index) < 0) {
      throw modelProtocolError('incompatible-response')
    }
    const index = Number(fragment.index)
    const call = state.openAiCalls.get(index) ?? { argumentsJson: '' }
    assignCanonicalToolField(call, 'id', fragment.id, budget)
    if (fragment.function !== undefined) {
      if (!isRecord(fragment.function)) throw modelProtocolError('incompatible-response')
      assignCanonicalToolField(call, 'name', fragment.function.name, budget)
      if (fragment.function.arguments !== undefined) {
        if (typeof fragment.function.arguments !== 'string') {
          throw modelProtocolError('incompatible-response')
        }
        budget.retain(fragment.function.arguments)
        call.argumentsJson += fragment.function.arguments
      }
    }
    state.openAiCalls.set(index, call)
  }
  return true
}

function completedToolCalls(
  calls: ReadonlyMap<number, ToolCallAccumulator>,
  allowedToolNames: ReadonlySet<string>,
): ModelToolCall[] {
  const ids = new Set<string>()
  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => {
      if (!isCanonicalAiToolCallId(call.id) || ids.has(call.id)) throw semanticModelError('incompatible-response', 'tool-invalid-identity', 'tool-validation', 'local')
      if (call.name === undefined || !allowedToolNames.has(call.name)) throw semanticModelError('incompatible-response', 'tool-invalid-name', 'tool-validation', 'local')
      try {
        if (!isRecord(JSON.parse(call.argumentsJson))) throw new Error()
      } catch {
        throw semanticModelError('incompatible-response', 'tool-invalid-arguments', 'tool-validation', 'local')
      }
      ids.add(call.id)
      return {
        id: call.id,
        name: call.name,
        argumentsJson: call.argumentsJson,
      }
    })
}

function completedOpenAiToolCalls(
  state: ToolStreamState,
  allowedToolNames: ReadonlySet<string>,
): ModelToolCall[] {
  if (state.openAiCalls.size === 0) {
    if (state.openAiToolFinish) throw incompleteToolStream()
    return []
  }
  if (!state.openAiToolFinish) throw incompleteToolStream()
  return completedToolCalls(state.openAiCalls, allowedToolNames)
}

function accumulateAnthropicToolCalls(
  value: unknown,
  state: ToolStreamState,
): boolean {
  if (!isRecord(value)) return false
  if (value.type === 'message_delta') {
    if (isRecord(value.delta) && value.delta.stop_reason === 'tool_use') {
      state.anthropicToolFinish = true
      return true
    }
    return false
  }
  if (value.type === 'content_block_start') {
    if (!Number.isInteger(value.index) || Number(value.index) < 0) {
      throw modelProtocolError('incompatible-response')
    }
    if (!isRecord(value.content_block) || value.content_block.type !== 'tool_use') {
      return false
    }
    const index = Number(value.index)
    if (state.anthropicCalls.has(index)) {
      throw modelProtocolError('incompatible-response')
    }
    const call: ToolCallAccumulator = { argumentsJson: '' }
    assignCanonicalToolField(call, 'id', value.content_block.id)
    assignCanonicalToolField(call, 'name', value.content_block.name)
    state.anthropicCalls.set(index, call)
    return true
  }
  if (value.type === 'content_block_stop') {
    if (!Number.isInteger(value.index) || Number(value.index) < 0) {
      throw modelProtocolError('incompatible-response')
    }
    const index = Number(value.index)
    if (!state.anthropicCalls.has(index)) return false
    if (state.anthropicStoppedCalls.has(index)) {
      throw modelProtocolError('incompatible-response')
    }
    state.anthropicStoppedCalls.add(index)
    return true
  }
  if (value.type !== 'content_block_delta' || !isRecord(value.delta)) return false
  if (value.delta.type !== 'input_json_delta') return false
  if (!Number.isInteger(value.index) || Number(value.index) < 0) {
    throw modelProtocolError('incompatible-response')
  }
  if (typeof value.delta.partial_json !== 'string') {
    throw modelProtocolError('incompatible-response')
  }
  const index = Number(value.index)
  const call = state.anthropicCalls.get(index)
  if (call === undefined) throw modelProtocolError('incompatible-response')
  if (state.anthropicStoppedCalls.has(index)) {
    throw modelProtocolError('incompatible-response')
  }
  call.argumentsJson += value.delta.partial_json
  return true
}

function completedAnthropicToolCalls(
  state: ToolStreamState,
  allowedToolNames: ReadonlySet<string>,
): ModelToolCall[] {
  if (state.anthropicCalls.size === 0) {
    if (state.anthropicToolFinish) throw incompleteToolStream()
    return []
  }
  if (!state.anthropicToolFinish) throw incompleteToolStream()
  if (
    state.anthropicStoppedCalls.size !== state.anthropicCalls.size
    || [...state.anthropicCalls.keys()].some((index) => !state.anthropicStoppedCalls.has(index))
  ) {
    throw incompleteToolStream()
  }
  return completedToolCalls(state.anthropicCalls, allowedToolNames)
}

function anthropicDelta(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if ((value as { type?: unknown }).type !== 'content_block_delta') return undefined
  const delta = (value as { delta?: unknown }).delta
  if (typeof delta !== 'object' || delta === null) return undefined
  if ((delta as { type?: unknown }).type !== 'text_delta') return undefined
  const text = (delta as { text?: unknown }).text
  return typeof text === 'string' && text !== '' ? text : undefined
}

interface AnthropicThinkingReplayAccumulator {
  type: 'thinking'
  thinking: string
  signature: string
  stopped: boolean
}

interface AnthropicRedactedReplayAccumulator {
  type: 'redacted_thinking'
  data: string
  stopped: boolean
}

type AnthropicReplayAccumulatorBlock =
  | AnthropicThinkingReplayAccumulator
  | AnthropicRedactedReplayAccumulator

interface AnthropicReplayAccumulator {
  blocks: Map<number, AnthropicReplayAccumulatorBlock>
  order: number[]
  content: Map<number, { block: Record<string, unknown>; json: string; stopped: boolean }>
  transformations: ModelInputTransformation[]
}

function inputTransformations(value: unknown): ModelInputTransformation[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 1000).flatMap((entry) => isRecord(entry) && entry.type === 'thinking_dropped'
    && typeof entry.path === 'string' && /^messages\.\d+\.content\.\d+$/.test(entry.path) && entry.path.length <= 128
    && (entry.reason === 'prefix_binding_mismatch' || entry.reason === 'model_binding_mismatch')
    ? [{ type: 'thinking_dropped' as const, path: entry.path, reason: entry.reason }] : [])
}

function accumulateAnthropicContent(value: Record<string, unknown>, accumulator: AnthropicReplayAccumulator): void {
  const transformations = value.type === 'message_start' && isRecord(value.message)
    ? value.message.input_transformations : value.input_transformations
  for (const item of inputTransformations(transformations)) {
    if (accumulator.transformations.length < 1000
      && !accumulator.transformations.some((prior) => prior.path === item.path && prior.reason === item.reason)) accumulator.transformations.push(item)
  }
  if (!Number.isInteger(value.index) || Number(value.index) < 0) return
  const index = Number(value.index)
  if (value.type === 'content_block_start' && isRecord(value.content_block)) {
    if (accumulator.content.has(index)) throw modelProtocolError('incompatible-response')
    accumulator.content.set(index, { block: { ...value.content_block }, json: '', stopped: false })
  }
  const entry = accumulator.content.get(index)
  if (!entry) return
  if (value.type === 'content_block_delta' && isRecord(value.delta)) {
    if (entry.stopped) throw modelProtocolError('incompatible-response')
    const delta = value.delta
    if (delta.type === 'text_delta' && typeof delta.text === 'string') entry.block.text = String(entry.block.text ?? '') + delta.text
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') entry.block.thinking = String(entry.block.thinking ?? '') + delta.thinking
    if (delta.type === 'signature_delta' && typeof delta.signature === 'string') entry.block.signature = String(entry.block.signature ?? '') + delta.signature
    if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') entry.json += delta.partial_json
  }
  if (value.type === 'content_block_stop') {
    if (entry.stopped) throw modelProtocolError('incompatible-response')
    entry.stopped = true
    if (entry.block.type === 'tool_use' && entry.json !== '') {
      try { entry.block.input = JSON.parse(entry.json) } catch { throw modelProtocolError('incompatible-response') }
      if (!isRecord(entry.block.input)) throw modelProtocolError('incompatible-response')
    }
  }
}

type AnthropicReplayActivity =
  | { type: 'reasoning'; reasoning: string; index: number }
  | { type: 'metadata' }
  | undefined

function anthropicReplayActivity(
  value: unknown,
  accumulator: AnthropicReplayAccumulator,
): AnthropicReplayActivity {
  if (!isRecord(value)) return undefined
  accumulateAnthropicContent(value, accumulator)
  if (value.type === 'content_block_start') {
    if (!Number.isSafeInteger(value.index) || Number(value.index) < 0) {
      throw modelProtocolError('incompatible-response')
    }
    if (!isRecord(value.content_block)) return undefined
    const index = Number(value.index)
    if (
      value.content_block.type !== 'thinking'
      && value.content_block.type !== 'redacted_thinking'
    ) return undefined
    if (accumulator.blocks.has(index)) throw modelProtocolError('incompatible-response')

    let block: AnthropicReplayAccumulatorBlock
    if (value.content_block.type === 'thinking') {
      if (
        typeof value.content_block.thinking !== 'string'
        || (
          value.content_block.signature !== undefined
          && typeof value.content_block.signature !== 'string'
        )
      ) throw modelProtocolError('incompatible-response')
      block = {
        type: 'thinking',
        thinking: value.content_block.thinking,
        signature: value.content_block.signature ?? '',
        stopped: false,
      }
    } else {
      if (typeof value.content_block.data !== 'string') {
        throw modelProtocolError('incompatible-response')
      }
      block = {
        type: 'redacted_thinking',
        data: value.content_block.data,
        stopped: false,
      }
    }
    accumulator.blocks.set(index, block)
    accumulator.order.push(index)
    return block.type === 'thinking' && block.thinking !== ''
      ? { type: 'reasoning', reasoning: block.thinking, index }
      : { type: 'metadata' }
  }

  if (value.type === 'content_block_stop') {
    if (!Number.isSafeInteger(value.index) || Number(value.index) < 0) {
      throw modelProtocolError('incompatible-response')
    }
    const block = accumulator.blocks.get(Number(value.index))
    if (block === undefined) return undefined
    if (block.stopped) throw modelProtocolError('incompatible-response')
    block.stopped = true
    return { type: 'metadata' }
  }

  if (value.type !== 'content_block_delta' || !isRecord(value.delta)) return undefined
  if (value.delta.type !== 'thinking_delta' && value.delta.type !== 'signature_delta') {
    return undefined
  }
  if (!Number.isSafeInteger(value.index) || Number(value.index) < 0) {
    throw modelProtocolError('incompatible-response')
  }
  const block = accumulator.blocks.get(Number(value.index))
  if (value.delta.type === 'thinking_delta') {
    if (
      block?.type !== 'thinking'
      || block.stopped
      || typeof value.delta.thinking !== 'string'
    ) throw modelProtocolError('incompatible-response')
    block.thinking += value.delta.thinking
    return value.delta.thinking === ''
      ? { type: 'metadata' }
      : { type: 'reasoning', reasoning: value.delta.thinking, index: Number(value.index) }
  }
  if (value.delta.type === 'signature_delta') {
    if (
      block?.type !== 'thinking'
      || block.stopped
      || typeof value.delta.signature !== 'string'
    ) throw modelProtocolError('incompatible-response')
    block.signature += value.delta.signature
    return { type: 'metadata' }
  }
  return undefined
}

function completedAnthropicReplay(
  accumulator: AnthropicReplayAccumulator,
): ModelProviderReplay | null {
  if ([...accumulator.content.values()].some(({ stopped }) => !stopped)) {
    throw modelProtocolError('incompatible-response')
  }
  const blocks: AnthropicReplayBlock[] = []
  for (const index of accumulator.order) {
    const block = accumulator.blocks.get(index)
    if (block === undefined || !block.stopped) continue
    if (block.type === 'thinking') {
      if (block.signature === '') continue
      blocks.push({
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      })
    } else {
      blocks.push({ type: 'redacted_thinking', data: block.data })
    }
  }
  const contentBlocks = [...accumulator.content.values()].filter(({ block, stopped }) => stopped
    && (block.type !== 'thinking' || (typeof block.signature === 'string' && block.signature !== ''))).map(({ block }) => block)
  return contentBlocks.length === 0 ? null : { protocol: 'anthropic', blocks, contentBlocks }
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function openAiUsage(value: unknown): ModelUsage | undefined {
  if (!isRecord(value) || !isRecord(value.usage)) return undefined
  const usage = value.usage
  if (
    !isSafeNonNegativeInteger(usage.prompt_tokens)
    || !isSafeNonNegativeInteger(usage.completion_tokens)
    || !isSafeNonNegativeInteger(usage.total_tokens)
    || usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens
  ) return undefined

  let cachedInputTokens: number | null = null
  if (usage.prompt_tokens_details !== undefined && usage.prompt_tokens_details !== null) {
    if (!isRecord(usage.prompt_tokens_details)) return undefined
    const cached = usage.prompt_tokens_details.cached_tokens
    if (cached !== undefined) {
      if (!isSafeNonNegativeInteger(cached) || cached > usage.prompt_tokens) return undefined
      cachedInputTokens = cached
    }
  }
  if (usage.prompt_cache_hit_tokens !== undefined) {
    if (
      !isSafeNonNegativeInteger(usage.prompt_cache_hit_tokens)
      || usage.prompt_cache_hit_tokens > usage.prompt_tokens
    ) return undefined
    if (
      cachedInputTokens !== null
      && cachedInputTokens !== usage.prompt_cache_hit_tokens
    ) return undefined
    cachedInputTokens = usage.prompt_cache_hit_tokens
  }
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cachedInputTokens,
    estimated: false,
  }
}

interface AnthropicUsageAccumulator {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  hasCacheDetail: boolean
}

function anthropicUsageRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if (value.type === 'message_start' && isRecord(value.message) && isRecord(value.message.usage)) {
    return value.message.usage
  }
  return isRecord(value.usage) ? value.usage : undefined
}

function accumulateAnthropicUsage(
  value: unknown,
  accumulator: AnthropicUsageAccumulator,
): ModelUsage | undefined {
  const usage = anthropicUsageRecord(value)
  if (usage === undefined) return undefined
  const fields = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ] as const
  for (const field of fields) {
    if (usage[field] !== undefined && !isSafeNonNegativeInteger(usage[field])) return undefined
  }
  if (isSafeNonNegativeInteger(usage.input_tokens)) accumulator.inputTokens = usage.input_tokens
  if (isSafeNonNegativeInteger(usage.output_tokens)) accumulator.outputTokens = usage.output_tokens
  if (isSafeNonNegativeInteger(usage.cache_creation_input_tokens)) {
    accumulator.cacheCreationInputTokens = usage.cache_creation_input_tokens
    accumulator.hasCacheDetail = true
  }
  if (isSafeNonNegativeInteger(usage.cache_read_input_tokens)) {
    accumulator.cacheReadInputTokens = usage.cache_read_input_tokens
    accumulator.hasCacheDetail = true
  }
  if (accumulator.inputTokens === undefined || accumulator.outputTokens === undefined) {
    return undefined
  }
  const inputTokens = accumulator.inputTokens
    + (accumulator.cacheCreationInputTokens ?? 0)
    + (accumulator.cacheReadInputTokens ?? 0)
  const totalTokens = inputTokens + accumulator.outputTokens
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(totalTokens)) return undefined
  return {
    inputTokens,
    outputTokens: accumulator.outputTokens,
    totalTokens,
    cachedInputTokens: accumulator.hasCacheDetail
      ? accumulator.cacheReadInputTokens ?? 0
      : null,
    estimated: false,
  }
}

interface ResponseMetadataState {
  encryptedContent?: string
  reasoningContent: string
  usage: ModelUsage | null
  anthropicUsage: AnthropicUsageAccumulator
  anthropicReplay: AnthropicReplayAccumulator
}

function mergeMonotonicUsage(previous: ModelUsage | null, next: ModelUsage): ModelUsage {
  if (
    previous !== null
    && (
      next.inputTokens < previous.inputTokens
      || next.outputTokens < previous.outputTokens
      || next.totalTokens < previous.totalTokens
    )
  ) return previous
  if (previous?.cachedInputTokens === null) return next
  if (next.cachedInputTokens === null) {
    return previous === null ? next : { ...next, cachedInputTokens: previous.cachedInputTokens }
  }
  return previous === null
    ? next
    : {
      ...next,
      cachedInputTokens: Math.max(previous.cachedInputTokens, next.cachedInputTokens),
    }
}

function chatEncryptedContent(value: unknown, field: 'delta' | 'message'): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) return undefined
  const choice = value.choices[0]
  if (!isRecord(choice) || !isRecord(choice[field])) return undefined
  const encrypted = choice[field].encrypted_content
  if (encrypted === undefined || encrypted === null) return undefined
  if (typeof encrypted !== 'string') throw modelProtocolError('incompatible-response')
  return encrypted || undefined
}

type SseDataResult =
  | 'ignored' | 'emitted' | 'reasoning' | 'metadata' | 'tool' | 'terminal'

function completionFailure(protocol: ModelProtocol, value: unknown, source: 'http' | 'sse') {
  if (!isRecord(value)) return undefined
  const reason = protocol === 'openai'
    ? Array.isArray(value.choices) && isRecord(value.choices[0]) ? value.choices[0].finish_reason : undefined
    : isRecord(value.delta) ? value.delta.stop_reason : value.stop_reason
  if (reason === 'length' || reason === 'max_tokens') return semanticModelError('incompatible-response', 'output-limit', 'receive', source)
  if (reason === 'content_filter') return semanticModelError('incompatible-response', 'content-filtered', 'receive', source)
  if (reason === 'aborted' || reason === 'insufficient_system_resource') {
    return semanticModelError('incompatible-response', 'provider-interrupted', 'receive', source)
  }
  return undefined
}

function parseSseData(
  protocol: ModelProtocol,
  data: string,
  onDelta: (delta: string) => void,
  toolState: ToolStreamState,
  metadata: ResponseMetadataState,
  budget: ChatContentBudget,
  onReasoning: (active: boolean) => void,
  acceptReasoningActivity = false,
  onProcess?: (event: ModelProcessDelta) => void,
): SseDataResult {
  if (protocol === 'openai' && data === '[DONE]') { onReasoning(false); return 'terminal' }

  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    throw modelProtocolError('incompatible-response')
  }
  const providerError = providerSseError(protocol, parsed)
  if (providerError !== undefined) throw providerError
  const incomplete = completionFailure(protocol, parsed, 'sse')
  if (incomplete && !(acceptReasoningActivity && incomplete.detail.reason === 'output-limit')) {
    const partial = protocol === 'openai' ? openAiDelta(parsed) : anthropicDelta(parsed)
    if (partial !== undefined) {
      if (protocol === 'openai') budget.retain(partial)
      onDelta(partial)
    }
    throw incomplete
  }
  const usage = protocol === 'openai'
    ? openAiUsage(parsed)
    : accumulateAnthropicUsage(parsed, metadata.anthropicUsage)
  if (usage !== undefined) metadata.usage = mergeMonotonicUsage(metadata.usage, usage)
  if (
    protocol === 'anthropic'
    && isRecord(parsed)
    && parsed.type === 'message_stop'
  ) { onReasoning(false); return 'terminal' }

  const anthropicActivity = protocol === 'anthropic'
    ? anthropicReplayActivity(parsed, metadata.anthropicReplay)
    : undefined
  const reasoningDelta = protocol === 'openai'
    ? openAiReasoningDelta(parsed)
    : anthropicActivity?.type === 'reasoning'
      ? anthropicActivity.reasoning
      : undefined
  if (reasoningDelta !== undefined) {
    if (protocol === 'openai') budget.retain(reasoningDelta)
    metadata.reasoningContent += reasoningDelta
    onReasoning(true)
    onProcess?.({ kind: 'reasoning-text', itemId: anthropicActivity?.type === 'reasoning'
      ? `anthropic-block-${anthropicActivity.index}` : 'chat-choice-0', segmentIndex: 0, delta: reasoningDelta, delivery: 'stream' })
  }
  if (protocol === 'anthropic' && isRecord(parsed)) {
    if (parsed.type === 'content_block_start' && isRecord(parsed.content_block)) {
      onReasoning(parsed.content_block.type === 'thinking' || parsed.content_block.type === 'redacted_thinking')
    } else if (parsed.type === 'content_block_stop' || parsed.type === 'message_delta') onReasoning(false)
  }
  if (protocol === 'openai' && isRecord(parsed) && Array.isArray(parsed.choices)
    && parsed.choices.some(choice => isRecord(choice) && choice.finish_reason != null)) onReasoning(false)
  const encrypted = protocol === 'openai' ? chatEncryptedContent(parsed, 'delta') : undefined
  if (encrypted !== undefined) {
    // Seed returns a complete signed blob, not text deltas. Never concatenate two signatures.
    if (metadata.encryptedContent !== undefined && metadata.encryptedContent !== encrypted) throw modelProtocolError('incompatible-response')
    if (metadata.encryptedContent === undefined) budget.retain(encrypted)
    metadata.encryptedContent = encrypted
  }
  const hiddenResult: SseDataResult = encrypted !== undefined ? 'metadata' : reasoningDelta !== undefined
    ? 'reasoning'
    : anthropicActivity?.type === 'metadata'
      ? 'metadata'
      : 'ignored'

  if (protocol === 'openai' && accumulateOpenAiToolCalls(parsed, toolState, budget)) {
    onReasoning(false)
    return hiddenResult === 'ignored' ? 'tool' : hiddenResult
  }
  if (protocol === 'anthropic' && accumulateAnthropicToolCalls(parsed, toolState)) {
    onReasoning(false)
    return hiddenResult === 'ignored' ? 'tool' : hiddenResult
  }

  const delta = protocol === 'openai'
    ? openAiDelta(parsed)
    : anthropicDelta(parsed)
  if (delta === undefined) {
    return hiddenResult
  }
  onReasoning(false)
  if (protocol === 'openai') budget.retain(delta)
  onDelta(delta)
  return 'emitted'
}

async function consumeSse(
  response: Response,
  protocol: ModelProtocol,
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  allowedToolNames: ReadonlySet<string>,
  acceptReasoningActivity = false,
  onReasoningActivity: () => void = () => undefined,
  responses?: ModelResponsesAdapter,
  onReasoning: (active: boolean) => void = () => undefined,
  onProcess?: (event: ModelProcessDelta) => void,
): Promise<ModelChatResult> {
  if (response.body === null) throw modelProtocolError('incompatible-response')

  const reader = response.body.getReader()
  const cancelOnAbort = () => { void cancelReader(reader) }
  if (signal.aborted) cancelOnAbort()
  else signal.addEventListener('abort', cancelOnAbort, { once: true })
  const pendingChunks: Uint8Array[] = []
  let pendingBytes = 0
  let totalBytes = 0
  let emitted = false
  const budget = new ChatContentBudget()
  const wireMaxBytes = protocol === 'openai' && !responses ? CHAT_SSE_WIRE_MAX_BYTES : SSE_RESPONSE_MAX_BYTES
  const toolState: ToolStreamState = {
    openAiCalls: new Map(),
    openAiToolFinish: false,
    anthropicCalls: new Map(),
    anthropicStoppedCalls: new Set(),
    anthropicToolFinish: false,
  }
  const metadata: ResponseMetadataState = {
    reasoningContent: '',
    usage: null,
    anthropicUsage: { hasCacheDetail: false },
    anthropicReplay: { blocks: new Map(), order: [], content: new Map(), transformations: [] },
  }

  const result = (): ModelChatResult => {
    if (responses) return responses.result()
    const toolCalls = protocol === 'openai'
      ? completedOpenAiToolCalls(toolState, allowedToolNames)
      : completedAnthropicToolCalls(toolState, allowedToolNames)
    if (
      !emitted
      && toolCalls.length === 0
      && !(acceptReasoningActivity && metadata.reasoningContent !== '')
    ) {
      throw modelProtocolError('incompatible-response')
    }
    return {
      toolCalls,
      reasoningContent: metadata.reasoningContent,
      // Probes accept legitimate partial reasoning activity and never reuse assistant replay.
      providerReplay: protocol === 'anthropic' && !acceptReasoningActivity
        ? completedAnthropicReplay(metadata.anthropicReplay)
        : protocol === 'openai' && !acceptReasoningActivity && metadata.encryptedContent !== undefined
          ? { protocol: 'openai-chat', encryptedContent: metadata.encryptedContent } : null,
      ...(metadata.anthropicReplay.transformations.length > 0 ? { inputTransformations: metadata.anthropicReplay.transformations } : {}),
      usage: metadata.usage,
    }
  }

  const consumeLine = (): boolean => {
    const bytes = new Uint8Array(pendingBytes)
    let offset = 0
    for (const chunk of pendingChunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    let line: string
    try {
      line = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw modelProtocolError('incompatible-response')
    }
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!normalized.startsWith('data:')) return false
    const data = normalized.slice(5).trimStart()
    if (data === '') return false
    let parsed: SseDataResult
    if (responses) {
      let value: unknown
      try { value = JSON.parse(data) } catch { throw modelProtocolError('incompatible-response') }
      parsed = responses.consume(value)
    } else parsed = parseSseData(protocol, data, onDelta, toolState, metadata, budget, onReasoning, acceptReasoningActivity, onProcess)
    if (parsed === 'emitted') emitted = true
    if (parsed === 'reasoning') {
      onReasoningActivity()
    }
    if (parsed === 'metadata' || parsed === 'tool') onReasoningActivity()
    return parsed === 'terminal'
  }

  const appendSegment = (segment: Uint8Array) => {
    if (pendingBytes + segment.byteLength > SSE_LINE_MAX_BYTES) {
      throw responseSizeFailure('sse')
    }
    if (segment.byteLength > 0) pendingChunks.push(segment)
    pendingBytes += segment.byteLength
  }

  const resetLine = () => {
    pendingChunks.length = 0
    pendingBytes = 0
  }

  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) {
        signal.throwIfAborted()
        break
      }

      let offset = 0
      while (offset < value.byteLength) {
        const newline = value.indexOf(0x0a, offset)
        const lineEnd = newline === -1 ? value.byteLength : newline
        const segment = value.slice(offset, lineEnd)
        const consumedBytes = segment.byteLength + (newline === -1 ? 0 : 1)
        if (totalBytes + consumedBytes > wireMaxBytes) {
          throw responseSizeFailure('sse')
        }
        totalBytes += consumedBytes
        appendSegment(segment)

        if (newline === -1) break
        if (consumeLine()) {
          await cancelReader(reader)
          return result()
        }
        resetLine()
        offset = newline + 1
      }
    }

    if (pendingBytes > 0 && consumeLine()) {
      await cancelReader(reader)
      return result()
    }
    return result()
  } catch (error) {
    await cancelReader(reader)
    throw error
  } finally {
    signal.removeEventListener('abort', cancelOnAbort)
  }
}

function completeJsonText(protocol: ModelProtocol, value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined

  if (protocol === 'openai') {
    const choices = (value as { choices?: unknown }).choices
    if (!Array.isArray(choices) || typeof choices[0] !== 'object' || choices[0] === null) {
      return undefined
    }
    const message = (choices[0] as { message?: unknown }).message
    if (typeof message !== 'object' || message === null) return undefined
    const content = (message as { content?: unknown }).content
    if (content !== undefined && content !== null && typeof content !== 'string') {
      throw modelProtocolError('incompatible-response')
    }
    return typeof content === 'string' && content !== '' ? content : undefined
  }

  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((block): block is { type: 'text'; text: string } => (
      typeof block === 'object'
      && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map((block) => block.text)
    .join('')
  return text !== '' ? text : undefined
}

function completeJsonReasoning(protocol: ModelProtocol, value: unknown): string {
  if (!isRecord(value)) return ''
  if (protocol === 'openai') {
    if (!Array.isArray(value.choices) || !isRecord(value.choices[0])) return ''
    const message = value.choices[0].message
    if (!isRecord(message)) return ''
    return typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
  }
  if (!Array.isArray(value.content)) return ''
  return value.content
    .filter((block): block is Record<string, unknown> => (
      isRecord(block)
      && block.type === 'thinking'
      && typeof block.thinking === 'string'
    ))
    .map((block) => block.thinking as string)
    .join('')
}

function completeJsonAnthropicReplay(value: unknown): ModelProviderReplay | null {
  if (!isRecord(value) || !Array.isArray(value.content)) return null
  const blocks: AnthropicReplayBlock[] = []
  for (const block of value.content) {
    if (!isRecord(block)) continue
    if (
      block.type === 'thinking'
      && typeof block.thinking === 'string'
      && typeof block.signature === 'string'
      && block.signature !== ''
    ) {
      blocks.push({
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      })
    } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
      blocks.push({ type: 'redacted_thinking', data: block.data })
    }
  }
  const contentBlocks = value.content.filter((block): block is Record<string, unknown> => isRecord(block)
    && (block.type !== 'thinking' || (typeof block.signature === 'string' && block.signature !== '')))
  return contentBlocks.length === 0 ? null : { protocol: 'anthropic', blocks, contentBlocks }
}

function completeJsonToolCalls(
  protocol: ModelProtocol,
  value: unknown,
  allowedToolNames: ReadonlySet<string>,
): ModelToolCall[] {
  if (protocol === 'openai') {
    if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) return []
    const choice = value.choices[0]
    const rawCalls = isRecord(choice.message) ? choice.message.tool_calls : undefined
    if (rawCalls === undefined || rawCalls === null) {
      if (choice.finish_reason === 'tool_calls') throw modelProtocolError('incompatible-response')
      return []
    }
    if (!Array.isArray(rawCalls)
      || (rawCalls.length > 0) !== (choice.finish_reason === 'tool_calls')) {
      throw modelProtocolError('incompatible-response')
    }
    const calls = new Map<number, ToolCallAccumulator>()
    rawCalls.forEach((call, index) => {
      if (!isRecord(call) || call.type !== 'function' || !isRecord(call.function)
        || typeof call.id !== 'string' || typeof call.function.name !== 'string'
        || typeof call.function.arguments !== 'string') {
        throw modelProtocolError('incompatible-response')
      }
      calls.set(index, { id: call.id, name: call.function.name, argumentsJson: call.function.arguments })
    })
    return completedToolCalls(calls, allowedToolNames)
  }
  if (protocol !== 'anthropic' || !isRecord(value) || !Array.isArray(value.content)) return []
  const toolCalls: ModelToolCall[] = []
  const ids = new Set<string>()
  for (const block of value.content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue
    if (!isCanonicalAiToolCallId(block.id) || ids.has(block.id)) throw semanticModelError('incompatible-response', 'tool-invalid-identity', 'tool-validation', 'local')
    if (typeof block.name !== 'string' || !allowedToolNames.has(block.name)) throw semanticModelError('incompatible-response', 'tool-invalid-name', 'tool-validation', 'local')
    if (!isRecord(block.input)) throw semanticModelError('incompatible-response', 'tool-invalid-arguments', 'tool-validation', 'local')
    ids.add(block.id)
    toolCalls.push({
      id: block.id,
      name: block.name,
      argumentsJson: JSON.stringify(block.input),
    })
  }
  if (
    (toolCalls.length > 0 && value.stop_reason !== 'tool_use')
    || (toolCalls.length === 0 && value.stop_reason === 'tool_use')
  ) throw modelProtocolError('incompatible-response')
  return toolCalls
}

function completeJsonUsage(protocol: ModelProtocol, value: unknown): ModelUsage | null {
  if (protocol === 'openai') return openAiUsage(value) ?? null
  const accumulator: AnthropicUsageAccumulator = { hasCacheDetail: false }
  return accumulateAnthropicUsage(value, accumulator) ?? null
}

async function consumeJson(
  response: Response,
  protocol: ModelProtocol,
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  allowedToolNames: ReadonlySet<string>,
  acceptReasoningActivity = false,
  responses?: ModelResponsesAdapter,
  onProcess?: (event: ModelProcessDelta) => void,
): Promise<ModelChatResult> {
  let value: unknown
  try {
    const bytes = await readBoundedBytes(response, JSON_RESPONSE_MAX_BYTES, signal)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    value = JSON.parse(text)
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof ModelProtocolError) throw error
    throw modelProtocolError('incompatible-response')
  }
  if (responses) {
    return responses.complete(value)
  }
  if (isRecord(value) && isRecord(value.error)) throw providerModelError(value.error, { source: 'http', httpStatus: response.status })
  const encryptedContent = protocol === 'openai' ? chatEncryptedContent(value, 'message') : undefined
  const text = completeJsonText(protocol, value)
  const incomplete = completionFailure(protocol, value, 'http')
  if (incomplete && !(acceptReasoningActivity && incomplete.detail.reason === 'output-limit')) {
    if (text !== undefined) onDelta(text)
    throw incomplete
  }
  const reasoningContent = completeJsonReasoning(protocol, value)
  const toolCalls = completeJsonToolCalls(protocol, value, allowedToolNames)
  if (
    text === undefined
    && toolCalls.length === 0
    && !(acceptReasoningActivity && reasoningContent !== '')
  ) {
    throw modelProtocolError('incompatible-response')
  }
  if (onProcess && reasoningContent) {
    if (protocol === 'openai') onProcess({ kind: 'reasoning-text', itemId: 'chat-choice-0', segmentIndex: 0, delta: reasoningContent, delivery: 'complete' })
    else if (isRecord(value) && Array.isArray(value.content)) value.content.forEach((block, index) => {
      if (isRecord(block) && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
        onProcess({ kind: 'reasoning-text', itemId: `anthropic-block-${index}`, segmentIndex: 0, delta: block.thinking, delivery: 'complete' })
      }
    })
  }
  if (text !== undefined) onDelta(text)
  return {
    toolCalls,
    reasoningContent,
    providerReplay: acceptReasoningActivity ? null : protocol === 'anthropic' ? completeJsonAnthropicReplay(value)
      : encryptedContent === undefined ? null : { protocol: 'openai-chat', encryptedContent },
    usage: completeJsonUsage(protocol, value),
    ...(protocol === 'anthropic' && isRecord(value) && inputTransformations(value.input_transformations).length > 0
      ? { inputTransformations: inputTransformations(value.input_transformations) } : {}),
  }
}

async function performRequest(
  fetchImpl: typeof fetch,
  timeoutMs: number,
  input: ModelChatInput,
  options: RequestOptions = {},
): Promise<ModelChatResult> {
  const abortContext = createAbortContext(
    input.signal,
    input.initialInactivityTimeoutMs ?? timeoutMs,
    timeoutMs,
  )
  const reasoning = createModelReasoningSignal(abortContext.signal, input.onReasoning)
  let processConsumer = options.acceptReasoningActivity ? undefined : input.onProcess
  const receiveProcess = (event: ModelProcessDelta) => {
    abortContext.signal.throwIfAborted()
    try { processConsumer?.(Object.freeze({ ...event })) } catch { processConsumer = undefined }
    abortContext.signal.throwIfAborted()
  }
  const receiveDelta = (delta: string) => {
    abortContext.signal.throwIfAborted()
    reasoning.update(false)
    try { input.onDelta(delta) } catch {
      if (input.signal.aborted) throw input.signal.reason
      throw semanticModelError('invalid-endpoint', 'unknown', 'receive', 'local')
    }
    abortContext.signal.throwIfAborted()
    abortContext.refreshTimeout()
  }

  const bindReplay = (result: ModelChatResult): ModelChatResult => result.providerReplay?.protocol === 'openai-chat'
    ? { ...result, providerReplay: { ...result.providerReplay, modelId: input.modelId, baseUrl: normalizeModelBaseUrl(input.baseUrl) } } : result
  const useResponses = usesModelResponses(input)
  let failureStage: 'configuration' | 'connect' | 'receive' = 'configuration'
  try {
    abortContext.signal.throwIfAborted()
    const request = input.protocol === 'openai'
      ? openAiRequest(input, options)
      : anthropicRequest(input, options)
    const body = JSON.stringify(request.body)
    failureStage = 'connect'
    const response = await fetchImpl(request.url, {
      method: 'POST',
      redirect: 'manual',
      headers: request.headers,
      body,
      signal: abortContext.signal,
    })
    failureStage = 'receive'
    if (!response.ok) throw await httpFailure(response, abortContext.signal)

    const recognizedToolNames = new Set([
      ...(input.tools?.map((tool) => tool.name) ?? []),
      ...(input.recognizedToolNames ?? []),
    ])
    const responses = useResponses
      ? new ModelResponsesAdapter(input.modelId, recognizedToolNames, receiveDelta, options.acceptReasoningActivity === true, reasoning.update, receiveProcess)
      : undefined
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('text/event-stream')) {
      return bindReplay(await consumeSse(
        response,
        input.protocol,
        abortContext.signal,
        receiveDelta,
        recognizedToolNames,
        options.acceptReasoningActivity === true,
        abortContext.refreshTimeout,
        responses,
        reasoning.update,
        receiveProcess,
      ))
    }
    return bindReplay(await consumeJson(
      response,
      input.protocol,
      abortContext.signal,
      receiveDelta,
      recognizedToolNames,
      options.acceptReasoningActivity === true,
      responses,
      receiveProcess,
    ))
  } catch (error) {
    if (input.signal.aborted) {
      throw input.signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
    }
    if (abortContext.didTimeout()) throw modelProtocolError('timeout')
    if (error instanceof ModelProtocolError) {
      // Native Astra tools are supported through Responses. A schema/endpoint failure
      // must not trigger the caller's compatibility fallback that removes tools.
      if (useResponses && error.capability === 'tools') throw modelProtocolError(error.status, undefined, error.detail)
      throw error
    }
    if (failureStage === 'configuration') throw semanticModelError('invalid-endpoint', 'unknown', 'configuration', 'local')
    throw transportModelError(error, failureStage)
  } finally {
    reasoning.dispose()
    abortContext.dispose()
  }
}

export function createModelProtocolClient(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = MODEL_REQUEST_INACTIVITY_TIMEOUT_MS,
  codex = createCodexCliModelAdapter(),
): ModelProtocolClient {
  return {
    streamChat(input) {
      if (isCodexCliConnection(input)) return codex.streamChat(input)
      return performRequest(fetchImpl, timeoutMs, input)
    },
    testConnection(input) {
      if (isCodexCliConnection(input)) return codex.streamChat({ ...input,
        messages: [{ role: 'user', content: 'Reply with OK only.' }], onDelta: () => undefined, onProcess: undefined,
      }).then(() => undefined)
      return performRequest(fetchImpl, timeoutMs, {
        ...input,
        messages: [{ role: 'user', content: 'Reply with OK only.' }],
        onDelta: () => undefined,
      }, {
        maxTokens: usesModelResponses(input) ? RESPONSES_PROBE_OUTPUT_TOKENS : input.protocol === 'openai' ? 2 : 8,
        acceptReasoningActivity: true,
      }).then(() => undefined)
    },
  }
}
