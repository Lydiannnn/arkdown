import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { ContextMenu } from './ContextMenu'
import type { ContextMenuRequest } from './context-menu-types'
import { dismissTooltip } from '../tooltip/TooltipProvider'

export interface ContextMenuController {
  openMenu(request: ContextMenuRequest): void
  closeMenu(): void
  isOpen: boolean
}

export const ContextMenuContext = createContext<ContextMenuController | null>(null)

export function ContextMenuProvider({ children }: PropsWithChildren) {
  const [request, setRequest] = useState<ContextMenuRequest | null>(null)
  const requestRef = useRef<ContextMenuRequest | null>(null)
  const [generation, setGeneration] = useState(0)

  const closeMenu = useCallback(() => {
    dismissTooltip()
    const active = requestRef.current
    requestRef.current = null
    setRequest(null)
    active?.onClose?.()
    if (active?.shouldRestoreFocus?.() !== false) active?.restoreFocus()
  }, [])

  const openMenu = useCallback((next: ContextMenuRequest) => {
    dismissTooltip()
    requestRef.current = next
    setGeneration((current) => current + 1)
    setRequest(next)
  }, [])

  useEffect(() => {
    if (!request) return
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target?.closest('.context-menu-list')) closeMenu()
    }
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
      }
    }
    window.addEventListener('pointerdown', closeOnPointer, true)
    window.addEventListener('keydown', closeOnKey, true)
    window.addEventListener('blur', closeMenu)
    return () => {
      window.removeEventListener('pointerdown', closeOnPointer, true)
      window.removeEventListener('keydown', closeOnKey, true)
      window.removeEventListener('blur', closeMenu)
    }
  }, [closeMenu, request])

  return (
    <ContextMenuContext.Provider value={{ closeMenu, isOpen: Boolean(request), openMenu }}>
      {children}
      {request && <ContextMenu close={closeMenu} key={generation} request={request} />}
    </ContextMenuContext.Provider>
  )
}

export function useOptionalContextMenu(): ContextMenuController | null {
  return useContext(ContextMenuContext)
}

export function useContextMenu(): ContextMenuController {
  const value = useContext(ContextMenuContext)
  if (!value) throw new Error('useContextMenu must be used inside ContextMenuProvider')
  return value
}
