import {
  MAX_STICKY_NOTE_FONT_SIZE_PX,
  MIN_STICKY_NOTE_FONT_SIZE_PX,
} from '../../shared/sticky-notes'
import type { ContextMenuItem } from '../context-menu/context-menu-types'

export type StickyNoteFontSizeChange = 'increase' | 'decrease'

export function nextStickyNoteFontSize(
  fontSizePx: number,
  change: StickyNoteFontSizeChange,
): number | null {
  if (!Number.isSafeInteger(fontSizePx)) return null
  const next = fontSizePx + (change === 'increase' ? 1 : -1)
  if (next < MIN_STICKY_NOTE_FONT_SIZE_PX || next > MAX_STICKY_NOTE_FONT_SIZE_PX) return null
  return next
}

export function buildStickyNoteFontSizeItems(fontSizePx: number): readonly ContextMenuItem[] {
  return [
    {
      kind: 'command',
      id: 'sticky-font-size-increase',
      label: '\u653e\u5927\u5b57\u53f7',
      disabled: nextStickyNoteFontSize(fontSizePx, 'increase') === null,
    },
    {
      kind: 'command',
      id: 'sticky-font-size-decrease',
      label: '\u7f29\u5c0f\u5b57\u53f7',
      disabled: nextStickyNoteFontSize(fontSizePx, 'decrease') === null,
    },
  ]
}
