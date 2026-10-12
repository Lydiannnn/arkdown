import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { SettingsStore } from '../../src/main/settings/settings-store'
import {
  DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES,
  type DesktopLifecyclePreferences,
} from '../../src/shared/desktop-lifecycle-preferences'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))))

describe('desktop lifecycle preference persistence', () => {
  it('round-trips lifecycle preferences through the settings whitelist', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-lifecycle-prefs-'))
    roots.push(root)
    const store = new SettingsStore(root)
    const lifecycle: DesktopLifecyclePreferences = {
      launchAtLogin: true,
      closeBehavior: 'quit',
      stickyNoteAutostartPrompted: true,
    }

    await store.save({ lastWorkspace: null, desktopLifecycle: lifecycle })

    expect((await store.load()).desktopLifecycle).toEqual(lifecycle)
  })

  it('copies lifecycle settings before exposing or saving coordinator state', async () => {
    const writes: unknown[] = []
    const coordinator = new SettingsCoordinator(
      { save: async (settings) => { writes.push(settings) } },
      {
        lastWorkspace: null,
        desktopLifecycle: DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES,
      },
    )

    const exposed = coordinator.get()
    exposed.desktopLifecycle!.launchAtLogin = true
    expect(coordinator.get().desktopLifecycle)
      .toEqual(DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES)

    await coordinator.update((settings) => ({
      ...settings,
      desktopLifecycle: {
        ...settings.desktopLifecycle!,
        stickyNoteAutostartPrompted: true,
      },
    }))
    expect(writes).toHaveLength(1)
    expect(coordinator.get().desktopLifecycle).toEqual({
      ...DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES,
      stickyNoteAutostartPrompted: true,
    })
  })
})
