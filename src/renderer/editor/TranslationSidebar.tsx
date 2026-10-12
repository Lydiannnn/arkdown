import {
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from 'react'
import type { TranslationEditorMode } from '../../shared/selection-translation'
import type {
  TranslationHistoryRecord,
  TranslationHistoryRevealAlignment,
} from './translation-history'
import {
  isPartialTranslationTimeout,
  PARTIAL_TRANSLATION_TIMEOUT_MESSAGE,
  type TranslationUiState,
} from './translation-ui-state'
import { SafeReadonlyMarkdown } from './SafeReadonlyMarkdown'
import { TranslationHistoryView } from './TranslationHistoryView'
import { EditorRightSidebar } from './EditorRightSidebar'
import { AppIcon } from '../icons/AppIcon'
import { ModelConfigurationNotice } from './ModelConfigurationNotice'
import { ModelThinkingControls, type ThinkingControlProps } from './ModelThinkingControls'
import './selection-translation.css'

export type TranslationSidebarView =
  | { kind: 'live' }
  | { kind: 'history'; recordId: string }

interface TranslationSidebarProps extends ThinkingControlProps {
  settingsError?: string | null
  onRetrySettings?(): void
  state: TranslationUiState
  mode: TranslationEditorMode
  containerWidth?: number
  selectionTop: number
  surfaceTop: number
  alignmentHeight: number
  resultHeight: number
  hasSelection?: boolean
  onTranslate(): void
  onStop(): void
  onCopy(output: string): void | Promise<void>
  onClose(): void
  onOpenSettings?(): void
  onRetry?(): void
  onWidthChange?(width: number): void
  view?: TranslationSidebarView
  historyRecords?: readonly TranslationHistoryRecord[]
  historyRecordId?: string | null
  historyButtonRef?: Ref<HTMLButtonElement>
  onOpenHistory?(recordId: string, initiator: HTMLButtonElement): void
  onReturnToLive?(): void
  onSelectHistory?(recordId: string, alignment?: TranslationHistoryRevealAlignment): void
  canReturnToLive?: boolean
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

const SIDEBAR_ALIGNMENT_LIFT_PX = 48

export function computeTranslationSidebarTopOffset({
  selectionTop,
  surfaceTop,
  alignmentHeight,
  resultHeight,
}: Pick<
  TranslationSidebarProps,
  | 'selectionTop'
  | 'surfaceTop'
  | 'alignmentHeight'
  | 'resultHeight'
>): number {
  return clamp(
    selectionTop - surfaceTop - SIDEBAR_ALIGNMENT_LIFT_PX,
    0,
    Math.max(0, alignmentHeight - resultHeight),
  )
}

export function computeTranslationSidebarReadyTopOffset({
  selectionTop,
  surfaceTop,
  alignmentHeight,
  resultHeight,
}: Pick<
  TranslationSidebarProps,
  | 'selectionTop'
  | 'surfaceTop'
  | 'alignmentHeight'
  | 'resultHeight'
>): number {
  const minimum = alignmentHeight * 0.1
  const maximum = Math.max(
    minimum,
    Math.min(alignmentHeight * 0.7, alignmentHeight - resultHeight),
  )
  return clamp(
    selectionTop - surfaceTop - SIDEBAR_ALIGNMENT_LIFT_PX,
    minimum,
    maximum,
  )
}

type TranslationSidebarContentProps = Omit<
  TranslationSidebarProps,
  'containerWidth' | 'onWidthChange'
>

function TranslationResultActions({
  output,
  onCopy,
  onClose,
}: {
  output: string
  onCopy(output: string): void | Promise<void>
  onClose(): void
}) {
  return (
    <div className="translation-actions">
      {output !== '' && (
        <button
          aria-label="复制"
          className="translation-icon-action translation-result-icon-action"
          onClick={() => void onCopy(output)}
          data-tooltip="复制"
          type="button"
        >
          <AppIcon name="copy" size={16} />
        </button>
      )}
      <button
        aria-label="关闭"
        className="translation-icon-action translation-result-icon-action"
        onClick={onClose}
        data-tooltip="关闭"
        type="button"
      >
        <AppIcon name="close" size={16} />
      </button>
    </div>
  )
}

export function TranslationSidebar({
  containerWidth,
  onWidthChange,
  ...contentProps
}: TranslationSidebarProps) {
  if (containerWidth === undefined) return <TranslationSidebarContent {...contentProps} />
  return (
    <EditorRightSidebar
      activeTab="translation"
      containerWidth={containerWidth}
      onActiveTabChange={() => undefined}
      onWidthChange={onWidthChange}
    >
      <TranslationSidebarContent {...contentProps} />
    </EditorRightSidebar>
  )
}

function TranslationSidebarContent({
  state,
  thinkingConnection, thinkingPreference, thinkingPending, onThinkingChange, settingsError, onRetrySettings,
  mode,
  selectionTop,
  surfaceTop,
  alignmentHeight,
  resultHeight,
  onTranslate,
  onStop,
  onCopy,
  onClose,
  onOpenSettings,
  onRetry,
  view = { kind: 'live' },
  historyRecords = [],
  historyRecordId = null,
  historyButtonRef,
  onOpenHistory,
  onReturnToLive,
  onSelectHistory,
  canReturnToLive = true,
  hasSelection = true,
}: TranslationSidebarContentProps) {
  const [scrollViewportHeight, setScrollViewportHeight] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const translationActive = state.status === 'starting' || state.status === 'streaming'
  const alignmentInput = {
    selectionTop,
    surfaceTop,
    alignmentHeight: translationActive && scrollViewportHeight !== null && scrollViewportHeight > 0
      ? scrollViewportHeight
      : alignmentHeight,
    resultHeight,
  }
  const hasOutput = state.output !== ''
  const isModelUnconfigured = state.status === 'failed'
    && state.errorCode === 'MODEL_NOT_CONFIGURED'
  const topOffset = state.status === 'ready'
      ? computeTranslationSidebarReadyTopOffset(alignmentInput)
      : computeTranslationSidebarTopOffset(alignmentInput)
  const partialTimeout = isPartialTranslationTimeout(state)
  const hasTerminalSurface = hasOutput && (
    state.status === 'completed'
    || state.status === 'stopped'
    || partialTimeout
  )
  const outputClassName = `translation-output translation-output-${mode}`
  const terminalOutputClassName = `${outputClassName}${hasTerminalSurface ? ' has-terminal-surface' : ''}`
  const historyIndex = view.kind === 'history'
    ? historyRecords.findIndex(({ id }) => id === view.recordId)
    : -1
  const historyRecord = historyIndex >= 0 ? historyRecords[historyIndex] : null

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const measure = () => {
      const nextHeight = scroll.clientHeight
      setScrollViewportHeight((current) => current === nextHeight ? current : nextHeight)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measure)
    observer?.observe(scroll)
    return () => observer?.disconnect()
  }, [translationActive])

  return (
    <div className="translation-sidebar-content">
      <div
        className={`translation-sidebar-scroll translation-sidebar-live-scroll${isModelUnconfigured ? ' is-unconfigured' : ''}`}
        hidden={view.kind === 'history'}
        ref={scrollRef}
      >
        <section
          className={`translation-sidebar-result${state.status === 'ready' ? ' is-ready' : ''}`}
          data-testid="translation-sidebar-result"
          style={{ marginTop: isModelUnconfigured ? 0 : topOffset }}
        >
          {state.status === 'ready' && hasSelection && (
            <button
              className="translation-primary-action translation-sidebar-ready-action"
              onClick={onTranslate}
              disabled={thinkingPending}
              type="button"
            >
              翻译选中的文本
            </button>
          )}

          {state.status === 'starting' && (
            <p className="translation-status">正在翻译…</p>
          )}

          {state.status === 'streaming' && (
            <>
              {hasOutput && (
                <SafeReadonlyMarkdown
                  className={outputClassName}
                  data-ui-selectable="true"
                  markdown={state.output}
                  tabIndex={0}
                />
              )}
            </>
          )}

          {state.status === 'completed' && (
            <>
              <SafeReadonlyMarkdown
                className={terminalOutputClassName}
                data-ui-selectable="true"
                markdown={state.output}
                tabIndex={0}
              />
              <TranslationResultActions
                onClose={onClose}
                onCopy={onCopy}
                output={state.output}
              />
            </>
          )}

          {state.status === 'stopped' && (
            <>
              <p className="translation-status">已停止</p>
              {hasOutput && (
                <SafeReadonlyMarkdown
                  className={terminalOutputClassName}
                  data-ui-selectable="true"
                  markdown={state.output}
                  tabIndex={0}
                />
              )}
              <TranslationResultActions
                onClose={onClose}
                onCopy={onCopy}
                output={state.output}
              />
            </>
          )}

          {state.status === 'failed' && (
            isModelUnconfigured ? (
              <ModelConfigurationNotice onConfigure={onOpenSettings} onDismiss={onClose} role="alert" />
            ) : (
              <>
                <p className="translation-error" data-ui-selectable="true" role="alert" tabIndex={0}>
                  {partialTimeout
                    ? PARTIAL_TRANSLATION_TIMEOUT_MESSAGE
                    : state.error ?? '翻译失败，请重试。'}
                </p>
                {partialTimeout && (
                  <SafeReadonlyMarkdown
                    aria-live="polite"
                    className={terminalOutputClassName}
                    data-ui-selectable="true"
                    markdown={state.output}
                    tabIndex={0}
                  />
                )}
                {partialTimeout ? (
                  <TranslationResultActions
                    onClose={onClose}
                    onCopy={onCopy}
                    output={state.output}
                  />
                ) : (
                  <div className="translation-actions">
                    {onRetry && <button disabled={thinkingPending} onClick={onRetry} type="button">重试</button>}
                    <button onClick={onClose} type="button">关闭</button>
                  </div>
                )}
              </>
            )
          )}
        </section>
      </div>
      {view.kind === 'history' ? (
        <div className="translation-sidebar-scroll translation-sidebar-history-scroll">
          {historyRecord ? (
            <TranslationHistoryView
              onCopy={onCopy}
              record={historyRecord}
            />
          ) : (
            <section aria-label="翻译记录" className="translation-history-view">
              <div className="translation-history-body translation-history-empty-body">
                <p className="translation-history-empty-state">暂无翻译记录</p>
              </div>
            </section>
          )}
        </div>
      ) : null}
      {settingsError && <p className="translation-error" role="alert">{settingsError}</p>}
      {onRetrySettings && <div className="translation-settings-recovery">
        <button type="button" disabled={thinkingPending || translationActive} onClick={onRetrySettings}
          title="保留当前选择，按最新设置重试保存">重试保存设置</button>
        {onOpenSettings && <button type="button" disabled={thinkingPending} onClick={onOpenSettings}>打开设置处理</button>}
      </div>}
      <div className={`translation-sidebar-footer${translationActive ? ' translation-sidebar-stop-bar' : ''}`}>
        <div className="translation-sidebar-footer-left">
          {view.kind === 'live' && <ModelThinkingControls label="翻译" thinkingConnection={thinkingConnection}
            thinkingPreference={thinkingPreference} thinkingPending={thinkingPending || translationActive} onThinkingChange={onThinkingChange} />}
          {view.kind === 'history' && historyRecord ? <>
            <button
              aria-label="上一条"
              className="translation-history-navigation-button"
              disabled={historyIndex <= 0}
              onClick={() => {
                const previous = historyRecords[historyIndex - 1]
                if (previous) onSelectHistory?.(previous.id, 'center')
              }}
              type="button"
              data-tooltip="上一条"
            >
              <AppIcon name="previous" size={17} />
            </button>
            <span aria-live="polite" className="translation-history-counter">
              {historyIndex + 1}/{historyRecords.length}
            </span>
            <button
              aria-label="下一条"
              className="translation-history-navigation-button"
              disabled={historyIndex >= historyRecords.length - 1}
              onClick={() => {
                const next = historyRecords[historyIndex + 1]
                if (next) onSelectHistory?.(next.id, 'center')
              }}
              type="button"
              data-tooltip="下一条"
            >
              <AppIcon name="next" size={17} />
            </button>
          </> : null}
        </div>
        <div className="translation-sidebar-footer-right">
          <button
            aria-label="查看翻译记录"
            className="translation-history-open-action"
            disabled={!historyRecordId}
            hidden={view.kind === 'history'}
            onClick={(event) => {
              if (historyRecordId) onOpenHistory?.(historyRecordId, event.currentTarget)
            }}
            ref={historyButtonRef}
            data-tooltip="查看翻译记录"
            type="button"
          >
            查看翻译记录
          </button>
          {view.kind === 'history' ? (
            <button
              aria-label={canReturnToLive ? '返回当前翻译' : '关闭翻译记录'}
              className="translation-icon-action"
              onClick={onReturnToLive}
              data-tooltip={canReturnToLive ? '返回当前翻译' : '关闭翻译记录'}
              type="button"
            >
              <AppIcon name={canReturnToLive ? 'return' : 'close-history'} size={16} />
            </button>
          ) : null}
          {translationActive && <button onClick={onStop} type="button">停止翻译</button>}
        </div>
      </div>
    </div>
  )
}
