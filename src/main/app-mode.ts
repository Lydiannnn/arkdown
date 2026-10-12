import path from 'node:path'

export type DesktopAppMode = 'arkdown' | 'arknote'

export interface AppProfileTarget {
  setName(name: string): void
  setPath(name: 'userData', value: string): void
}

export interface DesktopEntrypoints {
  startArkdown(): void | Promise<void>
  startArknote(): void | Promise<void>
}

export function desktopAppMode(executablePath: string): DesktopAppMode {
  return path.basename(executablePath).toLocaleLowerCase('en-US') === 'arknote.exe'
    ? 'arknote'
    : 'arkdown'
}

export function configureAppProfile(input: {
  app: AppProfileTarget
  mode: DesktopAppMode
  portableRoot: string
}): void {
  if (input.mode !== 'arknote') return
  input.app.setName('Arknote')
  input.app.setPath(
    'userData',
    path.join(input.portableRoot, 'portable-data', 'arknote', 'electron-profile'),
  )
}

export async function startDesktopApp(
  mode: DesktopAppMode,
  entrypoints: DesktopEntrypoints,
): Promise<void> {
  if (mode === 'arknote') {
    await entrypoints.startArknote()
    return
  }
  await entrypoints.startArkdown()
}
