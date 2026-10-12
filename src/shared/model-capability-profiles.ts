import type {
  ModelCapabilityOverride,
  ModelConnectionSummary,
  ReasoningEffort,
  ThinkingMode,
} from './large-model-settings'
import { parseModelCapabilityOverride, parseReasoningEffort } from './large-model-settings'
import { effectiveModelThinking, normalizeModelBaseUrl, resolveModelThinkingCapability, type ThinkingEncoding } from './model-thinking'

export interface ModelCapabilityProfile {
  contextWindowTokens: number
  maxInputTokens: number
  maxOutputTokens: number
  supportedReasoningEfforts: readonly ReasoningEffort[]
  defaultReasoningEffort: ReasoningEffort
  reasoningEncoding: ThinkingEncoding | 'glm-thinking' | 'anthropic-budget'
}

export interface ModelCapabilityResolutionOptions {
  requestedOutputTokens: number
  reasoningEffort: ReasoningEffort
  thinkingMode?: ThinkingMode
}

type CapabilityConnection = Pick<
  ModelConnectionSummary,
  'provider' | 'protocol' | 'baseUrl' | 'modelId' | 'capabilityOverride'
>

const DEEPSEEK_MODEL_IDS = new Set([
  'deepseek-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp',
])
const GLM_MODEL_IDS = new Set(['glm-5.3', 'glm-5.3-flash'])
const QWEN_MODEL_IDS = new Set(['qwen3.8-max', 'qwen3.8-flash'])

function validRequestedOutputTokens(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

export function requestedOutputWithinLimit(
  requestedOutputTokens: number,
  contextWindowTokens: number,
  maxOutputTokens: number,
): number {
  return Math.min(requestedOutputTokens, maxOutputTokens, contextWindowTokens - 1)
}

function customProfile(
  override: ModelCapabilityOverride,
  options: ModelCapabilityResolutionOptions,
  connection: CapabilityConnection,
): ModelCapabilityProfile {
  const contextWindowTokens = override.contextWindowTokens!
  const maxOutputTokens = override.maxOutputTokens ?? contextWindowTokens
  const requestedOutputTokens = requestedOutputWithinLimit(
    options.requestedOutputTokens,
    contextWindowTokens,
    maxOutputTokens,
  )
  const thinking = resolveModelThinkingCapability(connection)
  return {
    contextWindowTokens,
    maxInputTokens: override.maxInputTokens
      ?? contextWindowTokens - requestedOutputTokens,
    maxOutputTokens,
    supportedReasoningEfforts: thinking.efforts,
    defaultReasoningEffort: thinking.defaultEffort,
    reasoningEncoding: thinking.encoding,
  }
}

function overlayNumericLimits(
  profile: ModelCapabilityProfile,
  override: ModelCapabilityOverride | null,
  options: ModelCapabilityResolutionOptions,
): ModelCapabilityProfile | undefined {
  if (override === null || override.contextWindowTokens === undefined) return profile
  const parsed = parseModelCapabilityOverride(override)
  if (parsed === undefined) return undefined
  const contextWindowTokens = parsed.contextWindowTokens!
  const maxOutputTokens = parsed.maxOutputTokens
    ?? Math.min(profile.maxOutputTokens, contextWindowTokens)
  const availableInputTokens = contextWindowTokens - requestedOutputWithinLimit(
    options.requestedOutputTokens,
    contextWindowTokens,
    maxOutputTokens,
  )
  return {
    ...profile,
    contextWindowTokens,
    maxInputTokens: parsed.maxInputTokens
      ?? Math.min(profile.maxInputTokens, availableInputTokens),
    maxOutputTokens,
  }
}

export function resolveModelCapabilityProfile(
  connection: CapabilityConnection,
  options: ModelCapabilityResolutionOptions,
): ModelCapabilityProfile | undefined {
  if (
    !validRequestedOutputTokens(options.requestedOutputTokens)
    || parseReasoningEffort(options.reasoningEffort) === undefined
  ) return undefined

  connection = { ...connection, baseUrl: normalizeModelBaseUrl(connection.baseUrl) }
  const thinkingCapability = resolveModelThinkingCapability(connection)
  const reasoningProfile = {
    supportedReasoningEfforts: thinkingCapability.efforts,
    defaultReasoningEffort: thinkingCapability.defaultEffort,
    reasoningEncoding: thinkingCapability.encoding,
  }

  if (
    connection.protocol === 'openai'
    && connection.provider === 'deepseek'
    && ['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes(connection.baseUrl)
    && DEEPSEEK_MODEL_IDS.has(connection.modelId)
  ) {
    const contextWindowTokens = 1_048_576
    const maxOutputTokens = 384_000
    return overlayNumericLimits({
      contextWindowTokens,
      maxInputTokens: contextWindowTokens - requestedOutputWithinLimit(
        options.requestedOutputTokens,
        contextWindowTokens,
        maxOutputTokens,
      ),
      maxOutputTokens,
      ...reasoningProfile,
    }, connection.capabilityOverride, options)
  }

  if (
    connection.protocol === 'openai'
    && connection.provider === 'zhipu'
    && connection.baseUrl === 'https://open.bigmodel.cn/api/paas/v4'
    && GLM_MODEL_IDS.has(connection.modelId)
  ) {
    const contextWindowTokens = 1_000_000
    const maxOutputTokens = 131_072
    return overlayNumericLimits({
      contextWindowTokens,
      maxInputTokens: contextWindowTokens - requestedOutputWithinLimit(
        options.requestedOutputTokens,
        contextWindowTokens,
        maxOutputTokens,
      ),
      maxOutputTokens,
      ...reasoningProfile,
    }, connection.capabilityOverride, options)
  }

  if (
    connection.protocol === 'openai'
    && connection.provider === 'qwen'
    && connection.baseUrl === 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    && QWEN_MODEL_IDS.has(connection.modelId)
  ) {
    const thinking = effectiveModelThinking(connection, { thinkingMode: options.thinkingMode ?? 'default', reasoningEffort: options.reasoningEffort }).thinkingMode !== 'disabled'
    return overlayNumericLimits({
      contextWindowTokens: 1_000_000,
      maxInputTokens: thinking ? 983_616 : 991_808,
      maxOutputTokens: 131_072,
      ...reasoningProfile,
    }, connection.capabilityOverride, options)
  }

  if (connection.capabilityOverride === null) return undefined
  const override = parseModelCapabilityOverride(connection.capabilityOverride)
  return override?.contextWindowTokens === undefined ? undefined : customProfile(override, options, connection)
}
