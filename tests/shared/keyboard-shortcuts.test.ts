import { describe, expect, it } from 'vitest'
import { acceleratorFromKeyEvent, shortcutConflict, shortcutFor, applyShortcutUpdate, normalizeShortcutBindings } from '../../src/shared/keyboard-shortcuts'
import { parseObservedShortcutSnapshot, parseObservedShortcutUpdate } from '../../src/shared/keyboard-shortcuts'
import { buildApplicationMenuModel, DEFAULT_APPLICATION_MENU_RUNTIME_STATE, applicationMenuItemById } from '../../src/shared/application-menu-model'

describe('keyboard shortcut preferences', () => {
  it('requires an exact bounded observed command with revisions for only known stable actions', () => {
    const observed = { bindings: { 'file.save': 'Ctrl+Alt+S' }, revision: 5,
      observation: { version: 1, minimumBaseRevision: 1, fields: { 'file.save': 3 } } }
    expect(parseObservedShortcutSnapshot(observed)).toEqual(observed)
    expect(parseObservedShortcutUpdate({ observed, change: { id: 'file.save', reset: true } }))
      .toEqual({ observed, change: { id: 'file.save', reset: true } })
    for (const input of [{ bindings: {}, revision: 0 }, { ...observed, path: 'arbitrary' },
      { ...observed, bindings: { 'file.save': 'Ctrl+alt+s' } },
      { ...observed, observation: { ...observed.observation, fields: { bad: 1 } } },
      { ...observed, observation: { ...observed.observation, fields: { 'file.save': 6 } } }]) {
      expect(parseObservedShortcutSnapshot(input)).toBeNull()
    }
    expect(parseObservedShortcutUpdate({ observed, change: { id: 'unknown', reset: true } })).toBeNull()
    expect(parseObservedShortcutUpdate({ id: 'file.save', reset: true })).toBeNull()
  })
  it('supports remapping, conflicts, clearing and restoring the floating translation clear shortcut', () => {
    const id = 'tools.screen-translation-clear'
    expect(shortcutFor(id)).toBe('Ctrl+Shift+D')
    expect(() => applyShortcutUpdate({}, { id, accelerator: 'Ctrl+Shift+A' })).toThrow('悬浮翻译窗')
    const remapped = applyShortcutUpdate({}, { id, accelerator: 'Ctrl+Alt+D' })
    expect(normalizeShortcutBindings(remapped)).toEqual(remapped)
    expect(shortcutFor(id, remapped)).toBe('Ctrl+Alt+D')
    expect(shortcutFor(id, applyShortcutUpdate(remapped, { id, accelerator: null }))).toBeNull()
    expect(shortcutFor(id, applyShortcutUpdate(remapped, { id, reset: true }))).toBe('Ctrl+Shift+D')
  })
  it('normalizes key events without accepting composing, modifier-only or typing keys', () => {
    const key = { key: 'r', code: 'KeyR', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }
    expect(acceleratorFromKeyEvent(key)).toBe('Ctrl+Shift+R')
    expect(acceleratorFromKeyEvent({ ...key, key: 'Control', code: 'ControlLeft' })).toBeNull()
    expect(acceleratorFromKeyEvent({ ...key, isComposing: true })).toBeNull()
    expect(acceleratorFromKeyEvent({ ...key, ctrlKey: false, shiftKey: false })).toBeNull()
  })
  it('rejects conflicts with customizable and actual fixed shortcuts', () => {
    expect(shortcutConflict('file.save', 'Ctrl+N', {})).toContain('新建文档')
    expect(shortcutConflict('file.save', 'Ctrl+B', {})).toContain('加粗')
    expect(shortcutConflict('file.save', 'Ctrl+S', {})).toBeNull()
  })
  it('distinguishes clear from default and keeps unrelated bindings on a patch', () => {
    const first = applyShortcutUpdate({}, { id: 'file.save', accelerator: 'Ctrl+Alt+S' })
    const second = applyShortcutUpdate(first, { id: 'edit.find', accelerator: null })
    expect(shortcutFor('file.save', second)).toBe('Ctrl+Alt+S')
    expect(shortcutFor('edit.find', second)).toBeNull()
    expect(shortcutFor('edit.find', applyShortcutUpdate(second, { id: 'edit.find', reset: true }))).toBe('Ctrl+F')
    expect(() => applyShortcutUpdate(second, { id: 'file.save', accelerator: 'Ctrl+N' })).toThrow('新建文档')
  })
  it('sanitizes persisted unknown, invalid and conflicting overrides', () => {
    expect(normalizeShortcutBindings({ bad: 'Ctrl+R', 'file.save': 'Ctrl+B', 'edit.find': null })).toEqual({ 'edit.find': null })
  })
  it('uses current bindings in native and renderer models and includes the trailing edit entry', () => {
    const model = buildApplicationMenuModel({ ...DEFAULT_APPLICATION_MENU_RUNTIME_STATE, shortcutBindings: { 'file.save': 'Ctrl+Alt+S', 'view.zoom-in': null } })
    expect(applicationMenuItemById('file.save', model)).toMatchObject({ accelerator: 'Ctrl+Alt+S' })
    expect(applicationMenuItemById('view.zoom-in', model)).toMatchObject({ accelerator: '' })
    expect(applicationMenuItemById('view.fullscreen', model)).toMatchObject({ accelerator: 'F11' })
    expect(model.find(s => s.id === 'edit')?.items.slice(-2)).toEqual([
      { kind: 'separator', id: 'edit.separator.shortcuts' },
      expect.objectContaining({ id: 'edit.shortcuts', label: '快捷键', command: 'shortcut-settings' }),
    ])
  })
})
