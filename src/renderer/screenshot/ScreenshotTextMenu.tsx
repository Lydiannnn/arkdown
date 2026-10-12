import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { placeContextMenu } from '../context-menu/context-menu-position'
import './screenshot-text-menu.css'

interface TextMenuOptions {
  scopeRef: RefObject<HTMLElement | null>
  getTextElements(): HTMLElement[]
  contentVersion: unknown
  available?: boolean
}
interface MenuState { x: number; y: number; generation: number; text?: string; hasText: boolean }
const MENU_OPEN_EVENT = 'arkdown:screenshot-text-menu-open'

function selectionIn(elements: HTMLElement[]): string | undefined {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1
    || !elements.some(element => element.contains(selection.anchorNode))
    || !elements.some(element => element.contains(selection.focusNode))) return undefined
  const text = selection.toString()
  return text.trim() ? text : undefined
}

/** Each region owns its selection; the portal keeps menus above both panes and the toolbar. */
export function useScreenshotTextMenu({ scopeRef, getTextElements, contentVersion, available = true }: TextMenuOptions) {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [position, setPosition] = useState<{ x: number; y: number; generation: number } | null>(null)
  const sequence = useRef(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const textElements = () => getTextElements().filter(element => element.textContent?.trim())
  const dismiss = (restore = false) => { setMenu(null); if (restore) scopeRef.current?.focus() }
  const enabledItems = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]

  useEffect(() => { setMenu(null) }, [available, contentVersion])
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const outside = (event: globalThis.PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) close() }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('blur', close)
    window.addEventListener(MENU_OPEN_EVENT, close)
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('blur', close); window.removeEventListener(MENU_OPEN_EVENT, close) }
  }, [menu])
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return
    const place = () => {
      const bounds = menuRef.current?.getBoundingClientRect()
      if (bounds) setPosition({ ...placeContextMenu(menu, bounds, { width: window.innerWidth, height: window.innerHeight }), generation: menu.generation })
    }
    place(); window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [menu])
  useLayoutEffect(() => {
    if (menu && position?.generation === menu.generation) (enabledItems()[0] ?? menuRef.current)?.focus()
  }, [menu?.generation, position?.generation])

  const open = (x: number, y: number) => {
    if (!available) { dismiss(); return }
    const elements = textElements()
    window.dispatchEvent(new Event(MENU_OPEN_EVENT))
    setMenu({ x, y, generation: ++sequence.current, text: selectionIn(elements), hasText: elements.length > 0 })
  }
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    open(event.clientX, event.clientY)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    const rect = scopeRef.current?.getBoundingClientRect()
    open((rect?.left ?? 0) + 12, (rect?.top ?? 0) + 48)
  }
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); dismiss(true); return }
    if (event.key === 'Tab') { dismiss(true); return }
    const items = enabledItems()
    if (!items.length) return
    const index = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement))
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length
      : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : undefined
    if (next !== undefined) { event.preventDefault(); items[next]!.focus() }
  }
  const copy = () => {
    const text = menu?.text
    dismiss(true)
    if (text && navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).catch(() => undefined)
  }
  const selectAll = () => {
    const elements = textElements()
    const selection = window.getSelection()
    if (!elements.length || !selection) { dismiss(true); return }
    const range = document.createRange()
    range.setStart(elements[0]!, 0)
    const last = elements.at(-1)!
    range.setEnd(last, last.childNodes.length)
    dismiss(true)
    selection.removeAllRanges(); selection.addRange(range)
  }
  return {
    onContextMenu, onKeyDown,
    menu: menu && createPortal(
      <div aria-label="文字操作" className="screenshot-text-context-menu" key={menu.generation}
        ref={menuRef} role="menu" tabIndex={-1} onKeyDown={onMenuKeyDown}
        onContextMenu={event => event.preventDefault()}
        style={{ left: position?.generation === menu.generation ? position.x : menu.x,
          top: position?.generation === menu.generation ? position.y : menu.y,
          visibility: position?.generation === menu.generation ? 'visible' : 'hidden' }}>
        <button role="menuitem" disabled={!menu.text} onClick={copy}>复制</button>
        <button role="menuitem" disabled={!menu.hasText} onClick={selectAll}>全选</button>
      </div>, document.body),
  }
}
