import { useEffect, useState } from 'react'
import {
  copyStickyNoteWallpaperAppearances,
  DEFAULT_STICKY_NOTE_GLASS_APPEARANCES,
  type StickyNoteWallpaperAppearances,
} from '../../shared/sticky-note-glass-appearance'
import { DEFAULT_STICKY_NOTE_MICA_APPEARANCE, type StickyNoteMicaAppearance } from '../../shared/sticky-note-mica-appearance'
import { DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS, type StickyNoteMaterialEffect } from '../../shared/sticky-note-material-effects'
import { PreferencesRangeControl } from './PreferencesRangeControl'
import './sticky-note-material-settings.css'

const materials = [
  ['mica-light', 'Mica'],
  ['warm-frosted-glass', '暖雾玻璃'],
  ['clear-glass', '深色玻璃'],
  ['flowing-glass', 'Acrylic'],
] as const

function TintControl({ name, value, onChange, disabled }: {
  name: string
  value: string
  onChange(value: string): void
  disabled: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const valid = /^#[0-9a-f]{6}$/iu.test(draft)
  return <div className="sticky-note-material-tint">
    <span>色调颜色</span>
    <input aria-label={`${name} 色调颜色`} disabled={disabled} onChange={(event) => onChange(event.target.value.toUpperCase())} type="color" value={value} />
    <input
      aria-label={`${name} 色调 HEX`}
      aria-invalid={!valid}
      className="sticky-note-material-hex"
      disabled={disabled}
      maxLength={7}
      onBlur={() => setDraft(value)}
      onChange={(event) => {
        const next = event.target.value.toUpperCase()
        setDraft(next)
        if (/^#[0-9A-F]{6}$/u.test(next)) onChange(next)
      }}
      spellCheck={false}
      type="text"
      value={draft}
    />
  </div>
}

function RecipeControls({ name, value, onChange, disabled }: {
  name: string
  value: StickyNoteMicaAppearance
  onChange(value: StickyNoteMicaAppearance): void
  disabled: boolean
}) {
  return <>
    <TintControl name={name} value={value.tintColor} disabled={disabled} onChange={(tintColor) => onChange({ ...value, tintColor })} />
    {([['tintOpacity', '着色强度'], ['luminosityOpacity', '明度融合'], ['saturation', '饱和度']] as const).map(([key, label]) => (
      <PreferencesRangeControl key={key} ariaLabel={`${name} ${label}`} label={label} min={0} max={100} suffix="%"
        value={Number((value[key] * 100).toFixed(10))} disabled={disabled} onChange={(next) => onChange({ ...value, [key]: next / 100 })} />
    ))}
  </>
}

function EffectControls({ name, value, onChange, disabled, acrylic }: {
  name: string
  value: StickyNoteMaterialEffect
  onChange(value: StickyNoteMaterialEffect): void
  disabled: boolean
  acrylic: boolean
}) {
  return <>
    {([['transparency', '模拟透明度'], ['innerGlowIntensity', '白色内发光强度']] as const).map(([key, label]) => (
      <PreferencesRangeControl key={key} ariaLabel={`${name} ${label}`} label={label} min={0} max={100} suffix="%"
        value={Number((value[key] * 100).toFixed(10))} disabled={disabled} onChange={(next) => onChange({ ...value, [key]: next / 100 })} />
    ))}
    <PreferencesRangeControl ariaLabel={`${name} 内发光范围`} label="内发光范围" min={0} max={60} suffix=" px"
      value={value.innerGlowRangePx} disabled={disabled} onChange={(innerGlowRangePx) => onChange({ ...value, innerGlowRangePx })} />
    <label className="sticky-note-material-checkbox">
      <input type="checkbox" disabled={disabled} checked={acrylic ? value.borderHidden ?? true : value.shadowEnabled ?? false}
        onChange={(event) => onChange({ ...value, [acrylic ? 'borderHidden' : 'shadowEnabled']: event.target.checked })} />
      <span>{acrylic ? '去除描边' : '显示投影'}</span>
    </label>
  </>
}

export function StickyNoteMaterialSettingsPage({ value, onChange, disabled = false }: {
  value: StickyNoteWallpaperAppearances
  onChange(value: StickyNoteWallpaperAppearances): void
  disabled?: boolean
}) {
  return <div className="sticky-note-material-settings">
    <h1 id="preferences-arknote-material-settings" tabIndex={-1}>材质设置</h1>
    <p className="sticky-note-material-help">调整会同步更新所有使用同款材质的便签。内发光范围以屏幕物理像素为单位。</p>
    {materials.map(([id, name]) => {
      const change = (update: (next: StickyNoteWallpaperAppearances) => void) => {
        const next = copyStickyNoteWallpaperAppearances(value)
        update(next)
        onChange(next)
      }
      return <section key={id} aria-labelledby={`material-settings-${id}`} className="preferences-section sticky-note-material-group">
        <h2 id={`material-settings-${id}`}>{name}</h2>
        {id !== 'flowing-glass' && <RecipeControls name={name} disabled={disabled}
          value={id === 'mica-light' ? value.micaAppearance : value.glassAppearances[id]}
          onChange={(recipe) => change((next) => {
            if (id === 'mica-light') next.micaAppearance = recipe
            else next.glassAppearances[id] = recipe
          })} />}
        {id !== 'mica-light' && <EffectControls name={name} disabled={disabled} acrylic={id === 'flowing-glass'} value={value.materialEffects[id]}
          onChange={(effect) => change((next) => { next.materialEffects[id] = effect })} />}
        <button className="sticky-note-settings-button" disabled={disabled} type="button" onClick={() => change((next) => {
          if (id === 'mica-light') next.micaAppearance = { ...DEFAULT_STICKY_NOTE_MICA_APPEARANCE }
          else {
            next.materialEffects[id] = { ...DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS[id] }
            if (id !== 'flowing-glass') next.glassAppearances[id] = { ...DEFAULT_STICKY_NOTE_GLASS_APPEARANCES[id] }
          }
        })}>恢复默认</button>
      </section>
    })}
  </div>
}
