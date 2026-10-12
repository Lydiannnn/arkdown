import { isDeepStrictEqual } from 'node:util'
import { isCanonicalAiToolCallId, type ModelUsage } from '../../shared/ai-conversation'
import { effectiveModelThinking } from '../../shared/model-thinking'
import { providerModelError, semanticModelError } from './model-provider-errors'
import type { ModelChatInput, ModelChatResult, ModelToolCall } from './model-protocol-client'
import type { ModelProcessDelta } from './model-process-delta'

// An application probe budget, not a claim about a provider's exact minimum.
export const RESPONSES_PROBE_OUTPUT_TOKENS = 64
const ARGUMENTS_MAX_BYTES = 256 * 1024
type Item = Record<string, unknown>
const invalid = () => semanticModelError('incompatible-response', 'protocol-malformed', 'decode', 'responses')
const record = (value: unknown): value is Item => typeof value === 'object' && value !== null && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function responsesRequestBody(input: ModelChatInput, maxTokens?: number): Item {
  const messages: Item[] = []
  for (const message of input.messages) {
    if (message.role === 'tool') {
      messages.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content })
    } else if (message.role === 'assistant') {
      if (message.providerReplay?.protocol === 'openai-responses' && message.providerReplay.modelId === input.modelId) {
        messages.push(...message.providerReplay.outputItems)
      } else {
        if (message.content !== '') messages.push({ role: 'assistant', content: message.content })
        for (const call of message.toolCalls ?? []) messages.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argumentsJson })
      }
    } else messages.push({ role: message.role, content: message.content })
  }
  const body: Item = { model: input.modelId, input: messages, store: false, stream: true, include: ['reasoning.encrypted_content'] }
  const effective = effectiveModelThinking(input, input)
  const effort = effective.thinkingMode === 'disabled' ? 'none' : effective.reasoningEffort
  if (effort !== 'default') body.reasoning = { effort }
  if (maxTokens !== undefined) body.max_output_tokens = maxTokens
  if (input.tools?.length) {
    // Existing schemas intentionally contain optional properties. Responses defaults to
    // strict schemas, so explicitly retain the established non-strict tool contract.
    body.tools = input.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }))
    body.tool_choice = 'auto'
  }
  return body
}

function argumentsString(value: unknown): string {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > ARGUMENTS_MAX_BYTES) throw semanticModelError('incompatible-response', 'tool-invalid-arguments', 'tool-validation', 'responses')
  return value
}

function toolCalls(items: readonly Item[], allowed: ReadonlySet<string>): ModelToolCall[] {
  const ids = new Set<string>()
  return items.filter(item => item.type === 'function_call').map(item => {
    if (!isCanonicalAiToolCallId(item.call_id) || ids.has(item.call_id)) throw semanticModelError('incompatible-response', 'tool-invalid-identity', 'tool-validation', 'responses')
    if (typeof item.name !== 'string' || !allowed.has(item.name)) throw semanticModelError('incompatible-response', 'tool-invalid-name', 'tool-validation', 'responses')
    const args = argumentsString(item.arguments)
    try { if (!record(JSON.parse(args))) throw invalid() } catch { throw semanticModelError('incompatible-response', 'tool-invalid-arguments', 'tool-validation', 'responses') }
    ids.add(item.call_id)
    return { id: item.call_id, name: item.name, argumentsJson: args }
  })
}

function readUsage(value: unknown): ModelUsage | null {
  if (!record(value) || !integer(value.input_tokens) || !integer(value.output_tokens) || !integer(value.total_tokens)
    || value.total_tokens !== value.input_tokens + value.output_tokens) return null
  let cached: number | null = null
  if (value.input_tokens_details != null) {
    if (!record(value.input_tokens_details)) return null
    const count = value.input_tokens_details.cached_tokens
    if (count !== undefined) {
      if (!integer(count) || count > value.input_tokens) return null
      cached = count
    }
  }
  return { inputTokens: value.input_tokens, outputTokens: value.output_tokens, totalTokens: value.total_tokens, cachedInputTokens: cached, estimated: false }
}

function outputItems(value: unknown, incompleteProbe: boolean): Item[] {
  if (!Array.isArray(value)) throw invalid()
  const ids = new Set<string>()
  return value.map(item => {
    if (!record(item) || !isCanonicalAiToolCallId(item.id) || ids.has(item.id)) throw invalid()
    ids.add(item.id)
    const closed = item.status === 'completed' || incompleteProbe && item.status === 'incomplete'
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content) || !closed) throw invalid()
      for (const part of item.content) {
        if (!record(part) || !(part.type === 'output_text' && typeof part.text === 'string'
          || part.type === 'refusal' && typeof part.refusal === 'string')) throw invalid()
      }
    } else if (item.type === 'function_call') {
      if (item.status !== undefined && item.status !== 'completed') throw invalid()
    } else if (item.type === 'reasoning') {
      if (!Array.isArray(item.summary) || item.summary.some(part => !record(part) || part.type !== 'summary_text' || typeof part.text !== 'string')) throw invalid()
      if (item.encrypted_content != null && typeof item.encrypted_content !== 'string') throw invalid()
      if (item.status !== undefined && !closed) throw invalid()
    } else throw invalid()
    return item
  })
}

interface StreamItem {
  id: string
  type: string
  added?: Item
  done?: Item
  arguments?: string
  argumentsDone?: string
  content: Map<number, { type: string; text: string; emitted: number; closed: boolean }>
  nextContentIndex: number
  process: Map<string, { text: string; closed: boolean }>
}

const visiblePartText = (part: Item): string => (part.type === 'refusal' ? part.refusal : part.text) as string

/** Only protocol state lives here. The client owns bounded reads, cancellation and timeouts. */
export class ModelResponsesAdapter {
  private readonly items = new Map<number, StreamItem>()
  private readonly itemIds = new Set<string>()
  private finalResult: ModelChatResult | undefined
  private nextOutputIndex = 0

  constructor(
    private readonly modelId: string,
    private readonly allowedTools: ReadonlySet<string>,
    private readonly onDelta: (delta: string) => void,
    private readonly acceptReasoningActivity: boolean,
    private readonly onReasoning: (active: boolean) => void = () => undefined,
    private readonly onProcess?: (event: ModelProcessDelta) => void,
  ) {}

  private item(index: unknown, id: unknown, type: string): StreamItem {
    if (!integer(index) || !isCanonicalAiToolCallId(id)) throw invalid()
    let state = this.items.get(index)
    if (!state) {
      if (this.itemIds.has(id)) throw invalid()
      state = { id, type, content: new Map(), nextContentIndex: 0, process: new Map() }
      this.items.set(index, state)
      this.itemIds.add(id)
    }
    if (state.id !== id || state.type !== type) throw invalid()
    return state
  }

  private contentPart(state: StreamItem, index: unknown, type: string) {
    if (!integer(index)) throw invalid()
    let part = state.content.get(index)
    if (!part) {
      part = { type, text: '', emitted: 0, closed: false }
      state.content.set(index, part)
    }
    if (part.type !== type) throw invalid()
    return part
  }

  private processPart(state: StreamItem, kind: 'reasoning-summary' | 'reasoning-text', index: unknown, text: unknown, complete: boolean): void {
    if (!integer(index) || typeof text !== 'string') throw invalid()
    const key = `${kind}:${index}`
    const prior = state.process.get(key) ?? { text: '', closed: false }
    if (complete ? !text.startsWith(prior.text) || prior.closed && text !== prior.text : prior.closed) throw invalid()
    const delta = complete ? text.slice(prior.text.length) : text
    state.process.set(key, { text: complete ? text : prior.text + text, closed: complete })
    if (delta) this.onProcess?.({ kind, itemId: state.id, segmentIndex: index, delta, delivery: complete ? 'complete' : 'stream' })
  }

  private closeContentPart(state: StreamItem, index: unknown, type: string, text: unknown): void {
    const part = this.contentPart(state, index, type)
    if (typeof text !== 'string' || !text.startsWith(part.text) || part.closed && text !== part.text) throw invalid()
    part.text = text
    part.closed = true
  }

  private flushContent(): boolean {
    let emitted = false
    while (true) {
      const state = this.items.get(this.nextOutputIndex)
      if (!state) break
      if (state.type === 'message') {
        while (true) {
          const part = state.content.get(state.nextContentIndex)
          if (!part) break
          if (part.text.length > part.emitted) {
            this.onDelta(part.text.slice(part.emitted))
            part.emitted = part.text.length
            emitted = true
          }
          if (!part.closed) break
          state.nextContentIndex += 1
        }
      }
      // A later part/item must not overtake a refusal suffix supplied on completion.
      if (!state.done) break
      this.nextOutputIndex += 1
    }
    return emitted
  }

  private reconcile(item: Item, index: number): void {
    const state = this.item(index, item.id, String(item.type))
    if (state.added) {
      for (const field of ['call_id', 'name', 'role']) {
        if (state.added[field] !== undefined && state.added[field] !== item[field]) throw invalid()
      }
    }
    if (state.arguments !== undefined && state.arguments !== item.arguments) throw invalid()
    if (state.argumentsDone !== undefined && state.argumentsDone !== item.arguments) throw invalid()
    if (state.done && !isDeepStrictEqual(state.done, item)) throw invalid()
    if (item.type === 'message') {
      const content = item.content as Item[]
      for (const [index, streamed] of state.content) {
        const part = content[index]
        if (!part || part.type !== streamed.type) throw invalid()
      }
      content.forEach((part, contentIndex) => {
        this.closeContentPart(state, contentIndex, String(part.type), visiblePartText(part))
      })
    } else if (item.type === 'reasoning') {
      const summary = item.summary as Item[]
      for (const key of state.process.keys()) {
        if (key.startsWith('reasoning-summary:') && Number(key.slice(18)) >= summary.length) throw invalid()
      }
      summary.forEach((part, segmentIndex) => this.processPart(state, 'reasoning-summary', segmentIndex, part.text, true))
    }
    state.done = item
    this.flushContent()
  }

  consume(value: unknown): 'ignored' | 'emitted' | 'metadata' | 'terminal' {
    if (!record(value)) throw invalid()
    const type = value.type
    if (type === 'response.failed') {
      if (!record(value.response) || value.response.status !== undefined && value.response.status !== 'failed') throw invalid()
      throw providerModelError(value.response.error, { source: 'responses' })
    }
    if (type === 'error') throw providerModelError(record(value.error) ? value.error : value, { source: 'responses' })
    if (type === 'response.completed' || type === 'response.incomplete') {
      if (!record(value.response) || value.response.status !== String(type).slice(9)) throw invalid()
      this.onReasoning(false)
      this.complete(value.response)
      return 'terminal'
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (!record(value.item) || typeof value.item.type !== 'string') throw invalid()
      const state = this.item(value.output_index, value.item.id, value.item.type)
      if (state.done) throw invalid()
      if (type === 'response.output_item.added') {
        if (state.added) throw invalid()
        state.added = value.item
        this.onReasoning(value.item.type === 'reasoning')
      } else {
        const item = outputItems([value.item], this.acceptReasoningActivity)[0]!
        if (item.type === 'function_call') toolCalls([item], this.allowedTools)
        this.onReasoning(false)
        this.reconcile(item, Number(value.output_index))
      }
      return 'metadata'
    }
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      if (!integer(value.content_index) || typeof value.delta !== 'string') throw invalid()
      const state = this.item(value.output_index, value.item_id, 'message')
      if (state.done) throw invalid()
      const part = this.contentPart(state, value.content_index, type === 'response.refusal.delta' ? 'refusal' : 'output_text')
      if (part.closed) throw invalid()
      part.text += value.delta
      if (value.delta === '') return 'ignored'
      this.onReasoning(false)
      return this.flushContent() ? 'emitted' : 'metadata'
    }
    if (type === 'response.output_text.done' || type === 'response.refusal.done') {
      const state = this.item(value.output_index, value.item_id, 'message')
      if (state.done) throw invalid()
      const refusal = type === 'response.refusal.done'
      this.closeContentPart(state, value.content_index, refusal ? 'refusal' : 'output_text', refusal ? value.refusal : value.text)
      return this.flushContent() ? 'emitted' : 'metadata'
    }
    if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      this.onReasoning(false)
      const state = this.item(value.output_index, value.item_id, 'function_call')
      if (state.done || state.argumentsDone !== undefined) throw invalid()
      if (type === 'response.function_call_arguments.delta') {
        state.arguments = argumentsString((state.arguments ?? '') + argumentsString(value.delta))
      } else {
        const args = argumentsString(value.arguments)
        if (state.arguments !== undefined && state.arguments !== args) throw invalid()
        state.argumentsDone = args
      }
      return 'metadata'
    }
    // Readable text is display-only, independent of final answer and encrypted replay.
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta'
      || type === 'response.reasoning_summary_text.done' || type === 'response.reasoning_text.done'
      || type === 'response.reasoning_summary_part.done') {
      const summary = type !== 'response.reasoning_text.delta' && type !== 'response.reasoning_text.done'
      const done = type.endsWith('.done')
      const text = type === 'response.reasoning_summary_part.done'
        ? record(value.part) && value.part.type === 'summary_text' ? value.part.text : undefined : done ? value.text : value.delta
      const state = this.item(value.output_index, value.item_id, 'reasoning')
      if (state.done) throw invalid()
      this.processPart(state, summary ? 'reasoning-summary' : 'reasoning-text', summary ? value.summary_index : value.content_index, text, done)
      if (!done && text !== '') this.onReasoning(true)
      return text === '' ? 'ignored' : 'metadata'
    }
    return 'ignored'
  }

  complete(value: unknown): ModelChatResult {
    if (record(value) && value.error != null) throw providerModelError(value.error, { source: 'responses' })
    if (!record(value) || value.object !== 'response' || !isCanonicalAiToolCallId(value.id)) throw invalid()
    if (value.error != null || value.status === 'failed') throw providerModelError(value.error, { source: 'responses' })
    const incompleteProbe = this.acceptReasoningActivity && value.status === 'incomplete'
      && record(value.incomplete_details) && value.incomplete_details.reason === 'max_output_tokens'
    if (value.status === 'incomplete' && !incompleteProbe) {
      const reason = record(value.incomplete_details) ? value.incomplete_details.reason : undefined
      throw semanticModelError('incompatible-response', reason === 'max_output_tokens' ? 'output-limit'
        : reason === 'content_filter' ? 'content-filtered' : 'stream-interrupted', 'receive', 'responses')
    }
    if (value.status !== 'completed' && !incompleteProbe) throw invalid()
    const output = outputItems(value.output, incompleteProbe)
    const calls = toolCalls(output, this.allowedTools)
    const usage = readUsage(value.usage)
    const reasoningTokens = record(value.usage) && record(value.usage.output_tokens_details)
      ? value.usage.output_tokens_details.reasoning_tokens : undefined
    const reasoningActivity = output.some(item => item.type === 'reasoning'
      && (typeof item.encrypted_content === 'string' && item.encrypted_content !== '' || (item.summary as Item[]).some(part => (part.text as string).trim() !== '')))
      || usage !== null && integer(reasoningTokens) && reasoningTokens > 0 && reasoningTokens <= usage.outputTokens
    const visible = output.some(item => item.type === 'message' && (item.content as Item[]).some(part => visiblePartText(part) !== ''))
    if (!visible && calls.length === 0 && !(this.acceptReasoningActivity && reasoningActivity)) throw invalid()
    // Final output must include all streamed items; never return a partial replay at EOF.
    for (const index of this.items.keys()) if (index >= output.length) throw invalid()
    output.forEach((item, index) => this.reconcile(item, index))
    this.finalResult = {
      toolCalls: calls, reasoningContent: '', usage,
      providerReplay: this.acceptReasoningActivity ? null : { protocol: 'openai-responses', modelId: this.modelId, outputItems: output },
    }
    return this.finalResult
  }

  result(): ModelChatResult {
    if (!this.finalResult) throw invalid()
    return this.finalResult
  }
}
