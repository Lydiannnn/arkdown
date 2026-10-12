import type { UpdateSnapshot } from '../../shared/app-update'
import type { UpdateAction } from '../../shared/update-transfer'
import { ArkdownDialog } from '../modal/ArkdownDialog'
import './app-update.css'
export function UpdateDialog({ state, error, onAction, onExit }: { state: UpdateSnapshot | null; error?: string | null; onAction(action: UpdateAction): void; onExit(): void }) {
  const transfer = state?.transfer, candidate = state?.candidate
  if (!candidate || !transfer || transfer.dialog === 'hidden') return null
  const forced = transfer.forced, busy = transfer.phase === 'preparing' || transfer.phase === 'closing'
  const downloading = transfer.phase === 'downloading' || transfer.phase === 'verifying'
  const ready = transfer.phase === 'ready'
  const close = () => {
    if (busy) return
    if (forced) { if (downloading) onAction('cancel-download'); else onExit() }
    else onAction(downloading || ready ? 'dismiss' : 'later')
  }
  const title = busy ? '正在准备安装更新' : downloading ? '正在下载更新' : ready
    ? `现在安装 ${candidate.version} 版本吗？` : forced ? '需要更新 Arkdown' : `发现新版本 ${candidate.version}`
  return <ArkdownDialog role={forced ? 'alertdialog' : 'dialog'} className="application-update-dialog" title={title}
    cancelOnBackdrop={false} onCancel={close} escapeEnabled={!busy} error={transfer.error ?? error}
    description={busy ? '正在检查更新包及保存条件，请稍候。' : forced ? `新版本 ${candidate.version}。关闭此提醒将退出 Arkdown，便签保持运行。`
      : ready ? '安装前将依次确认并保存所有文档。取消任意一次保存，会取消本次安装；已关闭的窗口不会重新打开。' : undefined}
    actions={busy ? <button disabled>请稍候…</button> : downloading ? <>
      <button onClick={() => onAction('cancel-download')}>{forced ? '取消更新' : '取消下载'}</button>
      {!forced && <button className="arkdown-dialog__primary" onClick={() => onAction('dismiss')}>继续下载</button>}
    </> : ready ? <>
      <button onClick={close}>{forced ? '关闭' : '取消'}</button>
      <button className="arkdown-dialog__primary" onClick={() => onAction('install')}>{forced ? '安装更新' : '安装'}</button>
    </> : <>
      <button onClick={close}>{forced ? '关闭' : '暂不更新'}</button>
      <button className="arkdown-dialog__primary" onClick={() => onAction('download')}>{forced ? '更新新版本' : '下载新版本'}</button>
    </>}>
    {!busy && <button className="required-update-close" type="button" aria-label="关闭更新提醒" onClick={close}>×</button>}
    {!downloading && !ready && !busy && candidate.message && <p className="required-update-message">{candidate.message}</p>}
    {downloading && <div className="application-update-progress" aria-live="polite">
      <progress aria-label="更新下载进度" max={transfer.total || 1} value={transfer.received} />
      <span>{transfer.phase === 'verifying' ? '下载完成，正在校验更新包…' : `${Math.floor(transfer.received / (transfer.total || 1) * 100)}%`}</span>
    </div>}
    {!forced && !candidate.required && !downloading && !ready && !busy && <button className="app-update-link application-update-skip" onClick={() => onAction('skip')}>跳过该版本</button>}
  </ArkdownDialog>
}
export function updateIndicatorLabel(state: UpdateSnapshot | null): string | undefined {
  if (!state?.candidate || !state.bubbleVisible) return undefined
  const transfer = state.transfer
  if (transfer?.phase === 'downloading') return `正在下载 ${Math.floor(transfer.received / (transfer.total || 1) * 100)}%`
  if (transfer?.phase === 'verifying') return '正在校验更新包'
  if (transfer?.phase === 'ready') return `已下载 ${state.candidate.version} 版本`
  if (transfer?.phase === 'failed') return '更新下载失败，点击重试'
  return state.candidate.required ? '需要更新' : '发现新版本'
}
