const MAX_MENU_DEPTH = 4
const MAX_MENU_ITEMS = 96
const MAX_TEXT_LENGTH = 256

export const STICKY_NOTE_CONTEXT_MENU_CHANNELS = Object.freeze({
  open: 'sticky-note-context-menu:open',
  close: 'sticky-note-context-menu:close',
  execute: 'sticky-note-context-menu:execute',
  show: 'sticky-note-context-menu:show',
  command: 'sticky-note-context-menu:command',
  closed: 'sticky-note-context-menu:closed',
  ready: 'sticky-note-context-menu:ready',
  reset: 'sticky-note-context-menu:reset',
} as const)

export interface SerializableContextMenuCommandItem {
  kind: 'command'
  id: string
  label: string
  icon?: string
  iconSrc?: string
  iconPixelSize?: { width: number; height: number }
  accentIcon?: boolean
  shortcut?: string
  disabled?: boolean
  disabledReason?: string
  danger?: boolean
  checked?: boolean
  checkedAppearance?: 'check' | 'theme-text'
  iconChoice?: boolean
  swatchColor?: string
  preview?: { kind: 'horizontal-rule'; color: string; height: number }
}

export interface SerializableContextMenuSubmenuItem {
  kind: 'submenu'
  id: string
  label: string
  items: readonly SerializableContextMenuItem[]
  icon?: string
  iconSrc?: string
  iconPixelSize?: { width: number; height: number }
}

export type SerializableContextMenuItem =
  | SerializableContextMenuCommandItem
  | { kind: 'separator'; id: string }
  | SerializableContextMenuSubmenuItem
  | {
    kind: 'icon-grid'
    id: string
    columns: number
    items: readonly SerializableContextMenuCommandItem[]
  }

export interface StickyNoteContextMenuOpenInput {
  requestId: string
  screenX: number
  screenY: number
  items: readonly SerializableContextMenuItem[]
  widthCssPx?: number
  submenuWidthCssPx?: number
  rootIconGutter?: 'reserved' | 'none'
  themeColorRgb?: string
  colorScheme?: 'light' | 'dark'
}

export interface StickyNoteContextMenuShowPayload {
  requestId: string
  x: number
  y: number
  items: readonly SerializableContextMenuItem[]
  widthCssPx?: number
  submenuWidthCssPx?: number
  rootIconGutter?: 'reserved' | 'none'
  themeColorRgb?: string
  colorScheme?: 'light' | 'dark'
}

export interface StickyNoteContextMenuCommand {
  requestId: string
  commandId: string
}

function ownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
    && Object.getPrototypeOf(value) === Object.prototype
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

function safeText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH
}

function safeCoordinate(value: unknown): value is number {
  return Number.isFinite(value) && Math.abs(value as number) <= 1_000_000
}

function parsePixelSize(value: unknown): { width: number; height: number } | undefined | null {
  if (value === undefined) return undefined
  if (!ownRecord(value) || !exactKeys(value, ['width', 'height'])) return null
  if (!Number.isInteger(value.width) || !Number.isInteger(value.height)) return null
  if ((value.width as number) < 1 || (value.width as number) > 256) return null
  if ((value.height as number) < 1 || (value.height as number) > 256) return null
  return { width: value.width as number, height: value.height as number }
}

function parseOptionalText(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return safeText(value) ? value : null
}

function parseOptionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'boolean' ? value : null
}

function parseOptionalSwatch(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value : null
}

function parseOptionalCheckedAppearance(value: unknown): 'check' | 'theme-text' | undefined | null {
  if (value === undefined) return undefined
  return value === 'check' || value === 'theme-text' ? value : null
}

function parseOptionalThemeColorRgb(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/gu, ' ')
  const channels = normalized.split(' ')
  if (channels.length !== 3 || channels.some((channel) => (
    !/^(?:0|[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])$/u.test(channel)
  ))) return null
  return normalized
}

function parseOptionalRootIconGutter(value: unknown): 'reserved' | 'none' | undefined | null {
  if (value === undefined) return undefined
  return value === 'reserved' || value === 'none' ? value : null
}

function parseOptionalColorScheme(value: unknown): 'light' | 'dark' | undefined | null {
  if (value === undefined) return undefined
  return value === 'light' || value === 'dark' ? value : null
}

function parseOptionalWidth(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  return Number.isFinite(value) && (value as number) >= 72 && (value as number) <= 500
    ? value as number
    : null
}

function parseMenuItem(value: unknown, depth: number): SerializableContextMenuItem | null {
  if (!ownRecord(value) || depth > MAX_MENU_DEPTH || !safeText(value.id) || typeof value.kind !== 'string') return null
  if (value.kind === 'separator') {
    return exactKeys(value, ['kind', 'id']) ? { kind: 'separator', id: value.id as string } : null
  }
  if (value.kind === 'icon-grid') {
    if (!exactKeys(value, ['kind', 'id', 'columns', 'items'])) return null
    if (!Number.isInteger(value.columns) || (value.columns as number) < 1 || (value.columns as number) > 12) return null
    if (!Array.isArray(value.items) || value.items.length > MAX_MENU_ITEMS) return null
    const items = value.items.map((item) => parseMenuItem(item, depth + 1))
    if (items.some((item) => item?.kind !== 'command')) return null
    return {
      kind: 'icon-grid', id: value.id as string, columns: value.columns as number,
      items: items as SerializableContextMenuCommandItem[],
    }
  }
  const commonOptional = ['icon', 'iconSrc', 'iconPixelSize']
  if (value.kind === 'submenu') {
    if (!exactKeys(value, ['kind', 'id', 'label', 'items'], commonOptional)) return null
    if (!safeText(value.label) || !Array.isArray(value.items) || value.items.length > MAX_MENU_ITEMS) return null
    const items = value.items.map((item) => parseMenuItem(item, depth + 1))
    if (items.some((item) => item === null)) return null
    const icon = parseOptionalText(value.icon)
    const iconSrc = parseOptionalText(value.iconSrc)
    const iconPixelSize = parsePixelSize(value.iconPixelSize)
    if (icon === null || iconSrc === null || iconPixelSize === null) return null
    return {
      kind: 'submenu', id: value.id as string, label: value.label,
      items: items as SerializableContextMenuItem[],
      ...(icon === undefined ? {} : { icon }),
      ...(iconSrc === undefined ? {} : { iconSrc }),
      ...(iconPixelSize === undefined ? {} : { iconPixelSize }),
    }
  }
  if (value.kind !== 'command') return null
  const optional = [
    ...commonOptional, 'accentIcon', 'shortcut', 'disabled', 'disabledReason',
    'danger', 'checked', 'checkedAppearance', 'iconChoice', 'swatchColor', 'preview',
  ]
  if (!exactKeys(value, ['kind', 'id', 'label'], optional) || !safeText(value.label)) return null
  const icon = parseOptionalText(value.icon)
  const iconSrc = parseOptionalText(value.iconSrc)
  const iconPixelSize = parsePixelSize(value.iconPixelSize)
  const shortcut = parseOptionalText(value.shortcut)
  const disabledReason = parseOptionalText(value.disabledReason)
  const swatchColor = parseOptionalSwatch(value.swatchColor)
  const checkedAppearance = parseOptionalCheckedAppearance(value.checkedAppearance)
  const booleans = ['accentIcon', 'disabled', 'danger', 'checked', 'iconChoice'] as const
  const parsedBooleans = booleans.map((key) => parseOptionalBoolean(value[key]))
  if (
    icon === null || iconSrc === null || iconPixelSize === null || shortcut === null
    || disabledReason === null || swatchColor === null || checkedAppearance === null
    || parsedBooleans.includes(null)
  ) return null
  let preview: SerializableContextMenuCommandItem['preview'] | undefined
  if (value.preview !== undefined) {
    if (!ownRecord(value.preview) || !exactKeys(value.preview, ['kind', 'color', 'height'])) return null
    if (value.preview.kind !== 'horizontal-rule' || !safeText(value.preview.color)) return null
    if (!Number.isInteger(value.preview.height) || (value.preview.height as number) < 1 || (value.preview.height as number) > 64) return null
    preview = { kind: 'horizontal-rule', color: value.preview.color, height: value.preview.height as number }
  }
  const command: SerializableContextMenuCommandItem = {
    kind: 'command', id: value.id as string, label: value.label,
  }
  if (typeof icon === 'string') command.icon = icon
  if (typeof iconSrc === 'string') command.iconSrc = iconSrc
  if (iconPixelSize) command.iconPixelSize = iconPixelSize
  if (typeof parsedBooleans[0] === 'boolean') command.accentIcon = parsedBooleans[0]
  if (typeof shortcut === 'string') command.shortcut = shortcut
  if (typeof parsedBooleans[1] === 'boolean') command.disabled = parsedBooleans[1]
  if (typeof disabledReason === 'string') command.disabledReason = disabledReason
  if (typeof parsedBooleans[2] === 'boolean') command.danger = parsedBooleans[2]
  if (typeof parsedBooleans[3] === 'boolean') command.checked = parsedBooleans[3]
  if (checkedAppearance !== undefined) command.checkedAppearance = checkedAppearance
  if (typeof parsedBooleans[4] === 'boolean') command.iconChoice = parsedBooleans[4]
  if (typeof swatchColor === 'string') command.swatchColor = swatchColor
  if (preview) command.preview = preview
  return command
}

export function parseSerializableContextMenuItems(value: unknown): readonly SerializableContextMenuItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MENU_ITEMS) return null
  const items = value.map((item) => parseMenuItem(item, 0))
  return items.some((item) => item === null) ? null : items as SerializableContextMenuItem[]
}

export function serializeStickyNoteContextMenuItems(items: readonly unknown[]): readonly SerializableContextMenuItem[] {
  const clean = items.map((item) => {
    if (!ownRecord(item)) throw new Error('Invalid sticky-note context menu item')
    const { onSelect: _onSelect, ...rest } = item
    if (rest.icon !== undefined && typeof rest.icon !== 'string') delete rest.icon
    if ((rest.kind === 'submenu' || rest.kind === 'icon-grid') && Array.isArray(rest.items)) {
      return { ...rest, items: serializeStickyNoteContextMenuItems(rest.items) }
    }
    return rest
  })
  const parsed = parseSerializableContextMenuItems(clean)
  if (!parsed) throw new Error('Invalid sticky-note context menu items')
  return parsed
}

export function parseStickyNoteContextMenuOpenInput(value: unknown): StickyNoteContextMenuOpenInput | null {
  if (!ownRecord(value) || !exactKeys(value, ['requestId', 'screenX', 'screenY', 'items'], ['widthCssPx', 'submenuWidthCssPx', 'rootIconGutter', 'themeColorRgb', 'colorScheme'])) return null
  if (!safeText(value.requestId) || !safeCoordinate(value.screenX) || !safeCoordinate(value.screenY)) return null
  const widthCssPx = parseOptionalWidth(value.widthCssPx)
  const submenuWidthCssPx = parseOptionalWidth(value.submenuWidthCssPx)
  const rootIconGutter = parseOptionalRootIconGutter(value.rootIconGutter)
  const themeColorRgb = parseOptionalThemeColorRgb(value.themeColorRgb)
  const colorScheme = parseOptionalColorScheme(value.colorScheme)
  if (
    widthCssPx === null || submenuWidthCssPx === null
    || rootIconGutter === null || themeColorRgb === null || colorScheme === null
  ) return null
  const items = parseSerializableContextMenuItems(value.items)
  return items ? {
    requestId: value.requestId, screenX: value.screenX, screenY: value.screenY, items,
    ...(widthCssPx === undefined ? {} : { widthCssPx }),
    ...(submenuWidthCssPx === undefined ? {} : { submenuWidthCssPx }),
    ...(rootIconGutter === undefined ? {} : { rootIconGutter }),
    ...(themeColorRgb === undefined ? {} : { themeColorRgb }),
    ...(colorScheme === undefined ? {} : { colorScheme }),
  } : null
}

export function parseStickyNoteContextMenuCommand(value: unknown): StickyNoteContextMenuCommand | null {
  if (!ownRecord(value) || !exactKeys(value, ['requestId', 'commandId'])) return null
  return safeText(value.requestId) && safeText(value.commandId)
    ? { requestId: value.requestId, commandId: value.commandId }
    : null
}

function parseStickyNoteContextMenuRequestEvent(value: unknown): { requestId: string } | null {
  if (!ownRecord(value) || !exactKeys(value, ['requestId'])) return null
  return safeText(value.requestId) ? { requestId: value.requestId } : null
}

export function parseStickyNoteContextMenuClosed(value: unknown): { requestId: string } | null {
  return parseStickyNoteContextMenuRequestEvent(value)
}

export function parseStickyNoteContextMenuReady(value: unknown): { requestId: string } | null {
  return parseStickyNoteContextMenuRequestEvent(value)
}

export function parseStickyNoteContextMenuReset(value: unknown): { requestId: string } | null {
  return parseStickyNoteContextMenuRequestEvent(value)
}

export function parseStickyNoteContextMenuShowPayload(value: unknown): StickyNoteContextMenuShowPayload | null {
  if (!ownRecord(value) || !exactKeys(value, ['requestId', 'x', 'y', 'items'], ['widthCssPx', 'submenuWidthCssPx', 'rootIconGutter', 'themeColorRgb', 'colorScheme'])) return null
  if (!safeText(value.requestId) || !safeCoordinate(value.x) || !safeCoordinate(value.y)) return null
  const widthCssPx = parseOptionalWidth(value.widthCssPx)
  const submenuWidthCssPx = parseOptionalWidth(value.submenuWidthCssPx)
  const rootIconGutter = parseOptionalRootIconGutter(value.rootIconGutter)
  const themeColorRgb = parseOptionalThemeColorRgb(value.themeColorRgb)
  const colorScheme = parseOptionalColorScheme(value.colorScheme)
  if (
    widthCssPx === null || submenuWidthCssPx === null
    || rootIconGutter === null || themeColorRgb === null || colorScheme === null
  ) return null
  const items = parseSerializableContextMenuItems(value.items)
  return items ? {
    requestId: value.requestId, x: value.x, y: value.y, items,
    ...(widthCssPx === undefined ? {} : { widthCssPx }),
    ...(submenuWidthCssPx === undefined ? {} : { submenuWidthCssPx }),
    ...(rootIconGutter === undefined ? {} : { rootIconGutter }),
    ...(themeColorRgb === undefined ? {} : { themeColorRgb }),
    ...(colorScheme === undefined ? {} : { colorScheme }),
  } : null
}
