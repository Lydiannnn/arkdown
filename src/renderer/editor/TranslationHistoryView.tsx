import { useEffect, useRef } from 'react'
import { AppIcon } from '../icons/AppIcon'
import { SafeReadonlyMarkdown } from './SafeReadonlyMarkdown'
import type { TranslationHistoryRecord } from './translation-history'

interface TranslationHistoryViewProps {
  record: TranslationHistoryRecord
  onCopy(markdown: string): void | Promise<void>
}

const TERMINAL_LABELS: Record<TranslationHistoryRecord['terminal'], string> = {
  completed: '已完成',
  stopped: '已停止',
  'timeout-partial': '部分结果超时',
}

export function TranslationHistoryView({
  record,
  onCopy,
}: TranslationHistoryViewProps) {
  const viewRef = useRef<HTMLElement>(null)

  useEffect(() => {
    viewRef.current?.focus()
  }, [])

  return (
    <section
      aria-label="翻译记录"
      className="translation-history-view"
      ref={viewRef}
      tabIndex={-1}
    >
      <div className="translation-history-body">
        <div className="translation-history-metadata">
          <p>状态：{TERMINAL_LABELS[record.terminal]}</p>
          <p>模型：{record.modelId}</p>
          <p>目标语言：{record.targetLanguage}</p>
        </div>
        {record.anchor.status === 'location-changed' && (
          <p className="translation-history-anchor-status" role="status">原文位置已变化</p>
        )}
        <SafeReadonlyMarkdown
          className="translation-output translation-history-output"
          data-ui-selectable="true"
          markdown={record.translatedMarkdown}
          tabIndex={0}
        />
        <div className="translation-actions translation-history-copy-action">
          <button
            aria-label="复制译文"
            className="translation-icon-action translation-history-copy-button"
            onClick={() => void onCopy(record.translatedMarkdown)}
            data-tooltip="复制译文"
            type="button"
          >
            <AppIcon name="copy" size={16} />
          </button>
        </div>
      </div>
    </section>
  )
}
