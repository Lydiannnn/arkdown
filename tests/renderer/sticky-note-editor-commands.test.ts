import { expect, it, vi } from 'vitest'
import {
  dispatchStickyNoteEditorCommand,
  STICKY_NOTE_TOOLBAR_ITEMS,
} from '../../src/renderer/sticky-notes/sticky-note-editor-commands'

it('exposes the six approved formatting commands', () => {
  expect(STICKY_NOTE_TOOLBAR_ITEMS.map(({ command }) => command)).toEqual([
    'strong',
    'emphasis',
    'link',
    'ordered-list',
    'unordered-list',
    'task-list',
  ])
})

it('dispatches the same editor command event used by the main editor', () => {
  const dispatchEvent = vi.fn()
  dispatchStickyNoteEditorCommand('ordered-list', { dispatchEvent })

  expect(dispatchEvent).toHaveBeenCalledTimes(1)
  const event = dispatchEvent.mock.calls[0][0] as CustomEvent
  expect(event.type).toBe('arkdown:editor-command')
  expect(event.detail).toBe('ordered-list')
})
