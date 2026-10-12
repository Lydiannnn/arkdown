import { useEffect, useState } from 'react'

interface StickyNoteArchiveToastProps {
  token: number
}

export function StickyNoteArchiveToast({ token }: StickyNoteArchiveToastProps) {
  const [visibleToken, setVisibleToken] = useState(0)
  useEffect(() => {
    if (token <= 0) return
    setVisibleToken(token)
    const timer = setTimeout(() => setVisibleToken(0), 4000)
    return () => clearTimeout(timer)
  }, [token])
  return visibleToken > 0
    ? <div aria-live="polite" className="sticky-note-archive-toast" key={visibleToken}>便签已归档</div>
    : null
}
