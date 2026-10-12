import { DEFAULT_STICKY_NOTE_PREFERENCES, type StickyNotePreferences } from '../../shared/sticky-note-preferences'
import type { DesktopLifecyclePreferences } from '../../shared/desktop-lifecycle-preferences'
import './sticky-note-preferences.css'
import './sticky-note-material-settings.css'

interface StickyNotePreferencesSectionProps {
  value: StickyNotePreferences
  onChange(value: StickyNotePreferences): void
  lifecycleValue?: DesktopLifecyclePreferences
  onLifecycleChange?(value: DesktopLifecyclePreferences): void
  title?: string
  launchAtLogin?: boolean
  onLaunchAtLoginChange?(value: boolean): void
  onOpenMaterialSettings?(): void
  surface?: 'arkdown-embedded' | 'arknote-standalone'
}

export function StickyNoteLifecyclePreferences({ value, onChange }: {
  value: DesktopLifecyclePreferences
  onChange(value: DesktopLifecyclePreferences): void
}) {
  return <div className="sticky-note-lifecycle-preferences">
    <h3>应用驻留</h3>
    <label className="sticky-note-lifecycle-checkbox">
      <input
        aria-label="开机启动"
        checked={value.launchAtLogin}
        onChange={(event) => onChange({ ...value, launchAtLogin: event.target.checked })}
        type="checkbox"
      />
      <span>开机启动</span>
    </label>
    {value.launchAtLogin && <p className="sticky-note-portable-warning" role="status">
      免安装版启用开机启动时，如果移动了程序文件夹，开机启动将失效
    </p>}
    <fieldset className="sticky-note-close-behavior">
      <legend>关闭时…</legend>
      <label><input
        checked={value.closeBehavior === 'tray'}
        name="sticky-note-close-behavior"
        onChange={() => onChange({ ...value, closeBehavior: 'tray' })}
        type="radio"
      />关闭窗口，并在系统托盘显示图标</label>
      <label><input
        checked={value.closeBehavior === 'quit'}
        name="sticky-note-close-behavior"
        onChange={() => onChange({ ...value, closeBehavior: 'quit' })}
        type="radio"
      />关闭整个软件（无法维持桌面便签功能）</label>
    </fieldset>
  </div>
}

export function StickyNotePreferencesSection({
  value,
  onChange,
  lifecycleValue,
  onLifecycleChange,
  title = '便签设置',
  launchAtLogin,
  onLaunchAtLoginChange,
  onOpenMaterialSettings,
  surface = 'arknote-standalone',
}: StickyNotePreferencesSectionProps) {
  const headingId = title === 'Arknote'
    ? 'preferences-arknote-heading'
    : 'preferences-sticky-notes-heading'
  const isArkdownEmbedded = surface === 'arkdown-embedded'
  const surfaceClassName = isArkdownEmbedded
    ? 'sticky-note-preferences-section--arkdown-embedded'
    : 'sticky-note-preferences-section--arknote-standalone'
  const sectionClassName = `preferences-section sticky-note-preferences-section ${surfaceClassName}`
  const groupClassName = 'preferences-secondary-group sticky-note-preferences-group'
  const headingClassName = 'preferences-secondary-heading'
  return <section aria-labelledby={headingId} className={sectionClassName}>
    <h2 id={headingId}>{title}</h2>
    <p>设置新便签使用的默认材质和颜色。已有便签保持原样。</p>
    {lifecycleValue && onLifecycleChange && <StickyNoteLifecyclePreferences
      onChange={onLifecycleChange}
      value={lifecycleValue}
    />}
    {launchAtLogin !== undefined && onLaunchAtLoginChange && <section
      aria-labelledby="preferences-arknote-startup-heading"
      className={groupClassName}
    >
      <h3 className={headingClassName} id="preferences-arknote-startup-heading">开机启动</h3>
      <label className="preferences-checkbox-label preferences-secondary-control sticky-note-lifecycle-checkbox">
        <span className="preferences-checkbox-description">
          <input aria-label="开机启动" checked={launchAtLogin}
            onChange={(event) => onLaunchAtLoginChange(event.target.checked)} type="checkbox" />
          <small>随 Windows 自动启动 Arknote 服务。</small>
        </span>
      </label>
      {launchAtLogin && <p className="sticky-note-portable-warning" role="status">
        免安装版启用开机启动时，如果移动了程序文件夹，开机启动将失效
      </p>}
    </section>}
    <div aria-label="新便签默认样式" className="sticky-note-default-appearance" role="radiogroup">
    <section aria-labelledby="preferences-arknote-materials-heading" className={groupClassName}>
      <h3 className={headingClassName} id="preferences-arknote-materials-heading">默认材质</h3>
      <div className="sticky-note-material-options">
        {([['mica-light', 'Mica'], ['warm-frosted-glass', '暖雾玻璃'], ['clear-glass', '深色玻璃'], ['flowing-glass', 'Acrylic']] as const).map(([id, label]) => <label key={id}>
          <input checked={value.defaultAppearance === id} name="sticky-note-default-material" onChange={() => onChange({ ...value, defaultAppearance: id })} type="radio" />
          <span>{label}</span>
        </label>)}
      </div>
      {onOpenMaterialSettings && <div className="sticky-note-material-settings-action">
        <button className="sticky-note-settings-button" onClick={onOpenMaterialSettings} type="button">材质设置</button>
      </div>}
    </section>
    <section aria-labelledby="preferences-arknote-colors-heading" className={`${groupClassName} sticky-note-colors-row`}>
      <h3 className={headingClassName} id="preferences-arknote-colors-heading">默认颜色</h3>
      <label className="sticky-note-color-option">
        <input checked={value.defaultAppearance === 'color'} name="sticky-note-default-material" onChange={() => onChange({ ...value, defaultAppearance: 'color' })} type="radio" />
        <span>颜色</span>
      </label>
      <div className="sticky-note-color-preference-grid">
        <label className="sticky-note-color-preference">
          <span>自定义颜色</span>
          <input aria-label="自定义颜色" disabled={value.defaultAppearance !== 'color'} onChange={(event) => onChange({ ...value, defaultColor: event.target.value.toUpperCase() })} type="color" value={value.defaultColor} />
        </label>
      </div>
    </section>
    </div>
    <div className="sticky-note-preferences-actions">
      <button className="sticky-note-settings-button sticky-note-preferences-reset" onClick={() => onChange({ ...value, defaultAppearance: DEFAULT_STICKY_NOTE_PREFERENCES.defaultAppearance, defaultColor: DEFAULT_STICKY_NOTE_PREFERENCES.defaultColor })} type="button">恢复便签默认样式</button>
    </div>

  </section>
}
