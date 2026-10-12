import { expect, it, vi } from 'vitest'
import { ShortcutSettingsService } from '../../src/main/settings/shortcut-settings-service'
import { ScreenScopedShortcut } from '../../src/main/screen-translation/scoped-shortcut'
import { registerScreenshotTranslationShortcut } from '../../src/main/screenshot-translation/screenshot-shortcut'

const shot = 'tools.screenshot-translation'
const once = 'tools.screen-translation-once'
const toggle = 'tools.screen-translation-toggle'
const clear = 'tools.screen-translation-clear'
const swapped = { [shot]: 'Ctrl+Shift+A', [once]: 'Ctrl+Shift+Q', [toggle]: 'Ctrl+Alt+Y', [clear]: 'Ctrl+Alt+D' }
function setup() {
  const keys = new Map<string, () => void>()
  const unavailable = new Set<string>()
  const attempts: string[] = []
  const adapter = {
    register(key: string, callback: () => void) {
      attempts.push(key)
      if (keys.has(key) || unavailable.has(key)) return false
      keys.set(key, callback); return true
    },
    unregister(key: string) { keys.delete(key) },
    isRegistered(key: string) { return keys.has(key) },
  }
  const actions = [vi.fn(), vi.fn(), vi.fn(), vi.fn()] as const
  const screenshot = registerScreenshotTranslationShortcut({ accelerator: swapped[shot], globalShortcut: adapter,
    getOwner: () => ({}) as never, beginCapture: actions[0] })
  const one = new ScreenScopedShortcut(adapter, swapped[once], actions[1], vi.fn())
  const auto = new ScreenScopedShortcut(adapter, swapped[toggle], actions[2], vi.fn())
  const erase = new ScreenScopedShortcut(adapter, swapped[clear], actions[3], vi.fn())
  one.activate(); auto.activate(); erase.activate()
  let data = { shortcuts: { ...swapped } }
  const persist = vi.fn(async () => {})
  const settings = { get: () => data, update: async (update: (value: typeof data) => typeof data) => {
    const next = update(data); await persist(); data = next
  } }
  const service = new ShortcutSettingsService({ settings: settings as never, screenshot,
    additionalGlobals: [{ id: once, registration: one }, { id: toggle, registration: auto }, { id: clear, registration: erase }],
    broadcast: vi.fn(), refreshMenus: vi.fn() })
  return { service, keys, unavailable, persist, actions, attempts }
}
const originalKeys = Object.values(swapped).sort()
const defaultKeys = ['Ctrl+Shift+Q', 'Ctrl+Shift+A', 'Ctrl+Alt+T', 'Ctrl+Shift+D'].sort()
it('resets swapped screenshot/screen bindings using one shared OS occupancy set', async () => {
  const t = setup()
  expect((await t.service.update({ resetAll: true })).error).toBeNull()
  expect([...t.keys.keys()].sort()).toEqual(defaultKeys)
  t.keys.get('Ctrl+Shift+Q')!(); t.keys.get('Ctrl+Shift+A')!(); t.keys.get('Ctrl+Alt+T')!(); t.keys.get('Ctrl+Shift+D')!()
  t.actions.forEach(action => expect(action).toHaveBeenCalledOnce())
})
it('restores every previous binding when a later global registration fails', async () => {
  const t = setup(); t.unavailable.add('Ctrl+Alt+T')
  expect((await t.service.update({ resetAll: true })).error).toBeTruthy()
  expect(t.attempts).toContain('Ctrl+Alt+T')
  expect([...t.keys.keys()].sort()).toEqual(originalKeys)
  expect(t.service.get().bindings).toEqual(swapped)
  expect(t.persist).not.toHaveBeenCalled()
  t.keys.get('Ctrl+Shift+A')!(); expect(t.actions[0]).toHaveBeenCalledOnce()
})
it('restores all registrations when saving the new bindings fails', async () => {
  const t = setup(); t.persist.mockRejectedValueOnce(new Error('disk full'))
  expect((await t.service.update({ resetAll: true })).error).toBeTruthy()
  expect(t.persist).toHaveBeenCalledOnce()
  expect([...t.keys.keys()].sort()).toEqual(originalKeys)
  expect(t.service.get().bindings).toEqual(swapped)
})
it('keeps all recording owners suspended after a successful reset', async () => {
  const t = setup(); t.service.setRecording(1, true); t.service.setRecording(2, true)
  expect((await t.service.update({ resetAll: true })).error).toBeNull()
  expect(t.keys.size).toBe(0)
  t.service.releaseOwner(1); expect(t.keys.size).toBe(0)
  t.service.releaseOwner(2); expect([...t.keys.keys()].sort()).toEqual(defaultKeys)
})
it('validates conflicts during recording and retains the old suspended bindings', async () => {
  const t = setup(); t.service.setRecording(1, true); t.unavailable.add('Ctrl+Alt+T')
  expect((await t.service.update({ resetAll: true })).error).toBeTruthy()
  expect(t.keys.size).toBe(0); expect(t.persist).not.toHaveBeenCalled()
  t.service.releaseOwner(1); expect([...t.keys.keys()].sort()).toEqual(originalKeys)
})
it('ending recording during persistence does not activate reserved callbacks early', async () => {
  const t = setup(); t.service.setRecording(1, true)
  let finish!: () => void
  let entered!: () => void
  const saving = new Promise<void>(resolve => { entered = resolve })
  t.persist.mockImplementationOnce(() => { entered(); return new Promise<void>(resolve => { finish = resolve }) })
  const update = t.service.update({ resetAll: true }); await saving
  t.service.setRecording(1, false)
  for (const callback of t.keys.values()) callback()
  t.actions.forEach(action => expect(action).not.toHaveBeenCalled())
  finish(); expect((await update).error).toBeNull()
  expect([...t.keys.keys()].sort()).toEqual(defaultKeys)
})
it('keeps previous bindings suspended when persistence fails during recording', async () => {
  const t = setup(); t.service.setRecording(1, true)
  t.persist.mockRejectedValueOnce(new Error('disk full'))
  expect((await t.service.update({ resetAll: true })).error).toBeTruthy()
  expect(t.persist).toHaveBeenCalledOnce()
  expect(t.keys.size).toBe(0); expect(t.service.get().bindings).toEqual(swapped)
  t.service.releaseOwner(1); expect([...t.keys.keys()].sort()).toEqual(originalKeys)
})
