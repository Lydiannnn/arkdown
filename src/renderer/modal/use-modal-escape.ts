import { useEffect, useRef, type RefObject } from 'react'

export function useModalEscape<T extends HTMLElement>(
  modalRef: RefObject<T | null>,
  onEscape: () => void,
  enabled = true,
): void {
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    if (!enabled) return
    const closeTopmostModal = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const modal = modalRef.current
      if (!modal) return
      const activeModals = document.querySelectorAll<HTMLElement>('[aria-modal="true"]')
      if (activeModals.item(activeModals.length - 1) !== modal) return
      event.preventDefault()
      event.stopImmediatePropagation()
      onEscapeRef.current()
    }
    window.addEventListener('keydown', closeTopmostModal, true)
    return () => window.removeEventListener('keydown', closeTopmostModal, true)
  }, [enabled, modalRef])
}
