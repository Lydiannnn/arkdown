import { useRef } from 'react'
import { ArkdownDialog } from '../modal/ArkdownDialog'

export function ScreenshotOcrRemoveDialog({
  onCancel,
  onConfirm,
  pending,
  bundled = false,
}: {
  onCancel(): void
  onConfirm(): void
  pending: boolean
  bundled?: boolean
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <ArkdownDialog
      actions={({ requestClose }) => <>
        <button
          disabled={pending}
          onClick={() => requestClose(onCancel)}
          ref={cancelRef}
          type="button"
        >否</button>
        <button
          className="arkdown-dialog__primary preferences-confirm-dialog__confirm"
          disabled={pending}
          onClick={() => requestClose(onConfirm)}
          type="button"
        >是</button>
      </>}
      backdropClassName="preferences-confirm-backdrop"
      cancelOnBackdrop={false}
      className="preferences-dialog preferences-confirm-dialog"
      description={bundled ? '停用后将使用PP-OCRv6轻度模型，Full内置文件会保留，可随时重新启用。' : '删除后将恢复使用PP-OCRv6轻度模型'}
      descriptionClassName="preferences-confirm-dialog__hint"
      escapeEnabled={!pending}
      initialFocusRef={cancelRef}
      onCancel={onCancel}
      size="small"
      title={bundled ? '是否停用PP-OCRv6 Medium模型？' : '是否删除PP-OCRv6 Medium模型？'}
      tone="danger"
    />
  )
}
