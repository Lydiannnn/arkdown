export interface StickyNoteMicaAppearance {
  tintColor: string
  tintOpacity: number
  luminosityOpacity: number
  saturation: number
}

// A light starting recipe for the custom Windows wallpaper material.
// This does not instantiate or claim parity with WinAppSDK MicaController.
export const DEFAULT_STICKY_NOTE_MICA_APPEARANCE: Readonly<StickyNoteMicaAppearance> = Object.freeze({
  tintColor: '#F3F3F3', tintOpacity: 0, luminosityOpacity: 1, saturation: 1,
})

export const RAW_STICKY_NOTE_MICA_APPEARANCE: Readonly<StickyNoteMicaAppearance> = Object.freeze({
  tintColor: '#F3F3F3', tintOpacity: 0, luminosityOpacity: 0, saturation: 1,
})

export function parseStickyNoteMicaAppearance(value: unknown): StickyNoteMicaAppearance | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 4 || !keys.every(key => typeof key === 'string'
    && ['tintColor', 'tintOpacity', 'luminosityOpacity', 'saturation'].includes(key))) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.tintColor !== 'string' || !/^#[0-9a-f]{6}$/iu.test(input.tintColor)) return undefined
  for (const key of ['tintOpacity', 'luminosityOpacity', 'saturation'] as const) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1) return undefined
  }
  return {
    tintColor: input.tintColor.toUpperCase(),
    tintOpacity: input.tintOpacity as number,
    luminosityOpacity: input.luminosityOpacity as number,
    saturation: input.saturation as number,
  }
}

export function copyStickyNoteMicaAppearance(value: StickyNoteMicaAppearance): StickyNoteMicaAppearance {
  return { tintColor: value.tintColor, tintOpacity: value.tintOpacity,
    luminosityOpacity: value.luminosityOpacity, saturation: value.saturation }
}
