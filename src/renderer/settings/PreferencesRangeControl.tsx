import type { CSSProperties } from 'react'

interface PreferencesRangeControlProps {
  ariaLabel: string
  className?: string
  disabled?: boolean
  label?: string
  max: number
  min: number
  onChange(value: number): void
  step?: number
  suffix?: string
  value: number
}

export function PreferencesRangeControl({
  ariaLabel,
  className = '',
  disabled = false,
  label,
  max,
  min,
  onChange,
  step = 1,
  suffix = '',
  value,
}: PreferencesRangeControlProps) {
  const progress = max === min ? 0 : ((value - min) / (max - min)) * 100

  return <div className={`preferences-range-control${className ? ` ${className}` : ''}`}>
    <div className="preferences-range-header">
      {label && <span className="preferences-setting-label preferences-tertiary-title">{label}</span>}
      <output className="preferences-range-value">{value}{suffix}</output>
    </div>
    <input
      aria-label={ariaLabel}
      className="preferences-range-input"
      disabled={disabled}
      max={max}
      min={min}
      onChange={(event) => onChange(Number(event.target.value))}
      step={step}
      style={{
        '--preferences-range-progress': `${Math.max(0, Math.min(100, progress))}%`,
      } as CSSProperties}
      type="range"
      value={value}
    />
  </div>
}
