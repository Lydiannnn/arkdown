import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../../src/shared/large-model-settings'
import { DEFAULT_SCREEN_TRANSLATION, type ScreenTranslationApi, type ScreenTranslationSnapshot } from '../../../src/shared/screen-translation'

const modelId = '11111111-1111-4111-8111-111111111111'
const params = new URLSearchParams(location.search)
let snapshot: ScreenTranslationSnapshot = {
  preferences: { ...DEFAULT_SCREEN_TRANSLATION, connectionId: modelId },
  models: { ...DEFAULT_LARGE_MODEL_SETTINGS, connections: [{
    id: modelId, name: '合成模型 · 用于检查窄面板排版的长名称', provider: 'deepseek', protocol: 'openai', accessType: 'standard-api',
    baseUrl: 'https://example.invalid/v1', modelId: 'deepseek-v4-pro', status: 'connected', apiKeyHint: 'synthetic',
    lastTestedAt: null, capabilityOverride: { thinking: { thinking: 'toggle', encoding: 'thinking-effort',
      efforts: ['low', 'medium', 'high'], defaultThinking: 'disabled', defaultEffort: 'low', disabledEfforts: [] } },
  }] },
  configuredBaidu: true, engineReady: true,
  shortcuts: { once: 'Ctrl+Shift+A', clear: 'Ctrl+Shift+D', toggle: 'Ctrl+Alt+T' },
  theme: { mode: params.get('theme') === 'dark' ? 'dark' : 'light', accent: '#C62828' },
  status: { automatic: false, triggerMode: 'hotkey', busy: false, showOriginal: false, error: null,
    status: '合成译文已就绪。', result: { blocks: [{ box: [10, 10, 200, 80], text: '合成译文', background: '#ffffff', foreground: '#333333' }] } },
}
const listeners = new Set<(state: ScreenTranslationSnapshot) => void>()
const commands: string[] = []
const publish = () => { for (const listener of listeners) listener(structuredClone(snapshot)) }
const api: ScreenTranslationApi = {
  getState: async () => structuredClone(snapshot),
  onState: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  updateSettings: async patch => { snapshot = { ...snapshot, preferences: { ...snapshot.preferences, ...patch } }; publish(); return structuredClone(snapshot) },
  saveBaiduCredentials: async () => { snapshot = { ...snapshot, configuredBaidu: true }; publish(); return structuredClone(snapshot) },
  command: async action => {
    commands.push(action)
    if (action === 'clear') snapshot = { ...snapshot, status: { ...snapshot.status, automatic: false, busy: false,
      result: { blocks: [] }, status: '译文已清除，等待再次翻译。' } }
    publish(); return structuredClone(snapshot)
  },
}
declare global {
  interface Window {
    screenLayoutFixture: { commands(): string[] }
  }
}
Object.defineProperty(window, 'arkScreenTranslation', { value: api })
window.screenLayoutFixture = { commands: () => [...commands] }
// Load the real surface route and all production global/theme styles.
void import('../../../src/renderer/main')
