import { describe, expect, it, vi } from 'vitest'
import {
  chooseArknoteBackgroundImage,
  createArknoteBackgroundWiring,
} from '../../src/main/arknote-main'
import type { BackgroundSettingsWindow } from '../../src/main/backgrounds/background-settings-window-registry'
import type { BackgroundIpcService } from '../../src/main/ipc/register-ipc'
import { BACKGROUND_PRESENTATION_CHANNEL } from '../../src/shared/contracts'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'
const target = { kind: 'sticky-note' as const, noteId: NOTE_ID }

function stickyWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
    },
  }
}

describe('ArkNote background wiring', () => {
  it('routes source previews to the originating sticky note and applied state to every sticky note', async () => {
    const origin = stickyWindow()
    const peer = stickyWindow()
    const windowListeners = new Map<string, () => void>()
    const settingsWindow = {
      show: vi.fn(),
      focus: vi.fn(),
      close: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => windowListeners.set(event, listener)),
    }
    const persisted = {
      settings: {
        ...DEFAULT_BACKGROUND_SETTINGS,
        imageRelativePath: 'backgrounds/current.webp',
      },
      imageUrl: 'arkdown-asset://current',
    }
    const notes = {
      read: vi.fn(async () => ({ record: { background: persisted.settings } })),
      resolveBackgroundImagePath: vi.fn(async () => 'C:\\notes\\current.webp'),
      applyBackground: vi.fn(async (_noteId, settings) => ({ background: settings })),
    }
    const chosen = vi.fn(async () => 'C:\\pictures\\replacement.avif')
    let scoped: BackgroundIpcService | undefined
    const register = vi.fn((_window: BackgroundSettingsWindow, service: BackgroundIpcService) => {
      scoped = service
      return { dispose: vi.fn() }
    })
    const registry = createArknoteBackgroundWiring({
      notes: notes as never,
      assetAccess: { urlFor: vi.fn(async (value: string) => `arkdown-asset://${value}`) },
      stickyNoteWindows: new Set([origin, peer]) as never,
      chooseBackgroundImage: chosen,
      createWindow: vi.fn(() => settingsWindow),
      register,
    })

    await registry.serviceFor((event) => {
      origin.webContents.send(BACKGROUND_PRESENTATION_CHANNEL, event)
    }).open(target)
    if (!scoped) throw new Error('Expected settings IPC to be registered')

    await scoped.choose(target)
    expect(origin.webContents.send).toHaveBeenLastCalledWith(
      BACKGROUND_PRESENTATION_CHANNEL,
      expect.objectContaining({ target, phase: 'preview' }),
    )
    expect(peer.webContents.send).not.toHaveBeenCalled()

    await scoped.apply(target, DEFAULT_BACKGROUND_SETTINGS)
    for (const noteWindow of [origin, peer]) {
      expect(noteWindow.webContents.send).toHaveBeenLastCalledWith(
        BACKGROUND_PRESENTATION_CHANNEL,
        expect.objectContaining({ target, phase: 'applied' }),
      )
    }
  })

  it('limits background selection to static image formats', async () => {
    const showOpenDialog = vi.fn(async () => ({
      canceled: false,
      filePaths: ['C:\\pictures\\wallpaper.webp'],
    }))

    await expect(chooseArknoteBackgroundImage(showOpenDialog)).resolves
      .toBe('C:\\pictures\\wallpaper.webp')

    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      properties: ['openFile'],
      filters: [{
        name: '图片文件',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'svg'],
      }],
    }))
  })

  it('opens sticky-background selection in the last selected image directory', async () => {
    const showOpenDialog = vi.fn(async () => ({
      canceled: true,
      filePaths: [],
    }))

    await chooseArknoteBackgroundImage(showOpenDialog, 'C:\\pictures\\wallpapers')

    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      defaultPath: 'C:\\pictures\\wallpapers',
    }))
  })
})
