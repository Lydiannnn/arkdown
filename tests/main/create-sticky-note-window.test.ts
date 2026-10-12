import { beforeEach, describe, expect, it, vi } from 'vitest'

const browserWindowHarness = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  const instances: Array<{
    show: ReturnType<typeof vi.fn>
    once: ReturnType<typeof vi.fn>
    setBackgroundMaterial: ReturnType<typeof vi.fn>
    setAlwaysOnTop: ReturnType<typeof vi.fn>
    getBounds(): { x: number; y: number; width: number; height: number }
    setBounds: ReturnType<typeof vi.fn>
  }> = []
  const BrowserWindow = vi.fn(function MockBrowserWindow(options: { x?: number; y?: number; width: number; height: number }) {
    const events = new EventEmitter()
    let bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width + 3, height: options.height + 1 }
    const instance = {
      on: events.on.bind(events), removeListener: events.removeListener.bind(events),
      isDestroyed: () => false, setHasShadow: vi.fn(),
      show: vi.fn(),
      once: vi.fn(),
      setBackgroundMaterial: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      getBounds: vi.fn(() => ({ ...bounds })),
      setBounds: vi.fn((requested: typeof bounds) => { bounds = { ...requested } }),
      webContents: Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), isDestroyed: () => false, send: vi.fn() }),
      loadURL: vi.fn(async () => undefined),
      loadFile: vi.fn(async () => undefined),
    }
    instances.push(instance)
    return instance
  })
  return { BrowserWindow, instances }
})

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: browserWindowHarness.BrowserWindow }))

import {
  buildStickyNoteWindowOptions,
  createStickyNoteWindow,
  stickyNoteWindowUrl,
} from '../../src/main/create-sticky-note-window'
import type { StickyNoteStyleReference } from '../../src/shared/sticky-note-preferences'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'
const CLASSIC_STYLE = {
  mode: 'preset',
  colorPresetId: 'yellow',
  texturePresetId: 'plain',
} satisfies StickyNoteStyleReference

describe('sticky note BrowserWindow', () => {
  beforeEach(() => {
    browserWindowHarness.instances.length = 0
    vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://127.0.0.1:5173')
    vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window')
  })

  it('leaves ready-to-show promotion to the manager while creating the window hidden', () => {
    createStickyNoteWindow({ noteId: NOTE_ID, pinned: true, style: CLASSIC_STYLE })

    expect(browserWindowHarness.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ show: false }),
    )
    const created = browserWindowHarness.instances[0]!
    expect(created.setAlwaysOnTop).toHaveBeenCalledWith(true, 'pop-up-menu')
    expect(created.once).not.toHaveBeenCalled()
    expect(created.show).not.toHaveBeenCalled()
    expect(created.setBounds).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'win32')('restores persisted geometry before binding material policy', () => {
    createStickyNoteWindow({ noteId: NOTE_ID, style: CLASSIC_STYLE, bounds: { x: 160, y: 180, width: 428, height: 301 } })
    const created = browserWindowHarness.instances[0]!
    expect(created.getBounds()).toEqual({ x: 160, y: 180, width: 428, height: 301 })
    expect(created.setBounds).toHaveBeenCalledTimes(1)
    expect(created.setBounds.mock.invocationCallOrder[0]).toBeLessThan(created.setBackgroundMaterial.mock.invocationCallOrder[0]!)
  })

  it('uses the required default, minimum and secure renderer settings', () => {
    const options = buildStickyNoteWindowOptions('C:\\app\\preload.js', null, CLASSIC_STYLE)

    expect(options).toMatchObject({
      width: 320,
      height: 320,
      minWidth: 180,
      minHeight: 180,
      frame: false,
      roundedCorners: true,
      hasShadow: true,
      resizable: true,
      show: false,
      skipTaskbar: false,
      title: '便签 — Arknote',
      webPreferences: {
        preload: 'C:\\app\\preload.js',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
  })

  it('accepts only safe persisted bounds', () => {
    expect(buildStickyNoteWindowOptions('preload.js', {
      x: 30,
      y: 40,
      width: 480,
      height: 560,
    }, CLASSIC_STYLE)).toMatchObject({ x: 30, y: 40, width: 480, height: 560 })

    expect(buildStickyNoteWindowOptions('preload.js', {
      x: 30,
      y: 40,
      width: 100,
      height: 100,
    }, CLASSIC_STYLE)).toMatchObject({ width: 320, height: 320 })
  })

  it('creates new notes with the persisted hide-taskbar preference', () => {
    createStickyNoteWindow({ noteId: NOTE_ID, style: CLASSIC_STYLE, hideTaskbarIcons: true })
    expect(browserWindowHarness.BrowserWindow).toHaveBeenLastCalledWith(expect.objectContaining({ skipTaskbar: true }))
  })

  it('creates Mica and flowing-glass notes with their native backdrops', () => {
    const mica = buildStickyNoteWindowOptions('preload.js', null, {
      mode: 'material',
      materialPresetId: 'mica-light',
    })
    expect(mica.backgroundMaterial).toBe('mica')
    expect(mica.backgroundColor).toBeUndefined()

    const flowingGlass = buildStickyNoteWindowOptions('preload.js', null, {
      mode: 'material',
      materialPresetId: 'flowing-glass',
    })
    expect(flowingGlass.backgroundMaterial).toBe('acrylic')
    expect(flowingGlass.backgroundColor).toBeUndefined()
  })

  it('bootstraps classic notes through a translucent WebContents and then disables the backdrop', () => {
    const options = buildStickyNoteWindowOptions('preload.js', null, CLASSIC_STYLE)
    expect(options.backgroundMaterial).toBe('mica')
    expect(options.backgroundColor).toBeUndefined()

    createStickyNoteWindow({ noteId: NOTE_ID, style: CLASSIC_STYLE })
    expect(browserWindowHarness.instances[0]!.setBackgroundMaterial).toHaveBeenCalledWith('none')
  })

  it('builds an encoded sticky-note route without accepting arbitrary query text', () => {
    expect(stickyNoteWindowUrl('http://127.0.0.1:5173', NOTE_ID))
      .toBe(`http://127.0.0.1:5173/?surface=sticky-note&noteId=${NOTE_ID}`)
    expect(() => stickyNoteWindowUrl('http://127.0.0.1:5173', '../bad'))
      .toThrow('便签 ID 无效')
  })
})
