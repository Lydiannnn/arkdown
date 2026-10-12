import { ShellMenuRegistration, type ShellRegistrationIntent } from '../shell-integration/registration'
import type { RegistryBoundary } from '../shell-integration/windows-registry'

export const ARKNOTE_DESKTOP_CONTEXT_MENU_KEY =
  'HKCU\\Software\\Classes\\DesktopBackground\\Shell\\Arknote'

export interface DesktopContextMenuRegistrationOptions {
  executablePath: string
  registry?: RegistryBoundary
}

export class DesktopContextMenuRegistration {
  private readonly registration: ShellMenuRegistration
  constructor(options: DesktopContextMenuRegistrationOptions) {
    this.registration = new ShellMenuRegistration(options)
  }
  setEnabled(enabled: boolean, persist?: () => Promise<void>, intent?: ShellRegistrationIntent): Promise<void> {
    return this.registration.setEnabled('desktopNote', enabled, persist, intent)
  }
}
