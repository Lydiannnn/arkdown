import { createRequire } from 'node:module'
import path from 'node:path'
import { stickyNoteMaterialDescriptor } from '../../shared/sticky-note-materials'
import type { StickyNoteStyleReference } from '../../shared/sticky-note-preferences'
import { DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS, effectiveStickyNoteMaterialAppearance, type StickyNoteMaterialEffects } from '../../shared/sticky-note-material-effects'
import {
  copyStickyNoteWallpaperAppearances,
  DEFAULT_STICKY_NOTE_GLASS_APPEARANCES,
  isStickyNoteWallpaperPresetId,
  parseStickyNoteWallpaperAppearances,
  stickyNoteWallpaperAppearanceForPreset,
  type StickyNoteWallpaperAppearances,
} from '../../shared/sticky-note-glass-appearance'
import {
  DEFAULT_STICKY_NOTE_MICA_APPEARANCE,
  parseStickyNoteMicaAppearance,
  type StickyNoteMicaAppearance,
} from '../../shared/sticky-note-mica-appearance'

import type { StickyNotePhysicalRect } from './sticky-note-window-bounds'

export interface StickyNoteSurfaceAddon {
  getPhysicalRect?(hwnd: bigint): StickyNotePhysicalRect
  setPhysicalSize?(hwnd: bigint, expected: StickyNotePhysicalRect, size: { width: number; height: number }): boolean
  attach(hwnd: bigint, source?: 'wallpaper' | 'host'): boolean
  resize(hwnd: bigint): boolean | void
  detach(hwnd: bigint): void
  clear(): void
  configure(hwnd: bigint, appearance: StickyNoteMicaAppearance): boolean
  // Historical ABI names; these independent policies cover all custom materials.
  setGlassDecoration(hwnd: bigint, enabled: boolean, shadowEnabled?: boolean, resizable?: boolean): boolean
  setAcrylicBorderHidden(hwnd: bigint, hidden: boolean): boolean
}

interface AddonLocation {
  isPackaged: boolean
  resourcesPath: string
  buildDirectory: string
  arch: string
}

export function stickyNoteNativeSurfaceAddonPath(options: AddonLocation): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, 'sticky-note-native-surface', options.arch, 'surface.node')
    : path.resolve(options.buildDirectory, '../..', 'native/sticky-note-surface/dist', options.arch, 'surface.node')
}

export function loadStickyNoteNativeSurface(
  options: AddonLocation,
  requireAddon: (filename: string) => unknown = (filename) => createRequire(filename)(filename),
): StickyNoteSurfaceAddon {
  const loaded = requireAddon(stickyNoteNativeSurfaceAddonPath(options))
  if (typeof loaded !== 'object' || loaded === null
    || !(['attach', 'resize', 'detach', 'clear', 'configure', 'setGlassDecoration', 'setAcrylicBorderHidden'] as const)
      .every((key) => typeof (loaded as Record<string, unknown>)[key] === 'function')) {
    throw new Error('Invalid sticky-note native surface addon')
  }
  return loaded as StickyNoteSurfaceAddon
}

interface SurfaceWindow {
  isDestroyed(): boolean
  isResizable?(): boolean
  getNativeWindowHandle(): Buffer
  setBackgroundMaterial(material: 'none' | 'mica' | 'acrylic'): void
  setHasShadow(hasShadow: boolean): void
  on(event: 'resize' | 'closed', listener: () => void): unknown
  removeListener(event: 'resize' | 'closed', listener: () => void): unknown
}

interface SurfaceControllerOptions {
  platform: NodeJS.Platform
  load(): StickyNoteSurfaceAddon | null
  onError?(error: unknown): void
}

export function stickyNoteStyleHasShadow(
  style: StickyNoteStyleReference,
  effects: StickyNoteMaterialEffects = DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS,
): boolean {
  if (style.mode !== 'material'
    || (style.materialPresetId !== 'warm-frosted-glass' && style.materialPresetId !== 'clear-glass')) return true
  return effects[style.materialPresetId].shadowEnabled
    ?? DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS[style.materialPresetId].shadowEnabled ?? false
}

function sameAppearance(a: StickyNoteMicaAppearance | null, b: StickyNoteMicaAppearance | null): boolean {
  return a?.tintColor === b?.tintColor && a?.tintOpacity === b?.tintOpacity
    && a?.luminosityOpacity === b?.luminosityOpacity && a?.saturation === b?.saturation
}

const ACRYLIC_BASE_APPEARANCE: Readonly<StickyNoteMicaAppearance> = Object.freeze({
  tintColor: '#E9EEF2', tintOpacity: .30, luminosityOpacity: .65, saturation: .90,
})

function appearanceFor(preset: string | null, map: StickyNoteWallpaperAppearances): StickyNoteMicaAppearance | null {
  const base = preset === 'flowing-glass' ? ACRYLIC_BASE_APPEARANCE
    : stickyNoteWallpaperAppearanceForPreset(preset, map.micaAppearance, map.glassAppearances)
  if (!base) return null
  return preset === 'flowing-glass' || preset === 'warm-frosted-glass' || preset === 'clear-glass'
    ? effectiveStickyNoteMaterialAppearance(base, map.materialEffects[preset]) : base
}

// Each binding owns one HWND. Wallpaper and host sources share the effect
// graph and full-client layout; border color and shadow remain independent.
export function createStickyNoteNativeSurfaceController(options: SurfaceControllerOptions) {
  let attemptedLoad = false
  let addon: StickyNoteSurfaceAddon | null = null
  const report = options.onError ?? (() => undefined)
  let appearances = copyStickyNoteWallpaperAppearances({
    materialEffects: DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS,
    micaAppearance: DEFAULT_STICKY_NOTE_MICA_APPEARANCE,
    glassAppearances: DEFAULT_STICKY_NOTE_GLASS_APPEARANCES,
  })
  const updateBindings = new Set<(previous: StickyNoteWallpaperAppearances | 'mica') => boolean>()

  function setAppearance(value: StickyNoteMicaAppearance): boolean {
    const parsed = parseStickyNoteMicaAppearance(value)
    if (!parsed) throw new Error('Invalid sticky-note Mica appearance')
    appearances = { ...appearances, micaAppearance: parsed }
    let complete = true
    for (const update of updateBindings) {
      if (!update('mica')) complete = false
    }
    return complete
  }

  function setWallpaperAppearances(value: StickyNoteWallpaperAppearances): boolean {
    const parsed = parseStickyNoteWallpaperAppearances(value)
    if (!parsed) throw new Error('Invalid sticky-note wallpaper appearances')
    const previous = appearances
    appearances = parsed
    let complete = true
    for (const update of updateBindings) {
      if (!update(previous)) complete = false
    }
    return complete
  }

  function load(): StickyNoteSurfaceAddon | null {
    if (!attemptedLoad) {
      attemptedLoad = true
      try {
        addon = options.load()
      } catch (error) {
        report(error)
      }
    }
    return addon
  }

  function bind(window: SurfaceWindow, initialStyle: StickyNoteStyleReference) {
    let closed = false
    let currentStyle = initialStyle
    let currentMaterial: 'none' | 'mica' | 'acrylic' | undefined
    let currentWallpaperPreset: string | null = null
    let currentSource: 'wallpaper' | 'host' | null = null
    let currentHasShadow: boolean | undefined
    let applyingShadow = false
    let configurationPending = false
    type Target = { addon: StickyNoteSurfaceAddon; hwnd: bigint }
    let attached: (Target & { source: 'wallpaper' | 'host' }) | null = null
    let cleanupTarget: Target | null = null
    let surfacePending = false
    let establishingSurface = false
    // HWND decoration remains owned when the composition graph falls back.
    let nativeTarget: { addon: StickyNoteSurfaceAddon; hwnd: bigint } | null = null
    let wantsMaterialClientArea = false
    let wantsMaterialShadow = false
    let decorationApplied = false
    let decorationShadowApplied = false
    let decorationPending = false
    let applyingDecoration = false
    let wantsBorderHidden = false
    let borderApplied = false
    let borderPending = false
    let applyingBorder = false

    function updateDecorationPreferences(): void {
      wantsMaterialClientArea = currentStyle.mode === 'material'
        && (currentStyle.materialPresetId === 'warm-frosted-glass' || currentStyle.materialPresetId === 'clear-glass'
          || currentStyle.materialPresetId === 'flowing-glass')
      wantsMaterialShadow = wantsMaterialClientArea && stickyNoteStyleHasShadow(currentStyle, appearances.materialEffects)
      wantsBorderHidden = wantsMaterialShadow && (currentStyle.mode === 'material'
        && (currentStyle.materialPresetId !== 'flowing-glass'
          || (appearances.materialEffects['flowing-glass'].borderHidden
            ?? DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS['flowing-glass'].borderHidden ?? true)))
    }

    function syncMaterialPolicy(refresh = false, applyClientArea = true): boolean {
      if (closed || window.isDestroyed()) return true
      // Either setter may emit a synchronous resize. Let that callback resize
      // the graph, but complete this ordered policy transition only once.
      if (applyingShadow || applyingDecoration) return false
      // Material attachment must precede the initial full-client policy.
      // Acrylic keeps this scope regardless of its independent border toggle.
      if (wantsMaterialClientArea && wantsMaterialShadow && !applyClientArea) return true
      if (!wantsMaterialClientArea && !syncDecoration(refresh)) return false
      if (wantsMaterialClientArea && wantsMaterialShadow && !syncDecoration(refresh)) return false
      const hasShadow = !wantsMaterialClientArea || wantsMaterialShadow
      if (hasShadow !== currentHasShadow) {
        applyingShadow = true
        try {
          window.setHasShadow(hasShadow)
          currentHasShadow = hasShadow
        } catch (error) {
          report(error)
          return false
        } finally { applyingShadow = false }
      }
      // When disabling the shadow, first let Electron apply its policy, then
      // remove the native frame bits that would otherwise keep it visible.
      return wantsMaterialClientArea && !wantsMaterialShadow && applyClientArea ? syncDecoration(refresh) : true
    }

    function getNativeTarget() {
      if (nativeTarget) return nativeTarget
      const nativeAddon = load()
      if (!nativeAddon) return null
      const handle = window.getNativeWindowHandle()
      const hwnd = handle.length === 8
        ? handle.readBigUInt64LE()
        : handle.length === 4 ? BigInt(handle.readUInt32LE()) : 0n
      if (hwnd === 0n) throw new Error('Invalid sticky-note native window handle')
      nativeTarget = { addon: nativeAddon, hwnd }
      return nativeTarget
    }

    function syncDecoration(refresh = false): boolean {
      if (closed || window.isDestroyed() || options.platform !== 'win32') return true
      // Ordinary old styles must not load the addon just to perform a no-op.
      if (!wantsMaterialClientArea && !decorationApplied && !decorationPending) return true
      if (!refresh && !decorationPending && decorationApplied === wantsMaterialClientArea
        && (!wantsMaterialClientArea || decorationShadowApplied === wantsMaterialShadow)) return true
      // Native frame changes may synchronously emit a resize callback.
      if (applyingDecoration) return false
      applyingDecoration = true
      decorationPending = true
      try {
        const target = getNativeTarget()
        if (!target) return false
        const applied = window.isResizable
          ? target.addon.setGlassDecoration(target.hwnd, wantsMaterialClientArea, wantsMaterialShadow, window.isResizable())
          : wantsMaterialClientArea && wantsMaterialShadow
          ? target.addon.setGlassDecoration(target.hwnd, true, true)
          : target.addon.setGlassDecoration(target.hwnd, wantsMaterialClientArea)
        if (applied) {
          decorationApplied = wantsMaterialClientArea
          decorationShadowApplied = wantsMaterialShadow
          decorationPending = false
        } else report(new Error('Sticky-note native material client area could not be applied'))
        return applied
      } catch (error) {
        report(error)
        return false
      } finally {
        applyingDecoration = false
      }
    }

    function syncBorder(refresh = false): boolean {
      if (closed || window.isDestroyed() || options.platform !== 'win32') return true
      if (!wantsBorderHidden && !borderApplied && !borderPending) return true
      if (!refresh && !borderPending && borderApplied === wantsBorderHidden) return true
      if (applyingBorder) return false
      applyingBorder = true
      borderPending = true
      try {
        const target = getNativeTarget()
        if (!target) return false
        const complete = target.addon.setAcrylicBorderHidden(target.hwnd, wantsBorderHidden)
        if (complete) { borderApplied = wantsBorderHidden; borderPending = false }
        else report(new Error('Sticky-note material border policy could not be applied'))
        return complete
      } catch (error) { report(error); return false }
      finally { applyingBorder = false }
    }

    function configure(): boolean {
      if (closed || window.isDestroyed()) return true
      const selectedAppearance = appearanceFor(currentWallpaperPreset, appearances)
      if (!selectedAppearance) return true
      if (!attached) {
        configurationPending = options.platform === 'win32'
        return !configurationPending
      }
      try {
        const configured = attached.addon.configure(attached.hwnd, selectedAppearance)
        configurationPending = !configured
        if (!configured) report(new Error('Sticky-note native wallpaper appearance could not be applied'))
        return configured
      } catch (error) {
        // Preserve the previous native brush on effect-update failure.
        configurationPending = true
        report(error)
        return false
      }
    }

    function updateAppearance(previous: StickyNoteWallpaperAppearances | 'mica'): boolean {
      updateDecorationPreferences()
      // Retry failed restore even after the selected style became classic.
      const decorationComplete = syncMaterialPolicy()
      const borderComplete = syncBorder()
      if (previous === 'mica') {
        const appearanceComplete = currentWallpaperPreset === 'mica-light'
          ? (surfacePending ? establishSurface() : configure()) : true
        return decorationComplete && borderComplete && appearanceComplete
      }
      if (surfacePending || cleanupTarget) {
        const surfaceComplete = establishSurface()
        return decorationComplete && borderComplete && surfaceComplete
      }
      if (!currentWallpaperPreset) return decorationComplete && borderComplete
      const before = appearanceFor(currentWallpaperPreset, previous)
      const after = appearanceFor(currentWallpaperPreset, appearances)
      // A repeated full draft must retry failed configuration even when its
      // values match the current snapshot. Unchanged peers need no native call.
      const appearanceComplete = !configurationPending && sameAppearance(before, after) ? true : configure()
      return decorationComplete && borderComplete && appearanceComplete
    }

    function release(): boolean {
      cleanupTarget ??= attached
      attached = null
      if (!cleanupTarget) return true
      try {
        cleanupTarget.addon.detach(cleanupTarget.hwnd)
        cleanupTarget = null
        return true
      } catch (error) {
        report(error)
        return false
      }
    }

    function restoreFallback(): void {
      surfacePending = true
      const released = release()
      if (released && !closed && !window.isDestroyed()) {
        window.setBackgroundMaterial(currentMaterial ?? 'none')
        // Electron may restore its frame policy while changing the material.
        syncMaterialPolicy(true)
        syncBorder(true)
      }
    }

    function establishSurface(): boolean {
      if (closed || window.isDestroyed()) return true
      if (establishingSurface) return false
      establishingSurface = true
      try {
        surfacePending = true
        if (!release()) return false
        window.setBackgroundMaterial(currentMaterial ?? 'none')
        if (options.platform !== 'win32' || !currentSource) {
          surfacePending = false
          return true
        }
        try {
          const target = getNativeTarget()
          if (!target) return false
          // Store the cleanup handle before attach: a failed native rollback can
          // retain owned Host state even though no composition graph survives.
          attached = { ...target, source: currentSource }
          const complete = currentSource === 'host'
            ? target.addon.attach(target.hwnd, 'host') : target.addon.attach(target.hwnd)
          if (!complete) {
            if (currentSource === 'host') report(new Error('Persistent Acrylic host backdrop unavailable; using system Acrylic fallback'))
            restoreFallback()
            return false
          }
          surfacePending = false
          return configure()
        } catch (error) {
          report(error)
          restoreFallback()
          return false
        }
      } catch (error) {
        // A window material setter can fail before attach. Keep the pending
        // transition and let the full-map coordinator continue other windows.
        report(error)
        return false
      } finally {
        // Attachment is now complete. Native client-area policy measures the
        // final client rectangle even if Electron emits no resize event.
        establishingSurface = false
        syncMaterialPolicy()
        syncBorder()
      }
    }

    function apply(style: StickyNoteStyleReference): void {
      if (closed || window.isDestroyed()) return
      currentStyle = style
      updateDecorationPreferences()
      // Restore our owned bits before returning to an older material/style.
      syncMaterialPolicy(false, false)
      if (!wantsBorderHidden) syncBorder()
      const descriptor = style.mode === 'material'
        ? stickyNoteMaterialDescriptor(style.materialPresetId)
        : null
      const material = descriptor?.nativeMaterial ?? 'none'
      const wallpaperPreset = style.mode === 'material'
        && (isStickyNoteWallpaperPresetId(style.materialPresetId) || style.materialPresetId === 'flowing-glass')
        ? style.materialPresetId : null
      const source = wallpaperPreset === 'flowing-glass' ? 'host' : wallpaperPreset ? 'wallpaper' : null
      if (material === currentMaterial && wallpaperPreset === currentWallpaperPreset) {
        syncMaterialPolicy()
        syncBorder()
        if (surfacePending || cleanupTarget) establishSurface()
        else if (attached && configurationPending) configure()
        return
      }
      currentMaterial = material
      currentWallpaperPreset = wallpaperPreset
      currentSource = source
      configurationPending = false
      // Wallpaper presets share the existing source, HWND and composition
      // target. Only replace the recipe; Electron's DWM state stays untouched.
      if (attached && attached.source === source && !cleanupTarget) {
        syncMaterialPolicy()
        syncBorder()
        configure()
        return
      }
      // Electron's mica path repairs WebContents translucency after classic.
      // The addon disables DWM only after its own composition target is ready.
      establishSurface()
    }

    function resize(): void {
      if (closed || window.isDestroyed()) return
      // DWM/material setters can synchronously emit resize while a target is
      // being staged. Native attach measures the final client size itself.
      if (establishingSurface) return
      // A custom-material fallback retains HWND policy without a composition target.
      syncMaterialPolicy(true)
      syncBorder(true)
      if (!attached) return
      try {
        if (attached.addon.resize(attached.hwnd) === false) restoreFallback()
      } catch (error) {
        report(error)
        restoreFallback()
      }
    }

    function dispose(): void {
      if (closed) return
      closed = true
      updateBindings.delete(updateAppearance)
      window.removeListener('resize', resize)
      window.removeListener('closed', dispose)
      // WM_NCDESTROY owns native decoration cleanup; never write a dead HWND.
      nativeTarget = null
      decorationPending = false
      borderPending = false
      release()
    }

    // A close event can be prevented while saving. Keep the surface until closed.
    window.on('resize', resize)
    window.on('closed', dispose)
    updateBindings.add(updateAppearance)
    apply(initialStyle)
    return apply
  }

  return {
    bind, setAppearance, setWallpaperAppearances,
    hasShadow: (style: StickyNoteStyleReference) => stickyNoteStyleHasShadow(style, appearances.materialEffects),
  }
}
