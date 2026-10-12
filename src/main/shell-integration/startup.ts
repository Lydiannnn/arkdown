import { canInitializeDesktopRegistration } from './windows-registry'
import type { ShellIntegrationService } from './service'

/** The ordinary Arkdown bootstrap initializes both applications independently. */
export async function restoreArkdownContextMenus(
  shell: Pick<ShellIntegrationService, 'restoreEnabled'>,
  readArknoteSettings: () => Promise<unknown>,
  report: (message: string, error: unknown) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // The applications own disjoint menu keys. The caller schedules this after
  // presentation and drains it on shutdown; each service serializes user edits.
  await Promise.all([
    shell.restoreEnabled().catch((error) => report('Could not restore context menus', error)),
    canInitializeDesktopRegistration(env)
      ? readArknoteSettings().catch((error) => report('Could not initialize Arknote desktop registration', error))
      : Promise.resolve(),
  ])
}
