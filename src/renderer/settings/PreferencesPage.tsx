import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorAppearancePreferences } from '../../shared/editor-appearance-preferences'
import {
  type BrowserSearchPreferences,
  type SearchProviderId,
  isSafeCustomSearchTemplate,
} from '../../shared/search-preferences'
import {
  DEFAULT_LARGE_MODEL_SETTINGS,
  type LargeModelSettings,
} from '../../shared/large-model-settings'
import { LargeModelSettingsSection } from './LargeModelSettingsSection'
import { ModelManagerPage } from './ModelManagerPage'
import { PreferencesSelect } from './PreferencesSelect'
import { PreferencesShell, scrollPreferenceTarget } from './PreferencesShell'
import type { PreferencesOpenTarget } from './preferences-open-target'
import { PreferencesRangeControl } from './PreferencesRangeControl'
import { StickyNotePreferencesSection } from './StickyNotePreferencesSection'
import { StickyNoteMaterialSettingsPage } from './StickyNoteMaterialSettingsPage'
import { copyStickyNoteWallpaperAppearances } from '../../shared/sticky-note-glass-appearance'
import { ShellIntegrationPreferencesSection } from './ShellIntegrationPreferencesSection'
import type { ShellIntegrationPreferenceDraft } from './shell-integration-preference-draft'
import type { ModelPreferenceDraft } from './model-preference-draft'
import { ScreenshotOcrRemoveDialog } from './ScreenshotOcrRemoveDialog'
import { DocumentConversionPreferencesSection } from './DocumentConversionPreferencesSection'
import { AppIcon } from '../icons/AppIcon'
import {
  copyArknotePreferences,
  DEFAULT_ARKNOTE_PREFERENCES,
  type ArknotePreferences,
} from '../../shared/arknote-preferences'
import {
  THEME_COLOR_PRESETS,
  normalizeThemeColor,
  themeColorRgbChannels,
} from '../../shared/theme-color'
import type { ApiResult } from '../../shared/contracts'
import type {
  ScreenshotOcrModelState,
  ObservedOcrPreference, ScreenshotOcrMutationResult,
} from '../../shared/screenshot-ocr-models'
import './search-preferences.css'
import './large-model-settings.css'
import './preferences-normalization.css'

export interface PreferencesPageProps {
  shellPreferences?: ShellIntegrationPreferenceDraft
  modelPreferences?: ModelPreferenceDraft
  initialAppearance: EditorAppearancePreferences
  initialLargeModels?: LargeModelSettings
  initialSearch: BrowserSearchPreferences
  initialArknote?: ArknotePreferences
  initialTarget?: PreferencesOpenTarget
  persistenceError?: string | null
  onReloadSavedPreferences?(): void
  reloadRevision?: number
  systemFonts: readonly string[]
  onClose(): void
  onSearchChange(value: BrowserSearchPreferences): void
  onAppearanceChange(patch: Partial<EditorAppearancePreferences>): void
  onArknoteChange(patch: Partial<ArknotePreferences>): void
  onDesktopContextMenuChange?(enabled: boolean): Promise<void>
  onLargeModelsChange?(value: LargeModelSettings): void
}

function templateError(provider: SearchProviderId, template: string): string | null {
  if (provider !== 'custom') return null
  if (!template.trim().startsWith('https://')) return '自定义搜索地址必须使用 HTTPS。'
  if ((template.match(/\{query\}/g) ?? []).length !== 1) {
    return '自定义搜索地址必须且只能包含一个 {query}。'
  }
  if (!isSafeCustomSearchTemplate(template)) return '自定义搜索地址无效。'
  return null
}

function FontSelect({
  label,
  fonts,
  value,
  onChange,
}: {
  label: string
  fonts: readonly string[]
  value: string
  onChange(value: string): void
}) {
  return (
    <div className="preferences-font-option">
      <span>{label}</span>
      <PreferencesSelect
        label={label}
        onChange={onChange}
        options={fonts.map((font) => ({ value: font, label: font }))}
        value={value}
      />
    </div>
  )
}

type ScreenshotOcrAction = (observed: ObservedOcrPreference) => Promise<ApiResult<ScreenshotOcrMutationResult>>

function screenshotOcrProgressPercent(state: ScreenshotOcrModelState): number | null {
  if (!state.progress) return null
  return Math.min(100, Math.max(0, Math.round(
    state.progress.receivedBytes / state.progress.totalBytes * 100,
  )))
}

export function PreferencesPage({
  shellPreferences,
  modelPreferences,
  initialAppearance,
  initialLargeModels = DEFAULT_LARGE_MODEL_SETTINGS,
  initialSearch,
  initialArknote = DEFAULT_ARKNOTE_PREFERENCES,
  initialTarget = 'top',
  persistenceError,
  onReloadSavedPreferences,
  reloadRevision = 0,
  systemFonts,
  onAppearanceChange,
  onArknoteChange,
  onDesktopContextMenuChange,
  onLargeModelsChange,
  onClose,
  onSearchChange,
}: PreferencesPageProps) {
  const [provider, setProvider] = useState<SearchProviderId>(initialSearch.provider)
  const [customTemplate, setCustomTemplate] = useState(initialSearch.customTemplate)
  const [appearance, setAppearance] = useState(initialAppearance)
  const {
    minimumContentMarginPx, maximumContentWidthPx, preserveSingleLineBreaks,
    spellCheckEnabled, headingLatinFont, headingCjkFont, bodyLatinFont, bodyCjkFont,
    themeColor,
  } = appearance
  const [largeModels, setLargeModels] = useState(initialLargeModels)
  const [arknote, setArknote] = useState(() => copyArknotePreferences(initialArknote))
  const [largeModelView, setLargeModelView] = useState<'summary' | 'manager' | 'materials'>(
    initialTarget === 'large-model-manager' ? 'manager' : 'summary',
  )
  const [largeModelMutationPending, setLargeModelMutationPending] = useState(false)
  const largeModelMutationRef = useRef(false)
  const largeModelRefreshRevision = useRef(0)
  const onLargeModelsChangeRef = useRef(onLargeModelsChange)
  onLargeModelsChangeRef.current = onLargeModelsChange
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  const [screenshotOcrModel, setScreenshotOcrModel] = useState<ScreenshotOcrModelState | null>(null)
  const [screenshotOcrMutation, setScreenshotOcrMutation] = useState<'download' | 'remove' | 'refresh' | null>(null)
  const [screenshotOcrActionFailed, setScreenshotOcrActionFailed] = useState<'download' | 'remove' | 'conflict' | null>(null)
  const [screenshotOcrRemoveConfirmOpen, setScreenshotOcrRemoveConfirmOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const summaryScrollTopRef = useRef(0)
  const screenshotOcrLifecycleRef = useRef(0)
  const screenshotOcrEventRevisionRef = useRef(0)
  const screenshotOcrMutationLockRef = useRef<symbol | null>(null)
  const screenshotOcrDownloadStartedHereRef = useRef(false)
  const screenshotOcrObservationRef = useRef<ObservedOcrPreference | null>(null)
  const [screenshotOcrObservationReady, setScreenshotOcrObservationReady] = useState(false)
  const screenshotOcrRetryRef = useRef<{ mutation: 'download' | 'remove'; observed: ObservedOcrPreference } | null>(null)
  const screenshotOcrRemoveObservationRef = useRef<ObservedOcrPreference | null>(null)
  const directManagerReturnPendingRef = useRef(initialTarget === 'large-model-manager')
  const fonts = useMemo(() => Array.from(new Set([
    ...systemFonts,
    headingLatinFont,
    headingCjkFont,
    bodyLatinFont,
    bodyCjkFont,
  ])).sort((left, right) => left.localeCompare(right, 'zh-CN')), [
    bodyCjkFont,
    bodyLatinFont,
    headingCjkFont,
    headingLatinFont,
    systemFonts,
  ])
  const error = templateError(provider, customTemplate)

  useEffect(() => {
    setAppearance(initialAppearance)
  }, [initialAppearance])

  useEffect(() => {
    setProvider(initialSearch.provider)
    setCustomTemplate(initialSearch.customTemplate)
  }, [initialSearch.provider, initialSearch.customTemplate, reloadRevision])

  useEffect(() => {
    setArknote(copyArknotePreferences(initialArknote))
  }, [initialArknote])

  useEffect(() => {
    largeModelRefreshRevision.current += 1
    setLargeModels(initialLargeModels)
  }, [initialLargeModels])

  useEffect(() => {
    let active = true
    const refresh = () => {
      if (largeModelMutationRef.current) return
      const revision = ++largeModelRefreshRevision.current
      void window.arkdown?.getModelSettingsSnapshot?.().then(result => {
        if (!active || revision !== largeModelRefreshRevision.current || largeModelMutationRef.current || !result.ok) return
        modelPreferences?.accept(result.value)
        setLargeModels(result.value.settings)
        onLargeModelsChangeRef.current?.(result.value.settings)
      }).catch(() => undefined)
    }
    window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [modelPreferences])

  useEffect(() => {
    const lifecycle = ++screenshotOcrLifecycleRef.current
    let active = true
    const api = window.arkdown
    let receivedStateEvent = false
    const isCurrent = () => active && screenshotOcrLifecycleRef.current === lifecycle
    const acceptState = (state: ScreenshotOcrModelState) => {
      if (!isCurrent()) return
      setScreenshotOcrModel(state)
      setScreenshotOcrActionFailed(current => current === 'conflict' ? current : null)
    }
    const unsubscribe = api?.onScreenshotOcrModelState?.((state) => {
      receivedStateEvent = true
      screenshotOcrEventRevisionRef.current += 1
      acceptState(state)
    }) ?? (() => undefined)
    void api?.getScreenshotOcrModelState?.().then((result) => {
      if (result.ok && isCurrent()) {
        screenshotOcrObservationRef.current = { ...result.value.observed }
        setScreenshotOcrObservationReady(true)
        if (!receivedStateEvent) acceptState(result.value.state)
      }
    }).catch(() => undefined)
    return () => {
      active = false
      if (screenshotOcrLifecycleRef.current === lifecycle) screenshotOcrLifecycleRef.current += 1
      if (screenshotOcrDownloadStartedHereRef.current) {
        screenshotOcrDownloadStartedHereRef.current = false
        void api?.cancelScreenshotOcrMediumDownload?.().catch(() => undefined)
      }
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (initialTarget !== 'large-model-current') return
    const frame = requestAnimationFrame(() => {
      const viewport = contentRef.current
      const target = document.getElementById('preferences-large-model-heading')
      if (viewport && target) {
        scrollPreferenceTarget(viewport, target, 0.2)
        target.focus({ preventScroll: true })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [initialTarget])

  const changeAppearance = (patch: Partial<EditorAppearancePreferences>) => {
    setAppearance((current) => ({ ...current, ...patch }))
    onAppearanceChange(patch)
  }

  const changeArknote = (patch: Partial<ArknotePreferences>) => {
    setArknote((current) => ({ ...current, ...patch }))
    onArknoteChange(patch)
  }

  const changeSearch = (nextProvider: SearchProviderId, nextTemplate: string) => {
    setProvider(nextProvider)
    setCustomTemplate(nextTemplate)
    if (templateError(nextProvider, nextTemplate)) return
    onSearchChange({
      provider: nextProvider,
      customTemplate: nextProvider === 'custom' ? nextTemplate.trim() : '',
    })
  }

  const changeThemeColor = (nextThemeColor: string) => {
    changeAppearance({ themeColor: nextThemeColor })
  }

  const runScreenshotOcrAction = async (
    mutation: 'download' | 'remove',
    action: ScreenshotOcrAction | undefined,
    confirmation?: ObservedOcrPreference | null,
  ) => {
    if (screenshotOcrMutationLockRef.current || !screenshotOcrObservationRef.current
      || (mutation === 'remove' && !confirmation)) return
    const original = screenshotOcrRetryRef.current?.mutation === mutation
      ? screenshotOcrRetryRef.current.observed : mutation === 'remove' ? confirmation : screenshotOcrObservationRef.current
    if (!original) { setScreenshotOcrActionFailed(mutation); return }
    const observed = { ...original }
    screenshotOcrRetryRef.current = { mutation, observed }
    const lock = Symbol(mutation)
    screenshotOcrMutationLockRef.current = lock
    const lifecycle = screenshotOcrLifecycleRef.current
    const eventRevision = screenshotOcrEventRevisionRef.current
    if (mutation === 'download') screenshotOcrDownloadStartedHereRef.current = true
    setScreenshotOcrMutation(mutation)
    setScreenshotOcrActionFailed(null)
    try {
      const result = await action?.(observed)
      if (!result?.ok) throw new Error('OCR model action failed')
      if (screenshotOcrLifecycleRef.current !== lifecycle) return
      if (result.value.status === 'conflict') {
        if (screenshotOcrLifecycleRef.current === lifecycle) setScreenshotOcrActionFailed('conflict')
        return
      }
      if (
        screenshotOcrLifecycleRef.current === lifecycle
        && screenshotOcrEventRevisionRef.current === eventRevision
      ) setScreenshotOcrModel(result.value)
      if (result.value.status !== 'medium-failed') {
        screenshotOcrRetryRef.current = null
        const refreshed = await window.arkdown?.getScreenshotOcrModelState?.().catch(() => undefined)
        if (refreshed?.ok && screenshotOcrLifecycleRef.current === lifecycle) {
          screenshotOcrObservationRef.current = { ...refreshed.value.observed }
        }
      }
    } catch {
      if (
        screenshotOcrLifecycleRef.current === lifecycle
        && screenshotOcrEventRevisionRef.current === eventRevision
      ) setScreenshotOcrActionFailed(mutation)
    } finally {
      if (mutation === 'download') screenshotOcrDownloadStartedHereRef.current = false
      if (screenshotOcrLifecycleRef.current === lifecycle) setScreenshotOcrMutation(null)
      if (screenshotOcrMutationLockRef.current === lock) screenshotOcrMutationLockRef.current = null
    }
  }

  const refreshScreenshotOcr = async () => {
    if (screenshotOcrMutationLockRef.current) return
    const lock = Symbol('refresh')
    screenshotOcrMutationLockRef.current = lock
    setScreenshotOcrMutation('refresh')
    const lifecycle = screenshotOcrLifecycleRef.current
    const eventRevision = screenshotOcrEventRevisionRef.current
    try {
      const result = await window.arkdown?.getScreenshotOcrModelState?.()
      if (!result?.ok || screenshotOcrLifecycleRef.current !== lifecycle) return
      screenshotOcrObservationRef.current = { ...result.value.observed }
      setScreenshotOcrObservationReady(true)
      screenshotOcrRetryRef.current = null
      if (screenshotOcrEventRevisionRef.current === eventRevision) setScreenshotOcrModel(result.value.state)
      setScreenshotOcrActionFailed(null)
    } catch { /* Keep the original failed observation until explicit refresh succeeds. */ }
    finally {
      if (screenshotOcrLifecycleRef.current === lifecycle) setScreenshotOcrMutation(null)
      if (screenshotOcrMutationLockRef.current === lock) screenshotOcrMutationLockRef.current = null
    }
  }

  useEffect(() => {
    const refreshOnFocus = () => {
      if (screenshotOcrMutationLockRef.current || screenshotOcrRemoveConfirmOpen || screenshotOcrRetryRef.current) return
      void refreshScreenshotOcr()
    }
    window.addEventListener('focus', refreshOnFocus)
    return () => window.removeEventListener('focus', refreshOnFocus)
  }, [screenshotOcrRemoveConfirmOpen])


  const openLargeModelManager = () => {
    if (largeModelView === 'summary') summaryScrollTopRef.current = contentRef.current?.scrollTop ?? 0
    setLargeModelView('manager')
    requestAnimationFrame(() => {
      if (contentRef.current) contentRef.current.scrollTop = 0
    })
  }

  const openMaterialSettings = () => {
    if (largeModelView === 'summary') summaryScrollTopRef.current = contentRef.current?.scrollTop ?? 0
    directManagerReturnPendingRef.current = false
    setLargeModelView('materials')
    requestAnimationFrame(() => {
      if (contentRef.current) contentRef.current.scrollTop = 0
      document.getElementById('preferences-arknote-material-settings')?.focus({ preventScroll: true })
    })
  }

  const closeLargeModelManager = (sectionId?: string) => {
    if (largeModelMutationPending) return
    setLargeModelView('summary')
    requestAnimationFrame(() => {
      if (sectionId) {
        directManagerReturnPendingRef.current = false
        const target = document.getElementById(sectionId)
        if (contentRef.current && target) scrollPreferenceTarget(contentRef.current, target)
        return
      }
      if (directManagerReturnPendingRef.current) {
        directManagerReturnPendingRef.current = false
        const target = document.getElementById('preferences-large-model-heading')
        if (contentRef.current && target) {
          scrollPreferenceTarget(contentRef.current, target)
          target.focus({ preventScroll: true })
        }
        return
      }
      if (contentRef.current) {
        contentRef.current.scrollTop = summaryScrollTopRef.current
      }
      if (largeModelView === 'materials') {
        contentRef.current?.querySelector<HTMLButtonElement>('.sticky-note-material-settings-action button')?.focus({ preventScroll: true })
      }
    })
  }

  const handleTocClick = (event: React.MouseEvent<HTMLElement>) => {
    if (largeModelMutationPending) {
      event.preventDefault()
      return
    }
    const target = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]')
    if (!target) return

    const sectionId = decodeURIComponent(target.hash.slice(1))
    if (!sectionId) return

    if (sectionId === 'preferences-large-model-manager') {
      event.preventDefault()
      if (largeModelView !== 'manager') openLargeModelManager()
      return
    }

    if (sectionId === 'preferences-arknote-material-settings') {
      event.preventDefault()
      if (largeModelView !== 'materials') openMaterialSettings()
      return
    }

    if (largeModelView === 'summary') return

    event.preventDefault()
    closeLargeModelManager(sectionId)
  }

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.key !== 'Escape'
        || largeModelMutationPending
        || document.querySelector('[role="dialog"][aria-modal="true"]')
      ) return

      event.preventDefault()
      if (largeModelView !== 'summary') closeLargeModelManager()
      else onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [largeModelMutationPending, largeModelView, onClose])

  const screenshotOcrDownloading = screenshotOcrMutation === 'download'
    || screenshotOcrModel?.status === 'medium-downloading'
  const screenshotOcrBundled = screenshotOcrModel?.mediumSource === 'bundled'
  const screenshotOcrBundledToggle = screenshotOcrBundled && (screenshotOcrModel.availableMediumVersion === null
    || screenshotOcrModel.availableMediumVersion === screenshotOcrModel.mediumVersion)
  const screenshotOcrInstalled = screenshotOcrModel?.mediumVersion !== null
    && screenshotOcrModel?.status !== 'medium-update-available'
    && !(screenshotOcrModel?.status === 'medium-disabled' && screenshotOcrModel.availableMediumVersion !== null)
  const screenshotOcrActionLabel = screenshotOcrDownloading
    ? screenshotOcrBundledToggle ? '正在启用' : '正在下载'
    : screenshotOcrBundledToggle ? screenshotOcrModel.activeTier === 'medium' ? '停用' : '启用'
    : screenshotOcrInstalled ? '已安装' : '下载并更新'

  return (
    <PreferencesShell
      ariaLabel="偏好设置"
      className="preferences-page--arkdown"
      contentRef={contentRef}
      header={
        <button
          aria-label={largeModelView !== 'summary' ? '返回偏好设置' : '返回编辑器'}
          className="preferences-back"
          disabled={largeModelMutationPending}
          onClick={() => {
            if (largeModelView !== 'summary') closeLargeModelManager()
            else onClose()
          }}
          type="button"
        >
          <AppIcon aria-hidden="true" name="previous" size={16} />
        </button>
      }
      footer={
        largeModelView !== 'summary' ? (
          <button
            className="preferences-footer-secondary-action"
            disabled={largeModelMutationPending}
            onClick={() => closeLargeModelManager()}
            type="button"
          >
            返回
          </button>
        ) : <button className="preferences-footer-secondary-action" onClick={onClose} type="button">关闭</button>
      }
      onTocClick={handleTocClick}
      status={persistenceError ? (
        <div className="preferences-error" data-ui-selectable="true" role="alert" tabIndex={0}>
          {persistenceError}
          {onReloadSavedPreferences && <button type="button" onClick={onReloadSavedPreferences}>重新加载已保存设置</button>}
        </div>
      ) : null}
      style={{
        '--theme-color-rgb': themeColorRgbChannels(themeColor),
      } as React.CSSProperties}
      toc={<>
            <a className="preferences-toc-primary" href="#preferences-search-heading">浏览器搜索</a>
            <a className="preferences-toc-primary" href="#preferences-theme-heading">主题</a>
            <a className="preferences-toc-secondary" href="#preferences-theme-color-heading">主题颜色</a>
            <a className="preferences-toc-secondary" href="#preferences-background-heading">设置背景</a>
            <a className="preferences-toc-primary" href="#preferences-editor-heading">编辑器</a>
            <a className="preferences-toc-secondary" href="#preferences-font-heading">字体选择</a>
            <a className="preferences-toc-secondary" href="#preferences-editor-layout-heading">编辑器版面</a>
            <a className="preferences-toc-secondary" href="#preferences-single-line-breaks-heading">保留单个换行</a>
            <a className="preferences-toc-secondary" href="#preferences-spell-check-heading">拼写检查</a>
            <a className="preferences-toc-primary" href="#preferences-arknote-heading">Arknote</a>
            <a className="preferences-toc-secondary" href="#preferences-arknote-startup-heading">开机启动</a>
            <a className="preferences-toc-secondary" href="#preferences-arknote-materials-heading">默认材质</a>
            <a className="preferences-toc-secondary" href="#preferences-arknote-material-settings">材质设置</a>
            <a className="preferences-toc-secondary" href="#preferences-arknote-colors-heading">默认颜色</a>
            <a className="preferences-toc-primary" href="#preferences-context-menu-heading">右键菜单</a>
            <a className="preferences-toc-secondary" href="#preferences-default-applications-heading">md/txt默认程序</a>
            <a className="preferences-toc-primary" href="#preferences-large-model-heading">大模型设置</a>
            <a className="preferences-toc-secondary" href="#preferences-large-model-manager">管理大模型</a>
            <a className="preferences-toc-primary" href="#preferences-screenshot-heading">截图OCR识别</a>
            <a className="preferences-toc-primary" href="#preferences-document-conversion-heading">文档转换</a>

      </>}
      tocLabel="偏好设置目录"
    >
        {largeModelView === 'manager' ? (modelPreferences ? (
          <ModelManagerPage
            modelPreferences={modelPreferences}
            connectModel={window.arkdown.connectModel}
            deleteModel={window.arkdown.deleteModel}
            listModels={window.arkdown.listModels}
            onMutationChange={pending => {
              largeModelMutationRef.current = pending
              largeModelRefreshRevision.current += 1
              setLargeModelMutationPending(pending)
            }}
            onSettingsChange={(settings) => {
              largeModelRefreshRevision.current += 1
              setLargeModels(settings)
              onLargeModelsChange?.(settings)
            }}
            setAiConversationSettings={window.arkdown.setAiConversationSettings}
            setScreenshotTranslationSettings={window.arkdown.setScreenshotTranslationSettings}
            setFloatingTranslationSettings={window.arkdown.setFloatingTranslationSettings}
            setSelectionTranslationSettings={window.arkdown.setSelectionTranslationSettings}
            settings={largeModels}
            removeCodexCliConnection={window.arkdown.removeCodexCliConnection}
            testCodexCliConnection={window.arkdown.testCodexCliConnection}
            testModel={window.arkdown.testModel}
          />
        ) : <p role="alert">大模型设置暂不可用，请重新打开偏好设置。</p>) : largeModelView === 'materials' ? (
          <StickyNoteMaterialSettingsPage value={copyStickyNoteWallpaperAppearances(arknote)} onChange={changeArknote} />
        ) : (
          <>
        <h1>偏好设置</h1>
        <section aria-labelledby="preferences-search-heading" className="preferences-section">
          <h2 id="preferences-search-heading">浏览器搜索</h2>
          <p>设置“使用默认浏览器搜索”所使用的搜索提供商。</p>
          <div className="preferences-search-provider preferences-field">
            <span className="preferences-setting-label">搜索提供商</span>
            <PreferencesSelect<SearchProviderId>
              label="搜索提供商"
              onChange={(nextProvider) => changeSearch(nextProvider, customTemplate)}
              options={[
                { value: 'bing', label: 'Bing' },
                { value: 'baidu', label: '百度（默认）' },
                { value: 'google', label: 'Google' },
                { value: 'custom', label: '自定义' },
              ]}
              value={provider}
            />
          </div>
          {provider === 'custom' && (
            <div className="preferences-field preferences-custom-search-field">
              <span>自定义搜索地址</span>
              <input
                aria-label="自定义搜索地址"
                aria-describedby={error ? 'preferences-search-help preferences-search-error' : 'preferences-search-help'}
                aria-invalid={Boolean(error)}
                onChange={(event) => changeSearch(provider, event.target.value)}
                placeholder="https://example.com/search?q={query}"
                spellCheck={false}
                value={customTemplate}
              />
              <small id="preferences-search-help">使用 <code>{'{query}'}</code> 表示搜索内容。</small>
              {error && <p className="preferences-error" id="preferences-search-error" data-ui-selectable="true" role="alert" tabIndex={0}>{error}</p>}
            </div>
          )}
        </section>
        <section aria-labelledby="preferences-theme-heading" className="preferences-section">
          <h2 id="preferences-theme-heading">主题</h2>
          <p>设置 Arkdown 的主题颜色。</p>
          <div className="preferences-secondary-group">
            <h3 className="preferences-secondary-heading" id="preferences-theme-color-heading">主题颜色</h3>
            <fieldset
              aria-labelledby="preferences-theme-color-heading"
              className="preferences-theme-color"
              id="preferences-theme-color"
            >
              <div className="preferences-theme-color-controls">
                <div className="preferences-theme-swatches">
                  {THEME_COLOR_PRESETS.map((preset) => (
                    <button
                      aria-label={`主题颜色：${preset.name}`}
                      aria-pressed={themeColor === preset.value}
                      className="preferences-theme-swatch"
                      key={preset.value}
                      onClick={() => changeThemeColor(preset.value)}
                      style={{
                        '--theme-swatch-color': preset.value,
                      } as React.CSSProperties}
                      data-tooltip={`${preset.name} ${preset.value}`}
                      type="button"
                    >
                      <span aria-hidden="true">✓</span>
                    </button>
                  ))}
                </div>
                <label className="preferences-theme-custom">
                  <span>自定义</span>
                  <input
                    aria-label="自定义主题颜色"
                    onChange={(event) => changeThemeColor(
                      normalizeThemeColor(event.target.value),
                    )}
                    type="color"
                    value={themeColor}
                  />
                </label>
                <output aria-label="当前主题颜色">{themeColor}</output>
              </div>
            </fieldset>
          </div>
          <div className="preferences-secondary-group">
            <h3 className="preferences-secondary-heading" id="preferences-background-heading">设置背景</h3>
            <button className="preferences-background-open" onClick={() => {
              setBackgroundError(null)
              void window.arkdown.openBackgroundSettings({ kind: 'main' }).then((result) => {
                if (!result.ok) setBackgroundError(result.error.message)
              }).catch(() => setBackgroundError('背景窗口无法打开'))
            }} type="button">打开设置窗口</button>
            {backgroundError && <p className="preferences-error" role="alert">{backgroundError}</p>}
          </div>
        </section>
        <section aria-labelledby="preferences-editor-heading" className="preferences-section">
          <h2 id="preferences-editor-heading">编辑器</h2>
          <p>这些设置只改变 Arkdown 的显示效果，不修改 Markdown 文档内容。</p>
          <div className="preferences-secondary-group">
            <h3 className="preferences-font-heading preferences-secondary-heading" id="preferences-font-heading">字体选择</h3>
            <div className="preferences-font-grid">
              <FontSelect label="标题中文" fonts={fonts} value={headingCjkFont} onChange={(value) => changeAppearance({ headingCjkFont: value })} />
              <FontSelect label="标题英文" fonts={fonts} value={headingLatinFont} onChange={(value) => changeAppearance({ headingLatinFont: value })} />
              <FontSelect label="正文中文" fonts={fonts} value={bodyCjkFont} onChange={(value) => changeAppearance({ bodyCjkFont: value })} />
              <FontSelect label="正文英文" fonts={fonts} value={bodyLatinFont} onChange={(value) => changeAppearance({ bodyLatinFont: value })} />
            </div>
          </div>
          <div
            aria-labelledby="preferences-editor-layout-heading"
            className="preferences-secondary-group preferences-editor-layout"
            role="group"
          >
            <h3 className="preferences-secondary-heading" id="preferences-editor-layout-heading">编辑器版面</h3>
            <div className="preferences-tertiary-controls">
              <PreferencesRangeControl ariaLabel="最小边距" className="preferences-tertiary-setting"
                label="最小边距" max={150} min={30} suffix="px" value={minimumContentMarginPx}
                onChange={(value) => changeAppearance({ minimumContentMarginPx: value })} />
              <PreferencesRangeControl ariaLabel="正文宽度" className="preferences-tertiary-setting"
                label="正文宽度" max={1200} min={600} suffix="px" value={maximumContentWidthPx}
                onChange={(value) => changeAppearance({ maximumContentWidthPx: value })} />
            </div>
          </div>
          <div className="preferences-secondary-group" id="preferences-single-line-breaks">
            <h3 className="preferences-secondary-heading" id="preferences-single-line-breaks-heading">保留单个换行</h3>
            <label className="preferences-checkbox-label preferences-secondary-control">
              <span className="preferences-checkbox-description">
                <input
                  aria-label="保留单个换行"
                  checked={preserveSingleLineBreaks}
                  onChange={(event) => changeAppearance({ preserveSingleLineBreaks: event.target.checked })}
                  type="checkbox"
                />
                <small>开启后，源码中的每个真实换行都会在即时渲染模式中显示。</small>
              </span>
            </label>
          </div>
          <div className="preferences-secondary-group" id="preferences-spell-check">
            <h3 className="preferences-secondary-heading" id="preferences-spell-check-heading">拼写检查</h3>
            <label className="preferences-checkbox-label preferences-secondary-control">
              <span className="preferences-checkbox-description">
                <input
                  aria-label="拼写检查"
                  checked={spellCheckEnabled}
                  onChange={(event) => changeAppearance({ spellCheckEnabled: event.target.checked })}
                  type="checkbox"
                />
                <small>开启后，编辑器使用系统拼写检查，不会修改 Markdown 内容。</small>
              </span>
            </label>
          </div>
        </section>
        <StickyNotePreferencesSection
          onOpenMaterialSettings={openMaterialSettings}
          launchAtLogin={arknote.launchAtLogin}
          onLaunchAtLoginChange={(launchAtLogin) => changeArknote({ launchAtLogin })}
          onChange={(stickyNotes) => changeArknote({ stickyNotes })}
          surface="arkdown-embedded"
          title="Arknote"
          value={arknote.stickyNotes}
        />
        <ShellIntegrationPreferencesSection
          draft={shellPreferences}
          desktopEnabled={arknote.registerDesktopContextMenu}
          onDesktopChange={onDesktopContextMenuChange}
        />
        <LargeModelSettingsSection
          onManage={openLargeModelManager}
          settings={largeModels}
        />
        <section aria-labelledby="preferences-screenshot-heading" className="preferences-section preferences-screenshot-section">
          <h2 id="preferences-screenshot-heading">截图OCR识别</h2>
          <div className="preferences-screenshot-model" role="group" aria-label="截图 OCR 模型">
            <div className="preferences-screenshot-row">
              <p>{screenshotOcrBundled
                ? 'Full 已内置 PP-OCRv6 Medium 模型。停用后内置文件仍保留，不会释放磁盘空间，可随时重新启用。'
                : '下载使用 PP-OCRv6 Medium 模型以提升识别效果。PP-OCRv6是百度飞桨推出的开源OCR模型。'}</p>
              <div className="preferences-screenshot-control">
                {screenshotOcrBundled && <span role="status">{screenshotOcrModel.activeTier === 'medium' ? '已启用' : screenshotOcrModel.status === 'medium-disabled' ? '已停用' : '暂不可用'}</span>}
                {screenshotOcrModel && (
                  <button
                    aria-disabled={!screenshotOcrObservationReady || screenshotOcrMutation !== null || screenshotOcrDownloading}
                    disabled={!screenshotOcrObservationReady}
                    className="preferences-screenshot-action"
                    onClick={() => {
                      if (!screenshotOcrObservationRef.current || screenshotOcrMutation !== null || screenshotOcrDownloading) return
                      if (screenshotOcrInstalled && !(screenshotOcrBundledToggle && screenshotOcrModel.activeTier === 'small')) {
                        screenshotOcrRemoveObservationRef.current = screenshotOcrObservationRef.current
                          ? { ...screenshotOcrObservationRef.current } : null
                        setScreenshotOcrRemoveConfirmOpen(true)
                        return
                      }
                      void runScreenshotOcrAction(
                        'download', window.arkdown?.downloadScreenshotOcrMedium,
                      )
                    }}
                    type="button"
                  >{screenshotOcrActionLabel}</button>
                )}
                {screenshotOcrModel?.status === 'medium-downloading' && (() => {
                  const progress = screenshotOcrProgressPercent(screenshotOcrModel)
                  return progress === null ? null : (
                    <progress
                      aria-label="下载进度"
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={progress}
                      max={100}
                      value={progress}
                    >{progress}%</progress>
                  )
                })()}
              </div>
            </div>
            {(screenshotOcrModel?.status === 'medium-failed' || screenshotOcrActionFailed) && (
              <p className="preferences-screenshot-error" role="alert">
                {screenshotOcrActionFailed === 'conflict'
                  ? 'OCR 模型偏好已在其他窗口修改，请刷新后核对，再重新操作。'
                  : screenshotOcrActionFailed === 'remove'
                  ? screenshotOcrBundled ? '停用失败，请稍后重试。' : '删除失败，请稍后重试。'
                  : screenshotOcrBundledToggle ? '启用失败，请稍后重试。'
                  : screenshotOcrModel?.mediumVersion === null
                    ? '下载失败，请稍后重试。'
                    : '更新失败，请稍后重试。'}
              </p>
            )}
            {screenshotOcrActionFailed === 'conflict' && <button type="button" disabled={screenshotOcrMutation !== null} onClick={() => void refreshScreenshotOcr()}>
              刷新 OCR 设置
            </button>}
          </div>
        </section>
        <DocumentConversionPreferencesSection />
          </>
        )}

      {screenshotOcrRemoveConfirmOpen && (
        <ScreenshotOcrRemoveDialog
          bundled={screenshotOcrBundled}
          onCancel={() => setScreenshotOcrRemoveConfirmOpen(false)}
          onConfirm={() => {
            setScreenshotOcrRemoveConfirmOpen(false)
            void runScreenshotOcrAction('remove', window.arkdown?.removeScreenshotOcrMedium, screenshotOcrRemoveObservationRef.current)
          }}
          pending={screenshotOcrMutation === 'remove'}
        />
      )}
    </PreferencesShell>
  )
}
