/** Lightweight boundary validation, safe to load in sandboxed preloads. */
export type ReasoningEffort = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export function parseReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === 'string' && REASONING_EFFORT_VALUES.includes(value as ReasoningEffort) ? value as ReasoningEffort : undefined
}
export function codexCliModelConnectionId(modelId: string): string {
  return `codex-cli:${encodeURIComponent(modelId)}`
}
export function isCodexCliConnectionId(value: string): boolean {
  if (value === 'codex-cli') return true
  if (!value.startsWith('codex-cli:')) return false
  try {
    const modelId = decodeURIComponent(value.slice('codex-cli:'.length))
    return modelId.length > 0 && modelId.length <= 512 && modelId === modelId.trim()
      && !/[\x00-\x1f\x7f]/.test(modelId) && codexCliModelConnectionId(modelId) === value
  } catch { return false }
}
export function isCanonicalModelConnectionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}
export function isFeatureModelConnectionId(value: string): boolean {
  return isCodexCliConnectionId(value) || isCanonicalModelConnectionId(value)
}
