import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import {
  buildApplicationMenuModel,
  DEFAULT_APPLICATION_MENU_RUNTIME_STATE,
  type ApplicationMenuAction,
  type ApplicationMenuItem,
  type ApplicationMenuRole,
  type ApplicationMenuSection,
} from '../shared/application-menu-model'
import type { MenuCommand } from '../shared/menu-commands'
import type { WindowControlAction, WindowStateSnapshot } from '../shared/contracts'

export interface ApplicationMenuActions {
  reviewDrafts?(owner?: BrowserWindow): void
  createNewWindow(owner?: BrowserWindow): void
  openDocument(owner?: BrowserWindow): void
  closeWindow(owner?: BrowserWindow): void
  openGuide(owner?: BrowserWindow): void
  openAbout(owner?: BrowserWindow): void
  openBackgroundSettings(owner?: BrowserWindow): void
  beginScreenshotTranslation?(owner?: BrowserWindow): void
  openScreenTranslation?(owner?: BrowserWindow): void
  openRecentDocument?(owner: BrowserWindow | undefined, absolutePath: string): void
  executeRole?(owner: BrowserWindow, role: ApplicationMenuRole): void
}

type SendMenuCommand = (owner: BrowserWindow, command: MenuCommand) => void

export interface ApplicationMenuWindowController {
  controlWindow(action: WindowControlAction): WindowStateSnapshot
}

export function executeApplicationMenuRole(
  owner: BrowserWindow,
  role: ApplicationMenuRole,
  getWindowController: (owner: BrowserWindow) => ApplicationMenuWindowController | undefined,
): void {
  if (owner.isDestroyed() || owner.webContents.isDestroyed()) return
  if (role === 'togglefullscreen') {
    getWindowController(owner)?.controlWindow('toggle-fullscreen')
    return
  }
  const contents = owner.webContents
  switch (role) {
    case 'undo': contents.undo(); break
    case 'redo': contents.redo(); break
    case 'cut': contents.cut(); break
    case 'copy': contents.copy(); break
    case 'paste': contents.paste(); break
    case 'selectAll': contents.selectAll(); break
    case 'resetZoom': contents.setZoomFactor(1); break
    case 'zoomIn': contents.setZoomFactor(Math.min(3, contents.getZoomFactor() + 0.1)); break
    case 'zoomOut': contents.setZoomFactor(Math.max(0.5, contents.getZoomFactor() - 0.1)); break
  }
}

export function executeApplicationMenuModelItem(
  owner: BrowserWindow,
  item: ApplicationMenuItem,
  send: SendMenuCommand,
  actions: ApplicationMenuActions,
): boolean {
  if (
    ('disabled' in item && item.disabled)
    || item.kind === 'separator'
    || item.kind === 'submenu'
  ) return false
  if (item.kind === 'command' || item.kind === 'checkbox' || item.kind === 'radio') {
    send(owner, item.command)
    return true
  }
  if (item.kind === 'recent-document') {
    if (!actions.openRecentDocument) return false
    actions.openRecentDocument(owner, item.absolutePath)
    return true
  }
  if (item.kind === 'role') {
    if (!actions.executeRole) return false
    actions.executeRole(owner, item.role)
    return true
  }
  const action = actions[item.action as ApplicationMenuAction]
  if (!action) return false
  action(owner)
  return true
}

function asBrowserWindow(owner: Electron.BaseWindow | undefined): BrowserWindow | undefined {
  return owner && 'webContents' in owner ? owner as BrowserWindow : undefined
}

function nativeItem(
  item: ApplicationMenuItem,
  send: SendMenuCommand,
  actions: ApplicationMenuActions,
): MenuItemConstructorOptions {
  if (item.kind === 'separator') return { id: item.id, type: 'separator' }
  const enabled = item.disabled !== true
  if (item.kind === 'submenu') {
    return {
      id: item.id,
      label: item.label,
      enabled,
      submenu: item.items.map((nested) => nativeItem(nested, send, actions)),
    }
  }
  if (item.kind === 'recent-document') {
    return {
      id: item.id,
      label: item.label,
      enabled,
      click: enabled && actions.openRecentDocument
        ? (_menuItem, owner) => actions.openRecentDocument?.(
            asBrowserWindow(owner),
            item.absolutePath,
          )
        : undefined,
    }
  }
  if (item.kind === 'radio') {
    return {
      id: item.id,
      label: item.label,
      type: 'radio',
      checked: item.checked,
      enabled,
      click: enabled ? (_menuItem, owner) => {
        const browserWindow = asBrowserWindow(owner)
        if (browserWindow) send(browserWindow, item.command)
      } : undefined,
    }
  }
  if (item.kind === 'command' || item.kind === 'checkbox') {
    return {
      id: item.id,
      label: item.label,
      ...('accelerator' in item ? { accelerator: item.accelerator } : {}),
      ...(item.kind === 'checkbox' ? { type: 'checkbox' as const, checked: item.checked } : {}),
      enabled,
      click: enabled ? (_menuItem, owner) => {
        const browserWindow = asBrowserWindow(owner)
        if (browserWindow) send(browserWindow, item.command)
      } : undefined,
    }
  }
  if (item.kind === 'role') {
    if (item.role === 'togglefullscreen') {
      return {
        id: item.id,
        label: item.label,
        accelerator: item.accelerator,
        enabled,
        ...(typeof item.checked === 'boolean'
          ? { type: 'checkbox' as const, checked: item.checked }
          : {}),
        click: enabled && actions.executeRole
          ? (_menuItem, owner) => {
              const browserWindow = asBrowserWindow(owner)
              if (browserWindow) actions.executeRole?.(browserWindow, item.role)
            }
          : undefined,
      }
    }
    return {
      id: item.id,
      label: item.label,
      accelerator: item.accelerator,
      enabled,
      role: item.role,
      ...(typeof item.checked === 'boolean'
        ? { type: 'checkbox' as const, checked: item.checked }
        : {}),
    }
  }
  const action = actions[item.action as ApplicationMenuAction]
  return {
    id: item.id,
    label: item.label,
    accelerator: item.accelerator,
    ...(item.action === 'beginScreenshotTranslation' ? { registerAccelerator: false } : {}),
    enabled,
    click: enabled && action ? (_menuItem, owner) => {
      action(asBrowserWindow(owner))
    } : undefined,
  }
}

export function buildApplicationMenuTemplate(
  send: SendMenuCommand,
  actions: ApplicationMenuActions,
  model: readonly ApplicationMenuSection[] = buildApplicationMenuModel(
    DEFAULT_APPLICATION_MENU_RUNTIME_STATE,
  ),
): MenuItemConstructorOptions[] {
  return model.map((section) => ({
    id: section.id,
    label: section.label,
    submenu: section.items.map((item) => nativeItem(item, send, actions)),
  }))
}
