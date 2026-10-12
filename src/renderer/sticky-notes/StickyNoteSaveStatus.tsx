import type { StickyNoteSaveState } from '../../shared/sticky-notes'

export interface StickyNoteSaveStatusProps {
  state: StickyNoteSaveState
  onRetry?(): void
  onCancelClose?(): void
}

export function StickyNoteSaveStatus({
  state,
  onRetry,
  onCancelClose,
}: StickyNoteSaveStatusProps) {
  if (state.status === 'error') {
    return (
      <div className="sticky-note-save-status is-error" role="alert">
        <span>保存失败：{state.message}</span>
        {onRetry && <button onClick={onRetry} type="button">重试</button>}
        {onCancelClose && <button onClick={onCancelClose} type="button">取消关闭</button>}
      </div>
    )
  }
  return null
}
