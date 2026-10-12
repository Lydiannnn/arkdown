import { useEffect, useRef, useState } from 'react'
import type { UpdateCandidate } from '../../shared/app-update'
import { ArkdownDialog } from '../modal/ArkdownDialog'
import './app-update.css'

interface Props {
  candidate: UpdateCandidate
  onOpenWebsite(): void
  onExit(): void
  onProtectWork(): void
  canProtect?: boolean
  error?: string | null
}
export function RequiredUpdateDialog({ candidate, onOpenWebsite, onExit, onProtectWork, canProtect = true, error }: Props) {
  return <ArkdownDialog key={error ?? 'ready'} role="alertdialog" className="required-update-dialog" cancelOnBackdrop={false}
    title={candidate.mode === 'urgent' ? '需要立即更新 Arkdown' : '需要更新 Arkdown'} onCancel={onExit}
    description="关闭此提醒将退出 Arkdown；未保存的内容会先询问处理，Arknote 将继续运行。"
    error={error} actions={<>
      {canProtect && <button type="button" onClick={onProtectWork}>处理未保存内容</button>}
      <button type="button" onClick={onExit}>关闭 Arkdown</button>
      <button className="arkdown-dialog__primary" type="button" onClick={onOpenWebsite}>前往官网</button>
    </>}>
    <button className="required-update-close" type="button" aria-label="关闭更新提醒并退出 Arkdown" onClick={onExit}>×</button>
    <p className="required-update-version">新版本 {candidate.version}</p>
    {candidate.message && <p className="required-update-message">{candidate.message}</p>}
  </ArkdownDialog>
}

/** Delay presentation, never the existing save dialog or IME composition. */
export function RequiredUpdateGate({ active, candidate, ...props }: Omit<Props, 'candidate'> & { active: boolean; candidate: UpdateCandidate | null }) {
  const [visible, setVisible] = useState(false)
  const composing = useRef(false)
  useEffect(() => {
    const start = () => { composing.current = true }, end = () => { composing.current = false }
    document.addEventListener('compositionstart', start, true); document.addEventListener('compositionend', end, true)
    return () => { document.removeEventListener('compositionstart', start, true); document.removeEventListener('compositionend', end, true) }
  }, [])
  useEffect(() => {
    if (!active) { setVisible(false); return }
    const show = () => {
      if (composing.current || !document.hasFocus() || document.querySelector('[aria-modal="true"], dialog[open]')) return
      setVisible(true); clearInterval(timer)
    }
    const timer = setInterval(show, 250); show()
    return () => clearInterval(timer)
  }, [active])
  return active && visible && candidate ? <RequiredUpdateDialog candidate={candidate} {...props} /> : null
}
