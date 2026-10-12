import type { ReactNode } from 'react'

export interface ContextMenuCommandItem {
  kind: 'command'
  id: string
  label: string
  icon?: ReactNode
  iconSrc?: string
  iconPixelSize?: { width: number; height: number }
  accentIcon?: boolean
  shortcut?: string
  disabled?: boolean
  disabledReason?: string
  tooltip?: string
  danger?: boolean
  checked?: boolean
  checkedAppearance?: 'check' | 'theme-text' | 'neutral-surface'
  iconChoice?: boolean
  swatchColor?: string
  onSelect?(): void | Promise<void>
  preview?: {
    kind: 'horizontal-rule'
    color: string
    height: number
  }
}

export interface ContextMenuIconCommandItem extends ContextMenuCommandItem {
  disabledTooltip?: string
}

export interface ContextMenuSubmenuItem {
  kind: 'submenu'
  id: string
  label: string
  items: readonly ContextMenuItem[]
  icon?: ReactNode
  iconSrc?: string
  iconPixelSize?: { width: number; height: number }
}

export type ContextMenuItem =
  | ContextMenuCommandItem
  | { kind: 'separator'; id: string }
  | ContextMenuSubmenuItem
  | {
    kind: 'icon-grid'
    id: string
    columns: number
    items: readonly ContextMenuIconCommandItem[]
  }

export interface ContextMenuRequest {
  x: number
  y: number
  items: readonly ContextMenuItem[]
  execute(id: string): void | Promise<void>
  onClose?(): void
  shouldRestoreFocus?(): boolean
  restoreFocus(): void
  executeBeforeClose?: boolean
  autoFocus?: boolean
  widthCssPx?: number
  submenuWidthCssPx?: number
  rootIconGutter?: 'reserved' | 'none'
}

export function commandItemById(
  items: readonly ContextMenuItem[],
  id: string,
): ContextMenuCommandItem | null {
  for (const item of items) {
    if (item.kind === 'command' && item.id === id) return item
    if (item.kind === 'icon-grid' || item.kind === 'submenu') {
      const nested = commandItemById(item.items, id)
      if (nested) return nested
    }
  }
  return null
}

export function collectEnabledCommandIds(items: readonly ContextMenuItem[]): string[] {
  const result: string[] = []
  for (const item of items) {
    if (item.kind === 'command') {
      if (!item.disabled) result.push(item.id)
      continue
    }
    if (item.kind === 'icon-grid' || item.kind === 'submenu') {
      result.push(...collectEnabledCommandIds(item.items))
    }
  }
  return result
}
