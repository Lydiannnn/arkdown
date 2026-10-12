import { useEffect, useRef, useState } from 'react'
import { STICKY_NOTE_NAME_MAX_LENGTH } from '../../shared/sticky-notes'
import { ArkdownDialog, type ArkdownDialogControls } from '../modal/ArkdownDialog'

interface StickyNoteNameDialogProps {
  existingNames: readonly string[]
  initialValue: string
  currentName?: string
  title: string
  confirmLabel?: string
  onCancel(): void
  onSubmit(name: string): Promise<string | null>
}

function validateName(value: string, existingNames: readonly string[], currentName?: string): string | null {
  if (value.trim() === '') return '便签名不能为空'
  if (value !== value.trim()) return '便签名不能以空格开头或结尾'
  if (value.length > STICKY_NOTE_NAME_MAX_LENGTH) return `便签名不能超过 ${STICKY_NOTE_NAME_MAX_LENGTH} 个字符`
  if (value.endsWith('.')) return '便签名不能以句点结尾'
  if (/[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(value)) return '便签名不能包含 Windows 文件名非法字符'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(value)) return '该名称是 Windows 保留名称'
  const normalized = value.toLocaleLowerCase('en-US')
  if (normalized !== currentName?.toLocaleLowerCase('en-US') && existingNames.some((name) => name.toLocaleLowerCase('en-US') === normalized)) return '便签名已存在'
  return null
}

export function StickyNoteNameDialog({ existingNames, initialValue, currentName, title, confirmLabel = '创建', onCancel, onSubmit }: StickyNoteNameDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])
  const cancel = () => {
    if (submittingRef.current) return
    onCancel()
  }
  const submit = async (requestClose: ArkdownDialogControls['requestClose']) => {
    if (submittingRef.current) return
    const validationError = validateName(value, existingNames, currentName)
    if (validationError) { setError(validationError); return }
    submittingRef.current = true
    setSubmitting(true)
    let closeRequested = false
    try {
      const serverError = await onSubmit(value)
      if (serverError) setError(serverError)
      else {
        closeRequested = true
        requestClose(onCancel)
      }
    } finally {
      if (!closeRequested) {
        submittingRef.current = false
        setSubmitting(false)
      }
    }
  }

  return <ArkdownDialog
    actions={({ requestClose }) => <>
      <button
        disabled={submitting}
        onClick={() => {
          if (submittingRef.current) return
          requestClose(cancel)
        }}
        type="button"
      >取消</button>
      <button
        className="arkdown-dialog__primary"
        disabled={submitting}
        type="submit"
      >{confirmLabel}</button>
    </>}
    cancelOnBackdrop={false}
    className="sticky-note-name-dialog"
    error={error}
    escapeEnabled={!submitting}
    initialFocusRef={inputRef}
    onCancel={cancel}
    onSubmit={(event, { requestClose }) => {
      event.preventDefault()
      void submit(requestClose)
    }}
    size="small"
    surface="form"
    title={title}
  >
    <label className="arkdown-dialog__prompt-field">
      <span>便签名</span>
      <input
        aria-label="便签名" maxLength={STICKY_NOTE_NAME_MAX_LENGTH}
        onChange={(event) => { setValue(event.target.value); setError(null) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
        ref={inputRef} value={value}
      />
    </label>
  </ArkdownDialog>
}
