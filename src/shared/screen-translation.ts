import type { LargeModelSettings, ReasoningEffort, ThinkingMode } from './large-model-settings'
import { isFeatureModelConnectionId, parseReasoningEffort } from './model-selection-values'
import type { ModelCapabilityRulesState } from './model-capability-rules-state'
import type { ScreenTranslationComponentState } from './screen-translation-component'
import type { PublicModelSettingsSnapshot } from './settings-observation'

export const SCREEN_TRANSLATION_CHANNEL = 'screen-translation:request'
export const SCREEN_TRANSLATION_STATE = 'screen-translation:state'
export const SCREEN_TRANSLATION_SHORTCUTS = { once: 'tools.screen-translation-once', toggle: 'tools.screen-translation-toggle', clear: 'tools.screen-translation-clear' } as const
export const SCREEN_TRANSLATION_LANGUAGES = [
  ['auto', '自动'],
  ['zh', '简体中文'], ['cht', '繁体中文'], ['en', '英语'], ['jp', '日语'], ['kor', '韩语'],
  ['fra', '法语'], ['de', '德语'], ['spa', '西班牙语'], ['ru', '俄语'], ['ara', '阿拉伯语'],
  ['pt', '葡萄牙语'], ['it', '意大利语'], ['th', '泰语'], ['vie', '越南语'],
].map(([value, label]) => ({ value: value!, label: label! }))
export interface ScreenTranslationBounds { x: number; y: number; width: number; height: number }
export interface ScreenTranslationBlock { box: [number, number, number, number]; text: string; background: string; foreground: string }
export interface ScreenTranslationPreferences {
  backend: 'baidu' | 'model'
  target: string
  triggerMode: 'automatic' | 'hotkey'
  connectionId: string | null
  thinkingMode: ThinkingMode
  reasoningEffort: ReasoningEffort
  bounds?: ScreenTranslationBounds
}
export const DEFAULT_SCREEN_TRANSLATION: ScreenTranslationPreferences = {
  backend: 'model', target: 'auto', triggerMode: 'hotkey', connectionId: null,
  thinkingMode: 'disabled', reasoningEffort: 'low',
}
export interface ScreenTranslationStatus {
  automatic: boolean; triggerMode: 'automatic' | 'hotkey'; busy: boolean; showOriginal: boolean
  bounds?: ScreenTranslationBounds; result: { blocks: ScreenTranslationBlock[] }; error: string | null; status: string
}
export interface ScreenTranslationSnapshot {
  component?: ScreenTranslationComponentState
  modelRules?: ModelCapabilityRulesState
  preferences: ScreenTranslationPreferences
  models: LargeModelSettings
  /** Present in the production observed-settings path; legacy synthetic fixtures omit it. */
  modelObservation?: PublicModelSettingsSnapshot
  configuredBaidu: boolean
  status: ScreenTranslationStatus
  theme: { mode: 'light' | 'dark'; accent: string }
  shortcuts: { once: string | null; toggle: string | null; clear: string | null }
  engineReady: boolean
}
export type ScreenTranslationCommand = 'once' | 'start' | 'pause' | 'clear' | 'show-original' | 'show-translation' | 'copy' | 'close' | 'open-models' | 'install-engine' | 'cancel-install'
export interface ScreenTranslationApi {
  getState(options?: { reloadSettings: true }): Promise<ScreenTranslationSnapshot>
  updateSettings(patch: Partial<ScreenTranslationPreferences>, observed?: PublicModelSettingsSnapshot): Promise<ScreenTranslationSnapshot | { status: 'conflict' }>
  command(action: ScreenTranslationCommand): Promise<ScreenTranslationSnapshot | void>
  saveBaiduCredentials(input: { apiKey: string; secretKey: string }): Promise<ScreenTranslationSnapshot>
  onState(listener: (state: ScreenTranslationSnapshot) => void): () => void
}
export function screenTranslationRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function parseScreenTranslationBounds(value: unknown): ScreenTranslationBounds | undefined {
  if (!screenTranslationRecord(value)) return undefined
  const { x, y, width, height } = value
  if (![x, y, width, height].every(n => typeof n === 'number' && Number.isSafeInteger(n))
    || Math.abs(x as number) > 100_000 || Math.abs(y as number) > 100_000
    || (width as number) < 80 || (height as number) < 40
    || (width as number) > 16_000 || (height as number) > 16_000
    || (width as number) * (height as number) > 20_000_000) return undefined
  return { x, y, width, height } as ScreenTranslationBounds
}
export function parseScreenTranslationPatch(value: unknown): Partial<ScreenTranslationPreferences> | undefined {
  if (!screenTranslationRecord(value)) return undefined
  const keys = ['backend', 'target', 'triggerMode', 'connectionId', 'thinkingMode', 'reasoningEffort', 'bounds']
  if (Object.keys(value).some(key => !keys.includes(key))) return undefined
  if ('backend' in value && !['baidu', 'model'].includes(value.backend as string)) return undefined
  if ('target' in value && !SCREEN_TRANSLATION_LANGUAGES.some(item => item.value === value.target)) return undefined
  if ('triggerMode' in value && !['automatic', 'hotkey'].includes(value.triggerMode as string)) return undefined
  if ('connectionId' in value && value.connectionId !== null && (typeof value.connectionId !== 'string' || !isFeatureModelConnectionId(value.connectionId))) return undefined
  if ('thinkingMode' in value && !['default', 'enabled', 'disabled'].includes(value.thinkingMode as string)) return undefined
  if ('reasoningEffort' in value && parseReasoningEffort(value.reasoningEffort) === undefined) return undefined
  if ('bounds' in value && !parseScreenTranslationBounds(value.bounds)) return undefined
  return { ...value, ...('bounds' in value ? { bounds: parseScreenTranslationBounds(value.bounds)! } : {}) } as Partial<ScreenTranslationPreferences>
}
export function parseScreenTranslationBlocks(value: unknown): ScreenTranslationBlock[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined
  let textLength = 0
  const blocks: ScreenTranslationBlock[] = []
  for (const block of value) {
    if (!screenTranslationRecord(block) || !Array.isArray(block.box) || block.box.length !== 4
      || !block.box.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1000)
      || block.box[2] <= block.box[0] || block.box[3] <= block.box[1]
      || typeof block.text !== 'string' || block.text.length > 32_000
      || typeof block.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(block.background)
      || typeof block.foreground !== 'string' || !/^#[0-9a-f]{6}$/i.test(block.foreground)) return undefined
    textLength += block.text.length
    if (textLength > 200_000) return undefined
    blocks.push({ box: [...block.box] as ScreenTranslationBlock['box'], text: block.text, background: block.background, foreground: block.foreground })
  }
  return blocks
}
