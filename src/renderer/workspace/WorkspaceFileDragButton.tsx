import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { AppIcon } from '../icons/AppIcon'
import { dismissTooltip } from '../tooltip/TooltipProvider'

const description = '拖出已保存文件；普通拖动复制，Alt 或 Ctrl+Shift 创建快捷方式。未保存的修改不包含在内。'

export function WorkspaceFileDragButton({ workspace, relativePath, name }: { workspace: string; relativePath: string; name: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const pendingRef = useRef(false)
  useEffect(() => () => { request.current += 1 }, [workspace, relativePath])
  const start = async (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dismissTooltip()
    if (pendingRef.current) return
    pendingRef.current = true
    const current = ++request.current
    setPending(true)
    setError(null)
    try {
      const drag = window.arkdown?.startWorkspaceFileDrag
      if (!drag) throw new Error('文件拖出暂不可用。')
      const result = await drag({ workspace, relativePath })
      if (current === request.current && !result.ok) setError(result.error.message)
    } catch {
      if (current === request.current) setError('无法拖出文件，请重试。')
    } finally {
      if (current === request.current) { pendingRef.current = false; setPending(false) }
    }
  }
  return <>
    <button className="workspace-file-drag" type="button" draggable={!pending} disabled={pending}
      aria-label={`拖出文件：${name}`} aria-description={description} data-tooltip={description}
      onClick={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation() }}
      onDragStart={event => { void start(event) }}>
      <AppIcon name="copy" size={14} />
    </button>
    {error && <span className="workspace-file-drag-error" role="alert">{name}：{error}</span>}
  </>
}
