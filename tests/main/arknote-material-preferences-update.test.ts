import { describe, expect, it } from 'vitest'
import { DEFAULT_ARKNOTE_PREFERENCES, parseArknotePreferences, parseArknotePreferencesUpdate, arknotePreferencesForUpdate } from '../../src/shared/arknote-preferences'
import { DEFAULT_STICKY_NOTE_GLASS_APPEARANCES } from '../../src/shared/sticky-note-glass-appearance'
import { DEFAULT_STICKY_NOTE_MICA_APPEARANCE } from '../../src/shared/sticky-note-mica-appearance'
import { DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS } from '../../src/shared/sticky-note-material-effects'
import { ArknoteSettingsUpdateQueue, DEFAULT_ARKNOTE_SETTINGS, applyArknotePreferences, parseArknoteSettings } from '../../src/main/arknote/arknote-settings-store'

const snapshot = {
  micaAppearance: DEFAULT_STICKY_NOTE_MICA_APPEARANCE,
  glassAppearances: DEFAULT_STICKY_NOTE_GLASS_APPEARANCES,
  materialEffects: DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS,
}

describe('material preference aggregate compatibility', () => {
  it('reads missing old fields with detached defaults while keeping desktop menu opt-in', () => {
    const { micaAppearance: _mica, glassAppearances: _glass, materialEffects: _effects, ...old } = DEFAULT_ARKNOTE_PREFERENCES
    const parsed = parseArknotePreferences(old)
    expect(parsed).toMatchObject(snapshot)
    expect(parsed?.registerDesktopContextMenu).toBe(true)
    expect(parsed?.materialEffects).not.toBe(DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS)
  })

  it('preserves tuned clear-glass values on a full preference write and settings read', () => {
    const tuned = { ...snapshot, glassAppearances: {
      ...snapshot.glassAppearances,
      'clear-glass': { tintColor: '#1a2b3c', tintOpacity: 0.1357, luminosityOpacity: 0.2468, saturation: 0.9753 },
    } }
    const prefs = parseArknotePreferences({ ...DEFAULT_ARKNOTE_PREFERENCES, ...tuned })
    expect(prefs).toBeDefined()
    const saved = applyArknotePreferences(DEFAULT_ARKNOTE_SETTINGS, prefs!)
    expect(parseArknoteSettings(saved)?.glassAppearances['clear-glass']).toEqual({
      tintColor: '#1A2B3C', tintOpacity: 0.1357, luminosityOpacity: 0.2468, saturation: 0.9753,
    })
  })

  it.each(['micaAppearance', 'glassAppearances', 'materialEffects'])('rejects explicitly invalid %s instead of defaulting', key => {
    for (const bad of [undefined, null, {}, Infinity]) {
      expect(parseArknotePreferences({ ...DEFAULT_ARKNOTE_PREFERENCES, [key]: bad })).toBeUndefined()
      expect(parseArknoteSettings({ ...DEFAULT_ARKNOTE_SETTINGS, [key]: bad })).toBeUndefined()
    }
  })

  it('does not turn omitted write fields into defaults before a later queued save', async () => {
    const { micaAppearance: _mica, glassAppearances: _glass, materialEffects: _effects, ...old } = DEFAULT_ARKNOTE_PREFERENCES
    const update = parseArknotePreferencesUpdate({ ...old, launchAtLogin: true })!
    expect(update).not.toHaveProperty('micaAppearance')
    expect(update).not.toHaveProperty('glassAppearances')
    expect(update).not.toHaveProperty('materialEffects')
    const queue = new ArknoteSettingsUpdateQueue(DEFAULT_ARKNOTE_SETTINGS, async () => {})
    const first = queue.update(current => applyArknotePreferences(current, {
      ...DEFAULT_ARKNOTE_PREFERENCES,
      micaAppearance: { ...snapshot.micaAppearance, tintOpacity: 0.72 },
      materialEffects: { ...snapshot.materialEffects, 'clear-glass': { ...snapshot.materialEffects['clear-glass'], transparency: 0.1234 } },
    }))
    const second = queue.update(current => applyArknotePreferences(current, update))
    await first
    const saved = await second
    expect(saved.launchAtLogin).toBe(true)
    expect(saved.micaAppearance.tintOpacity).toBe(0.72)
    expect(saved.materialEffects['clear-glass'].transparency).toBe(0.1234)
  })

  it('sends only explicitly edited material groups when ordinary preferences rebase on a full read', () => {
    const plain = arknotePreferencesForUpdate(DEFAULT_ARKNOTE_PREFERENCES, { startupHintDismissed: true })
    expect(plain.startupHintDismissed).toBe(true)
    for (const key of ['micaAppearance', 'glassAppearances', 'materialEffects']) expect(plain).not.toHaveProperty(key)
    const material = arknotePreferencesForUpdate(DEFAULT_ARKNOTE_PREFERENCES, snapshot)
    expect(material).toMatchObject(snapshot)
    expect(material.materialEffects).not.toBe(snapshot.materialEffects)
  })

  it.each(['micaAppearance', 'glassAppearances', 'materialEffects'])('refuses an explicit invalid write for %s', key => {
    expect(parseArknotePreferencesUpdate({ ...DEFAULT_ARKNOTE_PREFERENCES, [key]: undefined })).toBeUndefined()
    expect(parseArknotePreferencesUpdate({ ...DEFAULT_ARKNOTE_PREFERENCES, [key]: null })).toBeUndefined()
  })
})
