import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { expect, it, vi } from 'vitest'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import type { VisualEditorHandle } from '../../src/renderer/editor/VisualEditor'
import { StickyNoteEditor } from '../../src/renderer/sticky-notes/StickyNoteEditor'

vi.mock('../../src/renderer/editor/VisualEditor', () => ({
  VisualEditor: forwardRef<VisualEditorHandle, { markdown: string; onChange(markdown: string): void }>(
    function FakeVisualEditor(_props, ref) {
      useImperativeHandle(ref, () => ({
        flush: () => null,
        captureSelection: () => true,
        insertMarkdown: () => true,
        selectedBlockStyle: () => 'paragraph',
      }) as unknown as VisualEditorHandle)
      return <div aria-label="content" className="ProseMirror" contentEditable suppressContentEditableWarning />
    },
  ),
}))

it('opens sticky background settings from the blank-area context menu command', async () => {
  const onOpenBackgroundSettings = vi.fn()
  render(
    <ContextMenuProvider>
      <StickyNoteEditor
        markdown=""
        onChange={vi.fn()}
        onOpenBackgroundSettings={onOpenBackgroundSettings}
      />
    </ContextMenuProvider>,
  )

  fireEvent.contextMenu(screen.getByLabelText('content'), { clientX: 120, clientY: 80 })
  screen.getByRole('menuitem', { name: '设置背景...' }).click()

  await waitFor(() => expect(onOpenBackgroundSettings).toHaveBeenCalledOnce())
})
