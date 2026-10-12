import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { BusinessMessageApi, BusinessMessageState } from '../../shared/business-message-dialog'
import { ArkdownDialog } from './ArkdownDialog'
import './business-message-surface.css'

export function BusinessMessageSurface({ api = (window as unknown as { arkdownMessage: BusinessMessageApi }).arkdownMessage }: { api?: BusinessMessageApi }) {
  const [state, setState] = useState<BusinessMessageState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const defaultButton = useRef<HTMLButtonElement>(null)
  const messageId = useId(), detailId = useId()
  useEffect(() => {
    let alive = true
    void api.get().then(value => { if (alive) setState(value) }).catch(() => { if (alive) setError('无法取得提示内容。') })
    return () => { alive = false }
  }, [api])
  useLayoutEffect(() => {
    if (state) document.documentElement.dataset.arkdownTheme = state.dark ? 'dark' : 'minimal'
  }, [state?.dark])
  useEffect(() => {
    if (!state) return
    const dialog = defaultButton.current?.closest<HTMLElement>('.business-message-dialog')
    const content = dialog?.querySelector<HTMLElement>('.arkdown-dialog__content')
    if (!dialog || !content) return
    let alive = true, lastHeight = 0
    const measure = () => {
      if (!alive) return
      // offsetHeight ignores the entrance animation's scale. Include overflow so
      // a screen-capped dialog can recover its natural size after text/width changes.
      const height = Math.max(120, dialog.offsetHeight + Math.max(0, content.scrollHeight - content.clientHeight))
      if (height === lastHeight) return
      lastHeight = height
      void api.ready({ requestId: state.requestId, height }).catch(() => {
        if (alive) setError('提示连接暂不可用，请重新操作。')
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(dialog); observer.observe(content)
    for (const child of content.children) observer.observe(child)
    measure()
    void document.fonts?.ready.then(measure)
    return () => { alive = false; observer.disconnect() }
  }, [api, state?.requestId])
  async function respond(response: number) {
    if (!state || busyRef.current) return
    busyRef.current = true; setBusy(true); setError('')
    try {
      if (!await api.respond({ requestId: state.requestId, response })) throw new Error('stale')
    } catch {
      busyRef.current = false; setBusy(false); setError('操作未能完成，请重试。')
    }
  }
  // Main owns window closure. Do not enter the shared dialog's irreversible
  // exit animation until IPC has actually accepted the choice.
  useEffect(() => {
    if (!state) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault(); event.stopPropagation()
      void respond(state.cancelId)
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [api, state])
  if (!state) return <p role="status">{error || '正在加载提示…'}</p>
  return <ArkdownDialog
    title={state.title}
    ariaDescribedBy={state.detail ? `${messageId} ${detailId}` : messageId}
    error={error}
    initialFocusRef={defaultButton}
    onCancel={() => void respond(state.cancelId)}
    cancelOnBackdrop={false}
    escapeEnabled={false}
    backdropClassName="business-message-surface"
    className="business-message-dialog"
    actions={state.buttons.map((text, index) => <button key={index} type="button"
      ref={index === state.defaultId ? defaultButton : undefined}
      className={index === state.defaultId ? 'arkdown-dialog__primary' : undefined}
      disabled={busy} onClick={() => void respond(index)}>{text}</button>)}
  >
    <button type="button" className="business-message-dialog__close" aria-label="关闭" disabled={busy}
      onClick={() => void respond(state.cancelId)}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
    </button>
    <p id={messageId} className="business-message-dialog__message">{state.message}</p>
    {state.detail && <p id={detailId} className="arkdown-dialog__description">{state.detail}</p>}
  </ArkdownDialog>
}
