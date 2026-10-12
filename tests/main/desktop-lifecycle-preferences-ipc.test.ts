import { describe, expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'

function dependencies() {
  const value = {
    launchAtLogin: false,
    closeBehavior: 'tray' as const,
    stickyNoteAutostartPrompted: false,
  }
  return {
    value,
    deps: {
      chooseDirectory: vi.fn(),
      workspace: {} as never,
      documents: {} as never,
      getLastWorkspace: () => null,
      setLastWorkspace: vi.fn(),
      reportError: vi.fn(),
      getDesktopLifecyclePreferences: vi.fn(() => value),
      setDesktopLifecyclePreferences: vi.fn(async () => undefined),
    },
  }
}

describe('desktop lifecycle preference IPC', () => {
  it('gets and updates the exact lifecycle preference shape', async () => {
    const { deps, value } = dependencies()
    const operations = createIpcOperations(deps)
    const updated = { ...value, launchAtLogin: true, stickyNoteAutostartPrompted: true }

    await expect(operations.getDesktopLifecyclePreferences()).resolves.toEqual({
      ok: true,
      value,
    })
    await expect(operations.setDesktopLifecyclePreferences(updated)).resolves.toEqual({
      ok: true,
      value: updated,
    })
    expect(deps.setDesktopLifecyclePreferences).toHaveBeenCalledWith(updated)
  })

  it('rejects partial, extra, and mistyped lifecycle preferences', async () => {
    const { deps, value } = dependencies()
    const operations = createIpcOperations(deps)

    for (const input of [
      { launchAtLogin: true, closeBehavior: 'tray' },
      { ...value, extra: true },
      { ...value, launchAtLogin: 1 },
      { ...value, closeBehavior: 'hide' },
    ]) {
      await expect(operations.setDesktopLifecyclePreferences(input))
        .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    expect(deps.setDesktopLifecyclePreferences).not.toHaveBeenCalled()
  })
})
