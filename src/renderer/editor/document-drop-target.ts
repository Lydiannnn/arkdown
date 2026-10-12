import type { DroppedInsertionPoint } from './dropped-link-insertion'

// Classify the original event before asynchronous inspection. A later rejected
// insertion is stale or unsupported, never a reason to open another document.
export function isDocumentBodyDrop(target: Element | null, point: DroppedInsertionPoint): boolean {
  const body = target?.closest<HTMLElement>('.ProseMirror, .cm-content')
  if (!body) return false
  const rect = body.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  const style = body.ownerDocument.defaultView?.getComputedStyle(body)
  const scaleX = body.offsetWidth > 0 ? rect.width / body.offsetWidth : 1
  const scaleY = body.offsetHeight > 0 ? rect.height / body.offsetHeight : 1
  const padding = (side: 'Left' | 'Right' | 'Top' | 'Bottom') => (
    (parseFloat(style?.[`padding${side}`] ?? '') || 0)
    * (side === 'Left' || side === 'Right' ? scaleX : scaleY)
  )
  let top = rect.top + padding('Top')
  let bottom = rect.bottom - padding('Bottom')
  const children = Array.from(body.children).filter((child) => child.getBoundingClientRect().height > 0)
  if (children.length) {
    top = Math.max(top, children[0].getBoundingClientRect().top)
    bottom = Math.min(bottom, children.at(-1)!.getBoundingClientRect().bottom)
  }
  return point.clientX >= rect.left + padding('Left') && point.clientX <= rect.right - padding('Right')
    && point.clientY >= top && point.clientY <= bottom
}
