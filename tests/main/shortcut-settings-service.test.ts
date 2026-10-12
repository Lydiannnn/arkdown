import { describe, expect, it, vi } from 'vitest'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { ShortcutSettingsService } from '../../src/main/settings/shortcut-settings-service'
import { registerScreenshotTranslationShortcut } from '../../src/main/screenshot-translation/screenshot-shortcut'
import { SCREENSHOT_TRANSLATION_ACCELERATOR } from '../../src/shared/screenshot-translation'

function setup(initiallyUnavailable = false) {
  const keys = new Map<string, () => void>()
  const unavailable = new Set<string>()
  if (initiallyUnavailable) unavailable.add(SCREENSHOT_TRANSLATION_ACCELERATOR)
  const capture = vi.fn()
  const adapter = {
    register: vi.fn((key: string, action: () => void) => {
      if (keys.has(key) || unavailable.has(key)) return false
      keys.set(key, action); return true
    }),
    isRegistered: (key: string) => keys.has(key),
    unregister: (key: string) => { keys.delete(key) },
  }
  const screenshot = registerScreenshotTranslationShortcut({ globalShortcut: adapter, getOwner: () => ({}) as never, beginCapture: capture })
  const save = vi.fn(async () => {})
  const settings = new SettingsCoordinator({ save }, { lastWorkspace: 'keep', search: { provider: 'bing', customTemplate: '' } })
  const broadcast = vi.fn()
  const refreshMenus = vi.fn()
  const service = new ShortcutSettingsService({ settings, screenshot, broadcast, refreshMenus })
  return { keys, unavailable, capture, screenshot, save, settings, broadcast, refreshMenus, service }
}

describe('shortcut settings runtime', () => {
  it('persists builtin remapping, rejects clearing, and exposes recording per window', async () => {
    const t = setup()
    expect((await t.service.update({ id: 'edit.undo', accelerator: 'Ctrl+Alt+R' })).error).toBeNull()
    expect(t.settings.get().shortcuts).toEqual({ 'edit.undo': 'Ctrl+Alt+R' })
    expect((await t.service.update({ id: 'edit.undo', accelerator: null })).error).toContain('不能清除')
    expect(t.service.isRecording(1)).toBe(false)
    t.service.setRecording(1, true)
    expect(t.service.isRecording(1)).toBe(true)
    expect(t.service.isRecording(2)).toBe(false)
    t.service.releaseOwner(1)
    expect(t.service.isRecording(1)).toBe(false)
    expect((await t.service.update({ id: 'edit.undo', reset: true })).error).toBeNull()
    expect(t.settings.get().shortcuts).toEqual({})
  })
  it('allows local editing and recording exit when the initial global shortcut is occupied', async () => {
    const t = setup(true)
    expect(t.screenshot.registered).toBe(false)
    t.service.setRecording(1, true)
    expect(() => t.service.setRecording(1, false)).not.toThrow()
    expect((await t.service.update({ id: 'file.save', accelerator: 'Ctrl+Alt+S' })).error).toBeNull()
    expect(t.service.get().bindings['file.save']).toBe('Ctrl+Alt+S')
    expect(t.keys.size).toBe(0)
  })
  it('serializes independent patches and preserves other preferences', async () => {
    const t = setup()
    await Promise.all([
      t.service.update({ id: 'file.save', accelerator: 'Ctrl+Alt+S' }),
      t.service.update({ id: 'edit.find', accelerator: 'Ctrl+Alt+F' }),
    ])
    expect(t.service.get().bindings).toEqual({ 'file.save': 'Ctrl+Alt+S', 'edit.find': 'Ctrl+Alt+F' })
    expect(t.settings.get()).toMatchObject({ lastWorkspace: 'keep', search: { provider: 'bing' } })
    expect(t.broadcast).toHaveBeenCalledTimes(2)
    expect(t.refreshMenus).toHaveBeenCalledTimes(2)
  })
  it('rejects conflicts without persistence or broadcast', async () => {
    const t = setup()
    expect((await t.service.update({ id: 'file.save', accelerator: 'Ctrl+B' })).error).toContain('加粗')
    expect(t.save).not.toHaveBeenCalled()
    expect(t.broadcast).not.toHaveBeenCalled()
  })
  it('retains the previous global registration when OS registration or persistence fails', async () => {
    const t = setup()
    t.unavailable.add('Ctrl+Alt+Q')
    expect((await t.service.update({ id: 'tools.screenshot-translation', accelerator: 'Ctrl+Alt+Q' })).error).toBeTruthy()
    expect([...t.keys.keys()]).toEqual([SCREENSHOT_TRANSLATION_ACCELERATOR])
    expect(t.save).not.toHaveBeenCalled()
    t.unavailable.clear()
    t.save.mockRejectedValueOnce(new Error('disk full'))
    expect((await t.service.update({ id: 'tools.screenshot-translation', accelerator: 'Ctrl+Alt+Q' })).error).toBeTruthy()
    expect([...t.keys.keys()]).toEqual([SCREENSHOT_TRANSLATION_ACCELERATOR])
    expect(t.service.get().bindings).toEqual({})
    expect(t.broadcast).not.toHaveBeenCalled()
  })
  it('changes, clears and restores a global shortcut without leaving an old key active', async () => {
    const t = setup()
    const oldCallback = t.keys.get(SCREENSHOT_TRANSLATION_ACCELERATOR)!
    expect((await t.service.update({ id: 'tools.screenshot-translation', accelerator: 'Ctrl+Alt+Q' })).error).toBeNull()
    oldCallback()
    expect(t.capture).not.toHaveBeenCalled()
    t.keys.get('Ctrl+Alt+Q')!()
    expect(t.capture).toHaveBeenCalledOnce()
    await t.service.update({ id: 'tools.screenshot-translation', accelerator: null })
    expect(t.keys.size).toBe(0)
    await t.service.update({ resetAll: true })
    expect([...t.keys.keys()]).toEqual([SCREENSHOT_TRANSLATION_ACCELERATOR])
  })
  it('can replace a screenshot binding while recording even if another process takes the previous key', async () => {
    const t = setup()
    t.service.setRecording(1, true)
    t.unavailable.add(SCREENSHOT_TRANSLATION_ACCELERATOR)
    expect((await t.service.update({ id: 'tools.screenshot-translation', accelerator: 'Ctrl+Alt+Q' })).error).toBeNull()
    expect(t.keys.size).toBe(0)
    t.service.setRecording(1, false)
    expect([...t.keys.keys()]).toEqual(['Ctrl+Alt+Q'])
  })
  it('pauses global capture for all recording windows and resumes after the last owner releases', () => {
    const t = setup()
    const stale = t.keys.get(SCREENSHOT_TRANSLATION_ACCELERATOR)!
    t.service.setRecording(1, true)
    t.service.setRecording(2, true)
    stale()
    expect(t.capture).not.toHaveBeenCalled()
    expect(t.keys.size).toBe(0)
    t.service.releaseOwner(1)
    expect(t.keys.size).toBe(0)
    t.service.releaseOwner(2)
    expect([...t.keys.keys()]).toEqual([SCREENSHOT_TRANSLATION_ACCELERATOR])
  })
})
