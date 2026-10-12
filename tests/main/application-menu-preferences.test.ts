import type { MenuItemConstructorOptions } from 'electron'
import { expect, it, vi } from 'vitest'
import { buildApplicationMenuTemplate } from '../../src/main/application-menu'

it('opens preferences from the File menu through a fixed renderer command', () => {
  const send = vi.fn()
  const actions = {
    createNewWindow: vi.fn(),
    openDocument: vi.fn(),
    closeWindow: vi.fn(),
    openGuide: vi.fn(),
    openAbout: vi.fn(),
    openBackgroundSettings: vi.fn(),
  }
  const template = buildApplicationMenuTemplate(send, actions)
  const file = template.find((item) => item.label === '文件')
  const submenu = file?.submenu as MenuItemConstructorOptions[] | undefined
  const preferences = submenu?.find((item) => item.label === '偏好设置…')
  const edit = template.find((item) => item.label === '编辑')
  const editSubmenu = edit?.submenu as MenuItemConstructorOptions[] | undefined

  expect(preferences).toBeDefined()
  expect(editSubmenu?.some((item) => item.label === '偏好设置…')).toBe(false)
  const owner = { webContents: {} } as Electron.BrowserWindow
  preferences?.click?.(null as never, owner, {} as never)
  expect(send).toHaveBeenCalledWith(owner, 'preferences')
})
