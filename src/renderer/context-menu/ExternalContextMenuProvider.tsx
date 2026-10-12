import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
} from 'react'
import { serializeStickyNoteContextMenuItems } from '../../shared/sticky-note-context-menu'
import {
  ContextMenuContext,
  type ContextMenuController,
} from './ContextMenuProvider'
import type { ContextMenuRequest } from './context-menu-types'

let nextRequestId = 0

export function ExternalContextMenuProvider({ children }: PropsWithChildren) {
  const activeRef = useRef<{ requestId: string; request: ContextMenuRequest } | null>(null)

  const finish = useCallback((requestId: string) => {
    const active = activeRef.current
    if (!active || active.requestId !== requestId) return
    activeRef.current = null
    active.request.onClose?.()
    if (active.request.shouldRestoreFocus?.() !== false) active.request.restoreFocus()
  }, [])

  useEffect(() => {
    const unsubscribeCommand = window.arkdown.onStickyNoteContextMenuCommand?.((command) => {
      const active = activeRef.current
      if (!active || active.requestId !== command.requestId) return
      void active.request.execute(command.commandId)
    }) ?? (() => undefined)
    const unsubscribeClosed = window.arkdown.onStickyNoteContextMenuClosed?.((event) => {
      finish(event.requestId)
    }) ?? (() => undefined)
    return () => {
      unsubscribeCommand()
      unsubscribeClosed()
    }
  }, [finish])

  const closeMenu = useCallback(() => {
    const active = activeRef.current
    if (!active) return
    void window.arkdown.closeStickyNoteContextMenu?.(active.requestId).then((result) => {
      if (!result?.ok) finish(active.requestId)
    })
  }, [finish])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !activeRef.current) return
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [closeMenu])

  const openMenu = useCallback((request: ContextMenuRequest) => {
    const previous = activeRef.current
    if (previous) {
      void window.arkdown.closeStickyNoteContextMenu?.(previous.requestId)
      finish(previous.requestId)
    }
    const requestId = `sticky-menu-${Date.now()}-${++nextRequestId}`
    activeRef.current = { requestId, request }
    const open = window.arkdown.openStickyNoteContextMenu
    if (!open) {
      finish(requestId)
      return
    }
    const themeSource = document.querySelector<HTMLElement>('.sticky-note-window')
      ?? document.documentElement
    const themeColorRgb = getComputedStyle(themeSource)
      .getPropertyValue('--theme-color-rgb')
      .trim()
    const colorScheme = themeSource.dataset.colorScheme === 'dark'
      ? 'dark' as const
      : themeSource.dataset.colorScheme === 'light'
        ? 'light' as const
        : undefined
    void open({
      requestId,
      screenX: window.screenX + request.x,
      screenY: window.screenY + request.y,
      items: serializeStickyNoteContextMenuItems(request.items),
      ...(request.widthCssPx === undefined ? {} : { widthCssPx: request.widthCssPx }),
      ...(request.submenuWidthCssPx === undefined ? {} : { submenuWidthCssPx: request.submenuWidthCssPx }),
      ...(request.rootIconGutter === undefined ? {} : { rootIconGutter: request.rootIconGutter }),
      ...(themeColorRgb === '' ? {} : { themeColorRgb }),
      ...(colorScheme === undefined ? {} : { colorScheme }),
    }).then((result) => {
      if (!result.ok) finish(requestId)
    })
  }, [finish])

  const controller = useMemo<ContextMenuController>(() => ({
    closeMenu,
    get isOpen() { return activeRef.current !== null },
    openMenu,
  }), [closeMenu, openMenu])

  return <ContextMenuContext.Provider value={controller}>{children}</ContextMenuContext.Provider>
}
