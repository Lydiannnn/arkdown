import { describe, expect, it, vi } from 'vitest'
import { ArknoteImmediateSave } from '../../src/renderer/settings/arknote-immediate-save'
import { copyArknotePreferences, DEFAULT_ARKNOTE_PREFERENCES, type ArknotePreferences } from '../../src/shared/arknote-preferences'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
describe('Arknote immediate preference saves', () => {
  it('serializes writes, keeps newer controls responsive, coalesces queued slider changes, and flushes the final revision', async () => {
    const first = deferred<ArknotePreferences>()
    const second = deferred<ArknotePreferences>()
    const persist = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const observe = vi.fn()
    const queue = new ArknoteImmediateSave(DEFAULT_ARKNOTE_PREFERENCES, persist, observe)
    queue.change({ launchAtLogin: true })
    queue.change({ registerDesktopContextMenu: false })
    queue.change({ startupHintDismissed: true })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(observe.mock.calls.at(-1)![0].value.startupHintDismissed).toBe(true)
    let finished = false
    const flush = queue.flush().then(value => { finished = true; return value })
    first.resolve({ ...DEFAULT_ARKNOTE_PREFERENCES, launchAtLogin: true })
    await Promise.resolve(); await Promise.resolve()
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[1][0]).toMatchObject({ launchAtLogin: true, registerDesktopContextMenu: false, startupHintDismissed: true })
    expect(finished).toBe(false)
    second.resolve({ ...DEFAULT_ARKNOTE_PREFERENCES, ...persist.mock.calls[1][0] })
    expect(await flush).toBe(true)
    expect(observe.mock.calls.at(-1)![0]).toMatchObject({ pending: false, error: null })
  })
  it('retries failed material changes without silently dropping them on a later ordinary setting', async () => {
    const initial = copyArknotePreferences(DEFAULT_ARKNOTE_PREFERENCES)
    const materials = { ...initial.glassAppearances, 'clear-glass': { ...initial.glassAppearances['clear-glass'], luminosityOpacity: 0.72 } }
    const persist = vi.fn().mockRejectedValueOnce(new Error('synthetic write error')).mockImplementation(async input => ({ ...initial, ...input }))
    const observe = vi.fn()
    const queue = new ArknoteImmediateSave(initial, persist, observe)
    queue.change({ glassAppearances: materials })
    expect(await queue.flush()).toBe(false)
    expect(observe.mock.calls.at(-1)![0].error).toContain('设置未能保存')
    await Promise.resolve()
    queue.change({ launchAtLogin: true })
    expect(await queue.flush()).toBe(true)
    expect(persist.mock.calls[1][0]).toMatchObject({ glassAppearances: materials, launchAtLogin: true })
  })
  it('does not submit unchanged material groups for an ordinary checkbox edit', async () => {
    const persist = vi.fn(async input => ({ ...DEFAULT_ARKNOTE_PREFERENCES, ...input }))
    const queue = new ArknoteImmediateSave(DEFAULT_ARKNOTE_PREFERENCES, persist, () => undefined)
    queue.change({ launchAtLogin: true })
    expect(await queue.flush()).toBe(true)
    for (const key of ['micaAppearance', 'glassAppearances', 'materialEffects']) expect(persist.mock.calls[0][0]).not.toHaveProperty(key)
  })
})
