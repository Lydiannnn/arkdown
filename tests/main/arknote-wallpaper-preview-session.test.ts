import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { copyStickyNoteMaterialEffects, DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS } from '../../src/shared/sticky-note-material-effects'
import { copyStickyNoteWallpaperAppearances, type StickyNoteWallpaperAppearances } from '../../src/shared/sticky-note-glass-appearance'
import { ArknoteWallpaperPreviewCoordinator, bindArknoteWallpaperPreviewSession } from '../../src/main/arknote/arknote-wallpaper-preview-session'

const base: StickyNoteWallpaperAppearances = {
  materialEffects: copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS),
  micaAppearance: { tintColor: '#F3F3F3', tintOpacity: 0.5, luminosityOpacity: 1, saturation: 1 },
  glassAppearances: {
    'warm-frosted-glass': { tintColor: '#E7DDD2', tintOpacity: 0.28, luminosityOpacity: 0.65, saturation: 0.8 },
    'clear-glass': { tintColor: '#4A585A', tintOpacity: 0.14, luminosityOpacity: 0.65, saturation: 0.95 },
  },
}
const draft: StickyNoteWallpaperAppearances = {
  materialEffects: {
    ...copyStickyNoteMaterialEffects(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS),
    'clear-glass': { transparency: 0.8, innerGlowIntensity: 0.3, innerGlowRangePx: 60 },
  },
  micaAppearance: { ...base.micaAppearance, saturation: 0.1 },
  glassAppearances: {
    'warm-frosted-glass': { ...base.glassAppearances['warm-frosted-glass'], luminosityOpacity: 0 },
    'clear-glass': { ...base.glassAppearances['clear-glass'], tintOpacity: 0 },
  },
}
function deferred() { let resolve!: () => void; let reject!: (reason: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture() {
  let saved = copyStickyNoteWallpaperAppearances(base)
  let visible = copyStickyNoteWallpaperAppearances(base)
  let available = true
  const coordinator = new ArknoteWallpaperPreviewCoordinator(() => saved, value => { if (!available) return false; visible = value; return true })
  const session = coordinator.createSession()
  return { coordinator, session, visible: () => visible, saved: () => saved,
    persist: () => { saved = copyStickyNoteWallpaperAppearances(draft) }, nativeAvailable: (value: boolean) => { available = value } }
}

describe('one wallpaper preview lifecycle for three independent recipes', () => {
  it('accepts repeated immediate commits and restores the latest committed snapshot on close', async () => {
    const f = fixture()
    const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() })
    const session = bindArknoteWallpaperPreviewSession(window as never, f.coordinator)
    await expect(session.saveImmediate(async () => { f.persist(); return 'first' })).resolves.toBe('first')
    await expect(session.saveImmediate(async () => 'second')).resolves.toBe('second')
    session.preview(base)
    window.emit('closed')
    expect(f.visible()).toEqual(draft)
    await expect(session.saveImmediate(async () => 'late')).rejects.toThrow()
  })
  it('previews defensively without persisting and cancels all recipes with a final barrier', () => {
    const f = fixture()
    const reply = f.session.preview(draft)
    reply.glassAppearances['clear-glass'].tintOpacity = 1
    expect(f.visible()).toEqual(draft)
    expect(f.saved()).toEqual(base)
    expect(f.session.preview(null)).toEqual(base)
    expect(f.visible()).toEqual(base)
    expect(() => f.session.preview(draft)).toThrow()
    expect(() => f.session.previewMica(draft.micaAppearance)).toThrow()
  })

  it('keeps the current glass draft during compatibility Mica previews and Mica reset', () => {
    const f = fixture()
    f.session.preview(draft)
    const mica = { ...base.micaAppearance, tintOpacity: 0 }
    expect(f.session.previewMica(mica)).toEqual(mica)
    expect(f.visible()).toEqual({ ...draft, micaAppearance: mica })
    f.session.previewMica(null)
    expect(f.visible()).toEqual({ ...draft, micaAppearance: base.micaAppearance })
  })

  it('blocks both preview endpoints during save and rejects late previews after successful save', async () => {
    const f = fixture(); const wait = deferred()
    f.session.preview(draft)
    const saving = f.session.save(async () => { await wait.promise; f.persist(); return 'saved' })
    expect(() => f.session.preview(base)).toThrow()
    expect(() => f.session.previewMica(base.micaAppearance)).toThrow()
    wait.resolve()
    await expect(saving).resolves.toBe('saved')
    expect(f.visible()).toEqual(draft)
    expect(() => f.session.preview(base)).toThrow()
  })

  it('saves the full latest request even when its preview has not run and allows retry after native failure', async () => {
    const f = fixture()
    f.nativeAvailable(false)
    await expect(f.session.save(async () => f.persist())).rejects.toMatchObject({ code: 'WALLPAPER_APPEARANCE_SAVED_NOT_APPLIED' })
    expect(f.saved()).toEqual(draft)
    f.nativeAvailable(true)
    f.session.preview(draft)
    await expect(f.session.save(async () => 'retried')).resolves.toBe('retried')
    expect(f.visible()).toEqual(draft)
  })

  it('keeps a failed persistence retryable and restores saved values on close during failure', async () => {
    const f = fixture(); const wait = deferred()
    f.session.preview(draft)
    await expect(f.session.save(async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
    expect(f.visible()).toEqual(draft)
    f.session.previewMica(base.micaAppearance)
    const saving = f.session.save(() => wait.promise)
    f.session.close(); wait.reject(new Error('disk full'))
    await expect(saving).rejects.toThrow('disk full')
    expect(f.visible()).toEqual(base)
  })

  it.each(['reload', 'reopen'] as const)('does not let an older accepted save, preview, or close overwrite the newer session after %s', async change => {
    const f = fixture(); const wait = deferred()
    const firstWindow = Object.assign(new EventEmitter(), { webContents: new EventEmitter() })
    const first = bindArknoteWallpaperPreviewSession(firstWindow as never, f.coordinator)
    first.preview(draft)
    const saving = first.save(async () => { await wait.promise; f.persist() })
    let newer = first
    if (change === 'reload') {
      firstWindow.webContents.emit('did-start-navigation', {}, 'file:///settings.html', false, true)
      firstWindow.webContents.emit('did-finish-load')
    } else {
      firstWindow.emit('closed')
      newer = bindArknoteWallpaperPreviewSession(Object.assign(new EventEmitter(), { webContents: new EventEmitter() }) as never, f.coordinator)
    }
    const newerDraft = copyStickyNoteWallpaperAppearances(base)
    newerDraft.glassAppearances['clear-glass'].luminosityOpacity = 0.2
    newer.preview(newerDraft)
    wait.resolve(); await saving
    expect(f.visible()).toEqual(newerDraft)
    expect(f.saved()).toEqual(draft)
    expect(newer.preview(null)).toEqual(draft)
  })

  it('invalidates an older live owner before it can preview, save, or restore over a newer session', async () => {
    const f = fixture()
    f.session.preview(draft)
    const newer = f.coordinator.createSession()
    newer.preview(base)
    expect(() => f.session.preview(draft)).toThrow()
    await expect(f.session.save(async () => { f.persist() })).rejects.toThrow()
    f.session.close()
    expect(f.visible()).toEqual(base)
    expect(f.saved()).toEqual(base)
  })

  it('restores all saved recipes on reload/crash/close and rejects previews until navigation finishes', () => {
    const f = fixture()
    const window = Object.assign(new EventEmitter(), { webContents: new EventEmitter() })
    const session = bindArknoteWallpaperPreviewSession(window as never, f.coordinator)
    session.preview(draft)
    window.webContents.emit('did-start-navigation', {}, 'file:///settings.html', false, true)
    expect(f.visible()).toEqual(base)
    expect(() => session.preview(draft)).toThrow()
    window.webContents.emit('did-finish-load')
    session.preview(draft)
    window.webContents.emit('render-process-gone')
    expect(f.visible()).toEqual(base)
    window.webContents.emit('did-finish-load')
    session.preview(draft)
    window.emit('closed')
    expect(f.visible()).toEqual(base)
    expect(() => session.preview(draft)).toThrow()
  })

  it('rejects invalid full maps without touching the native snapshot', () => {
    const f = fixture()
    expect(() => f.session.preview({ ...draft, glassAppearances: {} } as never)).toThrow()
    expect(f.visible()).toEqual(base)
    f.nativeAvailable(false)
    expect(() => f.session.preview(draft)).toThrow()
  })

  it('allows the current owner to retry cancellation while abandoned edits and saves stay blocked', async () => {
    const f = fixture()
    f.session.preview(draft)
    f.nativeAvailable(false)
    expect(() => f.session.preview(null)).toThrow()
    expect(() => f.session.preview(draft)).toThrow()
    await expect(f.session.save(async () => f.persist())).rejects.toThrow()
    f.nativeAvailable(true)
    expect(f.session.preview(null)).toEqual(base)
    expect(f.visible()).toEqual(base)
    const newer = f.coordinator.createSession()
    newer.preview(draft)
    expect(() => f.session.preview(null)).toThrow()
    expect(f.visible()).toEqual(draft)
    newer.close()
    expect(() => newer.preview(null)).toThrow()
  })

  it('retries saved restoration on close when cancel could not apply to the native surface', () => {
    const f = fixture()
    f.session.preview(draft)
    f.nativeAvailable(false)
    expect(() => f.session.preview(null)).toThrow()
    expect(() => f.session.preview(draft)).toThrow()
    f.nativeAvailable(true)
    f.session.close()
    expect(f.visible()).toEqual(base)
  })
})
