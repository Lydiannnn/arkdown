import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { placeContextMenu, placeSubmenu } from './context-menu-position'
import type {
  ContextMenuCommandItem,
  ContextMenuIconCommandItem,
  ContextMenuItem,
  ContextMenuRequest,
  ContextMenuSubmenuItem,
} from './context-menu-types'
import { AppIcon } from '../icons/AppIcon'
import { mainAppPortalMarker } from '../app/ui-selection-guard'
import { MenuHairline } from './MenuHairline'
import './context-menu-motion.css'

interface ContextMenuProps {
  request: ContextMenuRequest
  close(): void
  portalContainer?: Element
  onReady?(): void
}

interface MenuListProps {
  items: readonly ContextMenuItem[]
  style?: CSSProperties
  className?: string
  execute(item: ContextMenuCommandItem): void
  close(): void
  menuRef?: RefObject<HTMLDivElement | null>
  onMenuLeave?(event: MouseEvent<HTMLDivElement>): void
  closeParentSubmenu?(): void
  submenuWidthCssPx?: number
  portalContainer?: Element
}

function enabledButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(
    ':scope > .context-menu-entry > button:not([disabled]), '
    + ':scope > .context-menu-grid > button:not([disabled])',
  ))
}

function focusSibling(
  event: KeyboardEvent<HTMLElement>,
  direction: 1 | -1 | 'first' | 'last',
): void {
  const menu = event.currentTarget.closest<HTMLElement>('[role="menu"]')
  if (!menu) return
  const buttons = enabledButtons(menu)
  if (!buttons.length) return
  const current = event.target as HTMLElement
  const index = buttons.findIndex((button) => button === current)
  const nextIndex = direction === 'first'
    ? 0
    : direction === 'last'
      ? buttons.length - 1
      : (Math.max(index, 0) + direction + buttons.length) % buttons.length
  buttons[nextIndex]?.focus()
}

function MenuList({
  items,
  style,
  className = '',
  execute,
  close,
  menuRef,
  onMenuLeave,
  closeParentSubmenu,
  submenuWidthCssPx,
  portalContainer,
}: MenuListProps) {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null)
  const [submenuPosition, setSubmenuPosition] = useState<CSSProperties>({})
  const submenuAnchorRef = useRef<HTMLButtonElement | null>(null)
  const submenuRef = useRef<HTMLDivElement | null>(null)
  const closeDepartedSubmenu = (event: MouseEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && (
      submenuRef.current?.contains(next) || submenuAnchorRef.current?.parentElement?.contains(next)
    )) return
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
  }, [openSubmenu])

  const open = (item: Extract<ContextMenuItem, { kind: 'submenu' }>, button: HTMLButtonElement) => {
    if (openSubmenu === item.id) return
    submenuAnchorRef.current = button
    const parent = button.getBoundingClientRect()
    setSubmenuPosition({
      left: parent.right,
      top: parent.top,
      visibility: 'hidden',
    })
    setOpenSubmenu(item.id)
  }

  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    item: ContextMenuItem,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusSibling(event, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusSibling(event, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusSibling(event, 'first')
    } else if (event.key === 'End') {
      event.preventDefault()
      focusSibling(event, 'last')
    } else if (event.key === 'ArrowRight' && item.kind === 'submenu') {
      event.preventDefault()
      open(item, event.currentTarget)
      queueMicrotask(() => {
        const submenu = document.querySelector<HTMLElement>(
          `[data-context-submenu="${CSS.escape(item.id)}"]`,
        )
        enabledButtons(submenu ?? document.body)[0]?.focus()
      })
    } else if (event.key === 'ArrowLeft' && className.includes('context-menu-submenu')) {
      event.preventDefault()
      closeParentSubmenu?.()
      submenuAnchorRef.current?.focus()
    }
  }

  const renderIcon = (
    item: Pick<ContextMenuCommandItem | ContextMenuSubmenuItem, 'icon' | 'iconSrc' | 'iconPixelSize'>,
  ) => (item.icon || item.iconSrc) ? (
    <span aria-hidden="true" className="context-menu-icon">
      {item.iconSrc
        ? (
          <img
            alt=""
            draggable={false}
            src={item.iconSrc}
            style={item.iconPixelSize ? {
              width: item.iconPixelSize.width / (window.devicePixelRatio || 1),
              height: item.iconPixelSize.height / (window.devicePixelRatio || 1),
            } : undefined}
          />
        )
        : item.icon}
    </span>
  ) : null

  const renderCommand = (item: ContextMenuCommandItem, grid = false) => (
    <button
      aria-label={item.label}
      aria-checked={item.checked === undefined ? undefined : item.checked}
      aria-disabled={item.disabled ? 'true' : undefined}
      className={[
        'context-menu-command',
        grid ? 'context-menu-icon-command' : '',
        item.preview?.kind === 'horizontal-rule' ? 'context-menu-rule-preview-command' : '',
        item.danger ? 'context-menu-danger' : '',
        item.checked
          && !item.iconChoice
          && item.checkedAppearance !== 'theme-text'
          && item.checkedAppearance !== 'neutral-surface'
          ? 'context-menu-checked'
          : '',
        item.checked && item.checkedAppearance === 'theme-text' ? 'context-menu-checked-theme-text' : '',
        item.checked && item.checkedAppearance === 'neutral-surface' ? 'context-menu-checked-neutral-surface' : '',
        item.iconChoice ? 'context-menu-icon-choice' : '',
        item.accentIcon ? 'context-menu-accent-icon' : '',
      ].filter(Boolean).join(' ')}
      disabled={item.disabled}
      key={item.id}
      onClick={() => {
        if (!item.disabled) execute(item)
      }}
      onKeyDown={(event) => onKeyDown(event, item)}
      role={item.checked === undefined
        ? 'menuitem'
        : item.iconChoice
          ? 'menuitemradio'
          : 'menuitemcheckbox'}
      data-tooltip={grid
        ? item.disabled
          ? (item as ContextMenuIconCommandItem).disabledTooltip ?? item.disabledReason
          : item.tooltip ?? `${item.label}${item.shortcut ? `（${item.shortcut}）` : ''}`
        : item.tooltip
          ? item.disabled ? item.disabledReason ?? item.tooltip : item.tooltip
          : undefined}
      type="button"
    >
      {item.checked && !grid && !item.iconChoice && item.checkedAppearance !== 'theme-text' && !item.icon
        ? <span aria-hidden="true" className="context-menu-icon context-menu-check-indicator"><AppIcon name="check" size={16} /></span>
        : item.swatchColor
        ? <span aria-hidden="true" className="context-menu-swatch" style={{ backgroundColor: item.swatchColor }} />
        : renderIcon(item)}
      {item.preview?.kind === 'horizontal-rule'
        ? (
          <span
            aria-hidden="true"
            className="context-menu-rule-preview"
            style={{
              backgroundColor: item.preview.color,
              height: `${item.preview.height}px`,
            }}
          />
        )
        : <span className="context-menu-label">{item.label}</span>}
      {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
    </button>
  )

  return (
    <div
      aria-label="右键菜单"
      className={`context-menu-list ${style?.visibility === 'hidden' ? '' : 'context-menu-fade-in'} ${className}`}
      data-tooltip-layer="context-menu"
      data-ui-selection-portal={mainAppPortalMarker()}
      onMouseLeave={onMenuLeave}
      onContextMenu={(event: MouseEvent) => event.preventDefault()}
      ref={menuRef}
      role="menu"
      style={style}
    >
      {items.map((item) => {
        if (item.kind === 'separator') {
          return <MenuHairline className="context-menu-separator" key={item.id} />
        }
        if (item.kind === 'icon-grid') {
          return (
            <div
              className="context-menu-grid"
              key={item.id}
              role="group"
              style={{ gridTemplateColumns: `repeat(${item.columns}, minmax(0, 1fr))` }}
            >
              {item.items.map((command) => renderCommand(command, true))}
            </div>
          )
        }
        if (item.kind === 'submenu') {
          return (
            <div
              className="context-menu-entry"
              key={item.id}
              onMouseEnter={(event) => open(item, event.currentTarget.querySelector('button')!)}
              onMouseLeave={closeDepartedSubmenu}
            >
              <button
                aria-expanded={openSubmenu === item.id}
                aria-haspopup="menu"
                className="context-menu-command"
                onClick={(event) => open(item, event.currentTarget)}
                onKeyDown={(event) => onKeyDown(event, item)}
                role="menuitem"
                type="button"
              >
                {renderIcon(item)}
                <span className="context-menu-label">{item.label}</span>
                <span aria-hidden="true" className="context-menu-arrow">›</span>
              </button>
              {openSubmenu === item.id && createPortal(
                <MenuList
                  className="context-menu-submenu"
                  close={close}
                  execute={execute}
                  menuRef={submenuRef}
                  items={item.items}
                  onMenuLeave={closeDepartedSubmenu}
                  closeParentSubmenu={() => setOpenSubmenu(null)}
                  submenuWidthCssPx={submenuWidthCssPx}
                  portalContainer={portalContainer}
                  style={{
                    ...submenuPosition,
                    ...(submenuWidthCssPx === undefined ? {} : { width: submenuWidthCssPx }),
                  }}
                />,
                portalContainer ?? document.body,
              )}
            </div>
          )
        }
        return (
          <div className="context-menu-entry" key={item.id}>
            {renderCommand(item)}
          </div>
        )
      })}
    </div>
  )
}

export function ContextMenu({ request, close, portalContainer, onReady }: ContextMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const readyNotifiedRef = useRef(false)
  const [position, setPosition] = useState<CSSProperties>({
    left: request.x,
    top: request.y,
    visibility: 'hidden',
    ...(request.widthCssPx === undefined ? {} : { width: request.widthCssPx }),
  })

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const bounds = root.getBoundingClientRect()
    const point = placeContextMenu(
      { x: request.x, y: request.y },
      { width: bounds.width, height: bounds.height },
      { width: window.innerWidth, height: window.innerHeight },
    )
    setPosition({
      left: point.x,
      top: point.y,
      ...(request.widthCssPx === undefined ? {} : { width: request.widthCssPx }),
    })
    if (request.autoFocus !== false) enabledButtons(root)[0]?.focus()
  }, [request])

  useEffect(() => {
    if (position.visibility === 'hidden' || readyNotifiedRef.current) return
    readyNotifiedRef.current = true
    onReady?.()
  }, [onReady, position])

  const execute = (item: ContextMenuCommandItem) => {
    if (item.disabled) return
    if (request.executeBeforeClose) {
      void Promise.resolve(request.execute(item.id)).finally(close)
      return
    }
    close()
    void request.execute(item.id)
  }

  return createPortal(
    <MenuList
      className={request.rootIconGutter === 'none' ? 'context-menu-root-no-icon-gutter' : undefined}
      close={close}
      execute={execute}
      items={request.items}
      menuRef={rootRef}
      style={position}
      submenuWidthCssPx={request.submenuWidthCssPx}
      portalContainer={portalContainer}
    />,
    portalContainer ?? document.body,
  )
}
