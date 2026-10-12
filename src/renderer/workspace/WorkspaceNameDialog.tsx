import { useEffect, useRef, useState } from 'react'
import { ArkdownDialog, type ArkdownDialogControls } from '../modal/ArkdownDialog'

export interface WorkspaceNameDialogProps {
  title: string
  initialValue: string
  confirmLabel: string
  onCancel(): void
  onSubmit(value: string): Promise<string | null>
}

export function WorkspaceNameDialog({
  title,
  initialValue,
  confirmLabel,
  onCancel,
  onSubmit,
}: WorkspaceNameDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = async (requestClose: ArkdownDialogControls['requestClose']) => {
    if (submittingRef.current) return
    const normalized = value.trim()
    if (!normalized) {
      setError('名称不能为空。')
      return
    }
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    let closeRequested = false
    try {
      const nextError = await onSubmit(normalized)
      if (nextError) setError(nextError)
      else {
        closeRequested = true
        requestClose(onCancel)
      }
    } catch {
      setError('操作未能完成。')
    } finally {
      if (!closeRequested) {
        submittingRef.current = false
        setSubmitting(false)
      }
    }
  }

  return (
    <ArkdownDialog
      actions={({ requestClose }) => <>
        <button
          disabled={submitting}
          onClick={() => requestClose(onCancel)}
          type="button"
        >取消</button>
        <button
          className="arkdown-dialog__primary"
          disabled={submitting || !value.trim()}
          type="submit"
        >
          {submitting ? '正在处理…' : confirmLabel}
        </button>
      </>}
      cancelOnBackdrop={!submitting}
      className="workspace-name-dialog"
      error={error}
      escapeEnabled={!submitting}
      initialFocusRef={inputRef}
      onCancel={onCancel}
      onSubmit={(event, { requestClose }) => {
        event.preventDefault()
        void submit(requestClose)
      }}
      size="small"
      surface="form"
      title={title}
    >
      <label>
        <span>名称</span>
        <input
          aria-label="名称"
          disabled={submitting}
          onChange={(event) => {
            setValue(event.target.value)
            if (error) setError(null)
          }}
          ref={inputRef}
          value={value}
        />
      </label>
    </ArkdownDialog>
  )
}
