import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import {
  formatWindowsAccelerator,
  type ApplicationMenuItem,
  type ApplicationMenuSection,
  type ApplicationMenuSubmenuItem,
} from '../../shared/application-menu-model'
import { placeSubmenu } from '../context-menu/context-menu-position'
import { MenuHairline } from '../context-menu/MenuHairline'
import { mainAppPortalMarker } from '../app/ui-selection-guard'
import { AppIcon } from '../icons/AppIcon'
import './application-menu-popover.css'

interface ApplicationMenuPopoverProps {
  section: ApplicationMenuSection
  left: number
  onClose(restoreFocus?: boolean): void
  onExecute(itemId: string): void
  onSwitch(direction: -1 | 1): void
}

interface ApplicationMenuListProps {
  ariaLabel: string
  className?: string
  items: readonly ApplicationMenuItem[]
  menuRef?: RefObject<HTMLDivElement | null>
  onClose(restoreFocus?: boolean): void
  onCloseParent?(): void
  onExecute(itemId: string): void
  onSwitch(direction: -1 | 1): void
  portaled?: boolean
  style?: CSSProperties
}

function enabledButtons(menu: HTMLElement | null): HTMLButtonElement[] {
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)'))
}

function moveFocus(event: KeyboardEvent<HTMLButtonElement>, delta: -1 | 1): void {
  const menu = event.currentTarget.closest<HTMLElement>('[role="menu"]')
  const buttons = enabledButtons(menu)
  const index = buttons.indexOf(event.currentTarget)
  buttons[(Math.max(index, 0) + delta + buttons.length) % buttons.length]?.focus()
}

function ApplicationMenuList({
  ariaLabel,
  className = '',
  items,
  menuRef,
  onClose,
  onCloseParent,
  onExecute,
  onSwitch,
  portaled = false,
  style,
}: ApplicationMenuListProps) {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null)
  const [submenuPosition, setSubmenuPosition] = useState<CSSProperties>({})
  const focusSubmenuRef = useRef<string | null>(null)
  const submenuAnchorRef = useRef<HTMLButtonElement | null>(null)
  const submenuRef = useRef<HTMLDivElement | null>(null)
  const suppressFocusOpenRef = useRef<string | null>(null)
  const nested = items.find((item): item is ApplicationMenuSubmenuItem => (
    item.kind === 'submenu' && item.id === openSubmenu
  ))

  const open = (
    item: ApplicationMenuSubmenuItem,
    button: HTMLButtonElement,
    focusFirst = false,
  ) => {
    submenuAnchorRef.current = button
    focusSubmenuRef.current = focusFirst ? item.id : null
    if (openSubmenu === item.id) {
      if (focusFirst) queueMicrotask(() => enabledButtons(submenuRef.current)[0]?.focus())
      return
    }
    const parent = button.getBoundingClientRect()
    setSubmenuPosition({ left: parent.right, top: parent.top, visibility: 'hidden' })
    setOpenSubmenu(item.id)
  }

  const closeNested = () => {
    const anchor = submenuAnchorRef.current
    if (openSubmenu) suppressFocusOpenRef.current = openSubmenu
    focusSubmenuRef.current = null
    anchor?.focus()
    setOpenSubmenu(null)
  }

  useLayoutEffect(() => {
    if (!openSubmenu) return
    const anchor = submenuAnchorRef.current
    const submenu = submenuRef.current
    if (!anchor || !submenu) return
    const parent = anchor.getBoundingClientRect()
    const bounds = submenu.getBoundingClientRect()
    const point = placeSubmenu(
      {
        left: parent.left,
        top: parent.top,
        right: parent.right,
        bottom: parent.bottom,
        width: parent.width,
        height: parent.height,
      },
      { width: bounds.width, height: bounds.height },
      { width: window.innerWidth, height: window.innerHeight },
    )
    setSubmenuPosition({ left: point.x, top: point.y, visibility: 'visible' })
    if (focusSubmenuRef.current === openSubmenu) {
      focusSubmenuRef.current = null
      enabledButtons(submenu)[0]?.focus()
    }
  }, [openSubmenu])

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    item: ApplicationMenuItem,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveFocus(event, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event, -1)
    } else if (event.key === 'ArrowRight' && item.kind === 'submenu') {
      event.preventDefault()
      event.stopPropagation()
      open(item, event.currentTarget, true)
    } else if (event.key === 'ArrowLeft' && onCloseParent) {
      event.preventDefault()
      event.stopPropagation()
      onCloseParent()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      onSwitch(event.key === 'ArrowLeft' ? -1 : 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (openSubmenu) closeNested()
      else if (onCloseParent) onCloseParent()
      else onClose(true)
    }
  }

  return (
    <div
      aria-label={ariaLabel}
      className={`application-menu-popover ${className}`.trim()}
      data-ui-selection-portal={portaled ? mainAppPortalMarker() : undefined}
      ref={menuRef}
      role="menu"
      style={style}
    >
      {items.map((item) => {
        if (item.kind === 'separator') {
          return <MenuHairline className="application-menu-separator" key={item.id} />
        }
        const isSubmenu = item.kind === 'submenu'
        const hasCheckedState = item.kind === 'checkbox'
          || item.kind === 'radio'
          || (item.kind === 'role' && typeof item.checked === 'boolean')
        const isChecked = hasCheckedState && item.checked === true
        const usesTrailingStatus = item.id === 'view.edit-indicators'
          || (item.kind === 'radio' && item.id.startsWith('theme.'))
        const role = item.kind === 'checkbox'
          || (item.kind === 'role' && typeof item.checked === 'boolean')
          ? 'menuitemcheckbox'
          : item.kind === 'radio' ? 'menuitemradio' : 'menuitem'
        return (
          <button
            aria-checked={hasCheckedState ? item.checked : undefined}
            aria-expanded={isSubmenu ? openSubmenu === item.id : undefined}
            aria-haspopup={isSubmenu ? 'menu' : undefined}
            className={item.id === 'view.fullscreen' && isChecked
              ? 'application-menu-theme-state'
              : undefined}
            disabled={item.disabled === true}
            key={item.id}
            onClick={(event) => {
              if (item.disabled) return
              if (item.kind === 'submenu') {
                open(item, event.currentTarget, true)
                return
              }
              onExecute(item.id)
              onClose()
            }}
            onFocus={(event) => {
              if (item.kind !== 'submenu' || item.disabled) return
              if (suppressFocusOpenRef.current === item.id) {
                suppressFocusOpenRef.current = null
                return
              }
              open(item, event.currentTarget)
            }}
            onKeyDown={(event) => handleKeyDown(event, item)}
            onPointerEnter={(event) => {
              if (item.kind === 'submenu' && !item.disabled) open(item, event.currentTarget)
              else setOpenSubmenu(null)
            }}
            role={role}
            style={item.id === 'view.fullscreen' && isChecked
              ? { color: 'rgb(var(--theme-color-rgb, 198 40 40) / 100%)' }
              : undefined}
            type="button"
          >
            <span>
              {isChecked && !usesTrailingStatus && <span aria-hidden="true" className="application-menu-check"><AppIcon name="check" size={16} /></span>}
              {item.label}
            </span>
            {usesTrailingStatus
              ? (
                  <span aria-hidden="true" className="application-menu-trailing-status">
                    {isChecked && <span className="application-menu-check"><AppIcon name="check" size={16} /></span>}
                  </span>
                )
              : 'accelerator' in item && item.accelerator
                ? <span className="application-menu-accelerator">{formatWindowsAccelerator(item.accelerator)}</span>
                : isSubmenu
                  ? <span aria-hidden="true" className="application-menu-arrow">›</span>
                  : null}
          </button>
        )
      })}
      {nested && createPortal(
        <ApplicationMenuList
          ariaLabel={`${nested.label}子菜单`}
          className="application-menu-submenu"
          items={nested.items}
          menuRef={submenuRef}
          onClose={onClose}
          onCloseParent={closeNested}
          onExecute={onExecute}
          onSwitch={onSwitch}
          portaled
          style={submenuPosition}
        />,
        document.body,
      )}
    </div>
  )
}

export function ApplicationMenuPopover({
  section,
  left,
  onClose,
  onExecute,
  onSwitch,
}: ApplicationMenuPopoverProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target?.closest('.app-menu-root, .application-menu-popover')) onClose()
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose(true)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    queueMicrotask(() => enabledButtons(menuRef.current)[0]?.focus())
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose, section.id])

  return (
    <ApplicationMenuList
      ariaLabel={`${section.label}菜单`}
      items={section.items}
      menuRef={menuRef}
      onClose={onClose}
      onExecute={onExecute}
      onSwitch={onSwitch}
      style={{ left }}
    />
  )
}
