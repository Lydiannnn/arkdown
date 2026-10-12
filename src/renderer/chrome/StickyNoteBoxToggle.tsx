import { AppIcon } from '../icons/AppIcon'

export function StickyNoteBoxToggle({
  open,
  onToggle,
}: {
  open: boolean
  onToggle(): void
}) {
  return <button
    aria-label="便签盒子"
    aria-pressed={open}
    className="sticky-note-box-toolbar-button"
    data-tooltip="便签盒子"
    onClick={onToggle}
    type="button"
  >
    <AppIcon name="sticky-note" size={18} />
  </button>
}
