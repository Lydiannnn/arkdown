import bundled from './model-capability-rules.json'
import { parseModelCapabilityRules, type RuleFile } from './model-capability-rules'

export const MODEL_CAPABILITY_RULES_CHANGED = 'models:capability-rules-changed'
export const BUNDLED_MODEL_RULES_REVISION = bundled.revision
export interface ModelCapabilityRulesState {
  rules: RuleFile | null
  bundledRevision: string
  warning: string | null
}
export function parseModelCapabilityRulesState(value: unknown): ModelCapabilityRulesState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (Object.keys(v).length !== 3 || typeof v.bundledRevision !== 'string' || v.bundledRevision.length > 100
    || !(v.warning === null || typeof v.warning === 'string' && v.warning.length <= 200)) return undefined
  const rules = v.rules === null ? null : parseModelCapabilityRules(v.rules)
  if (rules === undefined) return undefined
  return { rules, bundledRevision: v.bundledRevision, warning: v.warning as string | null }
}
