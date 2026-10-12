import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AppIcon } from '../icons/AppIcon'
import { aiQuotePreview, type AiSelectionQuote } from './ai-composer-draft'

export function AiQuoteChip({ quote, onRemove }: { quote: AiSelectionQuote; onRemove(): void }) {
  const label = `${quote.documentName} · 片段 ${quote.fragment}`
  const trigger = useRef<HTMLButtonElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [position, setPosition] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const [preview, setPreview] = useState('')
  const cancelTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  const close = () => { cancelTimer(); setPosition(null) }
  const show = () => {
    cancelTimer()
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(412, window.innerWidth - 24)
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
      bottom: Math.max(12, window.innerHeight - rect.top), width })
  }
  const leave = () => { cancelTimer(); timer.current = setTimeout(() => setPosition(null), 150) }
  useEffect(() => () => cancelTimer(), [])
  useLayoutEffect(() => {
    const element = tooltip.current
    if (!position || !element) return
    let active = true
    const measure = () => {
      if (!active) return
      const style = getComputedStyle(element)
      const width = Math.min(412, window.innerWidth - 24) - parseFloat(style.paddingLeft)
        - parseFloat(style.paddingRight) - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)
      const probe = element.ownerDocument.createElement('span')
      // Use DOM shaping, including fallback glyphs and tabs, with the tooltip's inherited font.
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;width:max-content;'
      element.append(probe)
      try {
        const nextPreview = aiQuotePreview(quote.plainText, 30, (line) => {
          probe.textContent = line
          return probe.getBoundingClientRect().width <= width
        })
        setPreview(nextPreview)
        const longest = Math.max(...['引用内容：', ...nextPreview.split('\n')].map((line) => {
          probe.textContent = line
          return probe.getBoundingClientRect().width
        }))
        const fittedWidth = Math.min(Math.ceil(longest + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
          + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth) + 1), window.innerWidth - 24)
        const rect = trigger.current?.getBoundingClientRect()
        if (rect) setPosition((current) => current && Math.abs(current.width - fittedWidth) > .5
          ? { ...current, width: fittedWidth, left: Math.max(12, Math.min(rect.left, window.innerWidth - fittedWidth - 12)) }
          : current)
      } finally { probe.remove() }
    }
    measure()
    void element.ownerDocument.fonts?.ready.then(measure)
    return () => { active = false }
  }, [position, quote.plainText])
  useEffect(() => {
    if (!position) return
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); close() }
    }
    document.addEventListener('keydown', dismiss, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('keydown', dismiss, true)
      window.removeEventListener('resize', close)
    }
  }, [position])
  return <span className="ai-quote-chip" onMouseLeave={leave}>
    <button type="button" ref={trigger} aria-label={`预览引用：${label}`}
      aria-describedby={position ? `quote-${quote.id}` : undefined}
      onMouseEnter={() => { cancelTimer(); timer.current = setTimeout(show, 300) }}
      onFocus={show} onBlur={close}>{label}</button>
    <button type="button" className="ai-quote-remove" aria-label={`移除引用：${label}`} onClick={onRemove}>
      <AppIcon name="close" size={12} />
    </button>
    {position && createPortal(<div ref={tooltip} id={`quote-${quote.id}`} role="tooltip" className="ai-quote-tooltip"
      style={position} onMouseEnter={cancelTimer} onMouseLeave={leave}>
      <span className="ai-quote-tooltip-label">引用内容：</span><span className="ai-quote-tooltip-content">{preview}</span>
    </div>, document.body)}
  </span>
}
