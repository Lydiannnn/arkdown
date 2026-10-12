import { useEffect, useRef, useState } from 'react'
import { MODEL_CAPABILITY_RULES_MAX_BYTES, parseModelCapabilityRules, setModelCapabilityRules } from '../../shared/model-capability-rules'
import { BUNDLED_MODEL_RULES_REVISION, type ModelCapabilityRulesState } from '../../shared/model-capability-rules-state'
import type { ArkdownApi } from '../../shared/contracts'

export function ModelRulesSettings({ api = window.arkdown, disabled = false }: { api?: Pick<ArkdownApi, 'getModelCapabilityRules' | 'setModelCapabilityRules' | 'onModelCapabilityRulesChanged'>; disabled?: boolean }) {
  const [state, setState] = useState<ModelCapabilityRulesState>({ rules: null, bundledRevision: BUNDLED_MODEL_RULES_REVISION, warning: null })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const locked = useRef(false)
  useEffect(() => {
    if (!api?.getModelCapabilityRules) return
    let active = true
    let changed = false
    const unsubscribe = api.onModelCapabilityRulesChanged?.(next => { changed = true; if (active) setState(next) })
    void api.getModelCapabilityRules().then(result => { if (active && !changed && result.ok) setState(result.value) }).catch(() => undefined)
    return () => { active = false; unsubscribe?.() }
  }, [api])
  const update = async (file: File | null) => {
    if (locked.current || disabled || !api?.setModelCapabilityRules) return
    locked.current = true; setPending(true); setError(null)
    try {
      let rules = null
      if (file) {
        if (file.size > MODEL_CAPABILITY_RULES_MAX_BYTES) throw new Error('size')
        rules = parseModelCapabilityRules(JSON.parse((await file.text()).replace(/^\uFEFF/, '')))
        if (!rules) throw new Error('invalid')
      }
      const result = await api.setModelCapabilityRules(rules)
      if (!result.ok) { setError(result.error.message); return }
      setModelCapabilityRules(result.value.rules)
      setState(result.value)
    } catch { setError('无法导入，请选择有效且与当前版本兼容的模型规则 JSON 文件。') }
    finally { locked.current = false; setPending(false); if (input.current) input.current.value = '' }
  }
  return <section aria-label="模型能力规则" className="preferences-section model-rules-settings">
    <h3>模型能力规则</h3>
    <p className="preferences-description">导入更新文件即可识别新型号的思考能力，无需重新安装。</p>
    <div className="model-rules-actions">
      <span>当前规则：{state.rules?.revision ?? state.bundledRevision}{state.rules ? '（已导入）' : '（内置）'}</span>
      <button type="button" disabled={disabled || pending || !api?.setModelCapabilityRules} onClick={() => input.current?.click()}>{pending ? '处理中…' : '导入规则'}</button>
      <button type="button" disabled={disabled || pending || !state.rules || !api?.setModelCapabilityRules} onClick={() => void update(null)}>恢复内置规则</button>
      <input ref={input} type="file" accept=".json,application/json" aria-label="选择模型规则文件" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void update(file) }} />
    </div>
    {(error || state.warning) && <p role="alert" className="preferences-error">{error ?? state.warning}</p>}
  </section>
}
