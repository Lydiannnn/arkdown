import { useEffect, useRef, useState } from 'react'
import { ArrowRight, FileText, FolderOpen } from '@phosphor-icons/react'
import { ArkdownDialog } from '../modal/ArkdownDialog'
import '../icons/app-icon.css'
import './workspace-introduction.css'

const seenKey = 'arkdown.workspace-intro-seen.v1'

export function WorkspacePickerButton({ name, disabled, chooseWorkspace }: {
  name: string
  disabled: boolean
  chooseWorkspace(): Promise<void>
}) {
  const [introductionOpen, setIntroductionOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const seenThisMount = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const continueButton = useRef<HTMLButtonElement>(null)
  const openChooser = async () => {
    pending.current = true
    setBusy(true)
    try { await chooseWorkspace() }
    catch { if (mounted.current) setError('文件夹选择未能完成，请重试。') }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  const choose = async () => {
    if (disabled || pending.current) return
    pending.current = true; setBusy(true); setError(null)
    if (seenThisMount.current) { await openChooser(); return }
    let legacySeen = false
    try { legacySeen = localStorage.getItem(seenKey) === '1' } catch { /* Main owns durable state. */ }
    try {
      const result = await window.arkdown?.claimWorkspaceIntroduction?.(legacySeen)
      if (!mounted.current) return
      if (!result?.ok) throw new Error('intro-persistence-failed')
      seenThisMount.current = true
      if (result.value.showIntroduction) { setBusy(false); setIntroductionOpen(true) }
      else await openChooser()
    } catch {
      pending.current = false
      if (mounted.current) { setBusy(false); setError('引导状态未能保存，请重试。') }
    }
  }
  return <>
    <button className="sidebar-title" disabled={disabled || busy} onClick={() => { void choose() }} ref={trigger} type="button">
      <svg className="app-icon workspace-library-icon" width="22" height="22" viewBox="0 0 22 22"
        fill="none" stroke="currentColor" strokeWidth="1.375" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true" focusable="false">
        <rect x="3.25" y="5.25" width="8" height="12" rx=".65" />
        <path d="M7.25 5.25v12" />
        <path d="m12.5 5.9 3.4-.9 3.1 11.6-3.4.9ZM2.5 19.25h17m-15-10.5h1.5m3 0H10" />
      </svg>
      <span className="workspace-title-label">{name}</span>
    </button>
    {error && <ArkdownDialog title="未能打开文件夹选择" size="small" restoreFocusElement={trigger.current}
      onCancel={() => setError(null)}
      actions={({ closing, requestClose }) => <button type="button" disabled={closing}
        onClick={() => requestClose(() => { setError(null); void choose() })}>重试</button>}>
      <p role="alert">{error}</p>
    </ArkdownDialog>}
    {introductionOpen && <ArkdownDialog
      title="让文档出现在这里"
      description="选一个文档文件夹，里面的文档就会显示在左侧文件树中。"
      className="workspace-introduction"
      size="small"
      initialFocusRef={continueButton}
      restoreFocusElement={trigger.current}
      onCancel={() => { pending.current = false; setIntroductionOpen(false) }}
      actions={({ closing, requestClose }) => <>
        <button disabled={closing} ref={continueButton} type="button"
          onClick={() => requestClose(() => { setIntroductionOpen(false); void openChooser() })}>
          好的
        </button>
      </>}
    >
      <div className="workspace-introduction-demo" aria-hidden="true">
        <div className="workspace-introduction-folder"><FolderOpen size={36} weight="regular" /><span>文档文件夹</span></div>
        <ArrowRight size={20} />
        <div className="workspace-introduction-tree">
          <span><FileText size={16} />我的笔记.md</span>
          <span><FileText size={16} />写作计划.md</span>
          <span><FileText size={16} />资料整理.md</span>
        </div>
      </div>
    </ArkdownDialog>}
  </>
}
