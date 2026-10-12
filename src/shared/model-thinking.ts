import type { ModelConnectionSummary, ReasoningEffort, ThinkingMode } from './large-model-settings'
import { resolveModelCapabilityRule, parseModelThinkingCapability, type ModelThinkingCapability } from './model-capability-rules'
export type { ThinkingEncoding, ModelThinkingCapability } from './model-capability-rules'
export type ThinkingConnection = Pick<ModelConnectionSummary, 'provider' | 'protocol' | 'modelId'>
  & Partial<Pick<ModelConnectionSummary, 'baseUrl' | 'capabilityOverride'>>
export interface ModelThinkingPreference {
  thinkingMode: ThinkingMode
  reasoningEffort: ReasoningEffort
}

export function normalizeModelBaseUrl(value: string): string {
  try {
    const url = new URL(value.trim())
    if (url.username || url.password || url.search || url.hash) return ''
    return url.toString().replace(/\/+$/, '')
  } catch { return '' }
}


const UNKNOWN: ModelThinkingCapability = { thinking: 'unknown', efforts: [], defaultThinking: 'default', defaultEffort: 'default', encoding: 'none', disabledEfforts: [] }
export function isNativeAstra(connection: ThinkingConnection): boolean {
  return connection.protocol === 'openai' && connection.modelId === 'gpt-6-astra'
    && normalizeModelBaseUrl(connection.baseUrl ?? '') === 'https://api.openai.com/v1'
}
export function usesModelResponses(connection: ThinkingConnection): boolean {
  return connection.protocol === 'openai' && resolveModelCapabilityRule(connection)?.transport === 'responses'
}
export function resolveModelThinkingCapability(connection: ThinkingConnection): ModelThinkingCapability {
  const manual = connection.capabilityOverride?.thinking
  if (manual) return parseModelThinkingCapability(manual, connection.protocol) ?? UNKNOWN
  const rule = resolveModelCapabilityRule(connection)
  if (rule) return rule.capability
  // Preserve established legacy compatible connections; new native models use exact rules.
  if (connection.provider === 'other' && connection.protocol === 'openai'
    && /^(?:o1|o3|o4|gpt-5)(?:-|$)/i.test(connection.modelId)) return {
      thinking: 'fixed', encoding: 'legacy-openai-effort', efforts: ['low', 'medium', 'high'],
      defaultEffort: 'default', defaultThinking: 'default', disabledEfforts: [],
    }
  return UNKNOWN
}

export function normalizeReasoningPreference(connection: ThinkingConnection, effort: ReasoningEffort): ReasoningEffort {
  const cap = resolveModelThinkingCapability(connection)
  if (cap.thinking === 'unknown') return effort
  if (effort === 'default') return effort
  if (cap.efforts.includes(effort)) return effort
  if (cap.effortAliases?.[effort]) return cap.effortAliases[effort]!
  if (cap.encoding === 'openai-effort' && cap.efforts.includes('xhigh') && !cap.efforts.includes('high') && (effort === 'high' || effort === 'max')) return 'xhigh'
  if (cap.encoding === 'thinking-effort' && cap.efforts.includes('high') && (effort === 'medium' || effort === 'xhigh')) return 'high'
  return cap.defaultEffort
}

export function translationThinkingPreference(connection?: ThinkingConnection): ModelThinkingPreference {
  const cap = connection ? resolveModelThinkingCapability(connection) : UNKNOWN
  return { thinkingMode: cap.thinking === 'fixed' ? 'enabled' : 'disabled', reasoningEffort: cap.efforts[0] ?? (cap.thinking === 'unknown' ? 'low' : 'default') }
}

export function effectiveModelThinking(connection: ThinkingConnection, preference: ModelThinkingPreference): ModelThinkingPreference {
  const cap = resolveModelThinkingCapability(connection)
  if (cap.thinking === 'unknown') return { thinkingMode: 'default', reasoningEffort: 'default' }
  const thinkingMode = preference.thinkingMode === 'default' ? 'default'
    : cap.thinking === 'fixed' ? 'enabled' : preference.thinkingMode
  let reasoningEffort = normalizeReasoningPreference(connection, preference.reasoningEffort)
  if (thinkingMode === 'disabled' || thinkingMode === 'default' && cap.defaultThinking === 'disabled') {
    if (cap.disabledEfforts.length === 0) reasoningEffort = 'default'
    else if (reasoningEffort !== 'default' && !cap.disabledEfforts.includes(reasoningEffort)) reasoningEffort = cap.disabledEfforts[cap.disabledEfforts.length - 1]
  } else if (thinkingMode === 'enabled' && reasoningEffort === 'default') reasoningEffort = cap.defaultEffort
  return { thinkingMode, reasoningEffort }
}

/** Display active legal choices without rewriting the user's saved preference. */
export function modelThinkingControlState(connection: ThinkingConnection, preference: ModelThinkingPreference) {
  const cap = resolveModelThinkingCapability(connection)
  const effective = effectiveModelThinking(connection, preference)
  const enabled = cap.thinking === 'fixed' || (effective.thinkingMode === 'default'
    ? cap.defaultThinking !== 'disabled' : effective.thinkingMode === 'enabled')
  const efforts = enabled ? cap.efforts : cap.disabledEfforts
  const value = !enabled
    ? effectiveModelThinking(connection, { ...preference, thinkingMode: 'disabled' }).reasoningEffort
    : effective.reasoningEffort
  return { toggle: cap.thinking === 'toggle', enabled, efforts, value }
}
