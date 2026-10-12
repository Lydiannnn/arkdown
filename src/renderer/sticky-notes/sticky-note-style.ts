import type { CSSProperties } from 'react'
import { stickyNoteMaterialDescriptor } from '../../shared/sticky-note-materials'
import {
  type StickyNotePreferences,
  type StickyNoteStyleReference,
  type StickyNoteTexturePattern,
  type StickyNoteTextureSnapshot,
} from '../../shared/sticky-note-preferences'

export interface ResolvedStickyNoteStyle {
  backgroundColor: string
  backgroundImage: string
  backgroundSize: string
  textColor: string
  opacity: 1
}
type ClassicStickyNoteStyleReference = Exclude<StickyNoteStyleReference, { mode: 'material' }>
function rgb(hex: string): [number, number, number] { return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)] }
function rgba(hex: string, opacityPercent: number): string { const [r, g, b] = rgb(hex); return `rgb(${r} ${g} ${b} / ${opacityPercent}%)` }
function mixWithWhite(hex: string, colorPercent = 20): string {
  const [red, green, blue] = rgb(hex)
  const whitePercent = 100 - colorPercent
  const mix = (channel: number) => Math.round((channel * colorPercent + 255 * whitePercent) / 100)
  return '#' + [mix(red), mix(green), mix(blue)].map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()
}
function luminance(hex: string): number {
  const channels = rgb(hex).map((value) => { const normalized = value / 255; return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4 })
  return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!
}
function textureImage(texture: StickyNoteTextureSnapshot): string {
  const color = rgba(texture.foregroundColor, texture.opacityPercent)
  const half = Math.max(1, Math.round(texture.scalePx / 2))
  const pattern: Record<StickyNoteTexturePattern, string> = {
    none: 'none',
    'horizontal-lines': `linear-gradient(to bottom, transparent calc(100% - 1px), ${color} calc(100% - 1px))`,
    grid: `linear-gradient(to right, ${color} 1px, transparent 1px), linear-gradient(to bottom, ${color} 1px, transparent 1px)`,
    dots: `radial-gradient(circle at 1px 1px, ${color} 1px, transparent 1.5px)`,
    diagonal: `repeating-linear-gradient(135deg, transparent 0 ${half}px, ${color} ${half}px ${half + 1}px)`,
    paper: `radial-gradient(ellipse at 20% 30%, ${color} 0 1px, transparent 1.5px), radial-gradient(ellipse at 75% 65%, ${color} 0 1px, transparent 1.5px)`,
    fabric: `repeating-linear-gradient(0deg, transparent 0 ${half}px, ${color} ${half}px ${half + 1}px), repeating-linear-gradient(90deg, transparent 0 ${half}px, ${color} ${half}px ${half + 1}px)`,
  }
  return pattern[texture.pattern]
}
function resolveParts(style: ClassicStickyNoteStyleReference, preferences: StickyNotePreferences): { color: string; texture: StickyNoteTextureSnapshot } {
  if (style.mode === 'independent') return { color: style.color, texture: { ...style.texture } }
  const color = preferences.colorPresets.find(({ id }) => id === style.colorPresetId)?.value ?? '#FFF3B3'
  const texture = preferences.texturePresets.find(({ id }) => id === style.texturePresetId) ?? preferences.texturePresets[0]!
  return { color, texture: { pattern: texture.pattern, foregroundColor: texture.foregroundColor, opacityPercent: texture.opacityPercent, scalePx: texture.scalePx } }
}
export function resolveStickyNoteStyle(style: StickyNoteStyleReference, preferences: StickyNotePreferences): ResolvedStickyNoteStyle {
  if (style.mode === 'material') {
    const descriptor = stickyNoteMaterialDescriptor(style.materialPresetId)!
    return {
      backgroundColor: descriptor.fallbackColor,
      backgroundImage: 'none',
      backgroundSize: 'auto',
      textColor: descriptor.renderer.textColor,
      opacity: 1,
    }
  }
  const { color, texture } = resolveParts(style, preferences)
  const backgroundColor = mixWithWhite(color)
  return { backgroundColor, backgroundImage: textureImage(texture), backgroundSize: `${texture.scalePx}px ${texture.scalePx}px`, textColor: luminance(backgroundColor) < .32 ? '#FFFFFF' : '#252525', opacity: 1 }
}
export function independentStickyNoteStyle(style: StickyNoteStyleReference, preferences: StickyNotePreferences): StickyNoteStyleReference {
  if (style.mode === 'material') return { ...style }
  const { color, texture } = resolveParts(style, preferences)
  return { mode: 'independent', color, texture }
}
export function stickyNoteStyleCssVariables(style: StickyNoteStyleReference, preferences: StickyNotePreferences): CSSProperties {
  if (style.mode === 'material') {
    const descriptor = stickyNoteMaterialDescriptor(style.materialPresetId)!
    const { renderer } = descriptor
    return {
      '--sticky-note-background-color': descriptor.fallbackColor,
      '--sticky-note-preview-background-color': style.materialPresetId === 'mica-light' ? '#FFFFFF' : descriptor.fallbackColor,
      '--sticky-note-surface-layer': renderer.surfaceLayer,
      '--sticky-note-toolbar-layer': renderer.toolbarLayer,
      '--sticky-note-text-color': renderer.textColor,
      '--sticky-note-muted-text-color': renderer.mutedTextColor,
      '--sticky-note-border-color': renderer.borderColor,
      '--sticky-note-hover-layer': renderer.hoverLayer,
      '--sticky-note-pressed-layer': renderer.pressedLayer,
      '--sticky-note-selection-layer': renderer.selectionLayer,
      '--control-hover-layer': renderer.hoverLayer,
      '--control-pressed-layer': renderer.pressedLayer,
      '--sticky-note-background-image': 'none',
      '--sticky-note-background-size': 'auto',
      '--sticky-note-opacity': '1',
    } as CSSProperties
  }
  const resolved = resolveStickyNoteStyle(style, preferences)
  return {
    '--sticky-note-background-color': resolved.backgroundColor,
    '--sticky-note-background-image': resolved.backgroundImage,
    '--sticky-note-background-size': resolved.backgroundSize,
    '--sticky-note-text-color': resolved.textColor,
    '--sticky-note-opacity': String(resolved.opacity),
  } as CSSProperties
}
