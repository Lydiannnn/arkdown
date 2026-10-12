import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DocumentHeader } from '../../src/renderer/chrome/DocumentHeader'

describe('DocumentHeader sticky note box entry', () => {
  it('toggles the sticky note box from the document toolbar', () => {
    const onToggleStickyNotes = vi.fn()
    const { rerender } = render(
      <DocumentHeader
        dirty={false}
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={async () => true}
        onToggleStickyNotes={onToggleStickyNotes}
        stickyNotesOpen={false}
      />,
    )

    const button = screen.getByRole('button', { name: '便签盒子' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(onToggleStickyNotes).toHaveBeenCalledTimes(1)

    rerender(
      <DocumentHeader
        dirty={false}
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={async () => true}
        onToggleStickyNotes={onToggleStickyNotes}
        stickyNotesOpen
      />,
    )
    expect(screen.getByRole('button', { name: '便签盒子' }))
      .toHaveAttribute('aria-pressed', 'true')
  })
  it('keeps the sticky note box last in DOM and keyboard order, matching its visual toolbar position', () => {
    render(
      <DocumentHeader
        dirty={false}
        fileName="计划.md"
        hasOriginal
        onCommand={vi.fn()}
        onRename={async () => true}
        onToggleStickyNotes={vi.fn()}
      />,
    )

    const buttons = within(screen.getByRole('toolbar')).getAllByRole('button')
    expect(buttons.at(-1)).toHaveAccessibleName('便签盒子')
    expect(buttons.at(-1)?.previousElementSibling).toHaveClass('toolbar-separator')
  })
})
