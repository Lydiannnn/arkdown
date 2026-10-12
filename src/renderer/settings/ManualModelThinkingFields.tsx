import { areModelRulesReady, useModelRulesReady } from './model-rules-runtime'
import type { ModelProtocol } from '../../shared/large-model-settings'
import type { ModelThinkingCapability, ThinkingEncoding } from '../../shared/model-capability-rules'
import { PreferencesSelect } from './PreferencesSelect'
import { REASONING_LABELS } from './LargeModelSettingsSection'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const NO_EFFORT = new Set<ThinkingEncoding>(['none', 'thinking', 'enable-thinking', 'adaptive'])
const FORMATS: Array<{value: ThinkingEncoding; label: string; protocol?: ModelProtocol}> = [
  { value: 'thinking-effort', label: 'thinking.type + reasoning_effort', protocol: 'openai' },
  { value: 'openai-effort', label: 'reasoning_effort（none 表示关闭）', protocol: 'openai' },
  { value: 'thinking', label: 'thinking.type（enabled / disabled）' },
  { value: 'enable-thinking', label: 'enable_thinking（true / false）', protocol: 'openai' },
  { value: 'adaptive', label: 'thinking.type（adaptive / disabled）' },
  { value: 'thinking-output-effort', label: 'thinking.type + output_config.effort', protocol: 'anthropic' },
  { value: 'claude-adaptive', label: 'Claude 自适应思考', protocol: 'anthropic' },
  { value: 'claude-budget', label: 'Claude 预算思考', protocol: 'anthropic' },
  { value: 'none', label: '不发送思考参数' },
]

export function ManualModelThinkingFields({ protocol, value, detected, onChange: changeValue }: {
  protocol: ModelProtocol
  value?: ModelThinkingCapability
  detected: ModelThinkingCapability
  onChange(value: ModelThinkingCapability | undefined): void
}) {
  const modelRulesReady = useModelRulesReady()
  const onChange = (next: ModelThinkingCapability | undefined) => { if (areModelRulesReady()) changeValue(next) }
  const selectableFormats = FORMATS.filter(f => (!f.protocol || f.protocol === protocol) && (value?.thinking !== 'toggle' || f.value !== 'none'))
  const setFormat = (encoding: ThinkingEncoding) => {
    if (!value) return
    const efforts = NO_EFFORT.has(encoding) ? [] : ['low', 'medium', 'high'] as const
    const { effortAliases: _aliases, bindingControls: _binding, ...current } = value
    onChange({ ...current, encoding, efforts, disabledEfforts: [], defaultEffort: efforts.length ? 'high' : 'default' })
  }
  const automatic = detected.thinking === 'unknown' ? '未识别' : detected.thinking === 'fixed' ? '固定开启' : '可开关'
  return <div className="manual-model-thinking">
    <div className="preferences-field">
      <span>思考能力</span>
      <PreferencesSelect disabled={!modelRulesReady} label="思考能力识别" value={value?.thinking ?? 'auto'} options={[
        {value: 'auto', label: `自动识别（${automatic}）`},
        {value: 'toggle', label: '手动：可开关'},
        {value: 'fixed', label: '手动：固定开启'},
        {value: 'unknown', label: '手动：不提供思考控件'},
      ]} onChange={mode => {
        if (mode === 'auto') { onChange(undefined); return }
        if (mode === 'unknown') { onChange({ thinking: 'unknown', encoding: 'none', efforts: [], defaultThinking: 'default', defaultEffort: 'default', disabledEfforts: [] }); return }
        onChange({ thinking: mode, encoding: protocol === 'openai' ? 'thinking-effort' : 'thinking-output-effort', efforts: ['low', 'medium', 'high'], defaultThinking: 'enabled', defaultEffort: 'high', disabledEfforts: [] })
      }} />
    </div>
    {value && value.thinking !== 'unknown' && <>
      <div className="preferences-field"><span>参数格式</span><PreferencesSelect disabled={!modelRulesReady} label="思考参数格式" value={value.encoding} options={selectableFormats} onChange={setFormat} /></div>
      {!NO_EFFORT.has(value.encoding) && <div className="preferences-field">
        <span>有效强度</span>
        <div className="manual-model-efforts">{EFFORTS.map(effort => <label key={effort}>
          <input type="checkbox" checked={value.efforts.includes(effort)} disabled={!modelRulesReady || (value.efforts.length === 1 && value.efforts.includes(effort))} onChange={event => {
            const efforts = EFFORTS.filter(e => e === effort ? event.target.checked : value.efforts.includes(e))
            const { effortAliases: _aliases, ...current } = value
            onChange({ ...current, efforts, disabledEfforts: [], defaultEffort: value.defaultEffort === 'default' || efforts.some(effort => effort === value.defaultEffort) ? value.defaultEffort : efforts[0] })
          }} />{REASONING_LABELS[effort]}
        </label>)}</div>
      </div>}
      <div className="manual-model-defaults">
        {value.thinking === 'toggle' && <div className="preferences-field"><span>服务商默认思考</span><PreferencesSelect disabled={!modelRulesReady} label="服务商默认思考" value={value.defaultThinking} options={[{value:'enabled',label:'开启'},{value:'disabled',label:'关闭'}]} onChange={defaultThinking => onChange({...value,defaultThinking})} /></div>}
        {value.efforts.length > 0 && <div className="preferences-field"><span>默认强度</span><PreferencesSelect disabled={!modelRulesReady} label="手动默认推理强度" value={value.defaultEffort} options={['default' as const,...value.efforts].map(e=>({value:e,label:REASONING_LABELS[e]}))} onChange={defaultEffort=>onChange({...value,defaultEffort})} /></div>}
      </div>
      <p className="preferences-description">按服务商文档选择格式和有效档位；未提供的能力无需开启。</p>
    </>}
  </div>
}
