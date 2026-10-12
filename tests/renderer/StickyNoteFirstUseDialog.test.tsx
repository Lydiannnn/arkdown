import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  StickyNoteFirstUseDialog,
  completeStickyNoteFirstUseChoice,
  shouldPromptStickyNoteFirstUse,
} from '../../src/renderer/sticky-notes/StickyNoteFirstUseDialog'
import { DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES } from '../../src/shared/desktop-lifecycle-preferences'

describe('StickyNoteFirstUseDialog', () => {
  it('records either choice exactly once while keeping later manual changes possible', () => {
    const enabled = completeStickyNoteFirstUseChoice(
      DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES,
      true,
    )
    expect(enabled).toEqual({
      launchAtLogin: true,
      closeBehavior: 'tray',
      stickyNoteAutostartPrompted: true,
    })
    expect(shouldPromptStickyNoteFirstUse(enabled)).toBe(false)

    const declined = completeStickyNoteFirstUseChoice(
      DEFAULT_DESKTOP_LIFECYCLE_PREFERENCES,
      false,
    )
    expect(declined.launchAtLogin).toBe(false)
    expect(shouldPromptStickyNoteFirstUse(declined)).toBe(false)
    expect({ ...declined, launchAtLogin: true }).toMatchObject({ launchAtLogin: true })
  })

  it('offers a one-time choice without obscuring why startup is useful', async () => {
    const onEnable = vi.fn()
    const onDecline = vi.fn()
    render(<StickyNoteFirstUseDialog onDecline={onDecline} onEnable={onEnable} />)

    expect(screen.getByRole('dialog', { name: '开启便签开机启动' })).toBeVisible()
    expect(screen.getByText(/自动打开上一次关机时仍打开的便签/u)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '开启开机启动' }))
    expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'closing')
    expect(onEnable).not.toHaveBeenCalled()
    await waitFor(() => expect(onEnable).toHaveBeenCalledTimes(1))
    expect(onDecline).not.toHaveBeenCalled()
  })

  it('allows declining without treating the dialog as mandatory', async () => {
    const onDecline = vi.fn()
    render(<StickyNoteFirstUseDialog onDecline={onDecline} onEnable={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '暂不开启' }))
    expect(onDecline).not.toHaveBeenCalled()
    await waitFor(() => expect(onDecline).toHaveBeenCalledTimes(1))
  })

  it('does not treat a backdrop press as declining the first-use choice', () => {
    const onDecline = vi.fn()
    render(<StickyNoteFirstUseDialog onDecline={onDecline} onEnable={vi.fn()} />)

    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)

    expect(onDecline).not.toHaveBeenCalled()
  })
})
