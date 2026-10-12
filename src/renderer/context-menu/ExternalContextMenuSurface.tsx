import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import type { StickyNoteContextMenuShowPayload } from '../../shared/sticky-note-context-menu'
import { ContextMenu } from './ContextMenu'
import type { ContextMenuRequest } from './context-menu-types'

export function ExternalContextMenuSurface() {
  const [payload, setPayload] = useState<StickyNoteContextMenuShowPayload | null>(null)
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null)

  useEffect(() => window.arkdown.onStickyNoteContextMenuShow?.(setPayload) ?? (() => undefined), [])
  useEffect(() => window.arkdown.onStickyNoteContextMenuReset?.(({ requestId }) => {
    setPayload((current) => current?.requestId === requestId ? null : current)
  }) ?? (() => undefined), [])

  const ready = useCallback((requestId: string) => {
    void window.arkdown.readyStickyNoteContextMenu?.(requestId)
  }, [])

  const close = useCallback(() => {
    const active = payload
    setPayload(null)
    if (active) void window.arkdown.closeStickyNoteContextMenu?.(active.requestId)
  }, [payload])

  useEffect(() => {
    if (!payload) return
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target?.closest('.context-menu-list')) close()
    }
    window.addEventListener('pointerdown', closeOnPointer, true)
    return () => {
      window.removeEventListener('pointerdown', closeOnPointer, true)
    }
  }, [close, payload])

  if (!payload) return null
  const request: ContextMenuRequest = {
    x: payload.x,
    y: payload.y,
    items: payload.items,
    executeBeforeClose: true,
    autoFocus: false,
    widthCssPx: payload.widthCssPx,
    submenuWidthCssPx: payload.submenuWidthCssPx,
    rootIconGutter: payload.rootIconGutter,
    execute: async (commandId) => {
      await window.arkdown.executeStickyNoteContextMenuCommand?.({
        requestId: payload.requestId,
        commandId,
      })
    },
    restoreFocus: () => undefined,
  }
  return (
    <div
      className="external-context-menu"
      data-color-scheme={payload.colorScheme}
      ref={setPortalContainer}
      style={payload.themeColorRgb === undefined
        ? undefined
        : { '--theme-color-rgb': payload.themeColorRgb } as CSSProperties}
    >
      {portalContainer && (
        <ContextMenu
          close={close}
          key={payload.requestId}
          onReady={() => ready(payload.requestId)}
          portalContainer={portalContainer}
          request={request}
        />
      )}
    </div>
  )
}
