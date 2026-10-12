import bundledData from './model-capability-rules.json'
import type { ModelProtocol, ModelProviderId, ReasoningEffort, ThinkingMode } from './large-model-settings'

export type ThinkingEncoding = 'none' | 'openai-effort' | 'thinking-effort' | 'thinking'
  | 'enable-thinking' | 'adaptive' | 'claude-adaptive' | 'claude-budget' | 'legacy-openai-effort'
  | 'thinking-output-effort'
export interface ModelThinkingCapability {
  thinking: 'unknown' | 'fixed' | 'toggle'
  encoding: ThinkingEncoding
  efforts: readonly Exclude<ReasoningEffort, 'default'>[]
  defaultThinking: ThinkingMode
  defaultEffort: ReasoningEffort
  disabledEfforts: readonly Exclude<ReasoningEffort, 'default'>[]
  bindingControls?: true
  effortAliases?: Partial<Record<Exclude<ReasoningEffort, 'default'>, Exclude<ReasoningEffort, 'default'>>>
}
export interface ModelCapabilityRule {
  id: string
  provider?: ModelProviderId
  protocol: ModelProtocol
  baseUrls?: string[]
  endpointGroup?: 'dashscope'
  modelIds: string[]
  capability: ModelThinkingCapability
  /** Lower values appear first; the first model ID is the canonical recommendation. */
  recommendation?: number
  outputTokenField?: 'max_tokens' | 'max_completion_tokens'
  transport?: 'chat-completions' | 'responses'
}
export interface RuleFile { schemaVersion: 1; revision: string; rules: ModelCapabilityRule[] }
export type ModelCapabilityRuleConnection = {
  provider: ModelProviderId; protocol: ModelProtocol; baseUrl?: string; modelId: string
}
export const MODEL_CAPABILITY_RULES_MAX_BYTES = 1_048_576
export const MODEL_CAPABILITY_RULES_MAX_COUNT = 512
const PROVIDERS = ['kimi', 'deepseek', 'qwen', 'zhipu', 'doubao', 'minimax', 'xiaomi-mimo', 'hy', 'other']
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
const ENCODINGS: readonly ThinkingEncoding[] = ['none', 'openai-effort', 'thinking-effort', 'thinking', 'enable-thinking', 'adaptive', 'claude-adaptive', 'claude-budget', 'legacy-openai-effort', 'thinking-output-effort']
const OPENAI_ENCODINGS = ['none', 'openai-effort', 'thinking-effort', 'thinking', 'enable-thinking', 'adaptive', 'legacy-openai-effort']
const ANTHROPIC_ENCODINGS = ['none', 'thinking', 'adaptive', 'claude-adaptive', 'claude-budget', 'thinking-output-effort']
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
/** Validate plain JSON before serializing: getters, sparse arrays and class instances are not data. */
function jsonData(value: unknown): unknown {
  let nodes = 0
  let characters = 0
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 10) throw new TypeError('Rules are too complex')
    if (typeof item === 'string') {
      characters += item.length
      if (characters > MODEL_CAPABILITY_RULES_MAX_BYTES) throw new TypeError('Rules are too large')
      return item
    }
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item
    if (typeof item !== 'object' || item === null) throw new TypeError('Expected JSON data')
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError('Expected plain data')
    const ownKeys = Reflect.ownKeys(item)
    if (array && (item.length > 100_000 || ownKeys.length !== item.length + 1)) throw new TypeError('Invalid array')
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null)
    for (const key of ownKeys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new TypeError('Invalid property')
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) throw new TypeError('Invalid array property')
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Expected data property')
      characters += key.length
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true })
    }
    return result
  }
  const copy = visit(value, 0)
  if (new TextEncoder().encode(JSON.stringify(copy)).length > MODEL_CAPABILITY_RULES_MAX_BYTES) throw new TypeError('Rules are too large')
  return copy
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
function normalizeUrl(value: string): string {
  try {
    if (value !== value.trim() || value.length > 2048 || /[\s\\]/.test(value)) return ''
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash) return ''
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return ''
    return url.toString().replace(/\/+$/, '')
  } catch { return '' }
}
function dashscope(url: string, protocol: ModelProtocol): boolean {
  const host = 'https://(?:dashscope(?:-intl)?\\.aliyuncs\\.com|[a-z0-9-]+\\.(?:cn-beijing|ap-southeast-1|us-east-1|eu-central-1|ap-northeast-1|cn-hongkong)\\.maas\\.aliyuncs\\.com)'
  const suffix = protocol === 'openai' ? '/compatible-mode/v1' : '/apps/anthropic/v1'
  return new RegExp('^' + host + suffix + '$').test(url)
    || url === 'https://coding.dashscope.aliyuncs.com' + (protocol === 'openai' ? '/v1' : '/apps/anthropic/v1')
}

function effortList(value: unknown): value is ModelThinkingCapability['efforts'] {
  return Array.isArray(value) && value.length <= EFFORTS.length && new Set(value).size === value.length
    && value.every(item => typeof item === 'string' && (EFFORTS as readonly string[]).includes(item))
}
function parseCapability(value: unknown, protocol?: ModelProtocol): ModelThinkingCapability | undefined {
  if (!record(value) || !keys(value, ['thinking', 'encoding', 'efforts', 'defaultThinking', 'defaultEffort', 'disabledEfforts'], ['bindingControls', 'effortAliases'])) return
  if (!['unknown', 'fixed', 'toggle'].includes(String(value.thinking)) || !ENCODINGS.includes(value.encoding as ThinkingEncoding)) return
  if (protocol && !(protocol === 'openai' ? OPENAI_ENCODINGS : ANTHROPIC_ENCODINGS).includes(String(value.encoding))) return
  if (!effortList(value.efforts) || !effortList(value.disabledEfforts)) return
  const efforts = value.efforts
  if (!['default', 'enabled', 'disabled'].includes(String(value.defaultThinking))) return
  if (value.defaultEffort !== 'default' && !value.efforts.includes(value.defaultEffort as typeof EFFORTS[number])) return
  if (value.disabledEfforts.some(effort => !efforts.includes(effort))) return
  if (Object.hasOwn(value, 'bindingControls') && value.bindingControls !== true) return
  if (value.effortAliases !== undefined) {
    const efforts = value.efforts
    if (!record(value.effortAliases) || Object.entries(value.effortAliases).some(([from, to]) =>
      !(EFFORTS as readonly string[]).includes(from) || efforts.includes(from as typeof EFFORTS[number])
      || typeof to !== 'string' || !efforts.includes(to as typeof EFFORTS[number]))) return
  }
  if (value.bindingControls && value.encoding !== 'claude-adaptive') return
  if (value.disabledEfforts.length && !['claude-adaptive', 'claude-budget'].includes(String(value.encoding))) return
  if (value.thinking === 'fixed' && value.defaultThinking === 'disabled') return
  if (value.thinking === 'unknown' && (value.encoding !== 'none' || value.efforts.length || value.disabledEfforts.length || value.defaultThinking !== 'default' || value.defaultEffort !== 'default' || value.bindingControls)) return
  if (value.thinking === 'toggle' && value.encoding === 'none') return
  if (['none', 'thinking', 'enable-thinking', 'adaptive'].includes(String(value.encoding)) && (value.efforts.length || value.disabledEfforts.length)) return
  if (['openai-effort', 'thinking-effort', 'thinking-output-effort', 'claude-adaptive', 'legacy-openai-effort'].includes(String(value.encoding)) && !value.efforts.length) return
  return clone(value) as unknown as ModelThinkingCapability
}
export function parseModelThinkingCapability(value: unknown, protocol?: ModelProtocol): ModelThinkingCapability | undefined {
  try { return parseCapability(jsonData(value), protocol) } catch { return undefined }
}
function textList(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maxItems
    && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= maxLength && !/[\s\u0000-\u001f\u007f]/.test(item))
    && new Set(value).size === value.length
}
function parseRule(value: unknown): ModelCapabilityRule | undefined {
  if (!record(value) || !keys(value, ['id', 'protocol', 'modelIds', 'capability'], ['provider', 'baseUrls', 'endpointGroup', 'recommendation', 'outputTokenField', 'transport'])) return
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.id)) return
  if (value.protocol !== 'openai' && value.protocol !== 'anthropic') return
  if (Object.hasOwn(value, 'provider') && !PROVIDERS.includes(String(value.provider))) return
  if (Object.hasOwn(value, 'baseUrls') === Object.hasOwn(value, 'endpointGroup')) return
  if (value.endpointGroup !== undefined && value.endpointGroup !== 'dashscope') return
  let baseUrls: string[] | undefined
  if (value.baseUrls !== undefined) {
    if (!textList(value.baseUrls, 32, 2048)) return
    baseUrls = value.baseUrls.map(normalizeUrl)
    if (baseUrls.some(url => !url) || new Set(baseUrls).size !== baseUrls.length) return
  }
  if (!textList(value.modelIds, 128, 512)) return
  const capability = parseCapability(value.capability, value.protocol)
  if (!capability) return
  if (value.recommendation !== undefined && (typeof value.recommendation !== 'number' || !Number.isInteger(value.recommendation) || value.recommendation < 0 || value.recommendation > 100_000)) return
  if (value.outputTokenField !== undefined && !['max_tokens', 'max_completion_tokens'].includes(String(value.outputTokenField))) return
  if (value.transport !== undefined && !['chat-completions', 'responses'].includes(String(value.transport))) return
  if (value.protocol === 'anthropic' && (value.transport !== undefined || value.outputTokenField !== undefined)) return
  if (value.transport === 'responses' && (value.outputTokenField !== undefined || !['openai-effort', 'legacy-openai-effort'].includes(capability.encoding))) return
  return { ...clone(value), ...(baseUrls ? { baseUrls } : {}), capability } as unknown as ModelCapabilityRule
}
function priority(rule: ModelCapabilityRule): number { return (rule.provider ? 2 : 0) + (rule.baseUrls ? 1 : 0) }
function endpointMatches(rule: ModelCapabilityRule, url: string): boolean {
  return rule.baseUrls ? rule.baseUrls.includes(url) : rule.endpointGroup === 'dashscope' && dashscope(url, rule.protocol)
}
function ambiguous(rules: ModelCapabilityRule[]): boolean {
  if (new Set(rules.map(rule => rule.id)).size !== rules.length) return true
  for (let a = 0; a < rules.length; a++) for (let b = a + 1; b < rules.length; b++) {
    const left = rules[a], right = rules[b]
    if (left.protocol !== right.protocol || priority(left) !== priority(right)) continue
    if (left.provider && right.provider && left.provider !== right.provider) continue
    if (!left.modelIds.some(id => right.modelIds.includes(id))) continue
    const overlap = left.baseUrls ? left.baseUrls.some(url => endpointMatches(right, url))
      : right.baseUrls ? right.baseUrls.some(url => endpointMatches(left, url)) : left.endpointGroup === right.endpointGroup
    if (overlap) return true
  }
  return false
}
function parseFile(value: unknown): RuleFile | undefined {
  const data = jsonData(value)
  if (!record(data) || !keys(data, ['schemaVersion', 'revision', 'rules'])) return
  if (data.schemaVersion !== 1 || typeof data.revision !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.revision)) return
  const date = new Date(`${data.revision}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== data.revision) return
  if (!Array.isArray(data.rules) || data.rules.length > MODEL_CAPABILITY_RULES_MAX_COUNT) return
  const rules = data.rules.map(parseRule)
  if (rules.some(rule => !rule)) return
  const validRules = rules as ModelCapabilityRule[]
  if (ambiguous(validRules)) return
  return { schemaVersion: 1, revision: data.revision, rules: validRules }
}
const bundled = parseFile(bundledData)
if (!bundled) throw new TypeError('Invalid bundled model capability rules')
const bundledRules = bundled.rules
function merge(file: RuleFile | null): ModelCapabilityRule[] {
  const overrides = new Map(file?.rules.map(rule => [rule.id, rule]))
  return [...bundledRules.filter(rule => !overrides.has(rule.id)), ...overrides.values()]
}
/** Parse an overlay against bundled rules, rejecting ambiguous merged identities. */
export function parseModelCapabilityRules(value: unknown): RuleFile | undefined {
  try {
    const parsed = parseFile(value)
    return parsed && !ambiguous(merge(parsed)) ? parsed : undefined
  } catch { return undefined }
}
let overlay: RuleFile | null = null
let activeRules = bundledRules
let revision = 0
const listeners = new Set<() => void>()
export function setModelCapabilityRules(value: RuleFile | null): void {
  const parsed = value === null ? null : parseModelCapabilityRules(value)
  if (parsed === undefined) throw new TypeError('Invalid model capability rules')
  if (JSON.stringify(parsed) === JSON.stringify(overlay)) return
  overlay = parsed
  activeRules = merge(overlay)
  revision++
  for (const listener of [...listeners]) listener()
}
export function getModelCapabilityRules(): RuleFile | null { return overlay ? clone(overlay) : null }
export function getModelCapabilityRulesRevision(): number { return revision }
export function subscribeModelCapabilityRules(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function matches(rule: ModelCapabilityRule, connection: Omit<ModelCapabilityRuleConnection, 'modelId'>, url: string): boolean {
  return rule.protocol === connection.protocol && (!rule.provider || rule.provider === connection.provider) && endpointMatches(rule, url)
}
export function resolveModelCapabilityRule(connection: ModelCapabilityRuleConnection): ModelCapabilityRule | undefined {
  const url = normalizeUrl((connection.baseUrl ?? '').trim())
  if (!url) return
  const result = activeRules.filter(rule => rule.modelIds.includes(connection.modelId) && matches(rule, connection, url))
    .sort((a, b) => priority(b) - priority(a))[0]
  return result ? clone(result) : undefined
}
export function recommendedModelIds(connection: Omit<ModelCapabilityRuleConnection, 'modelId'>): string[] {
  const url = normalizeUrl((connection.baseUrl ?? '').trim())
  if (!url) return []
  const rules = activeRules.filter(rule => rule.recommendation !== undefined && matches(rule, connection, url))
    .sort((a, b) => a.recommendation! - b.recommendation! || priority(b) - priority(a) || a.id.localeCompare(b.id))
  return [...new Set(rules.flatMap(rule => rule.modelIds.filter(modelId => resolveModelCapabilityRule({ ...connection, modelId })?.id === rule.id)))]
}
