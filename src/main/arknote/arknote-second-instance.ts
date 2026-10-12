import { ARKNOTE_AUTOSTART_ARGUMENT } from '../sticky-notes/sticky-note-autostart'

export type ArknoteLaunchCommand = 'open-box' | 'new-note' | 'open-settings'
type ArknoteSingleInstanceCommand = ArknoteLaunchCommand | 'ensure-service'

export interface ArknoteSingleInstanceApp {
  requestSingleInstanceLock(additionalData: Record<string, unknown>): boolean
  on(
    event: 'second-instance',
    listener: (
      event: unknown,
      argv: string[],
      cwd: string,
      additionalData: unknown,
    ) => void,
  ): void
  quit(): void
}

const flags: Readonly<Record<string, ArknoteLaunchCommand>> = {
  '--open-box': 'open-box',
  '--new-note': 'new-note',
  '--open-settings': 'open-settings',
}

export function parseArknoteLaunchCommand(argv: readonly string[]): ArknoteLaunchCommand {
  for (const value of argv) {
    const command = flags[value]
    if (command) return command
  }
  return 'open-box'
}

export function arknoteSingleInstanceData(
  argv: readonly string[],
): { arknoteCommand: ArknoteSingleInstanceCommand } {
  const publicCommand = argv.find((value) => flags[value])
  return {
    arknoteCommand: publicCommand
      ? flags[publicCommand]
      : argv.includes(ARKNOTE_AUTOSTART_ARGUMENT)
        ? 'ensure-service'
        : 'open-box',
  }
}

export function parseArknoteSingleInstanceData(
  value: unknown,
): ArknoteSingleInstanceCommand | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).length !== 1) return undefined
  const command = record.arknoteCommand
  return command === 'open-box'
    || command === 'new-note'
    || command === 'open-settings'
    || command === 'ensure-service'
    ? command
    : undefined
}

export function acquireArknoteSingleInstance(
  app: ArknoteSingleInstanceApp,
  argv: readonly string[],
  onCommand: (command: ArknoteLaunchCommand) => void,
): boolean {
  const acquired = app.requestSingleInstanceLock(arknoteSingleInstanceData(argv))
  if (!acquired) {
    app.quit()
    return false
  }
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    const command = parseArknoteSingleInstanceData(additionalData)
    if (command && command !== 'ensure-service') onCommand(command)
  })
  return true
}
