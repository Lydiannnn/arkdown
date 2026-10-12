import { expect, it, vi } from 'vitest'
import { applyArknoteTaskbarPreference, createArknoteTaskbarPreferenceChange } from '../../src/main/arknote/taskbar-preference'
import { DEFAULT_ARKNOTE_SETTINGS, applyArknotePreferences, arknotePreferencesFromSettings, parseArknoteSettings, arknotePreferencesUpdateFromSettings } from '../../src/main/arknote/arknote-settings-store'

it('defaults legacy settings to visible taskbar icons and keeps tray preference out of ordinary UI writes', () => {
  const { hideTaskbarIcons: _old, ...legacy } = DEFAULT_ARKNOTE_SETTINGS
  expect(parseArknoteSettings(legacy)?.hideTaskbarIcons).toBe(false)
  expect(parseArknoteSettings({ ...legacy, hideTaskbarIcons: 'yes' })).toBeUndefined()
  const hidden = { ...DEFAULT_ARKNOTE_SETTINGS, hideTaskbarIcons: true }
  const ordinary = arknotePreferencesFromSettings(hidden)
  expect(applyArknotePreferences(hidden, ordinary).hideTaskbarIcons).toBe(true)
  expect(arknotePreferencesUpdateFromSettings(hidden)).not.toHaveProperty('hideTaskbarIcons')
})
it('persists before changing all live note windows without recreating or repositioning them', async () => {
  const order: string[] = []
  const first = { isDestroyed: () => false, setSkipTaskbar: vi.fn(() => { order.push('first') }) }
  const second = { isDestroyed: () => false, setSkipTaskbar: vi.fn(() => { order.push('second') }) }
  const dead = { isDestroyed: () => true, setSkipTaskbar: vi.fn() }
  await applyArknoteTaskbarPreference(true, { persist: async value => { expect(value).toBe(true); order.push('save') }, windows: () => [first, dead, second] })
  expect(order).toEqual(['save', 'first', 'second'])
  expect(dead.setSkipTaskbar).not.toHaveBeenCalled()
  expect(first.setSkipTaskbar).toHaveBeenCalledExactlyOnceWith(true)
})
it('does not change windows on persistence failure and still applies other windows after a native failure', async () => {
  const failing = { isDestroyed: () => false, setSkipTaskbar: vi.fn(() => { throw new Error('private/native') }) }
  const good = { isDestroyed: () => false, setSkipTaskbar: vi.fn() }
  await expect(applyArknoteTaskbarPreference(true, { persist: async () => { throw new Error('disk failed') }, windows: () => [good] })).rejects.toMatchObject({ code: 'save-failed' })
  expect(good.setSkipTaskbar).not.toHaveBeenCalled()
  await expect(applyArknoteTaskbarPreference(false, { persist: async () => {}, windows: () => [failing, good] })).rejects.toMatchObject({ code: 'apply-failed' })
  expect(good.setSkipTaskbar).toHaveBeenCalledExactlyOnceWith(false)
})
it('retries only native application once this user action has already persisted', async () => {
  const persist = vi.fn(async () => {})
  const window = { isDestroyed: () => false, setSkipTaskbar: vi.fn().mockImplementationOnce(() => { throw new Error('native failed') }) }
  const change = createArknoteTaskbarPreferenceChange(true, { persist, windows: () => [window] })
  await expect(change()).rejects.toMatchObject({ code: 'apply-failed' })
  persist.mockRejectedValueOnce(new Error('a second disk write must not happen'))
  await expect(change()).resolves.toBeUndefined()
  expect(persist).toHaveBeenCalledExactlyOnceWith(true)
  expect(window.setSkipTaskbar).toHaveBeenCalledTimes(2)
})
