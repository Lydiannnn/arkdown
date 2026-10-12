import { areModelRulesReady, useModelRulesReady } from '../settings/model-rules-runtime'
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react'
import type { SelectionAnchorRect } from '../../shared/selection-translation'
import { AppIcon } from '../icons/AppIcon'
import {
  isPartialTranslationTimeout,
  PARTIAL_TRANSLATION_TIMEOUT_MESSAGE,
  type TranslationUiState,
} from './translation-ui-state'
import { SafeReadonlyMarkdown } from './SafeReadonlyMarkdown'
import { ModelConfigurationNotice } from './ModelConfigurationNotice'
import './selection-translation.css'
import './translation-history-rail.css'

interface Size {
  width: number
  height: number
}

interface TranslationPopoverProps {
  anchorRect: SelectionAnchorRect
  state: TranslationUiState
  selectionScope?: 'selection' | 'document'
  viewport?: Size
  popoverSize?: Size
  onTranslate(): void
  onQuoteToAi?(): void
  onStop(): void
  onCopy(output: string): void | Promise<void>
  onClose(): void
  onOpenSettings(): void
  historyRecordId?: string | null
  hidden?: boolean
  historyButtonRef?: Ref<HTMLButtonElement>
  onOpenHistory?(recordId: string, initiator: HTMLButtonElement): void
  onRetry?(): void
}

const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 8
const DEFAULT_POPOVER_SIZE: Size = { width: 280, height: 48 }
const READY_TRIGGER_SIZE: Size = { width: 30, height: 30 }
const DOCUMENT_TRIGGER_SIZE: Size = { width: 104, height: 32 }

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

export function computeTranslationPopoverPosition({
  anchorRect,
  popoverSize,
  viewport,
  preferBelow = false,
  verticalOffset = 0,
}: {
  anchorRect: SelectionAnchorRect
  popoverSize: Size
  viewport: Size
  preferBelow?: boolean
  verticalOffset?: number
}): { left: number; top: number; placement: 'above' | 'below' } {
  const aboveTop = anchorRect.top - ANCHOR_GAP - popoverSize.height + verticalOffset
  const belowTop = anchorRect.bottom + ANCHOR_GAP + verticalOffset
  const belowFits = belowTop + popoverSize.height <= viewport.height - VIEWPORT_MARGIN
  const placement = preferBelow
    ? (belowFits ? 'below' : 'above')
    : (aboveTop >= VIEWPORT_MARGIN ? 'above' : 'below')
  const desiredTop = placement === 'above'
    ? aboveTop
    : belowTop
  const desiredLeft = anchorRect.left + anchorRect.width / 2 - popoverSize.width / 2

  return {
    left: clamp(
      desiredLeft,
      VIEWPORT_MARGIN,
      viewport.width - VIEWPORT_MARGIN - popoverSize.width,
    ),
    top: clamp(
      desiredTop,
      VIEWPORT_MARGIN,
      viewport.height - VIEWPORT_MARGIN - popoverSize.height,
    ),
    placement,
  }
}

export function TranslationPopover({
  anchorRect,
  state,
  selectionScope = 'selection',
  viewport = { width: window.innerWidth, height: window.innerHeight },
  popoverSize,
  onTranslate,
  onQuoteToAi,
  onStop,
  onCopy,
  onClose,
  onOpenSettings,
  historyRecordId = null,
  hidden = false,
  historyButtonRef,
  onOpenHistory,
  onRetry,
}: TranslationPopoverProps) {
  const modelRulesReady = useModelRulesReady()
  const rootRef = useRef<HTMLDivElement>(null)
  const [measuredSize, setMeasuredSize] = useState(DEFAULT_POPOVER_SIZE)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCopying, setIsCopying] = useState(false)

  useLayoutEffect(() => {
    if (popoverSize) return
    const bounds = rootRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return
    setMeasuredSize((current) => (
      current.width === bounds.width && current.height === bounds.height
        ? current
        : { width: bounds.width, height: bounds.height }
    ))
  }, [popoverSize, selectionScope, state])

  useEffect(() => {
    if (state.status !== 'ready' && state.status !== 'failed') setIsSubmitting(false)
  }, [state.status])

  useEffect(() => {
    if (hidden) return
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('pointerdown', dismissOutside, true)
    return () => document.removeEventListener('pointerdown', dismissOutside, true)
  }, [hidden, onClose])

  const position = computeTranslationPopoverPosition({
    anchorRect,
    popoverSize: popoverSize ?? (state.status === 'ready'
      ? selectionScope === 'document' ? DOCUMENT_TRIGGER_SIZE : onQuoteToAi ? { width: 79.3, height: 30 } : READY_TRIGGER_SIZE
      : measuredSize),
    viewport,
    preferBelow: state.status === 'ready',
    verticalOffset: state.status === 'ready' && selectionScope === 'selection' ? 10 : 0,
  })
  const hasOutput = state.output !== ''
  const isModelUnconfigured = state.status === 'failed'
    && state.errorCode === 'MODEL_NOT_CONFIGURED'
  const partialTimeout = isPartialTranslationTimeout(state)

  const submitTranslation = (submit: () => void) => {
    if (!areModelRulesReady() || isSubmitting) return
    setIsSubmitting(true)
    submit()
  }

  const copyOutput = async (output: string) => {
    if (isCopying) return
    setIsCopying(true)
    try {
      await onCopy(output)
    } finally {
      setIsCopying(false)
    }
  }

  return (
    <div
      aria-label="划词翻译"
      className={`translation-popover${state.status === 'ready' ? ' translation-popover--ready' : ''}${state.status === 'ready' && selectionScope === 'document' ? ' translation-popover--document' : ''}${state.status === 'ready' && selectionScope !== 'document' && onQuoteToAi ? ' translation-popover--dual' : ''}`}
      data-placement={position.placement}
      hidden={hidden}
      ref={rootRef}
      role="dialog"
      style={{ left: position.left, top: position.top }}
    >
      {state.status === 'ready' && (
        <>
        <button
          aria-label={selectionScope === 'document' ? '全文翻译' : '翻译选中的文本'}
          data-tooltip={selectionScope === 'document' ? '全文翻译' : '翻译选中文本'}
          className={`translation-popover-trigger${selectionScope === 'document' ? ' translation-popover-trigger--document' : ''}`}
          disabled={isSubmitting || !modelRulesReady}
          onClick={() => submitTranslation(onTranslate)}
          type="button"
        >
          <AppIcon name="translate" size={18} />
          {selectionScope === 'document' && <span>全文翻译</span>}
        </button>
        {selectionScope !== 'document' && onQuoteToAi && <>
          <span className="translation-popover-divider" aria-hidden="true" />
          <button type="button" aria-label="引用到 AI 对话" data-tooltip="引用到 AI 对话"
            className="translation-popover-trigger"
            onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}
            onClick={onQuoteToAi}><AppIcon name="ai" size={18} /></button>
        </>}
        </>
      )}

      {state.status === 'starting' && (
        <>
          <p aria-live="polite" className="translation-status">正在翻译…</p>
          <div className="translation-actions">
            <button onClick={onStop} type="button">停止</button>
          </div>
        </>
      )}

      {state.status === 'streaming' && (
        <>
          <SafeReadonlyMarkdown aria-live="polite" className="translation-output" data-ui-selectable="true" markdown={state.output} tabIndex={0} />
          <div className="translation-actions">
            <button onClick={onStop} type="button">停止</button>
          </div>
        </>
      )}

      {state.status === 'completed' && (
        <>
          <SafeReadonlyMarkdown aria-live="polite" className="translation-output" data-ui-selectable="true" markdown={state.output} tabIndex={0} />
          <div className="translation-actions">
            <button disabled={isCopying} onClick={() => void copyOutput(state.output)} type="button">
              {isCopying ? '正在复制…' : '复制'}
            </button>
            <button onClick={onClose} type="button">关闭</button>
          </div>
        </>
      )}

      {state.status === 'stopped' && (
        <>
          <p aria-live="polite" className="translation-status">已停止</p>
          {hasOutput && (
            <SafeReadonlyMarkdown aria-live="polite" className="translation-output" data-ui-selectable="true" markdown={state.output} tabIndex={0} />
          )}
          <div className="translation-actions">
            {hasOutput && (
              <button disabled={isCopying} onClick={() => void copyOutput(state.output)} type="button">
                {isCopying ? '正在复制…' : '复制'}
              </button>
            )}
            <button onClick={onClose} type="button">关闭</button>
          </div>
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
          {hasOutput && (
            <SafeReadonlyMarkdown aria-live="polite" className="translation-output" data-ui-selectable="true" markdown={state.output} tabIndex={0} />
          )}
          <div className="translation-actions">
              {partialTimeout && (
                <button disabled={isCopying} onClick={() => void copyOutput(state.output)} type="button">
                  {isCopying ? '正在复制…' : '复制'}
                </button>
              )}
              {!partialTimeout && onRetry && (
                <button
                  disabled={isSubmitting || !modelRulesReady}
                  onClick={() => submitTranslation(onRetry)}
                  type="button"
                >
                  {isSubmitting ? '正在翻译…' : '重试'}
                </button>
              )}
            <button onClick={onClose} type="button">关闭</button>
          </div>
          </>
        )
      )}
      {state.status !== 'ready' && !isModelUnconfigured && (
        <div className="translation-history-entry">
          <button
            disabled={!historyRecordId}
            onClick={(event) => {
              if (historyRecordId) onOpenHistory?.(historyRecordId, event.currentTarget)
            }}
            ref={historyButtonRef}
            type="button"
          >
            翻译记录
          </button>
        </div>
      )}
    </div>
  )
}
