import { useEffect, useRef, useState } from 'react'

interface StickyNoteStartupHintProps {
  onEnable(): Promise<boolean>
  onDismiss(): Promise<boolean>
}

export function StickyNoteStartupHint({ onEnable, onDismiss }: StickyNoteStartupHintProps) {
  const [phase, setPhase] = useState<'choice' | 'follow-up' | 'fading'>('choice')
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  if (hidden) return null

  const enable = async () => {
    if (busy) return
    setBusy(true)
    if (await onEnable()) setHidden(true)
    else setBusy(false)
  }
  const dismiss = async () => {
    if (busy) return
    setBusy(true)
    if (!await onDismiss()) {
      setBusy(false)
      return
    }
    setPhase('follow-up')
    timers.current.push(setTimeout(() => setPhase('fading'), 3000))
    timers.current.push(setTimeout(() => setHidden(true), 3500))
  }

  return <div className={`sticky-note-startup-hint sticky-note-startup-hint-${phase}`} role="status">
    {phase === 'choice'
      ? <>
          <span>开机启动便签服务，更方便地使用便签</span>
          <button disabled={busy} onClick={() => void enable()} type="button">开机启动</button>
          <button disabled={busy} onClick={() => void dismiss()} type="button">不再提示</button>
        </>
      : <span>之后可以在【偏好设置】中更改开机启动设置</span>}
  </div>
}
