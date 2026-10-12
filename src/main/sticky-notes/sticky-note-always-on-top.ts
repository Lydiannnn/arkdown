export const STICKY_NOTE_ALWAYS_ON_TOP_LEVEL = 'pop-up-menu' as const

interface StickyNoteAlwaysOnTopTarget {
  setAlwaysOnTop(pinned: boolean, level?: string): void
}

export function applyStickyNotePinnedState(
  target: StickyNoteAlwaysOnTopTarget,
  pinned: boolean,
): void {
  if (pinned) {
    target.setAlwaysOnTop(true, STICKY_NOTE_ALWAYS_ON_TOP_LEVEL)
    return
  }
  target.setAlwaysOnTop(false)
}
