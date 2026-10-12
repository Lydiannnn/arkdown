import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CloseRecoveryApi, CloseRecoveryAction, CloseRecoveryState } from '../../shared/close-recovery'
import '../modal/arkdown-dialog.css'
import './close-recovery.css'

const stages: Record<CloseRecoveryState['stage'], string> = {
  'prepare-editor': '正在检查编辑区', 'await-user': '等待你的选择', 'await-preferences': '等待处理未保存的设置', 'settle-document': '正在确认文档和草稿的保存结果',
  'settle-preferences': '正在保存偏好设置', 'quiesce-owner': '正在等待本窗口的任务安全结束',
  'drain-ipc': '正在等待已开始的操作结束', 'persist-window': '正在保存窗口设置',
  finalize: '正在清理窗口资源', 'native-close': '正在等待系统关闭窗口', 'restore-editor': '正在恢复编辑状态',
}
const errors: Record<NonNullable<CloseRecoveryState['error']>, string> = {
  'editor-unavailable': '编辑区尚未完成关闭检查，当前窗口保留。',
  'document-save-failed': '文档保存失败，当前内容保留。请返回编辑区检查保存提示。',
  'draft-end-failed': '草稿处理未能完成，当前内容保留。',
  'document-result-unknown': '正在确认保存结果，请勿重复提交。',
  'preferences-save-failed': '偏好设置尚未保存或应用完成，请返回设置处理。',
  'ai-drain-failed': 'AI 任务未能完成关闭清理，请查看阶段信息。',
  'owner-close-failed': '本窗口的任务清理失败。', 'ipc-drain-failed': '在途操作清理失败。',
  'window-settings-failed': '窗口位置等设置保存失败。', 'cleanup-failed': '窗口资源清理失败，当前阶段无法返回编辑。',
  'native-close-failed': '系统未能关闭窗口，可以再次请求关闭。', 'restore-failed': '编辑状态未能恢复，请保留窗口并复制诊断。',
}
export function CloseRecoverySurface({ api = (window as unknown as { arkdownClose: CloseRecoveryApi }).arkdownClose }: { api?: CloseRecoveryApi }) {
  const [state, setState] = useState<CloseRecoveryState | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const content = useRef<HTMLElement>(null)
  useEffect(() => {
    if (state) document.documentElement.dataset.arkdownTheme = state.dark ? 'dark' : 'minimal'
  }, [state?.dark])
  useLayoutEffect(() => {
    if (!state || !content.current) return
    const report = () => {
      const height = content.current?.getBoundingClientRect().height ?? 0
      if (height > 0) void api.ready({ attemptId: state.attemptId, generation: state.generation, height }).catch(() => undefined)
    }
    report()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(report)
    observer?.observe(content.current)
    return () => observer?.disconnect()
  }, [api, state?.attemptId, state?.generation, state?.confirmAi, state?.error, state?.rendererUnavailable, state?.feedback, notice])
  useEffect(() => {
    let alive = true, changed = false
    const unsubscribe = api.subscribe(value => { changed = true; if (alive) setState(value) })
    void api.get().then(value => { if (alive && !changed) setState(value) }).catch(() => { if (alive) setNotice('无法取得关闭状态，请保留窗口。') })
    return () => { alive = false; unsubscribe() }
  }, [api])
  const act = async (action: CloseRecoveryAction['action']) => {
    if (!state || busy) return
    setBusy(true); setNotice('')
    try {
      const accepted = await api.act({ attemptId: state.attemptId, generation: state.generation, action })
      setNotice(accepted ? action === 'copy' ? '诊断已复制。' : '' : '状态已变化，请按当前可用操作继续。')
    } catch { setNotice('操作未能完成，当前关闭状态保留。') }
    finally { setBusy(false) }
  }
  const description = !state ? '正在取得关闭状态…' : state.confirmAi
    ? 'AI 任务仍在运行，是否停止任务并关闭？已经提交的修改不会被撤销。'
    : state.error ? errors[state.error] : state.rendererUnavailable
      ? '编辑区连接暂不可用。保存结果尚未确认，窗口会继续保留。'
      : state.feedback === 'no-progress' || state.feedback === 'long-wait'
        ? '这一阶段等待较久，操作仍在进行。只有结果确认后，才会开放安全的返回或重试。'
        : '正在完成关闭前的检查。'
  return <div className="arkdown-dialog-backdrop close-recovery-surface" data-arkdown-theme={state?.dark ? 'dark' : 'light'}>
    <section ref={content} className="arkdown-dialog" role="dialog" aria-modal="false" aria-labelledby="close-recovery-title">
      <header className="arkdown-dialog__header"><h1 className="arkdown-dialog__title" id="close-recovery-title">{state?.confirmAi ? '关闭 Arkdown' : '正在关闭 Arkdown'}</h1>
        <p className="arkdown-dialog__description">{description}</p></header>
      {state && !state.confirmAi && <p role="status" className="arkdown-dialog__description">{stages[state.stage]} · {Math.floor(state.elapsedMs / 1000)} 秒</p>}
      {notice && <p role="status" className="arkdown-dialog__description">{notice}</p>}
      <footer className="arkdown-dialog__actions">
        {state?.confirmAi ? <>
          <button type="button" disabled={busy} onClick={() => void act('continue-using')}>继续使用</button>
          <button type="button" className="arkdown-dialog__primary" disabled={busy} onClick={() => void act('stop-ai-and-close')}>停止任务并关闭</button>
        </> : <>
          <button type="button" disabled={busy || !state} onClick={() => void act('copy')}>复制诊断</button>
          <button type="button" className={state?.canReturn ? 'arkdown-dialog__primary' : undefined} disabled={busy || !state?.canReturn} onClick={() => void act('return')}>返回编辑</button>
          <button type="button" disabled={busy || !state?.canRetry} onClick={() => void act('retry')}>重试关闭</button>
        </>}
      </footer>
    </section>
  </div>
}
