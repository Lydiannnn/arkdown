import { describe, expect, it } from 'vitest'
import { SHORTCUT_DEFINITIONS, applyShortcutUpdate, normalizeShortcutBindings, parseShortcutSnapshot, parseShortcutUpdate, shortcutFor } from '../../src/shared/keyboard-shortcuts'
import { applicationMenuItemById, buildApplicationMenuModel, DEFAULT_APPLICATION_MENU_RUNTIME_STATE } from '../../src/shared/application-menu-model'
import { isMenuCommand } from '../../src/shared/menu-commands'

describe('editable builtin shortcuts', () => {
  it('accepts renderer command routing and allows the released old combination to be reused', () => {
    expect(isMenuCommand('search-workspace')).toBe(true)
    expect(isMenuCommand('toggle-document-outline')).toBe(true)
    expect(isMenuCommand('execute-arbitrary-shortcut')).toBe(false)
    const first = applyShortcutUpdate({}, { id: 'editor.strong', accelerator: 'Ctrl+R' })
    const next = applyShortcutUpdate(first, { id: 'workspace.search', accelerator: 'Ctrl+B' })
    expect(normalizeShortcutBindings(next)).toEqual(next)
    expect(() => applyShortcutUpdate(next, { id: 'editor.strong', reset: true })).toThrow('搜索')
  })
  for (const definition of SHORTCUT_DEFINITIONS.filter(item => item.owner === 'fixed')) {
    it(`changes, persists and resets ${definition.id}, but never clears it`, () => {
      const bindings = applyShortcutUpdate({}, { id: definition.id, accelerator: 'Ctrl+Alt+Shift+F12' })
      expect(shortcutFor(definition.id, bindings)).toBe('Ctrl+Alt+Shift+F12')
      expect(normalizeShortcutBindings(bindings)).toEqual(bindings)
      expect(shortcutFor(definition.id, applyShortcutUpdate(bindings, { id: definition.id, reset: true }))).toBe(definition.defaultAccelerator)
      expect(() => applyShortcutUpdate(bindings, { id: definition.id, accelerator: null })).toThrow('不能清除')
      expect(parseShortcutUpdate({ id: definition.id, accelerator: null })).toBeNull()
      expect(normalizeShortcutBindings({ [definition.id]: null })).toEqual({})
      expect(parseShortcutSnapshot({ bindings: { [definition.id]: null }, revision: 1 })).toBeNull()
      expect(shortcutFor(definition.id, { [definition.id]: null })).toBe(definition.defaultAccelerator)
    })
  }
  it('maps menu command IDs to their editable builtin definitions', () => {
    const aliases = { 'format.strong': 'editor.strong', 'format.emphasis': 'editor.emphasis', 'format.link': 'editor.link', 'format.strike': 'editor.strike', 'format.inline-code': 'editor.inline-code', 'paragraph.body': 'editor.paragraph', 'paragraph.heading-1': 'editor.heading-1', 'paragraph.heading-6': 'editor.heading-6', 'paragraph.unordered-list': 'editor.bullet-list', 'paragraph.ordered-list': 'editor.ordered-list', 'paragraph.indent': 'editor.indent', 'paragraph.outdent': 'editor.outdent', 'paragraph.blockquote': 'editor.blockquote', 'paragraph.code-fence': 'editor.code-block', 'edit.undo': 'edit.undo' }
    for (const [menuId, shortcutId] of Object.entries(aliases)) {
      const model = buildApplicationMenuModel({ ...DEFAULT_APPLICATION_MENU_RUNTIME_STATE, shortcutBindings: { [shortcutId]: 'Ctrl+Alt+Shift+F12' } })
      expect(applicationMenuItemById(menuId, model)).toMatchObject({ accelerator: 'Ctrl+Alt+Shift+F12' })
    }
  })
})
