import { describe, expect, it } from 'vitest'
import { DEFAULT_EDITOR_APPEARANCE, parseEditorAppearancePreferences, parseCompleteEditorAppearancePreferences, resolveEditorTheme } from '../../src/shared/editor-appearance-preferences'
import { buildApplicationMenuModel, DEFAULT_APPLICATION_MENU_RUNTIME_STATE } from '../../src/shared/application-menu-model'

describe('explicit editor theme', () => {
  it('round trips every explicit theme and defaults missing preferences to system', () => {
    const dark = { ...DEFAULT_EDITOR_APPEARANCE, editorTheme: 'dark' }
    expect(parseEditorAppearancePreferences(dark)).toEqual(dark)
    expect(parseCompleteEditorAppearancePreferences(dark)).toEqual(dark)
    const { editorTheme, ...legacy } = DEFAULT_EDITOR_APPEARANCE
    expect(parseEditorAppearancePreferences(legacy)?.editorTheme).toBe('system')
    expect(parseEditorAppearancePreferences({ ...dark, editorTheme: 'minimal' })?.editorTheme).toBe('minimal')
    expect(parseEditorAppearancePreferences({ ...dark, editorTheme: 'unknown' })).toBeUndefined()
  })

  it('offers exactly one checked theme for both modes', () => {
    for (const editorTheme of ['system', 'minimal', 'dark'] as const) {
      const themes = buildApplicationMenuModel({ ...DEFAULT_APPLICATION_MENU_RUNTIME_STATE, editorTheme })
        .find(section => section.id === 'theme')!.items.filter(item => item.kind === 'radio')
      expect(themes.map(item => item.label)).toEqual(['跟随系统', '浅色模式', '深色模式'])
      expect(themes.filter(item => item.checked).map(item => item.command)).toEqual([`select-editor-theme-${editorTheme}`])
    }
  })

  it('only resolves system selection from the OS', () => {
    for (const systemDark of [true, false]) {
      expect(resolveEditorTheme('system', systemDark)).toBe(systemDark ? 'dark' : 'minimal')
      expect(resolveEditorTheme('minimal', systemDark)).toBe('minimal')
      expect(resolveEditorTheme('dark', systemDark)).toBe('dark')
    }
  })
})
