import { SCREENSHOT_TRANSLATION_ACCELERATOR } from './screenshot-translation'

export interface ShortcutDefinition {
  id: string
  label: string
  group: string
  defaultAccelerator: string | null
  owner: 'native' | 'renderer' | 'global' | 'fixed'
}

const entry = (id: string, label: string, group: string, defaultAccelerator: string | null,
  owner: ShortcutDefinition['owner'] = 'native'): ShortcutDefinition => ({ id, label, group, defaultAccelerator, owner })

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  entry('file.new-document', '新建文档', '文件', 'Ctrl+N'),
  entry('file.new-window', '新建窗口', '文件', 'Ctrl+Shift+N'),
  entry('file.open-document', '打开文档', '文件', 'Ctrl+O'),
  entry('file.open-workspace', '打开文件夹', '文件', 'Ctrl+Shift+O'),
  entry('file.save', '保存', '文件', 'Ctrl+S'),
  entry('file.save-as', '另存为', '文件', 'Ctrl+Shift+S'),
  entry('file.print', '打印', '文件', 'Ctrl+P'),
  entry('file.close-window', '关闭窗口', '文件', 'Ctrl+W'),
  entry('edit.find', '在文档中搜索', '搜索与大纲', 'Ctrl+F'),
  entry('workspace.search', '在文件夹中搜索', '搜索与大纲', 'Ctrl+Shift+F', 'renderer'),
  entry('document.outline', '显示或隐藏大纲', '搜索与大纲', 'Ctrl+Shift+E', 'renderer'),
  entry('view.sidebar', '显示或隐藏侧边栏', '视图', 'Ctrl+Shift+L'),
  entry('view.source', '切换源码模式', '视图', 'Ctrl+/'),
  entry('view.actual-size', '实际大小', '视图', 'Ctrl+0'),
  entry('view.zoom-in', '放大', '视图', 'Ctrl+Plus'),
  entry('view.zoom-out', '缩小', '视图', 'Ctrl+-'),
  entry('view.fullscreen', '全屏', '视图', 'F11'),
  entry('tools.screenshot-translation', '截图翻译', '工具', SCREENSHOT_TRANSLATION_ACCELERATOR, 'global'),
  entry('tools.screen-translation-once', '悬浮翻译窗一次（工具打开时）', '工具', 'Ctrl+Shift+A', 'global'),
  entry('tools.screen-translation-toggle', '悬浮翻译窗自动开关（工具打开时）', '工具', 'Ctrl+Alt+T', 'global'),
  entry('tools.screen-translation-clear', '悬浮翻译窗清除译文（工具打开时）', '工具', 'Ctrl+Shift+D', 'global'),
  ...[
    ['undo', '撤销', 'Ctrl+Z'], ['redo', '重做', 'Ctrl+Y'],
    ['redo-alternate', '重做（实时预览）', 'Ctrl+Shift+Z'],
    ['cut', '剪切', 'Ctrl+X'], ['copy', '复制', 'Ctrl+C'],
    ['paste', '粘贴', 'Ctrl+V'], ['select-all', '全选', 'Ctrl+A'],
  ].map(([id, label, key]) => entry(`edit.${id}`, label!, '通用编辑', key!, 'fixed')),
  ...[
    ['strong', '加粗', 'Ctrl+B'], ['emphasis', '斜体', 'Ctrl+I'],
    ['link', '链接', 'Ctrl+K'], ['paragraph', '正文', 'Ctrl+`'],
    ['inline-code', '行内代码（实时预览）', 'Ctrl+E'],
    ['strike', '删除线（实时预览）', 'Ctrl+Alt+X'],
    ['blockquote', '引用（实时预览）', 'Ctrl+Shift+B'],
    ['code-block', '代码块（实时预览）', 'Ctrl+Alt+C'],
    ['ordered-list', '有序列表（实时预览）', 'Ctrl+Alt+7'],
    ['bullet-list', '无序列表（实时预览）', 'Ctrl+Alt+8'],
    ['body-alternate', '正文（实时预览）', 'Ctrl+Alt+0'],
    ['indent', '增加缩进 / 下一单元格', 'Ctrl+]'],
    ['outdent', '减少缩进 / 上一单元格', 'Ctrl+['],
    ['exit-block', '退出代码块 / 表格（实时预览）', 'Ctrl+Enter'],
  ].map(([id, label, key]) => entry(`editor.${id}`, label!, '编辑器', key!, 'fixed')),
  ...[1, 2, 3, 4, 5, 6].flatMap(level => [
    entry(`editor.heading-${level}`, `${level} 级标题`, '编辑器', `Ctrl+${level}`, 'fixed'),
    entry(`editor.heading-alt-${level}`, `${level} 级标题（实时预览）`, '编辑器', `Ctrl+Alt+${level}`, 'fixed'),
  ]),
  ...[
    ['left', '向前移动一个词', 'Ctrl+Left'], ['right', '向后移动一个词', 'Ctrl+Right'],
    ['home', '移至文档开头', 'Ctrl+Home'], ['end', '移至文档结尾', 'Ctrl+End'],
    ['select-left', '向前选择一个词', 'Ctrl+Shift+Left'], ['select-right', '向后选择一个词', 'Ctrl+Shift+Right'],
    ['select-home', '选择至文档开头', 'Ctrl+Shift+Home'], ['select-end', '选择至文档结尾', 'Ctrl+Shift+End'],
    ['delete-left', '删除前一个词', 'Ctrl+Backspace'], ['delete-right', '删除后一个词', 'Ctrl+Delete'],
  ].map(([id, label, key]) => entry(`navigation.${id}`, label!, '导航与文本', key!, 'fixed')),
]

export type ShortcutBindings = Record<string, string | null>
export interface ShortcutSnapshot { bindings: ShortcutBindings; revision: number }
export type ShortcutUpdate = { id: string; accelerator: string | null } | { id: string; reset: true } | { resetAll: true }
export interface ShortcutUpdateResult { snapshot: ShortcutSnapshot; error: string | null }
export interface ObservedShortcutSnapshot extends ShortcutSnapshot {
  observation: { version: 1; minimumBaseRevision: number; fields: Partial<Record<string, number>> }
}
export interface ObservedShortcutUpdate { observed: ObservedShortcutSnapshot; change: ShortcutUpdate }
export interface ObservedShortcutUpdateResult { snapshot: ObservedShortcutSnapshot; error: string | null }
export const SHORTCUTS_CHANGED_CHANNEL = 'settings:shortcuts-changed'

const definitionsById = new Map(SHORTCUT_DEFINITIONS.map(item => [item.id, item]))
export function shortcutFor(id: string, bindings: ShortcutBindings = {}): string | null {
  if (definitionsById.get(id)?.owner === 'fixed' && bindings[id] === null) return definitionsById.get(id)!.defaultAccelerator
  return Object.hasOwn(bindings, id) ? bindings[id]! : definitionsById.get(id)?.defaultAccelerator ?? null
}

const namedKeys = new Set(['Plus', 'Space', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right'])
export function normalizeAccelerator(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null
  const parts = value.replaceAll('CmdOrCtrl', 'Ctrl').split('+')
  let key = parts.pop() ?? ''
  const modifiers = new Set(parts)
  if (parts.some(part => !['Ctrl', 'Alt', 'Shift'].includes(part)) || modifiers.size !== parts.length) return null
  if (/^[a-z]$/i.test(key)) key = key.toUpperCase()
  if (key === '=') key = 'Plus'
  if (!(namedKeys.has(key) || /^[A-Z0-9`\-\[\];',./\\]$/.test(key) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key))) return null
  if (!modifiers.has('Ctrl') && !modifiers.has('Alt') && !/^F\d+$/.test(key)) return null
  if (key === 'Plus') modifiers.delete('Shift')
  return [...['Ctrl', 'Alt', 'Shift'].filter(part => modifiers.has(part)), key].join('+')
}

interface ShortcutKeyEvent {
  key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean
  isComposing?: boolean; repeat?: boolean; keyCode?: number
}
export function acceleratorFromKeyEvent(event: ShortcutKeyEvent): string | null {
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.metaKey || event.key === 'Escape') return null
  let key = event.key
  if (event.code?.startsWith('Key')) key = event.code.slice(3)
  else if (event.code?.startsWith('Digit')) key = event.code.slice(5)
  else if (event.code === 'Equal') key = 'Plus'
  else if (event.code === 'Backquote') key = '`'
  else if (event.code === 'Slash') key = '/'
  else if (key.startsWith('Arrow')) key = key.slice(5)
  else if (key === ' ') key = 'Space'
  return normalizeAccelerator([event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+'))
}

export function matchesShortcut(event: ShortcutKeyEvent & { defaultPrevented?: boolean }, id: string, bindings: ShortcutBindings): boolean {
  return !event.defaultPrevented && shortcutFor(id, bindings) !== null && acceleratorFromKeyEvent(event) === shortcutFor(id, bindings)
}

export function shortcutConflict(id: string, accelerator: string | null, bindings: ShortcutBindings): string | null {
  if (accelerator === null) return null
  const match = SHORTCUT_DEFINITIONS.find(item => item.id !== id && shortcutFor(item.id, bindings) === accelerator)
  if (match) return `此快捷键已用于“${match.label}”。请先修改原绑定或选择其他组合。`
  if (['Alt+F4', 'Alt+Tab', 'Ctrl+Alt+Delete'].includes(accelerator)) return '此组合由系统使用，请选择其他快捷键。'
  return null
}

export function applyShortcutUpdate(bindings: ShortcutBindings, update: ShortcutUpdate): ShortcutBindings {
  if ('resetAll' in update) return {}
  const definition = definitionsById.get(update.id)
  if (!definition) throw new Error('此操作不支持自定义快捷键。')
  if ('accelerator' in update && update.accelerator === null && definition.owner === 'fixed') throw new Error('此快捷键不能清除，可以修改或恢复默认。')
  const next = { ...bindings }
  if ('reset' in update) delete next[update.id]
  else {
    const key = update.accelerator === null ? null : normalizeAccelerator(update.accelerator)
    if (key === null && update.accelerator !== null) throw new Error('请使用 Ctrl、Alt 组合键或功能键。')
    next[update.id] = key
  }
  const conflict = shortcutConflict(update.id, shortcutFor(update.id, next), next)
  if (conflict) throw new Error(conflict)
  return next
}

export function normalizeShortcutBindings(value: unknown): ShortcutBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const candidates: ShortcutBindings = {}
  for (const item of SHORTCUT_DEFINITIONS) {
    if (!Object.hasOwn(value, item.id)) continue
    const raw = (value as ShortcutBindings)[item.id]
    if (raw === null) { if (item.owner !== 'fixed') candidates[item.id] = null }
    else { const normalized = normalizeAccelerator(raw); if (normalized) candidates[item.id] = normalized }
  }
  // Remove conflicting overrides until no fallback default can introduce a new conflict.
  for (let pass = 0; pass < SHORTCUT_DEFINITIONS.length; pass++) {
    let changed = false
    for (const id of Object.keys(candidates)) {
      if (shortcutConflict(id, shortcutFor(id, candidates), candidates)) { delete candidates[id]; changed = true }
    }
    if (!changed) break
  }
  return candidates
}

export function parseShortcutSnapshot(value: unknown): ShortcutSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const record = value as ShortcutSnapshot
  if (!Number.isSafeInteger(record.revision) || record.revision < 0 || !record.bindings || typeof record.bindings !== 'object' || Array.isArray(record.bindings)) return null
  const bindings = normalizeShortcutBindings(record.bindings)
  if (Object.keys(bindings).length !== Object.keys(record.bindings).length) return null
  return { bindings, revision: record.revision }
}

export function parseShortcutUpdate(value: unknown): ShortcutUpdate | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.resetAll === true && Object.keys(record).length === 1) return { resetAll: true }
  if (typeof record.id !== 'string' || Object.keys(record).length !== 2) return null
  if (record.accelerator === null && definitionsById.get(record.id)?.owner === 'fixed') return null
  if (record.reset === true) return { id: record.id, reset: true }
  if (record.accelerator === null || typeof record.accelerator === 'string') return { id: record.id, accelerator: record.accelerator }
  return null
}

function exactShortcutRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
}

export function parseObservedShortcutSnapshot(value: unknown): ObservedShortcutSnapshot | null {
  if (!exactShortcutRecord(value, ['bindings', 'revision', 'observation'])) return null
  const snapshot = parseShortcutSnapshot(value), observation = value.observation
  if (!snapshot || !exactShortcutRecord(observation, ['version', 'minimumBaseRevision', 'fields'])
    || observation.version !== 1 || !Number.isSafeInteger(observation.minimumBaseRevision)
    || Number(observation.minimumBaseRevision) < 0 || Number(observation.minimumBaseRevision) > snapshot.revision) return null
  const bindings = value.bindings
  if (!exactShortcutRecord(bindings, Object.keys(snapshot.bindings))
    || Object.entries(snapshot.bindings).some(([id, binding]) => bindings[id] !== binding)) return null
  const fields = observation.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)
    || !exactShortcutRecord(fields, Object.keys(fields)) || Object.keys(fields).length > SHORTCUT_DEFINITIONS.length) return null
  const copied: Partial<Record<string, number>> = {}
  for (const [id, revision] of Object.entries(fields)) {
    if (!definitionsById.has(id) || !Number.isSafeInteger(revision) || Number(revision) < 0 || Number(revision) > snapshot.revision) return null
    copied[id] = Number(revision)
  }
  return { ...snapshot, observation: { version: 1, minimumBaseRevision: Number(observation.minimumBaseRevision), fields: copied } }
}

export function parseObservedShortcutUpdate(value: unknown): ObservedShortcutUpdate | null {
  if (!exactShortcutRecord(value, ['observed', 'change'])) return null
  const observed = parseObservedShortcutSnapshot(value.observed), change = parseShortcutUpdate(value.change)
  if (!observed || !change || ('id' in change && !definitionsById.has(change.id))
    || !exactShortcutRecord(value.change, Object.keys(change))) return null
  return { observed, change }
}

export function parseObservedShortcutUpdateResult(value: unknown): ObservedShortcutUpdateResult | null {
  if (!exactShortcutRecord(value, ['snapshot', 'error']) || !(value.error === null || typeof value.error === 'string')) return null
  const snapshot = parseObservedShortcutSnapshot(value.snapshot)
  return snapshot ? { snapshot, error: value.error } : null
}
