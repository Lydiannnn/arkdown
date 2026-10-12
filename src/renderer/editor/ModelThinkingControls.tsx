import { areModelRulesReady, useModelRulesReady, useModelRulesRevision } from '../settings/model-rules-runtime'
import type { ModelThinkingPreference, ThinkingConnection } from '../../shared/model-thinking'
import { modelThinkingControlState } from '../../shared/model-thinking'
import { PreferencesSelect } from '../settings/PreferencesSelect'
import { REASONING_LABELS } from '../settings/LargeModelSettingsSection'
import './model-thinking-controls.css'

export interface ThinkingControlProps {
  thinkingConnection?: ThinkingConnection
  thinkingPreference?: ModelThinkingPreference
  thinkingPending?: boolean
  onThinkingChange?(change: Partial<ModelThinkingPreference>): void
}

export function ModelThinkingControls({ thinkingConnection, thinkingPreference, thinkingPending,
  onThinkingChange, label, togglePresentation = 'switch', composerMenus = false, showReasoningEffort = true }: ThinkingControlProps & {
    label: string
    togglePresentation?: 'switch' | 'menu'
    composerMenus?: boolean
    showReasoningEffort?: boolean
  }) {
  useModelRulesRevision()
  const rulesReady = useModelRulesReady()
  thinkingPending = thinkingPending || !rulesReady
  if (!thinkingConnection || !thinkingPreference || !onThinkingChange) return null
  const changeThinking = (change: Partial<ModelThinkingPreference>) => {
    if (areModelRulesReady() && !thinkingPending) onThinkingChange(change)
  }
  const controls = modelThinkingControlState(thinkingConnection, thinkingPreference)
  if (!controls.toggle && (!showReasoningEffort || controls.efforts.length === 0)) return null
  return <div className="model-thinking-controls">
    {controls.toggle && (togglePresentation === 'menu'
      ? <PreferencesSelect label={`${label}思考`} className="model-thinking-menu-trigger"
        menuTitle={composerMenus ? '思考模式' : undefined}
        menuClassName={composerMenus ? 'ai-composer-menu' : undefined} optionTooltips={!composerMenus}
        disabled={thinkingPending} value={controls.enabled ? 'enabled' : 'disabled'}
        options={[{ value: 'enabled', label: '开' }, { value: 'disabled', label: '关' }]}
        onChange={(thinkingMode) => changeThinking({ thinkingMode })} />
      : <button type="button" role="switch" aria-label={`${label}思考`}
      aria-checked={controls.enabled} disabled={thinkingPending}
      className="model-thinking-switch"
      onClick={() => changeThinking({ thinkingMode: controls.enabled ? 'disabled' : 'enabled' })}>
      <span aria-hidden="true" className="model-thinking-switch-track" />思考
    </button>)}
    {showReasoningEffort && controls.efforts.length > 0 && <PreferencesSelect label={`${label}推理强度`}
      menuTitle={composerMenus ? '模型强度' : undefined}
      menuClassName={composerMenus ? 'ai-composer-menu' : undefined} optionTooltips={!composerMenus}
      disabled={thinkingPending} value={controls.value}
      options={['default' as const, ...controls.efforts].map((value) => ({ value, label: REASONING_LABELS[value] }))}
      onChange={(reasoningEffort) => changeThinking({ reasoningEffort })} />}
  </div>
}
