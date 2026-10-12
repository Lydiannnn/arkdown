import { describe, expect, it, vi } from 'vitest'
import {
  ARKNOTE_AUTOSTART_ARGUMENT,
  StickyNoteAutostart,
} from '../../src/main/sticky-notes/sticky-note-autostart'

describe('StickyNoteAutostart', () => {
  it('registers only the sibling Arknote executable with an argument array', () => {
    const setLoginItemSettings = vi.fn()
    const autostart = new StickyNoteAutostart({
      executablePath: 'C:\\Portable Apps\\Arkdown\\Arkdown.exe',
      setLoginItemSettings,
    })

    autostart.sync(true)

    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: 'C:\\Portable Apps\\Arkdown\\Arknote.exe',
      args: [ARKNOTE_AUTOSTART_ARGUMENT],
    })
  })

  it('removes the same login item without string-building the path', () => {
    const setLoginItemSettings = vi.fn()
    const autostart = new StickyNoteAutostart({
      executablePath: 'C:\\Portable Apps\\Arkdown\\Arkdown.exe',
      setLoginItemSettings,
    })

    autostart.sync(false)

    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      path: 'C:\\Portable Apps\\Arkdown\\Arknote.exe',
      args: [ARKNOTE_AUTOSTART_ARGUMENT],
    })
  })
})