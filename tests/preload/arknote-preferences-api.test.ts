import { describe, expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../src/shared/arknote-preferences'
import { IPC_CHANNELS } from '../../src/shared/contracts'

describe('Arknote preference preload API', () => {
  it('uses fixed channels and reconstructs strict preference values', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: DEFAULT_ARKNOTE_PREFERENCES }))
    const api = createArkdownApi(invoke)

    await expect(api.getArknotePreferences?.()).resolves.toEqual({
      ok: true,
      value: DEFAULT_ARKNOTE_PREFERENCES,
    })
    await expect(api.setArknotePreferences?.(DEFAULT_ARKNOTE_PREFERENCES)).resolves.toEqual({
      ok: true,
      value: DEFAULT_ARKNOTE_PREFERENCES,
    })
    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.getArknotePreferences],
      [IPC_CHANNELS.setArknotePreferences, DEFAULT_ARKNOTE_PREFERENCES],
    ])
  })

  it('uses a strict transient preview channel and theme event subscription', async () => {
    const invoke = vi.fn(async () => ({ ok: true, value: null }))
    let emit: ((payload: unknown) => void) | undefined
    const api = createArkdownApi(
      invoke,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        subscribe(listener) {
          emit = listener
          return () => undefined
        },
      },
    )
    const themeListener = vi.fn()
    api.onArknoteThemeColorChanged?.(themeListener)

    await expect(api.previewArknoteThemeColor?.('#2563eb')).resolves.toEqual({
      ok: true,
      value: null,
    })
    expect(invoke).toHaveBeenCalledWith(
      IPC_CHANNELS.previewArknoteThemeColor,
      { themeColor: '#2563EB' },
    )
    emit?.({ type: 'theme-color-changed', themeColor: '#18864b' })
    emit?.({ type: 'theme-color-changed', themeColor: 'green' })
    expect(themeListener).toHaveBeenCalledTimes(1)
    expect(themeListener).toHaveBeenCalledWith('#18864B')
  })

  it('fails closed when the service returns an extended preference object', async () => {
    const api = createArkdownApi(vi.fn(async () => ({
      ok: true,
      value: { ...DEFAULT_ARKNOTE_PREFERENCES, unexpected: true },
    })))

    await expect(api.getArknotePreferences?.()).resolves.toEqual({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
    })
  })
})
