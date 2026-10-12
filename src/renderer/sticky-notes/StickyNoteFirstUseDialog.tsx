import type { DesktopLifecyclePreferences } from '../../shared/desktop-lifecycle-preferences'
import { ArkdownDialog } from '../modal/ArkdownDialog'

export function shouldPromptStickyNoteFirstUse(
  value: DesktopLifecyclePreferences,
): boolean {
  return !value.stickyNoteAutostartPrompted
}

export function completeStickyNoteFirstUseChoice(
  value: DesktopLifecyclePreferences,
  launchAtLogin: boolean,
): DesktopLifecyclePreferences {
  return { ...value, launchAtLogin, stickyNoteAutostartPrompted: true }
}

interface StickyNoteFirstUseDialogProps {
  onEnable(): void
  onDecline(): void
}

export function StickyNoteFirstUseDialog({
  onEnable,
  onDecline,
}: StickyNoteFirstUseDialogProps) {
  return <ArkdownDialog
    actions={({ requestClose }) => <>
      <button onClick={() => requestClose(onDecline)} type="button">暂不开启</button>
      <button
        className="arkdown-dialog__primary"
        onClick={() => requestClose(onEnable)}
        type="button"
      >
        开启开机启动
      </button>
    </>}
    cancelOnBackdrop={false}
    className="sticky-note-name-dialog sticky-note-first-use-dialog"
    onCancel={onDecline}
    size="small"
    title="开启便签开机启动"
  >
      <p>开启后，Arknote 可在开机时自动运行，并自动打开上一次关机时仍打开的便签。</p>
      <p>免安装版移动程序文件夹后，开机启动会失效；你可以稍后在偏好设置中修改。</p>
  </ArkdownDialog>
}
