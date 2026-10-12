import { describe, expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'

describe('desktop lifecycle preference preload API', () => {
  it('uses fixed channels and exposes only strictly parsed preferences', async () => {
    const value = {
      launchAtLogin: true,
      closeBehavior: 'quit' as const,
      stickyNoteAutostartPrompted: true,
    }
    const invoke = vi.fn().mockResolvedValue({ ok: true, value })
    const api = createArkdownApi(invoke)

    await expect(api.getDesktopLifecyclePreferences!())
      .resolves.toEqual({ ok: true, value })
    await expect(api.setDesktopLifecyclePreferences!(value))
      .resolves.toEqual({ ok: true, value })
    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.getDesktopLifecyclePreferences],
      [IPC_CHANNELS.setDesktopLifecyclePreferences, value],
    ])

    const malformed = createArkdownApi(vi.fn().mockResolvedValue({
      ok: true,
      value: { ...value, unexpected: true },
    }))
    await expect(malformed.getDesktopLifecyclePreferences!()).resolves.toEqual({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
    })
  })
})
