import { describe, expect, it } from 'vitest'
import { APP_MENU_SECTIONS } from '../../src/shared/app-menu-definition'
import {
  applicationMenuItemById,
  buildApplicationMenuModel,
  DEFAULT_APPLICATION_MENU_RUNTIME_STATE,
} from '../../src/shared/application-menu-model'
import { MENU_COMMANDS } from '../../src/shared/menu-commands'
import { SCREENSHOT_TRANSLATION_ACCELERATOR } from '../../src/shared/screenshot-translation'

describe('screenshot translation application-menu model', () => {
  it('adds the Tools section and its main-process-owned screenshot action', () => {
    const model = buildApplicationMenuModel(DEFAULT_APPLICATION_MENU_RUNTIME_STATE)

    expect(APP_MENU_SECTIONS.map(({ id, label }) => [id, label])).toContainEqual(['tools', '工具'])
    expect(model.map(({ id, label }) => [id, label])).toContainEqual(['tools', '工具'])
    expect(applicationMenuItemById('tools.screenshot-translation', model)).toEqual({
      kind: 'action',
      id: 'tools.screenshot-translation',
      label: '截图翻译',
      action: 'beginScreenshotTranslation',
      accelerator: SCREENSHOT_TRANSLATION_ACCELERATOR,
    })
    expect(SCREENSHOT_TRANSLATION_ACCELERATOR).toBe('Ctrl+Shift+Q')
  })

  it('does not expose screenshot capture as a renderer menu command', () => {
    expect(MENU_COMMANDS).not.toContain('screenshot-translation')
  })
})

describe('document export application-menu model', () => {
  it('offers exactly DOCX and XLSX as direct commands in the export submenu', () => {
    const model = buildApplicationMenuModel(DEFAULT_APPLICATION_MENU_RUNTIME_STATE)

    expect(applicationMenuItemById('file.export', model)).toEqual({
      kind: 'submenu',
      id: 'file.export',
      label: '导出...',
      items: [
        {
          kind: 'command',
          id: 'file.export-docx',
          label: 'DOCX...',
          command: 'export-docx',
        },
        {
          kind: 'command',
          id: 'file.export-xlsx',
          label: 'XLSX...',
          command: 'export-xlsx',
        },
      ],
    })
    expect(MENU_COMMANDS).toContain('export-docx')
    expect(MENU_COMMANDS).toContain('export-xlsx')
  })
})

describe('body paragraph shortcut', () => {
  it('uses only the physical Backquote accelerator instead of Ctrl+0', () => {
    const model = buildApplicationMenuModel(DEFAULT_APPLICATION_MENU_RUNTIME_STATE)
    expect(applicationMenuItemById('paragraph.body', model)).toMatchObject({
      command: 'paragraph',
      accelerator: 'CmdOrCtrl+`',
    })
    expect(JSON.stringify(model)).not.toContain('CmdOrCtrl+0')
  })
})

describe('minimal editor theme menu', () => {
  it('keeps the stable light command and defaults to the system option', () => {
    const model = buildApplicationMenuModel(DEFAULT_APPLICATION_MENU_RUNTIME_STATE)

    expect(applicationMenuItemById('theme.minimal', model)).toEqual({
      kind: 'radio',
      id: 'theme.minimal',
      label: '浅色模式',
      checked: false,
      command: 'select-editor-theme-minimal',
    })
    expect(applicationMenuItemById('theme.github', model)).toBeNull()
    expect(MENU_COMMANDS).toContain('select-editor-theme-minimal')
    expect(JSON.stringify(model)).not.toContain('GitHub')
  })

  it('opens the global background settings surface from the Theme menu', () => {
    const model = buildApplicationMenuModel(DEFAULT_APPLICATION_MENU_RUNTIME_STATE)

    expect(applicationMenuItemById('theme.background', model)).toEqual({
      kind: 'action',
      id: 'theme.background',
      label: '设置背景...',
      action: 'openBackgroundSettings',
    })
  })
})
