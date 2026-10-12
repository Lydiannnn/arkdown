import { useId, useLayoutEffect, useRef } from 'react'

export interface ChoiceProps {
  label: string
  checked: boolean
  indeterminate?: boolean
  description?: string
  disabled?: boolean
  pending?: boolean
  error?: string
  onChange?(enabled: boolean): void
}

export function Choice({ label, checked, indeterminate = false, description, disabled, pending, error, onChange }: ChoiceProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const descriptionId = useId()
  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  })
  return <div className="preferences-shell-menu-choice">
    <label className="preferences-checkbox-label sticky-note-lifecycle-checkbox">
      <span className="preferences-checkbox-description">
        <input aria-label={label} aria-checked={indeterminate ? 'mixed' : checked}
          aria-describedby={description ? descriptionId : undefined}
          ref={inputRef} checked={checked} disabled={disabled || pending}
          onChange={(event) => onChange?.(event.target.checked)} type="checkbox" />
        <span className="preferences-shell-menu-copy">{label}</span>
      </span>
    </label>
    {description && <p className="preferences-choice-description" id={descriptionId}>{description}</p>}
    {pending && <p role="status">正在应用…</p>}
    {error && <p className="preferences-error" data-ui-selectable="true" role="alert" tabIndex={0}>{error}</p>}
  </div>
}

