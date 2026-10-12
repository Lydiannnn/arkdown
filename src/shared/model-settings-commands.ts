import {
  isCanonicalModelConnectionId, isFeatureModelConnectionId, MODEL_CONNECTION_LIMIT,
  parseAiWritePolicy, parseReasoningEffort, parseThinkingMode, parseFloatingTranslationPatch,
  type AiConversationSettings, type CodexCliConnectionStatus, type FloatingTranslationSettings,
  type ScreenshotTranslationSettings,
} from './large-model-settings'
import {
  hasObservationKeys, OBSERVED_CONNECTION_FIELDS, OBSERVED_MODEL_FIELDS, parsePublicModelSettingsSnapshot,
  type PublicModelMutationResult, type PublicModelSettingsConflict, type PublicModelSettingsSnapshot,
  type PublicSettingsConflictReason,
} from './settings-observation'

export interface ModelFeaturePatches {
  aiConversation: Partial<AiConversationSettings>
  selectionTranslation: Partial<ScreenshotTranslationSettings>
  screenshotTranslation: Partial<ScreenshotTranslationSettings>
  floatingTranslation: Partial<FloatingTranslationSettings>
}
export type ModelFeatureName = keyof ModelFeaturePatches
export interface ObservedModelCommand<T> { observed: PublicModelSettingsSnapshot; input: T }
export interface ObservedCodexTestResult { status?: CodexCliConnectionStatus; mutation: PublicModelMutationResult }
export interface ObservedModelTestResult { mutation: PublicModelMutationResult; error: string | null }
export type ObservedCodexLoginResult = { status: 'completed'; connection: ObservedCodexTestResult }
  | { status: 'cancelled' | 'failed' | 'not-found' | 'timeout' }

const targetLanguages = ['auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'it', 'ar']
const conflictReasons: readonly PublicSettingsConflictReason[] = [
  'future-revision', 'snapshot-too-old', 'field-changed', 'connection-exists', 'connection-missing',
]
const codexStatuses: readonly CodexCliConnectionStatus[] = [
  'connected', 'not-found', 'launch-failed', 'not-logged-in', 'timeout', 'incompatible-response',
]

/** The transport must receive the observation from the actual UI intent, never manufacture one. */
export function parseModelObservationRequest(value: unknown): PublicModelSettingsSnapshot | undefined {
  return hasObservationKeys(value, ['observed']) ? parsePublicModelSettingsSnapshot(value.observed) : undefined
}

export function parseObservedModelCommand<T>(value: unknown, parseInput: (input: unknown) => T | undefined): ObservedModelCommand<T> | undefined {
  if (!hasObservationKeys(value, ['observed', 'input'])) return undefined
  const observed = parsePublicModelSettingsSnapshot(value.observed), input = parseInput(value.input)
  return observed && input !== undefined ? { observed, input } : undefined
}

export function parseModelFeaturePatch<F extends ModelFeatureName>(feature: F, value: unknown): ModelFeaturePatches[F] | undefined {
  const extra = feature === 'aiConversation' ? 'writePolicy' : feature === 'floatingTranslation' ? 'target' : 'targetLanguage'
  if (!hasObservationKeys(value, [], ['connectionId', 'thinkingMode', 'reasoningEffort', extra]) || Object.keys(value).length === 0) return undefined
  if (feature === 'floatingTranslation') return parseFloatingTranslationPatch(value) as ModelFeaturePatches[F] | undefined
  if (Object.hasOwn(value, 'connectionId') && !(value.connectionId === null || typeof value.connectionId === 'string' && isFeatureModelConnectionId(value.connectionId))) return undefined
  if (Object.hasOwn(value, 'thinkingMode') && parseThinkingMode(value.thinkingMode) === undefined) return undefined
  if (Object.hasOwn(value, 'reasoningEffort') && parseReasoningEffort(value.reasoningEffort) === undefined) return undefined
  if (Object.hasOwn(value, 'writePolicy') && parseAiWritePolicy(value.writePolicy) === undefined) return undefined
  if (Object.hasOwn(value, 'targetLanguage') && !(typeof value.targetLanguage === 'string' && targetLanguages.includes(value.targetLanguage))) return undefined
  return { ...value } as ModelFeaturePatches[F]
}

export function parsePublicModelMutation(value: unknown): PublicModelMutationResult | undefined {
  if (!hasObservationKeys(value, ['status', 'snapshot'], ['reason', 'conflicts'])) return undefined
  const snapshot = parsePublicModelSettingsSnapshot(value.snapshot)
  if (!snapshot) return undefined
  if (value.status === 'committed' || value.status === 'unchanged') {
    return hasObservationKeys(value, ['status', 'snapshot']) ? { status: value.status, snapshot } : undefined
  }
  if (value.status !== 'conflict' || !hasObservationKeys(value, ['status', 'snapshot', 'reason', 'conflicts'])
    || !conflictReasons.includes(value.reason as PublicSettingsConflictReason) || !Array.isArray(value.conflicts)
    || value.conflicts.length > OBSERVED_MODEL_FIELDS.length + MODEL_CONNECTION_LIMIT * (OBSERVED_CONNECTION_FIELDS.length + 3)) return undefined
  const conflicts: PublicModelSettingsConflict[] = []
  for (const item of value.conflicts) {
    if (hasObservationKeys(item, ['kind', 'field']) && item.kind === 'field'
      && OBSERVED_MODEL_FIELDS.includes(item.field as typeof OBSERVED_MODEL_FIELDS[number])) {
      conflicts.push({ kind: 'field', field: item.field as typeof OBSERVED_MODEL_FIELDS[number] })
    } else if (hasObservationKeys(item, ['kind', 'id', 'field']) && item.kind === 'connection'
      && typeof item.id === 'string' && isCanonicalModelConnectionId(item.id)
      && [...OBSERVED_CONNECTION_FIELDS, 'entity', 'credential', 'presence'].includes(item.field as string)) {
      conflicts.push({ kind: 'connection', id: item.id, field: item.field as Extract<PublicModelSettingsConflict, { kind: 'connection' }>['field'] })
    } else return undefined
  }
  return { status: 'conflict', snapshot, reason: value.reason as PublicSettingsConflictReason, conflicts }
}

export function parseObservedModelTestResult(value: unknown): ObservedModelTestResult | undefined {
  if (!hasObservationKeys(value, ['mutation', 'error']) || !(value.error === null || typeof value.error === 'string' && value.error.length <= 4096)) return undefined
  const mutation = parsePublicModelMutation(value.mutation)
  return mutation ? { mutation, error: value.error } : undefined
}

export function parseObservedCodexTestResult(value: unknown): ObservedCodexTestResult | undefined {
  if (!hasObservationKeys(value, ['mutation'], ['status'])) return undefined
  const mutation = parsePublicModelMutation(value.mutation)
  if (!mutation) return undefined
  if (!Object.hasOwn(value, 'status')) return mutation.status === 'conflict' ? { mutation } : undefined
  return codexStatuses.includes(value.status as CodexCliConnectionStatus) ? { status: value.status as CodexCliConnectionStatus, mutation } : undefined
}

export function parseObservedCodexLoginResult(value: unknown): ObservedCodexLoginResult | undefined {
  if (hasObservationKeys(value, ['status', 'connection']) && value.status === 'completed') {
    const connection = parseObservedCodexTestResult(value.connection)
    return connection ? { status: 'completed', connection } : undefined
  }
  if (hasObservationKeys(value, ['status']) && (value.status === 'cancelled' || value.status === 'failed'
    || value.status === 'not-found' || value.status === 'timeout')) return { status: value.status }
  return undefined
}
