import { parseModelThinkingCapability, type ModelThinkingCapability } from './model-capability-rules'
import { normalizeReasoningPreference, translationThinkingPreference } from './model-thinking'
import { SCREEN_TRANSLATION_LANGUAGES } from './screen-translation'
import { codexCliModelConnectionId, isCanonicalModelConnectionId, isFeatureModelConnectionId, parseReasoningEffort, REASONING_EFFORT_VALUES, type ReasoningEffort } from './model-selection-values'
export { codexCliModelConnectionId, isCodexCliConnectionId, isCanonicalModelConnectionId, isFeatureModelConnectionId, parseReasoningEffort, type ReasoningEffort } from './model-selection-values'

export type ModelProviderId =
  | 'kimi' | 'deepseek' | 'qwen' | 'zhipu'
  | 'doubao' | 'minimax' | 'xiaomi-mimo' | 'hy' | 'other'

export type ModelProtocol = 'openai' | 'anthropic'
export type ThinkingMode = 'default' | 'enabled' | 'disabled'
export type AiWritePolicy = 'ask-every-time' | 'document-grant' | 'workspace-grant'
export type TargetLanguage =
  | 'auto' | 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko'
  | 'fr' | 'de' | 'es' | 'pt' | 'ru' | 'it' | 'ar'

export type ModelConnectionStatus =
  | 'untested' | 'connected' | 'authentication-failed'
  | 'model-not-found' | 'invalid-endpoint' | 'timeout'
  | 'rate-limited' | 'quota-exceeded' | 'incompatible-response'
  | 'encryption-unavailable'

export interface ModelCapabilityOverride {
  contextWindowTokens?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  thinking?: ModelThinkingCapability
}

export interface ModelConnectionSummary {
  id: string
  name: string
  provider: ModelProviderId
  accessType: 'standard-api' | 'codex-cli'
  protocol: ModelProtocol
  baseUrl: string
  modelId: string
  apiKeyHint: string
  status: ModelConnectionStatus
  lastTestedAt: string | null
  capabilityOverride: ModelCapabilityOverride | null
}

export interface SelectionTranslationSettings {
  connectionId: string | null
  thinkingMode: ThinkingMode
  reasoningEffort: ReasoningEffort
  targetLanguage: TargetLanguage
  privacyNoticeAccepted: boolean
}

export interface ScreenshotTranslationSettings {
  connectionId: string | null
  thinkingMode: ThinkingMode
  reasoningEffort: ReasoningEffort
  targetLanguage: TargetLanguage
}

export interface AiConversationSettings {
  connectionId: string | null
  thinkingMode: ThinkingMode
  reasoningEffort: ReasoningEffort
  writePolicy: AiWritePolicy
}

export type CodexCliConnectionStatus =
  | 'connected' | 'not-found' | 'launch-failed'
  | 'not-logged-in' | 'timeout' | 'incompatible-response'

export interface CodexCliConnectionSummary {
  cliVersion: string
  status: CodexCliConnectionStatus
  lastTestedAt: string
  /** Sanitized app-server catalog; absent in settings saved before model discovery. */
  models?: CodexCliModelSummary[]
}

export interface CodexCliModelSummary {
  modelId: string
  displayName: string
  supportedReasoningEfforts: Exclude<ReasoningEffort, 'default'>[]
  defaultReasoningEffort: ReasoningEffort
  isDefault: boolean
  /** Retained only while a feature still references a model absent from a refreshed catalog. */
  unavailable?: true
}

export interface LargeModelSettings {
  version: 6
  codexCli: CodexCliConnectionSummary | null
  connections: ModelConnectionSummary[]
  selectionTranslation: SelectionTranslationSettings
  screenshotTranslation: ScreenshotTranslationSettings
  aiConversation: AiConversationSettings
  /** Absent only in settings predating the shared floating-window binding. */
  floatingTranslation?: FloatingTranslationSettings
}

export type FloatingTranslationSettings = Pick<ScreenshotTranslationSettings, 'connectionId' | 'thinkingMode' | 'reasoningEffort'> & {
  /** Missing in bindings saved before target language became shared. */
  target?: string
}
export const DEFAULT_FLOATING_TRANSLATION_SETTINGS: FloatingTranslationSettings = Object.freeze({
  connectionId: null, thinkingMode: 'disabled', reasoningEffort: 'low', target: 'auto',
})

export function parseFloatingTranslationSettings(value: unknown): FloatingTranslationSettings | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['connectionId', 'thinkingMode', 'reasoningEffort', ...(Object.hasOwn(value, 'target') ? ['target'] : [])])
    || !(value.connectionId === null || (typeof value.connectionId === 'string' && isFeatureModelConnectionId(value.connectionId)))
    || parseThinkingMode(value.thinkingMode) === undefined || parseReasoningEffort(value.reasoningEffort) === undefined
    || (Object.hasOwn(value, 'target') && !SCREEN_TRANSLATION_LANGUAGES.some(item => item.value === value.target))) return undefined
  return { connectionId: value.connectionId as string | null, thinkingMode: value.thinkingMode as ThinkingMode, reasoningEffort: value.reasoningEffort as ReasoningEffort,
    ...(Object.hasOwn(value, 'target') ? { target: value.target as string } : {}) }
}

export function parseFloatingTranslationPatch(value: unknown): Partial<FloatingTranslationSettings> | undefined {
  if (!isRecord(value) || Reflect.ownKeys(value).length === 0
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['connectionId', 'thinkingMode', 'reasoningEffort', 'target'].includes(key))
    || !parseFloatingTranslationSettings({ ...DEFAULT_FLOATING_TRANSLATION_SETTINGS, ...value })) return undefined
  return { ...value }
}

export interface CodexCliConnectionTestResult {
  status: CodexCliConnectionStatus
  settings: LargeModelSettings
}

export const DEFAULT_AI_CONVERSATION_SETTINGS: AiConversationSettings = Object.freeze({
  connectionId: null,
  thinkingMode: 'default' as const,
  reasoningEffort: 'default' as const,
  writePolicy: 'ask-every-time' as const,
})

export const DEFAULT_LARGE_MODEL_SETTINGS: LargeModelSettings = Object.freeze({
  version: 6 as const,
  codexCli: null,
  connections: Object.freeze([]) as unknown as ModelConnectionSummary[],
  selectionTranslation: Object.freeze({
    connectionId: null,
    thinkingMode: 'disabled' as const,
    reasoningEffort: 'low' as const,
    targetLanguage: 'auto' as const,
    privacyNoticeAccepted: false,
  }),
  screenshotTranslation: Object.freeze({
    connectionId: null,
    thinkingMode: 'disabled' as const,
    reasoningEffort: 'low' as const,
    targetLanguage: 'auto' as const,
  }),
  aiConversation: DEFAULT_AI_CONVERSATION_SETTINGS,
})

const PROVIDERS = new Set<ModelProviderId>([
  'kimi', 'deepseek', 'qwen', 'zhipu', 'doubao', 'minimax', 'xiaomi-mimo', 'hy', 'other',
])
const PROTOCOLS = new Set<ModelProtocol>(['openai', 'anthropic'])
const REASONING_EFFORTS = new Set<ReasoningEffort>(REASONING_EFFORT_VALUES)
const AI_WRITE_POLICIES = new Set<AiWritePolicy>([
  'ask-every-time', 'document-grant', 'workspace-grant',
])
const TARGET_LANGUAGES = new Set<TargetLanguage>([
  'auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'it', 'ar',
])
const CONNECTION_STATUSES = new Set<ModelConnectionStatus>([
  'untested', 'connected', 'authentication-failed', 'model-not-found', 'invalid-endpoint',
  'timeout', 'rate-limited', 'quota-exceeded', 'incompatible-response', 'encryption-unavailable',
])
const CODEX_CLI_CONNECTION_STATUSES = new Set<CodexCliConnectionStatus>([
  'connected', 'not-found', 'launch-failed', 'not-logged-in', 'timeout', 'incompatible-response',
])

export const MODEL_CONNECTION_LIMIT = 1000
export const MODEL_CONNECTION_NAME_MAX_LENGTH = 120
export const MODEL_BASE_URL_MAX_LENGTH = 2048
export const MODEL_ID_MAX_LENGTH = 512
export const CODEX_CLI_VERSION_MAX_LENGTH = 512

export const CODEX_CLI_CONNECTION_ID = 'codex-cli'
export const CODEX_CLI_BASE_URL = 'codex-cli://local'

/** Virtual feature choice only. Never insert it into persisted API connections. */
export function featureModelConnections(settings: Pick<LargeModelSettings, 'connections' | 'codexCli'>): ModelConnectionSummary[] {
  if (!settings.codexCli) return settings.connections
  const models = settings.codexCli.models ?? []
  const makeChoice = (model: CodexCliModelSummary | undefined, legacy = false): ModelConnectionSummary => ({
    id: legacy ? CODEX_CLI_CONNECTION_ID : codexCliModelConnectionId(model!.modelId),
    name: legacy ? 'Codex CLI' : `Codex CLI · ${model!.displayName}${model!.unavailable ? '（暂不可用）' : ''}`, accessType: 'codex-cli', provider: 'other',
    protocol: 'openai', baseUrl: CODEX_CLI_BASE_URL, modelId: model?.modelId ?? 'codex-default', apiKeyHint: '',
    status: model?.unavailable ? 'model-not-found' : settings.codexCli!.status === 'connected' ? 'connected' : 'authentication-failed',
    lastTestedAt: settings.codexCli!.lastTestedAt,
    capabilityOverride: model && model.supportedReasoningEfforts.length ? { thinking: {
      thinking: 'fixed', encoding: 'openai-effort', efforts: [...model.supportedReasoningEfforts],
      defaultThinking: 'enabled', defaultEffort: model.defaultReasoningEffort, disabledEfforts: [],
    } } : null,
  })
  return [...settings.connections, ...models.map(model => makeChoice(model)),
    makeChoice(models.find(model => model.isDefault && !model.unavailable) ?? models.find(model => !model.unavailable), true)]
}

export function isCodexCliConnection(connection: Pick<ModelConnectionSummary, 'baseUrl'>): boolean {
  return connection.baseUrl === CODEX_CLI_BASE_URL
}

function hasExactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isExactArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes('length')) return false
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) return false
  }
  return true
}

export function isSafeModelBaseUrl(baseUrl: string): boolean {
  try {
    const endpoint = new URL(baseUrl)
    if (endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '') {
      return false
    }
    if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') return false

    const isLoopback = endpoint.hostname === 'localhost'
      || endpoint.hostname === '127.0.0.1'
      || endpoint.hostname === '[::1]'
      || endpoint.hostname === '::1'
    return endpoint.protocol === 'https:' || isLoopback
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function parseThinkingMode(value: unknown): ThinkingMode | undefined {
  return value === 'default' || value === 'enabled' || value === 'disabled' ? value : undefined
}

export function parseAiWritePolicy(value: unknown): AiWritePolicy | undefined {
  return typeof value === 'string' && AI_WRITE_POLICIES.has(value as AiWritePolicy)
    ? value as AiWritePolicy
    : undefined
}

export function parseModelCapabilityOverride(value: unknown): ModelCapabilityOverride | undefined {
  if (!isRecord(value)) return undefined
  const allowed = ['contextWindowTokens', 'maxInputTokens', 'maxOutputTokens', 'thinking']
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) return undefined
  const thinking = Object.hasOwn(value, 'thinking') ? parseModelThinkingCapability(value.thinking) : undefined
  if (Object.hasOwn(value, 'thinking') && !thinking) return undefined
  const hasContext = Object.hasOwn(value, 'contextWindowTokens')
  const context = value.contextWindowTokens
  const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
  if (hasContext ? !positive(context) : !thinking) return undefined
  for (const key of ['maxInputTokens', 'maxOutputTokens']) {
    if (Object.hasOwn(value, key) && (!positive(value[key]) || !positive(context) || value[key] > context)) return undefined
  }
  return {
    ...(hasContext ? { contextWindowTokens: context as number } : {}),
    ...(Object.hasOwn(value, 'maxInputTokens') ? { maxInputTokens: value.maxInputTokens as number } : {}),
    ...(Object.hasOwn(value, 'maxOutputTokens') ? { maxOutputTokens: value.maxOutputTokens as number } : {}),
    ...(thinking ? { thinking } : {}),
  }
}

function isCanonicalTrimmedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && value === value.trim()
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

export function parseModelConnectionSummary(value: unknown): ModelConnectionSummary | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'id', 'name', 'provider', 'accessType', 'protocol', 'baseUrl', 'modelId', 'apiKeyHint',
    'status', 'lastTestedAt', 'capabilityOverride',
  ])) return undefined

  if (
    typeof value.id !== 'string'
    || !isCanonicalModelConnectionId(value.id)
    || !isCanonicalTrimmedString(value.name, MODEL_CONNECTION_NAME_MAX_LENGTH)
    || typeof value.provider !== 'string' || !PROVIDERS.has(value.provider as ModelProviderId)
    || value.accessType !== 'standard-api'
    || typeof value.protocol !== 'string' || !PROTOCOLS.has(value.protocol as ModelProtocol)
    || !isCanonicalTrimmedString(value.baseUrl, MODEL_BASE_URL_MAX_LENGTH)
    || !isSafeModelBaseUrl(value.baseUrl)
    || !isCanonicalTrimmedString(value.modelId, MODEL_ID_MAX_LENGTH)
    || typeof value.apiKeyHint !== 'string' || !/^••••[\x20-\x7e]{0,4}$/.test(value.apiKeyHint)
    || typeof value.status !== 'string'
    || !CONNECTION_STATUSES.has(value.status as ModelConnectionStatus)
    || !(value.lastTestedAt === null || isCanonicalTimestamp(value.lastTestedAt))
    || !(value.capabilityOverride === null
      || parseModelCapabilityOverride(value.capabilityOverride) !== undefined)
  ) return undefined

  return {
    id: value.id,
    name: value.name,
    provider: value.provider as ModelProviderId,
    accessType: 'standard-api',
    protocol: value.protocol as ModelProtocol,
    baseUrl: value.baseUrl,
    modelId: value.modelId,
    apiKeyHint: value.apiKeyHint,
    status: value.status as ModelConnectionStatus,
    lastTestedAt: value.lastTestedAt as string | null,
    capabilityOverride: value.capabilityOverride === null
      ? null
      : parseModelCapabilityOverride(value.capabilityOverride)!,
  }
}

function parseLegacyModelConnectionSummary(value: unknown): ModelConnectionSummary | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'id', 'name', 'provider', 'accessType', 'protocol', 'baseUrl', 'modelId', 'apiKeyHint',
    'status', 'lastTestedAt',
  ])) return undefined
  return parseModelConnectionSummary({ ...value, capabilityOverride: null })
}

type LegacyReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'
type LegacySelectionTranslationSettings = Omit<SelectionTranslationSettings, 'thinkingMode' | 'reasoningEffort'> & { reasoningEffort: LegacyReasoningEffort }
type LegacyScreenshotTranslationSettings = Omit<ScreenshotTranslationSettings, 'thinkingMode' | 'reasoningEffort'> & { reasoningEffort: LegacyReasoningEffort }
type LegacyAiConversationSettings = Omit<AiConversationSettings, 'thinkingMode' | 'reasoningEffort'> & { reasoningEffort: LegacyReasoningEffort }
interface LegacyLargeModelSettings extends Omit<LargeModelSettings, 'version' | 'selectionTranslation' | 'screenshotTranslation' | 'aiConversation'> {
  version: 5
  selectionTranslation: LegacySelectionTranslationSettings
  screenshotTranslation: LegacyScreenshotTranslationSettings
  aiConversation: LegacyAiConversationSettings
}
const LEGACY_DEFAULT_AI_CONVERSATION_SETTINGS: LegacyAiConversationSettings = { connectionId: null, reasoningEffort: 'off', writePolicy: 'ask-every-time' }

function hasKnownReasoningEffort(value: unknown): value is LegacyReasoningEffort {
  return typeof value === 'string' && ['off', 'low', 'medium', 'high', 'max'].includes(value)
}

export function parseCodexCliConnectionSummary(value: unknown): CodexCliConnectionSummary | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'cliVersion', 'status', 'lastTestedAt', ...(Object.hasOwn(value, 'models') ? ['models'] : []),
  ])) return undefined

  if (
    !isCanonicalTrimmedString(value.cliVersion, CODEX_CLI_VERSION_MAX_LENGTH)
    || typeof value.status !== 'string'
    || !CODEX_CLI_CONNECTION_STATUSES.has(value.status as CodexCliConnectionStatus)
    || !isCanonicalTimestamp(value.lastTestedAt)
  ) return undefined

  let models: CodexCliModelSummary[] | undefined
  if (Object.hasOwn(value, 'models')) {
    if (!isExactArray(value.models) || value.models.length > MODEL_CONNECTION_LIMIT + 4) return undefined
    models = []
    for (const candidate of value.models) {
      const model = parseCodexCliModelSummary(candidate)
      if (!model || models.some(item => item.modelId === model.modelId)) return undefined
      models.push(model)
    }
  }
  return {
    cliVersion: value.cliVersion,
    status: value.status as CodexCliConnectionStatus,
    lastTestedAt: value.lastTestedAt,
    ...(models ? { models } : {}),
  }
}

export function parseCodexCliModelSummary(value: unknown): CodexCliModelSummary | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['modelId', 'displayName', 'supportedReasoningEfforts', 'defaultReasoningEffort', 'isDefault', ...(Object.hasOwn(value, 'unavailable') ? ['unavailable'] : [])])) return undefined
  if (!isCanonicalTrimmedString(value.modelId, MODEL_ID_MAX_LENGTH) || /[\x00-\x1f\x7f]/.test(value.modelId)
    || !isCanonicalTrimmedString(value.displayName, MODEL_CONNECTION_NAME_MAX_LENGTH)
    || !isExactArray(value.supportedReasoningEfforts) || value.supportedReasoningEfforts.length > REASONING_EFFORTS.size
    || new Set(value.supportedReasoningEfforts).size !== value.supportedReasoningEfforts.length
    || value.supportedReasoningEfforts.some(effort => effort === 'default' || !parseReasoningEffort(effort))
    || !parseReasoningEffort(value.defaultReasoningEffort) || typeof value.isDefault !== 'boolean'
    || Object.hasOwn(value, 'unavailable') && value.unavailable !== true
    || value.defaultReasoningEffort !== 'default' && !value.supportedReasoningEfforts.includes(value.defaultReasoningEffort)) return undefined
  return structuredClone(value) as unknown as CodexCliModelSummary
}

function isLegacySelectionTranslationSettings(value: unknown): value is LegacySelectionTranslationSettings {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'connectionId', 'reasoningEffort', 'targetLanguage', 'privacyNoticeAccepted',
  ])) return false

  return (
    value.connectionId === null
      || (
        typeof value.connectionId === 'string'
        && isCanonicalModelConnectionId(value.connectionId)
      )
  )
    && hasKnownReasoningEffort(value.reasoningEffort)
    && typeof value.targetLanguage === 'string'
    && TARGET_LANGUAGES.has(value.targetLanguage as TargetLanguage)
    && typeof value.privacyNoticeAccepted === 'boolean'
}

function isLegacyScreenshotTranslationSettings(value: unknown): value is LegacyScreenshotTranslationSettings {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'connectionId', 'reasoningEffort', 'targetLanguage',
  ])) return false

  return (
    value.connectionId === null
      || (
        typeof value.connectionId === 'string'
        && isCanonicalModelConnectionId(value.connectionId)
      )
  )
    && hasKnownReasoningEffort(value.reasoningEffort)
    && typeof value.targetLanguage === 'string'
    && TARGET_LANGUAGES.has(value.targetLanguage as TargetLanguage)
}

function isLegacyAiConversationSettings(value: unknown): value is LegacyAiConversationSettings {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'connectionId', 'reasoningEffort', 'writePolicy',
  ])) return false

  return (
    value.connectionId === null
      || (
        typeof value.connectionId === 'string'
        && isCanonicalModelConnectionId(value.connectionId)
      )
  )
    && hasKnownReasoningEffort(value.reasoningEffort)
    && parseAiWritePolicy(value.writePolicy) !== undefined
}

function isLegacyLegacyAiConversationSettings(value: unknown): value is Omit<
  LegacyAiConversationSettings, 'writePolicy'
> {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['connectionId', 'reasoningEffort'])) return false
  return (
    value.connectionId === null
      || (typeof value.connectionId === 'string' && isCanonicalModelConnectionId(value.connectionId))
  ) && hasKnownReasoningEffort(value.reasoningEffort)
}

function parseConnections(value: unknown): ModelConnectionSummary[] | undefined {
  if (!isExactArray(value) || value.length > MODEL_CONNECTION_LIMIT) return undefined
  const connections: ModelConnectionSummary[] = []
  const connectionIds = new Set<string>()
  for (const candidate of value) {
    const connection = parseModelConnectionSummary(candidate)
    if (connection === undefined || connectionIds.has(connection.id)) return undefined
    connectionIds.add(connection.id)
    connections.push(connection)
  }
  return connections
}

function parseLegacyConnections(value: unknown): ModelConnectionSummary[] | undefined {
  if (!isExactArray(value) || value.length > MODEL_CONNECTION_LIMIT) return undefined
  const connections: ModelConnectionSummary[] = []
  const connectionIds = new Set<string>()
  for (const candidate of value) {
    const connection = parseLegacyModelConnectionSummary(candidate)
    if (connection === undefined || connectionIds.has(connection.id)) return undefined
    connectionIds.add(connection.id)
    connections.push(connection)
  }
  return connections
}

function referencesKnownConnection(
  settings: { connectionId: string | null },
  connections: readonly ModelConnectionSummary[],
): boolean {
  return settings.connectionId === null || connections.some(
    (connection) => connection.id === settings.connectionId,
  )
}

function parseVersionFourLegacyLargeModelSettings(value: unknown): Omit<LegacyLargeModelSettings, 'version' | 'codexCli'> | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'version', 'connections', 'selectionTranslation', 'screenshotTranslation', 'aiConversation',
  ])) return undefined
  if (value.version !== 4) return undefined
  const connections = parseConnections(value.connections)
  if (
    connections === undefined
    || !isLegacySelectionTranslationSettings(value.selectionTranslation)
    || !isLegacyScreenshotTranslationSettings(value.screenshotTranslation)
    || !isLegacyAiConversationSettings(value.aiConversation)
    || !referencesKnownConnection(value.selectionTranslation, connections)
    || !referencesKnownConnection(value.screenshotTranslation, connections)
    || !referencesKnownConnection(value.aiConversation, connections)
  ) return undefined

  return {
    connections,
    selectionTranslation: { ...value.selectionTranslation },
    screenshotTranslation: { ...value.screenshotTranslation },
    aiConversation: { ...value.aiConversation },
  }
}

function parseVersionThreeLegacyLargeModelSettings(value: unknown): {
  connections: ModelConnectionSummary[]
  selectionTranslation: LegacySelectionTranslationSettings
  screenshotTranslation: LegacyScreenshotTranslationSettings
  aiConversation: Omit<LegacyAiConversationSettings, 'writePolicy'>
} | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'version', 'connections', 'selectionTranslation', 'screenshotTranslation', 'aiConversation',
  ]) || value.version !== 3) return undefined
  const connections = parseLegacyConnections(value.connections)
  if (
    connections === undefined
    || !isLegacySelectionTranslationSettings(value.selectionTranslation)
    || !isLegacyScreenshotTranslationSettings(value.screenshotTranslation)
    || !isLegacyLegacyAiConversationSettings(value.aiConversation)
    || !referencesKnownConnection(value.selectionTranslation, connections)
    || !referencesKnownConnection(value.screenshotTranslation, connections)
    || !referencesKnownConnection(value.aiConversation, connections)
  ) return undefined
  return {
    connections,
    selectionTranslation: { ...value.selectionTranslation },
    screenshotTranslation: { ...value.screenshotTranslation },
    aiConversation: { ...value.aiConversation },
  }
}

function parseVersionTwoLegacyLargeModelSettings(value: unknown): {
  connections: ModelConnectionSummary[]
  selectionTranslation: LegacySelectionTranslationSettings
  screenshotTranslation: LegacyScreenshotTranslationSettings
} | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'version', 'connections', 'selectionTranslation', 'screenshotTranslation',
  ])) return undefined
  if (value.version !== 2) return undefined
  const connections = parseLegacyConnections(value.connections)
  if (
    connections === undefined
    || !isLegacySelectionTranslationSettings(value.selectionTranslation)
    || !isLegacyScreenshotTranslationSettings(value.screenshotTranslation)
    || !referencesKnownConnection(value.selectionTranslation, connections)
    || !referencesKnownConnection(value.screenshotTranslation, connections)
  ) return undefined

  return {
    connections,
    selectionTranslation: { ...value.selectionTranslation },
    screenshotTranslation: { ...value.screenshotTranslation },
  }
}

function parseVersionOneLegacyLargeModelSettings(value: unknown): {
  connections: ModelConnectionSummary[]
  selectionTranslation: LegacySelectionTranslationSettings
} | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'version', 'connections', 'selectionTranslation',
  ]) || value.version !== 1) return undefined
  const connections = parseLegacyConnections(value.connections)
  if (connections === undefined
    || !isLegacySelectionTranslationSettings(value.selectionTranslation)
    || !referencesKnownConnection(value.selectionTranslation, connections)) return undefined
  return { connections, selectionTranslation: { ...value.selectionTranslation } }
}

function parseVersionFiveLargeModelSettings(value: unknown): LegacyLargeModelSettings | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'version', 'codexCli', 'connections', 'selectionTranslation', 'screenshotTranslation', 'aiConversation',
  ]) || value.version !== 5) return undefined
  const codexCli = value.codexCli === null ? null : parseCodexCliConnectionSummary(value.codexCli)
  if (codexCli === undefined) return undefined
  const { codexCli: _codexCli, ...aiSettings } = value
  const parsed = parseVersionFourLegacyLargeModelSettings({ ...aiSettings, version: 4 })
  if (parsed === undefined) return undefined
  return { version: 5, codexCli, ...parsed }
}

export function parseCodexCliConnectionTestResult(
  value: unknown,
): CodexCliConnectionTestResult | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['status', 'settings'])) return undefined
  if (
    typeof value.status !== 'string'
    || !CODEX_CLI_CONNECTION_STATUSES.has(value.status as CodexCliConnectionStatus)
  ) return undefined
  const status = value.status as CodexCliConnectionStatus
  const settings = parseLargeModelSettings(value.settings)
  if (settings === undefined) return undefined
  if (status === 'connected') {
    if (settings.codexCli?.status !== 'connected') return undefined
  } else if (settings.codexCli !== null && settings.codexCli.status !== status) {
    return undefined
  }
  return { status, settings: copyLargeModelSettings(settings) }
}

function parseCliVersionThreeLegacyLargeModelSettings(value: unknown): LegacyLargeModelSettings | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'version', 'codexCli', 'connections', 'selectionTranslation', 'screenshotTranslation',
  ]) || value.version !== 3) return undefined
  const codexCli = value.codexCli === null ? null : parseCodexCliConnectionSummary(value.codexCli)
  const connections = parseLegacyConnections(value.connections)
  if (codexCli === undefined || connections === undefined
    || !isLegacySelectionTranslationSettings(value.selectionTranslation)
    || !isLegacyScreenshotTranslationSettings(value.screenshotTranslation)
    || !referencesKnownConnection(value.selectionTranslation, connections)
    || !referencesKnownConnection(value.screenshotTranslation, connections)) return undefined
  return {
    version: 5,
    codexCli,
    connections,
    selectionTranslation: { ...value.selectionTranslation },
    screenshotTranslation: { ...value.screenshotTranslation },
    aiConversation: { ...LEGACY_DEFAULT_AI_CONVERSATION_SETTINGS },
  }
}

function migrateLegacyLargeModelSettings(value: unknown): LegacyLargeModelSettings | undefined {
  const versionFive = parseVersionFiveLargeModelSettings(value)
  if (versionFive !== undefined) return versionFive
  const versionFour = parseVersionFourLegacyLargeModelSettings(value)
  if (versionFour !== undefined) return { version: 5, codexCli: null, ...versionFour }
  const cliVersionThree = parseCliVersionThreeLegacyLargeModelSettings(value)
  if (cliVersionThree !== undefined) return cliVersionThree
  const versionThree = parseVersionThreeLegacyLargeModelSettings(value)
  if (versionThree !== undefined) {
    return {
      version: 5,
      codexCli: null,
      connections: versionThree.connections,
      selectionTranslation: versionThree.selectionTranslation,
      screenshotTranslation: versionThree.screenshotTranslation,
      aiConversation: {
        ...versionThree.aiConversation,
        writePolicy: 'ask-every-time',
      },
    }
  }

  const versionTwo = parseVersionTwoLegacyLargeModelSettings(value)
  if (versionTwo !== undefined) {
    return {
      version: 5,
      codexCli: null,
      connections: versionTwo.connections,
      selectionTranslation: versionTwo.selectionTranslation,
      screenshotTranslation: versionTwo.screenshotTranslation,
      aiConversation: { ...LEGACY_DEFAULT_AI_CONVERSATION_SETTINGS },
    }
  }

  const versionOne = parseVersionOneLegacyLargeModelSettings(value)
  if (versionOne === undefined) return undefined
  return {
    version: 5,
    codexCli: null,
    connections: versionOne.connections,
    selectionTranslation: versionOne.selectionTranslation,
    screenshotTranslation: {
      connectionId: versionOne.selectionTranslation.connectionId,
      reasoningEffort: versionOne.selectionTranslation.reasoningEffort,
      targetLanguage: versionOne.selectionTranslation.targetLanguage,
    },
    aiConversation: { ...LEGACY_DEFAULT_AI_CONVERSATION_SETTINGS },
  }
}

export function parseLargeModelSettings(value: unknown): LargeModelSettings | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'version', 'codexCli', 'connections', 'selectionTranslation', 'screenshotTranslation', 'aiConversation',
    ...(Object.hasOwn(value, 'floatingTranslation') ? ['floatingTranslation'] : []),
  ]) || value.version !== 6) return undefined
  const codexCli = value.codexCli === null ? null : parseCodexCliConnectionSummary(value.codexCli)
  const connections = parseConnections(value.connections)
  if (codexCli === undefined || connections === undefined) return undefined
  if (Object.hasOwn(value, 'floatingTranslation')) {
    const binding = value.floatingTranslation
    if (!parseFloatingTranslationSettings(binding)
      || !referencesKnownConnection(binding as FloatingTranslationSettings, featureModelConnections({ connections, codexCli }))) return undefined
  }
  for (const [key, extra] of [
    ['selectionTranslation', ['targetLanguage', 'privacyNoticeAccepted']],
    ['screenshotTranslation', ['targetLanguage']],
    ['aiConversation', ['writePolicy']],
  ] as const) {
    const feature = value[key]
    if (!isRecord(feature) || !hasExactOwnKeys(feature, ['connectionId', 'thinkingMode', 'reasoningEffort', ...extra])
      || !(feature.connectionId === null || (typeof feature.connectionId === 'string' && isFeatureModelConnectionId(feature.connectionId)))
      || !referencesKnownConnection(feature as { connectionId: string | null }, featureModelConnections({ connections, codexCli }))
      || parseThinkingMode(feature.thinkingMode) === undefined || parseReasoningEffort(feature.reasoningEffort) === undefined) return undefined
    if (key === 'aiConversation') {
      if (parseAiWritePolicy(feature.writePolicy) === undefined) return undefined
    } else if (typeof feature.targetLanguage !== 'string' || !TARGET_LANGUAGES.has(feature.targetLanguage as TargetLanguage)
      || (key === 'selectionTranslation' && typeof feature.privacyNoticeAccepted !== 'boolean')) return undefined
  }
  return copyLargeModelSettings(value as unknown as LargeModelSettings)
}

export function migrateLargeModelSettings(value: unknown): LargeModelSettings | undefined {
  const legacy = migrateLegacyLargeModelSettings(value)
  if (legacy === undefined) return undefined
  function preference(feature: { connectionId: string | null; reasoningEffort: LegacyReasoningEffort }, translation: boolean) {
    const connection = legacy!.connections.find((item) => item.id === feature.connectionId)
    if (feature.reasoningEffort === 'off') return translation ? translationThinkingPreference(connection)
      : { thinkingMode: 'default' as const, reasoningEffort: 'default' as const }
    return { thinkingMode: 'enabled' as const, reasoningEffort: connection
      ? normalizeReasoningPreference(connection, feature.reasoningEffort) : feature.reasoningEffort }
  }
  return {
    ...legacy, version: 6,
    selectionTranslation: { ...legacy.selectionTranslation, ...preference(legacy.selectionTranslation, true) },
    screenshotTranslation: { ...legacy.screenshotTranslation, ...preference(legacy.screenshotTranslation, true) },
    aiConversation: { ...legacy.aiConversation, ...preference(legacy.aiConversation, false) },
  }
}

function copyLargeModelSettings(settings: LargeModelSettings): LargeModelSettings {
  return {
    ...(settings.floatingTranslation ? { floatingTranslation: { ...settings.floatingTranslation } } : {}),
    version: 6,
    codexCli: settings.codexCli ? structuredClone(settings.codexCli) : null,
    connections: settings.connections.map((connection) => ({
      ...connection,
      capabilityOverride: connection.capabilityOverride === null
        ? null
        : structuredClone(connection.capabilityOverride),
    })),
    selectionTranslation: { ...settings.selectionTranslation },
    screenshotTranslation: { ...settings.screenshotTranslation },
    aiConversation: { ...settings.aiConversation },
  }
}

export function normalizeLargeModelSettings(value: unknown): LargeModelSettings {
  const current = parseLargeModelSettings(value)
  if (current !== undefined) return current
  return migrateLargeModelSettings(value) ?? copyLargeModelSettings(DEFAULT_LARGE_MODEL_SETTINGS)
}
