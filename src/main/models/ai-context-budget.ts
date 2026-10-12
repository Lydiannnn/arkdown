import type {
  AiConversationCapabilities,
  ModelUsage,
} from '../../shared/ai-conversation'
import { requestedOutputWithinLimit, resolveModelCapabilityProfile, type ModelCapabilityProfile } from '../../shared/model-capability-profiles'
import { usesModelResponses } from '../../shared/model-thinking'
import type { ModelChatMessage } from './model-protocol-client'

export const AI_NORMAL_REQUESTED_OUTPUT_TOKENS = 98_304
const AI_COMPAT_REQUESTED_OUTPUT_TOKENS = 32_768
export const AI_SUMMARY_REQUESTED_OUTPUT_TOKENS = 16_384
export const AI_NO_READ_TOOL_RESERVE_TOKENS = 32_768
export const AI_CURRENT_DOCUMENT_TOOL_RESERVE_TOKENS = 65_536
export const AI_WORKSPACE_TOOL_RESERVE_TOKENS = 98_304
export const AI_CONTEXT_SOFT_TRIGGER_PERCENT = 85
export const AI_CONTEXT_POST_COMPACTION_MIN_PERCENT = 45
export const AI_CONTEXT_POST_COMPACTION_MAX_PERCENT = 50

const AI_WIRE_LINEAGE = Symbol('AiWireLineage')

export interface AiWireLineage {
  readonly [AI_WIRE_LINEAGE]: true
}

export interface SafeInputTokenOptions {
  maxInputTokens: number
  contextWindowTokens: number
  requestedOutputTokens: number
  toolReserveTokens: number
}

export interface AiContextUsageBaseline {
  usage: ModelUsage
  wireLineage: AiWireLineage
  estimatedNextRequestTokensAtRequest: number
}

export type AiContextUsageSnapshot =
  | {
    visible: false
    inputTokens: number
    estimated: boolean
  }
  | {
    visible: true
    inputTokens: number
    contextWindowTokens: number
    safeInputTokens: number
    softLimitTokens: number
    hardLimitTokens: number
    percentage: number
    estimated: boolean
  }

export function toolReserveTokens(capabilities: AiConversationCapabilities): number {
  if (capabilities.workspace) return AI_WORKSPACE_TOOL_RESERVE_TOKENS
  if (capabilities.currentDocument) return AI_CURRENT_DOCUMENT_TOOL_RESERVE_TOKENS
  return AI_NO_READ_TOOL_RESERVE_TOKENS
}

/** Leave at least half a known window for input and tool results. Unknown
 * endpoints retain the previous allowance rather than receiving an unverified cap. */
export function normalRequestedOutputTokens(profile: ModelCapabilityProfile | undefined): number {
  if (profile === undefined) return AI_COMPAT_REQUESTED_OUTPUT_TOKENS
  return requestedOutputWithinLimit(
    Math.min(AI_NORMAL_REQUESTED_OUTPUT_TOKENS, Math.floor(profile.contextWindowTokens / 2)),
    profile.contextWindowTokens,
    profile.maxOutputTokens,
  )
}

export function resolveAiConversationProfile(
  connection: Parameters<typeof resolveModelCapabilityProfile>[0],
  options: Omit<Parameters<typeof resolveModelCapabilityProfile>[1], 'requestedOutputTokens'>,
): ModelCapabilityProfile | undefined {
  let profile = resolveModelCapabilityProfile(connection, {
    ...options, requestedOutputTokens: AI_COMPAT_REQUESTED_OUTPUT_TOKENS,
  })
  if (profile === undefined) return undefined
  const knownOutput = connection.capabilityOverride?.maxOutputTokens !== undefined
    || resolveModelCapabilityProfile({ ...connection, capabilityOverride: null }, {
      ...options, requestedOutputTokens: AI_COMPAT_REQUESTED_OUTPUT_TOKENS,
    }) !== undefined
  // A context-only custom profile is not evidence of the provider's output cap.
  // Responses/Anthropic retain their prior allowance until their separate replay
  // accumulators can safely support a larger wire bound (currently 8 MiB).
  if (!knownOutput || connection.protocol !== 'openai' || usesModelResponses(connection)) {
    profile = { ...profile, maxOutputTokens: Math.min(profile.maxOutputTokens, AI_COMPAT_REQUESTED_OUTPUT_TOKENS) }
    connection = { ...connection, capabilityOverride: {
      ...connection.capabilityOverride, contextWindowTokens: profile.contextWindowTokens,
      maxOutputTokens: profile.maxOutputTokens,
    } }
  }
  // Derived maxInputTokens must use the same effective output as the wire request,
  // including overrides that specify only the context window.
  return resolveModelCapabilityProfile(connection, {
    ...options, requestedOutputTokens: normalRequestedOutputTokens(profile),
  })
}

/**
 * Creates the identity of one append-only wire lineage. Preserve this object
 * across appends; create a replacement after compaction, wholesale replacement,
 * or a model switch so provider usage can never cross those boundaries.
 */
export function createAiWireLineage(): AiWireLineage {
  return Object.freeze({ [AI_WIRE_LINEAGE]: true as const })
}

export function safeInputTokens(options: SafeInputTokenOptions): number {
  return Math.max(0, Math.min(
    options.maxInputTokens,
    options.contextWindowTokens
      - options.requestedOutputTokens
      - options.toolReserveTokens,
  ))
}

export function contextInputBudget(options: {
  profile: ModelCapabilityProfile
  capabilities: AiConversationCapabilities
  requestedOutputTokens?: number
  toolReserveTokens?: number
}): { requestedOutputTokens: number; toolReserveTokens: number; safeInputTokens: number } {
  const { profile } = options
  const requestedOutputTokens = requestedOutputWithinLimit(
    options.requestedOutputTokens ?? normalRequestedOutputTokens(profile),
    profile.contextWindowTokens,
    profile.maxOutputTokens,
  )
  const availableWindowTokens = profile.contextWindowTokens - requestedOutputTokens
  // Capability reserves are upper bounds, not minimum model-window requirements.
  // Keep at least half the remaining window for actual input; explicit overrides
  // retain their exact meaning for callers that supply a different reserve.
  const reserve = options.toolReserveTokens ?? Math.min(
    toolReserveTokens(options.capabilities),
    Math.floor(availableWindowTokens / 2),
  )
  return {
    requestedOutputTokens,
    toolReserveTokens: reserve,
    safeInputTokens: safeInputTokens({
      maxInputTokens: profile.maxInputTokens,
      contextWindowTokens: profile.contextWindowTokens,
      requestedOutputTokens,
      toolReserveTokens: reserve,
    }),
  }
}

export function estimateTextTokens(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function estimateWireTokens(messages: readonly ModelChatMessage[]): number {
  return messages.reduce(
    (total, message) => total + 12 + estimateTextTokens(JSON.stringify(message)),
    0,
  )
}

function resolvedInputUsage(options: {
  estimatedNextRequestTokens: number
  wireLineage: AiWireLineage
  usageBaseline: AiContextUsageBaseline | null
}): { inputTokens: number; estimated: boolean } {
  const baseline = options.usageBaseline
  if (baseline === null
    || baseline.usage.estimated
    || baseline.wireLineage !== options.wireLineage
    || !Number.isSafeInteger(baseline.estimatedNextRequestTokensAtRequest)
    || baseline.estimatedNextRequestTokensAtRequest < 0
    || options.estimatedNextRequestTokens
      < baseline.estimatedNextRequestTokensAtRequest) {
    return { inputTokens: options.estimatedNextRequestTokens, estimated: true }
  }
  const estimatedDelta = options.estimatedNextRequestTokens
    - baseline.estimatedNextRequestTokensAtRequest
  return {
    inputTokens: baseline.usage.inputTokens + estimatedDelta,
    estimated: estimatedDelta > 0,
  }
}

export function contextUsageSnapshot(options: {
  profile: ModelCapabilityProfile | undefined
  capabilities: AiConversationCapabilities
  requestedOutputTokens?: number
  toolReserveTokens?: number
  /** Complete input estimate for the next normal provider request. */
  estimatedNextRequestTokens: number
  wireLineage: AiWireLineage
  usageBaseline: AiContextUsageBaseline | null
}): AiContextUsageSnapshot {
  const { inputTokens, estimated } = resolvedInputUsage(options)
  if (options.profile === undefined) return { visible: false, inputTokens, estimated }

  const hardLimitTokens = contextInputBudget({
    profile: options.profile,
    capabilities: options.capabilities,
    requestedOutputTokens: options.requestedOutputTokens,
    toolReserveTokens: options.toolReserveTokens,
  }).safeInputTokens
  const percentage = options.profile.contextWindowTokens === 0
    ? 100
    : Math.min(100, Math.max(0, Math.round(
      inputTokens / options.profile.contextWindowTokens * 100,
    )))
  return {
    visible: true,
    inputTokens,
    contextWindowTokens: options.profile.contextWindowTokens,
    safeInputTokens: hardLimitTokens,
    softLimitTokens: Math.ceil(
      hardLimitTokens * AI_CONTEXT_SOFT_TRIGGER_PERCENT / 100,
    ),
    hardLimitTokens,
    percentage,
    estimated,
  }
}

export function shouldCompactContext(snapshot: AiContextUsageSnapshot): boolean {
  return snapshot.visible
    && snapshot.inputTokens * 100
      >= snapshot.safeInputTokens * AI_CONTEXT_SOFT_TRIGGER_PERCENT
}
