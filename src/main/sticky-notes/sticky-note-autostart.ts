import path from 'node:path'

export const ARKNOTE_AUTOSTART_ARGUMENT = '--arkdown-autostart'
// Retained until Arkdown's legacy service wiring is removed in Task 5.
export const ARKDOWN_AUTOSTART_ARGUMENT = ARKNOTE_AUTOSTART_ARGUMENT

interface StickyNoteAutostartOptions {
  executablePath: string
  setLoginItemSettings(settings: {
    openAtLogin: boolean
    path: string
    args: string[]
  }): void
}

export class StickyNoteAutostart {
  constructor(private readonly options: StickyNoteAutostartOptions) {}

  sync(enabled: boolean): void {
    this.options.setLoginItemSettings({
      openAtLogin: enabled,
      path: path.join(path.dirname(this.options.executablePath), 'Arknote.exe'),
      args: [ARKNOTE_AUTOSTART_ARGUMENT],
    })
  }
}