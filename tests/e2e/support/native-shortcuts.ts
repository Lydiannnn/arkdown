import type { ElectronApplication, Page } from '@playwright/test'

export async function saveWithNativeShortcut(application: ElectronApplication, page: Page): Promise<void> {
  // CDP Input.dispatchKeyEvent does not pass through Electron's before-input-event.
  // Exercise the application's real native shortcut router, as physical keys do.
  const window = await application.browserWindow(page)
  try {
    await window.evaluate((target) => {
      target.focus()
      target.webContents.focus()
      target.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['control'] })
      target.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['control'] })
    })
  } finally { await window.dispose() }
}
