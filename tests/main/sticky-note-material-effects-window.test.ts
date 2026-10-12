import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyStickyNoteWallpaperAppearances } from '../../src/shared/sticky-note-glass-appearance'
import { DEFAULT_STICKY_NOTE_MICA_APPEARANCE } from '../../src/shared/sticky-note-mica-appearance'
import { DEFAULT_STICKY_NOTE_GLASS_APPEARANCES } from '../../src/shared/sticky-note-glass-appearance'
import { DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS } from '../../src/shared/sticky-note-material-effects'
const DEFAULT_APPEARANCES = { micaAppearance: DEFAULT_STICKY_NOTE_MICA_APPEARANCE, glassAppearances: DEFAULT_STICKY_NOTE_GLASS_APPEARANCES, materialEffects: DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS }
import { STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL as CHANNEL } from '../../src/shared/sticky-note-material-effects'

const native = vi.hoisted(() => ({ apply: vi.fn((_input: unknown) => true) }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: { isPackaged: false },
    BrowserWindow: class extends EventEmitter {
      webContents = Object.assign(new EventEmitter(), {
        send: vi.fn(), isDestroyed: () => false, setWindowOpenHandler: vi.fn(),
      })
      isDestroyed = () => false
      isFocused = () => false
      isMaximized = () => false
      isFullScreen = () => false
      setAlwaysOnTop = vi.fn()
      loadURL = vi.fn(async () => { this.webContents.emit('did-finish-load') })
      loadFile = this.loadURL
    },
  }
})
// This test owns the window/event wiring; the native controller is a separate boundary.
vi.mock('../../src/main/sticky-notes/sticky-note-native-surface', () => ({
  createStickyNoteNativeSurfaceController: () => ({
    bind: () => () => undefined, setAppearance: () => true, setWallpaperAppearances: native.apply,
    hasShadow: () => false,
  }),
  loadStickyNoteNativeSurface: () => null,
}))

import { createStickyNoteWindow, setStickyNoteWallpaperAppearances } from '../../src/main/create-sticky-note-window'

interface Note extends EventEmitter {
  webContents: EventEmitter & { send: ReturnType<typeof vi.fn> }
}
const notes: Note[] = []
function createNote(): Note {
  const note = createStickyNoteWindow({
    noteId: '00000000-0000-4000-8000-000000000001',
    style: { mode: 'material', materialPresetId: 'clear-glass' },
  }) as unknown as Note
  notes.push(note)
  return note
}
function effectsCalls(note: Note) { return note.webContents.send.mock.calls.filter(([channel]) => channel === CHANNEL) }
function draft() {
  const result = copyStickyNoteWallpaperAppearances(DEFAULT_APPEARANCES)
  result.materialEffects['clear-glass'] = { transparency: 0.8, innerGlowIntensity: 0.4, innerGlowRangePx: 60 }
  return result
}

describe('note-window effective material effects wiring', () => {
  beforeEach(() => {
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173')
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    native.apply.mockReset().mockReturnValue(true)
    setStickyNoteWallpaperAppearances(copyStickyNoteWallpaperAppearances(DEFAULT_APPEARANCES))
    native.apply.mockClear()
  })
  afterEach(() => {
    for (const note of notes.splice(0)) note.emit('closed')
    vi.restoreAllMocks()
  })

  it('binds before synchronous initial loading and replays the active draft to new and reloaded notes', () => {
    const value = draft()
    expect(setStickyNoteWallpaperAppearances(value)).toBe(true)
    const first = createNote()
    expect(effectsCalls(first)).toEqual([[CHANNEL, value.materialEffects]])
    value.materialEffects['clear-glass'].innerGlowRangePx = 0
    first.webContents.emit('did-start-loading')
    first.webContents.emit('did-finish-load')
    const second = createNote()
    expect(effectsCalls(first).at(-1)).toEqual([CHANNEL, draft().materialEffects])
    expect(effectsCalls(second)).toEqual([[CHANNEL, draft().materialEffects]])
  })

  it.each(['false', 'throw'])('publishes effects even when the native update returns %s, then retries the same map', failure => {
    const note = createNote()
    if (failure === 'throw') native.apply.mockImplementationOnce(() => { throw new Error('native lost') })
    else native.apply.mockReturnValueOnce(false)
    const value = draft()
    expect(setStickyNoteWallpaperAppearances(value)).toBe(false)
    expect(effectsCalls(note).at(-1)).toEqual([CHANNEL, value.materialEffects])
    expect(setStickyNoteWallpaperAppearances(value)).toBe(true)
    expect(native.apply).toHaveBeenCalledTimes(2)
  })

  it('keeps healthy peers and cached state current after a send failure and retries through the same complete snapshot', async () => {
    const failing = createNote(); const healthy = createNote()
    const value = draft()
    failing.webContents.send.mockImplementationOnce(() => { throw new Error('renderer unavailable') })
    expect(setStickyNoteWallpaperAppearances(value)).toBe(false)
    expect(effectsCalls(healthy).at(-1)).toEqual([CHANNEL, value.materialEffects])
    expect(effectsCalls(createNote())).toEqual([[CHANNEL, value.materialEffects]])
    expect(setStickyNoteWallpaperAppearances(value)).toBe(true)
    expect(effectsCalls(failing).at(-1)).toEqual([CHANNEL, value.materialEffects])
    expect(native.apply).toHaveBeenCalledTimes(2)
  })

  it('isolates the effects snapshot from native sink mutation and rejects malformed maps atomically', () => {
    const note = createNote(); const value = draft()
    native.apply.mockImplementationOnce((input: unknown) => {
      (input as typeof value).materialEffects['clear-glass'].innerGlowRangePx = 0
      return true
    })
    expect(setStickyNoteWallpaperAppearances(value)).toBe(true)
    expect(effectsCalls(note).at(-1)).toEqual([CHANNEL, value.materialEffects])
    const count = note.webContents.send.mock.calls.length
    expect(() => setStickyNoteWallpaperAppearances({ ...value, materialEffects: {} } as never)).toThrow()
    expect(native.apply).toHaveBeenCalledTimes(1)
    expect(note.webContents.send).toHaveBeenCalledTimes(count)
  })
})
