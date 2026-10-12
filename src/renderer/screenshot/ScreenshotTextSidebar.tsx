import { useEffect, useRef, type RefObject } from 'react'
import { useScreenshotTextMenu } from './ScreenshotTextMenu'

interface ScreenshotExtractedTextBlock { id: string; text: string }
export interface ScreenshotTextSidebarProps {
  open: boolean
  blocks: readonly ScreenshotExtractedTextBlock[]
  loading?: boolean
  returnFocusRef?: RefObject<HTMLButtonElement | null>
}

export function ScreenshotTextSidebar({ open, blocks, loading = false, returnFocusRef }: ScreenshotTextSidebarProps) {
  const sidebarRef = useRef<HTMLElement>(null)
  const ocrTextRef = useRef<HTMLDivElement>(null)
  const textBlocks = loading ? [] : blocks.filter(({ text }) => text.trim().length > 0)
  const textMenu = useScreenshotTextMenu({
    scopeRef: sidebarRef, contentVersion: blocks, available: open && textBlocks.length > 0,
    getTextElements: () => ocrTextRef.current ? [ocrTextRef.current] : [],
  })
  useEffect(() => {
    if (!open) return
    return () => returnFocusRef?.current?.focus()
  }, [open, returnFocusRef])
  if (!open) return null
  return (
    <aside aria-label="提取的文字" className="screenshot-text-sidebar" ref={sidebarRef} tabIndex={0}
      onContextMenu={textMenu.onContextMenu} onKeyDown={textMenu.onKeyDown}>
      <div className="screenshot-text-sidebar__heading">提取文字</div>
      <div className="screenshot-text-sidebar__content">
        {loading ? <p className="screenshot-text-sidebar__empty">识别文字中…</p>
          : textBlocks.length === 0 ? <p className="screenshot-text-sidebar__empty">未识别到文字</p>
          : <div className="screenshot-text-sidebar__ocr-text" ref={ocrTextRef}>
              {textBlocks.map(block => <p key={block.id}>{block.text}</p>)}
            </div>}
      </div>
      {textMenu.menu}
    </aside>
  )
}
