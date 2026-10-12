import { useCallback, useEffect, useRef, useState } from 'react'
import { CaretDown, Copy, Eye, Pause, Play, X } from '@phosphor-icons/react'
import { featureModelConnections, isCodexCliConnection } from '../../shared/large-model-settings'
import {
  SCREEN_TRANSLATION_LANGUAGES,
  type ScreenTranslationApi,
  type ScreenTranslationCommand,
  type ScreenTranslationPreferences,
  type ScreenTranslationSnapshot,
} from '../../shared/screen-translation'
import { themeColorRgbChannels } from '../../shared/theme-color'
import { modelThinkingControlState } from '../../shared/model-thinking'
import { setModelCapabilityRules } from '../../shared/model-capability-rules'
import { PreferencesSelect } from '../settings/PreferencesSelect'
import { ModelThinkingControls } from '../editor/ModelThinkingControls'
import { TooltipProvider } from '../tooltip/TooltipProvider'
import { ScreenTranslationCrosshair } from './ScreenTranslationCrosshair'
import { ScreenTranslationInstaller } from './ScreenTranslationInstaller'
import type { PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import './screen-translation.css'

interface SettingsDraft {
  patch: Partial<ScreenTranslationPreferences>
  observed?: PublicModelSettingsSnapshot
  state: 'pending' | 'failed' | 'conflict'
}
export function ScreenTranslationSurface({ api: suppliedApi }: { api?: ScreenTranslationApi }) {
  const api = suppliedApi ?? (window as unknown as { arkScreenTranslation?: ScreenTranslationApi }).arkScreenTranslation
  const [hostSnapshot, setSnapshot] = useState<ScreenTranslationSnapshot | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null)
  const draftRef = useRef<SettingsDraft | null>(null)
  // Live host status can advance without replacing a pending or failed user choice.
  const snapshot = hostSnapshot && settingsDraft
    ? { ...hostSnapshot, preferences: { ...hostSnapshot.preferences, ...settingsDraft.patch } } : hostSnapshot
  const [pending, setPending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [credentialError, setCredentialError] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const alive = useRef(false)
  const pendingRef = useRef(false)
  const eventRevision = useRef(0)
  const actionRevision = useRef(0)

  useEffect(() => {
    alive.current = true
    if (!api) {
      setLocalError('无法连接悬浮翻译窗服务，请关闭后重新打开。')
      return () => { alive.current = false }
    }
    // Subscribe first: a late initial read must never replace a newer host event.
    let receivedEvent = false
    const unsubscribe = api.onState(state => {
      receivedEvent = true
      eventRevision.current += 1
      if (alive.current) setSnapshot(state)
    })
    void api.getState().then(state => {
      if (alive.current && !receivedEvent) setSnapshot(state)
    }).catch(() => {
      if (alive.current && !receivedEvent) setLocalError('无法载入翻译状态，请关闭后重新打开。')
    })
    return () => { alive.current = false; unsubscribe() }
  }, [api])

  useEffect(() => {
    if (!snapshot) return
    // Arkdown's existing light theme is named "minimal" in its CSS contract.
    document.documentElement.dataset.arkdownTheme = snapshot.theme.mode === 'dark' ? 'dark' : 'minimal'
    document.documentElement.style.setProperty('--theme-color-rgb', themeColorRgbChannels(snapshot.theme.accent))
  }, [snapshot?.theme.mode, snapshot?.theme.accent])

  useEffect(() => { if (snapshot?.modelRules) setModelCapabilityRules(snapshot.modelRules.rules) }, [snapshot?.modelRules])

  const execute = useCallback(async (
    operation: () => Promise<ScreenTranslationSnapshot | void>,
    options: { bypassPending?: boolean; credentials?: boolean } = {},
  ): Promise<boolean> => {
    if (!api || (pendingRef.current && !options.bypassPending)) return false
    const eventAtStart = eventRevision.current
    const action = ++actionRevision.current
    if (!options.bypassPending) {
      pendingRef.current = true
      setPending(true)
    }
    if (options.credentials) setCredentialError(null)
    else setLocalError(null)
    try {
      const next = await operation()
      if (alive.current && next && action === actionRevision.current && eventAtStart === eventRevision.current) setSnapshot(next)
      return true
    } catch {
      if (alive.current) {
        if (options.credentials) setCredentialError('密钥保存失败，请检查两项输入后重试。')
        else setLocalError('操作未完成，请稍后重试。')
      }
      return false
    } finally {
      if (!options.bypassPending) {
        pendingRef.current = false
        if (alive.current) setPending(false)
      }
    }
  }, [api])

  const command = (action: ScreenTranslationCommand) => {
    if (api) void execute(() => api.command(action), { bypassPending: action === 'pause' || action === 'close' || action === 'clear' || action === 'cancel-install' })
  }
  const saveDraft = async (draft: SettingsDraft) => {
    if (!api || pendingRef.current) return
    pendingRef.current = true; setPending(true)
    draftRef.current = draft
    draft.state = 'pending'; setSettingsDraft({ ...draft }); setLocalError(null)
    const eventAtStart = eventRevision.current
    try {
      const next = draft.observed ? await api.updateSettings(draft.patch, draft.observed) : await api.updateSettings(draft.patch)
      if (!alive.current || draftRef.current !== draft) return
      if (!('preferences' in next)) {
        draft.state = 'conflict'; setSettingsDraft({ ...draft })
      } else {
        draftRef.current = null; setSettingsDraft(null)
        if (eventAtStart === eventRevision.current) setSnapshot(next)
      }
    } catch {
      if (alive.current && draftRef.current === draft) { draft.state = 'failed'; setSettingsDraft({ ...draft }) }
    } finally {
      pendingRef.current = false
      if (alive.current) setPending(false)
    }
  }
  const update = (patch: Partial<ScreenTranslationPreferences>) => {
    if (!snapshot || draftRef.current || pendingRef.current) return
    void saveDraft({ patch: structuredClone(patch),
      ...(snapshot.modelObservation ? { observed: structuredClone(snapshot.modelObservation) } : {}), state: 'pending' })
  }
  const reloadSettings = async () => {
    if (!api || pendingRef.current) return
    pendingRef.current = true; setPending(true)
    const eventAtStart = eventRevision.current
    try {
      const next = await api.getState({ reloadSettings: true })
      if (!alive.current) return
      if (eventAtStart === eventRevision.current) setSnapshot(next)
      draftRef.current = null; setSettingsDraft(null); setLocalError(null); setCredentialError(null)
      setApiKey(''); setSecretKey('')
    } catch { if (alive.current) setLocalError('重新载入失败，未保存的修改已保留。') }
    finally { pendingRef.current = false; if (alive.current) setPending(false) }
  }
  const settingsBlocked = pending || Boolean(settingsDraft)
  const connections = snapshot ? featureModelConnections(snapshot.models) : []
  const selected = connections.find(connection => connection.id === snapshot?.preferences.connectionId)
  const configured = snapshot?.preferences.backend === 'baidu'
    ? snapshot.configuredBaidu
    : Boolean(selected && (isCodexCliConnection(selected) ? selected.status === 'connected' : selected.apiKeyHint && selected.status !== 'encryption-unavailable'))
  const canTranslate = Boolean(snapshot?.engineReady && configured && !settingsDraft && !credentialError)
  const canPause = Boolean(snapshot?.status.automatic || snapshot?.status.busy)
  const blocks = snapshot?.status.result.blocks ?? []
  const thinking = selected && snapshot ? modelThinkingControlState(selected, snapshot.preferences) : null
  const needsInstallation = snapshot?.component && snapshot.component.status !== 'installed'

  return <TooltipProvider>
    <main className="screen-translation-surface" aria-label="悬浮翻译窗">
      <header className="screen-translation-header">
        <h1>悬浮翻译窗</h1>
        <button type="button" className="screen-translation-close" aria-label="关闭悬浮翻译窗"
          data-tooltip="关闭悬浮翻译窗" onClick={() => command('close')} disabled={!api}>
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <div className="screen-translation-body">
        {!needsInstallation && <p className="screen-translation-guide"><ScreenTranslationCrosshair />
          <span>拖动准星移动取景框，拖动边缘调整范围。</span>
        </p>}
        {!snapshot && <p role={localError ? 'alert' : 'status'} className="screen-translation-note">{localError ?? '正在连接翻译服务…'}</p>}
        {needsInstallation && snapshot.component && <ScreenTranslationInstaller component={snapshot.component}
          pending={pending} error={localError} install={() => command('install-engine')} cancel={() => command('cancel-install')} />}
        {snapshot && !needsInstallation && <>
          <section className="screen-translation-section" aria-label="翻译设置">
            <div className="screen-translation-field">
              <span className="screen-translation-label">翻译方式</span>
              <PreferencesSelect label="翻译方式" menuClassName="screen-translation-menu" value={snapshot.preferences.backend} disabled={settingsBlocked}
                options={[{ value: 'baidu', label: '百度快译' }, { value: 'model', label: '大模型' }]}
                onChange={backend => update({ backend })} />
            </div>
            <div className="screen-translation-field">
              <span className="screen-translation-label">目标语言</span>
              <PreferencesSelect label="目标语言" menuClassName="screen-translation-menu" value={snapshot.preferences.target} disabled={settingsBlocked}
                options={SCREEN_TRANSLATION_LANGUAGES} onChange={target => update({ target })} />
            </div>
            {snapshot.preferences.backend === 'model' && <div className="screen-translation-model">
              <div className="screen-translation-field">
                <span className="screen-translation-label">模型连接</span>
                <PreferencesSelect label="模型连接" menuClassName="screen-translation-menu" value={snapshot.preferences.connectionId ?? ''} disabled={settingsBlocked}
                  options={[{ value: '', label: '选择模型连接', disabled: true }, ...connections.map(connection => ({ value: connection.id, label: connection.name || connection.modelId }))]}
                  onChange={connectionId => update({ connectionId })} />
              </div>
              {thinking?.toggle && <div className="screen-translation-field screen-translation-thinking">
                <span className="screen-translation-label">思考模式</span>
                <ModelThinkingControls label="悬浮翻译窗" togglePresentation="menu" showReasoningEffort={false} thinkingConnection={selected}
                  thinkingPreference={snapshot.preferences} thinkingPending={settingsBlocked} onThinkingChange={update} />
              </div>}
              {!configured && <p className="screen-translation-note">请先添加并选择已配置密钥的模型连接。</p>}
              <button type="button" className="screen-translation-text-button" onClick={() => command('open-models')} disabled={pending}>管理大模型</button>
            </div>}
            {snapshot.preferences.backend === 'baidu' && <details className="screen-translation-credentials">
              <summary><span>百度智能云密钥</span><span className="screen-translation-credential-state">{snapshot.configuredBaidu ? '已配置' : '未配置'}</span><CaretDown size={14} aria-hidden="true" /></summary>
              <form onSubmit={event => {
                event.preventDefault()
                if (!api || pendingRef.current) return
                if (!apiKey.trim() || !secretKey.trim()) { setCredentialError('请填写 API Key 和 Secret Key。'); return }
                void execute(() => api.saveBaiduCredentials({ apiKey: apiKey.trim(), secretKey: secretKey.trim() }), { credentials: true }).then(saved => {
                  if (saved && alive.current) { setApiKey(''); setSecretKey('') }
                })
              }}>
                <p className="screen-translation-note">填写百度智能云文本翻译的 API Key 和 Secret Key。已保存的密钥不会回显。</p>
                <label htmlFor="screen-translation-api-key">API Key</label>
                <input id="screen-translation-api-key" type="password" autoComplete="new-password" value={apiKey}
                  spellCheck={false} maxLength={4096} disabled={pending} onChange={event => setApiKey(event.target.value)} />
                <label htmlFor="screen-translation-secret-key">Secret Key</label>
                <input id="screen-translation-secret-key" type="password" autoComplete="new-password" value={secretKey}
                  spellCheck={false} maxLength={4096} disabled={pending} onChange={event => setSecretKey(event.target.value)} />
                {credentialError && <p className="screen-translation-error" role="alert">{credentialError}</p>}
                <button type="submit" className="screen-translation-button" disabled={pending || !apiKey.trim() || !secretKey.trim()}>{pending ? '正在保存…' : '保存密钥'}</button>
              </form>
            </details>}
            {settingsDraft && settingsDraft.state !== 'pending' && <p className="screen-translation-error" role="alert">
              {settingsDraft.state === 'conflict' ? '翻译设置已被其他窗口修改。请放弃修改并重新载入后再操作。' : '设置保存失败，修改已保留。请重试或放弃修改并重新载入。'}
            </p>}
            {settingsDraft?.state === 'failed' && <button type="button" className="screen-translation-button" disabled={pending}
              onClick={() => { if (draftRef.current) void saveDraft(draftRef.current) }}>重试保存设置</button>}
            {(settingsDraft && settingsDraft.state !== 'pending' || credentialError) && <button type="button" className="screen-translation-text-button" disabled={pending}
              onClick={() => { void reloadSettings() }}>放弃修改并重新载入</button>}
          </section>
          <section className="screen-translation-section screen-translation-operation" aria-label="翻译控制">
            <div className="screen-translation-field">
              <span className="screen-translation-label">触发方式</span>
              <PreferencesSelect label="触发方式" menuClassName="screen-translation-menu" value={snapshot.preferences.triggerMode} disabled={settingsBlocked}
                options={[{ value: 'hotkey', label: '快捷键' }, { value: 'automatic', label: '自动' }]}
                onChange={triggerMode => update({ triggerMode })} />
            </div>
            <p className="screen-translation-note">{snapshot.preferences.triggerMode === 'automatic'
              ? '开始后每秒检查画面，只翻译变化的内容。'
              : snapshot.shortcuts.once ? <>按 <strong className="screen-translation-shortcut">{snapshot.shortcuts.once}</strong> 翻译一次，也可使用下方按钮。</> : '尚未绑定单次翻译快捷键，可使用下方按钮。'}</p>
            <p className="screen-translation-note">{snapshot.shortcuts.clear
              ? <>按 <strong className="screen-translation-shortcut">{snapshot.shortcuts.clear}</strong> 清除译文，保留取景框。</>
              : '尚未绑定清除快捷键，可在编辑 → 快捷键中设置。'}</p>
            <div className="screen-translation-actions">
              <button type="button" className="screen-translation-button screen-translation-primary"
                disabled={!canPause && (pending || !canTranslate || snapshot.preferences.triggerMode === 'hotkey')}
                data-tooltip={snapshot.shortcuts.toggle ? `自动翻译开关 · ${snapshot.shortcuts.toggle}` : undefined}
                onClick={() => command(canPause ? 'pause' : 'start')}>
                {canPause ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                {canPause ? '暂停翻译' : snapshot.preferences.triggerMode === 'hotkey' ? '等待快捷键' : '开始翻译'}
              </button>
              <button type="button" className="screen-translation-button" disabled={pending || !canTranslate || snapshot.status.busy}
                data-tooltip={snapshot.shortcuts.once ? `翻译一次 · ${snapshot.shortcuts.once}` : undefined} onClick={() => command('once')}>翻译一次</button>
            </div>
            <div className="screen-translation-status" role="status" aria-live="polite" aria-atomic="true">
              <span className={`screen-translation-status-dot${snapshot.status.automatic || snapshot.status.busy ? ' is-active' : ''}`} aria-hidden="true" />
              <span>{!snapshot.engineReady ? 'OCR 引擎尚未就绪' : !configured ? '请先完成翻译配置' : snapshot.status.status || (snapshot.status.busy ? '正在翻译…' : '就绪，等待开始')}</span>
            </div>
            {(localError || snapshot.status.error) && <p className="screen-translation-error" role="alert">{localError || snapshot.status.error}</p>}
          </section>
          <section className="screen-translation-result" aria-label="译文操作">
            <div className="screen-translation-actions">
              <button type="button" className="screen-translation-button" disabled={pending} aria-pressed={snapshot.status.showOriginal}
                onClick={() => command(snapshot.status.showOriginal ? 'show-translation' : 'show-original')}>
                <Eye size={16} aria-hidden="true" />{snapshot.status.showOriginal ? '显示译文' : '显示原文'}
              </button>
              <button type="button" className="screen-translation-button" disabled={pending || !blocks.some(block => block.text.trim())} onClick={() => command('copy')}>
                <Copy size={16} aria-hidden="true" />复制译文
              </button>
            </div>
            <button type="button" className="screen-translation-text-button" disabled={!snapshot.engineReady}
              data-tooltip={snapshot.shortcuts.clear ? `清除译文 · ${snapshot.shortcuts.clear}` : '清除译文并保留取景框'}
              onClick={() => command('clear')}>清除译文</button>
          </section>
        </>}
      </div>
    </main>
  </TooltipProvider>
}
