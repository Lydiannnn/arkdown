import { useCallback, useRef, useState } from 'react'
import type { WindowControlAction, WindowStateSnapshot } from '../../shared/contracts'
import {
  buildApplicationMenuModel,
  DEFAULT_APPLICATION_MENU_RUNTIME_STATE,
  type ApplicationMenuSection,
  type ApplicationMenuWindowState,
} from '../../shared/application-menu-model'
import type { AppMenuSectionId } from '../../shared/app-menu-definition'
import { ApplicationMenuPopover } from './ApplicationMenuPopover'
import { AppIcon } from '../icons/AppIcon'
import './app-title-bar.css'
import '../updates/app-update.css'

export interface AppTitleBarProps {
  updateLabel?: string
  onOpenUpdate?(): void
  menuModel?: readonly ApplicationMenuSection[]
  menuState?: ApplicationMenuWindowState
  sidebarVisible?: boolean
  onToggleSidebar?(): void
  onExecuteItem(itemId: string): void
  onWindowStateChange?(state: WindowStateSnapshot): void
  windowState: WindowStateSnapshot
}

function correctFullscreenMenuItem(
  model: readonly ApplicationMenuSection[],
  fullscreen: boolean,
): readonly ApplicationMenuSection[] {
  const sectionIndex = model.findIndex(({ id }) => id === 'view')
  if (sectionIndex < 0) return model
  const section = model[sectionIndex]
  const itemIndex = section.items.findIndex(({ id }) => id === 'view.fullscreen')
  if (itemIndex < 0) return model
  const item = section.items[itemIndex]
  if (
    item.kind === 'role'
    && item.checked === fullscreen
    && item.label === (fullscreen ? '退出全屏' : '全屏')
  ) return model
  if (item.kind !== 'role') return model
  const items = section.items.slice()
  items[itemIndex] = {
    ...item,
    checked: fullscreen,
    label: fullscreen ? '退出全屏' : '全屏',
  }
  const corrected = model.slice()
  corrected[sectionIndex] = { ...section, items }
  return corrected
}

export function AppTitleBar({
  updateLabel, onOpenUpdate,
  menuModel,
  menuState,
  sidebarVisible = true,
  onToggleSidebar,
  onExecuteItem,
  onWindowStateChange,
  windowState,
}: AppTitleBarProps) {
  const [openSection, setOpenSection] = useState<AppMenuSectionId | null>(null)
  const [menuLeft, setMenuLeft] = useState(0)
  const menuButtonsRef = useRef(new Map<AppMenuSectionId, HTMLButtonElement>())
  const openSectionRef = useRef(openSection)
  openSectionRef.current = openSection

  const baseApplicationMenuModel = menuModel ?? buildApplicationMenuModel({
    ...DEFAULT_APPLICATION_MENU_RUNTIME_STATE,
    ...menuState,
    recentDocuments: [],
    fullscreen: windowState.fullscreen,
  })
  const applicationMenuModel = correctFullscreenMenuItem(
    baseApplicationMenuModel,
    windowState.fullscreen,
  )

  const controlWindow = useCallback((action: WindowControlAction) => {
    const request = window.arkdown.controlWindow?.(action)
    if (!request) return
    void request.then((result) => {
      if (!result.ok) return
      onWindowStateChange?.(result.value)
    })
  }, [onWindowStateChange])

  const handleTitlebarDoubleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (!windowState.fullscreen || event.target !== event.currentTarget) return
    controlWindow('toggle-fullscreen')
  }, [controlWindow, windowState.fullscreen])

  const open = useCallback((section: AppMenuSectionId, button: HTMLButtonElement) => {
    setMenuLeft(Math.round(button.getBoundingClientRect().left))
    setOpenSection((current) => current === section ? null : section)
  }, [])

  const switchSection = useCallback((direction: -1 | 1) => {
    setOpenSection((current) => {
      const index = applicationMenuModel.findIndex((section) => section.id === current)
      return applicationMenuModel[
        (Math.max(index, 0) + direction + applicationMenuModel.length)
        % applicationMenuModel.length
      ].id
    })
  }, [applicationMenuModel])

  const section = applicationMenuModel.find((candidate) => candidate.id === openSection)
  const closeMenu = useCallback((restoreFocus = false) => {
    if (restoreFocus && openSectionRef.current) {
      menuButtonsRef.current.get(openSectionRef.current)?.focus({ preventScroll: true })
    }
    setOpenSection(null)
  }, [])

  return (
    <header
      className={`app-titlebar${windowState.fullscreen ? ' is-fullscreen' : ''}`}
      data-testid="app-titlebar"
      onDoubleClick={handleTitlebarDoubleClick}
    >
      {onToggleSidebar && <button
        aria-label={sidebarVisible ? '隐藏侧边栏' : '显示侧边栏'}
        aria-pressed={sidebarVisible}
        className="app-sidebar-toggle"
        data-tooltip={sidebarVisible ? '隐藏侧边栏' : '显示侧边栏'}
        onClick={onToggleSidebar}
        type="button"
      >
        <AppIcon name="sidebar" size={18} />
      </button>}
      <nav aria-label="应用程序菜单" className="app-menu-bar app-menu-root">
        {applicationMenuModel.map((menuSection) => (
          <button
            aria-expanded={openSection === menuSection.id}
            className="app-menu-button"
            key={menuSection.id}
            onClick={(event) => open(menuSection.id, event.currentTarget)}
            onPointerEnter={(event) => {
              if (openSection && openSection !== menuSection.id) {
                setMenuLeft(Math.round(event.currentTarget.getBoundingClientRect().left))
                setOpenSection(menuSection.id)
              }
            }}
            ref={(button) => {
              if (button) menuButtonsRef.current.set(menuSection.id, button)
              else menuButtonsRef.current.delete(menuSection.id)
            }}
            type="button"
          >
            {menuSection.label}
          </button>
        ))}
        {updateLabel && <button className="app-update-bubble" type="button" onClick={onOpenUpdate}>{updateLabel}</button>}
        {section && (
          <ApplicationMenuPopover
            left={menuLeft}
            onClose={closeMenu}
            onExecute={onExecuteItem}
            onSwitch={switchSection}
            section={section}
          />
        )}
      </nav>
      <div aria-label="窗口控制" className="window-controls" role="group">
        <button aria-label="最小化" data-tooltip="最小化" onClick={() => controlWindow('minimize')} type="button">
          <AppIcon name="minimize" size={14} />
        </button>
        <button
          aria-label={windowState.fullscreen ? '退出全屏' : '全屏'}
          data-tooltip={windowState.fullscreen ? '退出全屏' : '全屏'}
          onClick={() => controlWindow('toggle-fullscreen')}
          type="button"
        >
          <AppIcon
            className={windowState.fullscreen ? 'window-restore-icon' : ''}
            name={windowState.fullscreen ? 'restore-window' : 'maximize'}
            size={13}
          />
        </button>
        <button
          aria-label="关闭"
          className="window-close-button"
          data-tooltip="关闭"
          onClick={() => controlWindow('close')}
          type="button"
        >
          <AppIcon name="close" size={14} />
        </button>
      </div>
    </header>
  )
}
