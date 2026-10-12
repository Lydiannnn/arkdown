import { ArknoteSettingsUpdateQueue, copyArknoteSettings, type ArknoteSettings } from './arknote-settings-store'
import type { DesktopContextMenuRegistration } from './desktop-context-menu'

export async function createArknoteContextMenuSettings(
  saved: ArknoteSettings,
  desktop: Pick<DesktopContextMenuRegistration, 'setEnabled'>,
  store: { save(settings: ArknoteSettings): Promise<void> },
  autostart: { sync(enabled: boolean): void },
  report: (message: string, error: unknown) => void,
): Promise<ArknoteSettingsUpdateQueue> {
  const initial = copyArknoteSettings(saved)
  let restoreFailed = false
  autostart.sync(initial.launchAtLogin)
  if (initial.registerDesktopContextMenu) {
    await desktop.setEnabled(true).catch((error) => {
      // Expose failure and let a subsequent true update enter the native path.
      // Do not persist an opt-out merely because this startup attempt failed.
      initial.registerDesktopContextMenu = false
      restoreFailed = true
      report('Could not restore desktop context menu', error)
    })
  }
  return new ArknoteSettingsUpdateQueue(initial, async (next, previous) => {
    if (next.registerDesktopContextMenu !== previous.registerDesktopContextMenu) {
      await desktop.setEnabled(next.registerDesktopContextMenu, () => store.save(next), { explicitEnable: next.registerDesktopContextMenu })
      restoreFailed = false
    } else {
      await store.save(restoreFailed ? { ...next, registerDesktopContextMenu: saved.registerDesktopContextMenu } : next)
    }
    if (next.launchAtLogin !== previous.launchAtLogin) autostart.sync(next.launchAtLogin)
  })
}
