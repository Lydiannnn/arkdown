import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode, useEffect, useRef, useState, type CSSProperties } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ArkdownDialog } from '../../src/renderer/modal/ArkdownDialog'
import { TooltipProvider } from '../../src/renderer/tooltip/TooltipProvider'

function DialogHarness() {
  const [open, setOpen] = useState(false)
  return <>
    <button
      onClick={() => setOpen(true)}
      style={{ '--theme-color-rgb': '11 22 33' } as CSSProperties}
      type="button"
    >打开</button>
    {open && (
      <ArkdownDialog
        actions={<button onClick={() => setOpen(false)} type="button">确认</button>}
        description="共享弹窗说明"
        onCancel={() => setOpen(false)}
        title="共享弹窗"
      >
        <button type="button">次要操作</button>
      </ArkdownDialog>
    )}
  </>
}

function DialogStack({ first, second }: { first: boolean; second: boolean }) {
  return <>
    {first && <ArkdownDialog onCancel={vi.fn()} title="底层弹窗" />}
    {second && <ArkdownDialog onCancel={vi.fn()} title="顶层弹窗" />}
  </>
}

interface SequentialStackControls {
  removeFirst(): void
  removeSecond(): void
}

function SequentialDialogStack({ controls }: { controls: SequentialStackControls }) {
  const [first, setFirst] = useState(false)
  const [second, setSecond] = useState(false)
  controls.removeFirst = () => setFirst(false)
  controls.removeSecond = () => setSecond(false)

  return (
    <main aria-hidden="false" className="app-shell">
      <button onClick={() => setFirst(true)} type="button">打开底层</button>
      {first && (
        <ArkdownDialog
          actions={<button onClick={() => setSecond(true)} type="button">打开顶层</button>}
          onCancel={() => setFirst(false)}
          title="底层弹窗"
        />
      )}
      {second && (
        <ArkdownDialog
          actions={<button type="button">顶层操作</button>}
          onCancel={() => setSecond(false)}
          title="顶层弹窗"
        />
      )}
    </main>
  )
}

function ClosingDialogHarness({
  onClosed,
}: {
  onClosed(): void
}) {
  const [open, setOpen] = useState(true)
  const finish = () => {
    onClosed()
    setOpen(false)
  }
  return open ? (
    <ArkdownDialog
      actions={({ requestClose }) => <>
        <button onClick={() => undefined} type="button">异步操作</button>
        <button onClick={() => requestClose(finish)} type="button">确认</button>
      </>}
      onCancel={finish}
      title="退出动画"
    />
  ) : null
}

function ClosingFormDialogHarness({
  onClosed,
  onSubmit,
}: {
  onClosed(): void
  onSubmit(): void
}) {
  return (
    <ArkdownDialog
      actions={<button className="arkdown-dialog__primary" type="submit">保存</button>}
      onCancel={onClosed}
      onSubmit={(event, { requestClose }) => {
        event.preventDefault()
        onSubmit()
        requestClose(onClosed)
      }}
      surface="form"
      title="提交退出动画"
    >
      <input aria-label="名称" defaultValue="Arkdown" />
    </ArkdownDialog>
  )
}

function CloseOnMount({
  onClosed,
  requestClose,
}: {
  onClosed(): void
  requestClose(onClosed?: () => void): void
}) {
  const requestedRef = useRef(false)
  useEffect(() => {
    if (requestedRef.current) return
    requestedRef.current = true
    requestClose(onClosed)
  }, [onClosed, requestClose])
  return null
}

describe('ArkdownDialog', () => {
  it('labels the dialog, traps focus, closes with Escape, and restores its trigger', async () => {
    render(<DialogHarness />)
    const trigger = screen.getByRole('button', { name: '打开' })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: '共享弹窗' })
    expect(dialog).toHaveFocus()
    expect(dialog.parentElement).toHaveStyle({ '--theme-color-rgb': '11 22 33' })
    expect(dialog).toHaveAttribute('aria-describedby')
    expect(screen.getByText('共享弹窗说明')).toHaveAttribute(
      'id',
      dialog.getAttribute('aria-describedby'),
    )

    const first = screen.getByRole('button', { name: '次要操作' })
    const last = screen.getByRole('button', { name: '确认' })
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(first).toHaveFocus()
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'closing')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('uses the requested initial focus target and announces errors', () => {
    function ErrorDialog() {
      const initialFocusRef = useRef<HTMLButtonElement>(null)
      return (
        <ArkdownDialog
          actions={<button ref={initialFocusRef} type="button">返回</button>}
          error="操作未能完成。"
          initialFocusRef={initialFocusRef}
          onCancel={vi.fn()}
          title="错误提示"
          tone="danger"
        />
      )
    }
    render(<ErrorDialog />)

    expect(screen.getByRole('button', { name: '返回' })).toHaveFocus()
    expect(screen.getByRole('dialog')).toHaveAttribute('data-tone', 'danger')
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive')
  })

  it.each([
    { label: 'lower modal first', remaining: { first: false, second: true } },
    { label: 'top modal first', remaining: { first: true, second: false } },
  ])('keeps the background isolated when removing the $label', ({ remaining }) => {
    const background = document.createElement('main')
    background.setAttribute('aria-hidden', 'legacy')
    background.inert = true
    document.body.append(background)
    const view = render(<DialogStack first second />)

    expect(background).toHaveAttribute('aria-hidden', 'true')
    expect(background.inert).toBe(true)
    view.rerender(<DialogStack {...remaining} />)
    expect(background).toHaveAttribute('aria-hidden', 'true')
    expect(background.inert).toBe(true)

    view.unmount()
    expect(background).toHaveAttribute('aria-hidden', 'legacy')
    expect(background.inert).toBe(true)
    background.remove()
  })

  it('isolates the lower modal and restores it with its opener after LIFO removal', () => {
    const controls: SequentialStackControls = {
      removeFirst: vi.fn(),
      removeSecond: vi.fn(),
    }
    render(<SequentialDialogStack controls={controls} />)
    const appOpener = screen.getByRole('button', { name: '打开底层' })
    appOpener.focus()
    fireEvent.click(appOpener)
    const lowerDialog = screen.getByRole('dialog', { name: '底层弹窗' })
    const lowerBackdrop = lowerDialog.parentElement as HTMLElement
    const upperOpener = screen.getByRole('button', { name: '打开顶层' })
    upperOpener.focus()
    fireEvent.click(upperOpener)

    expect(lowerBackdrop).toHaveAttribute('aria-hidden', 'true')
    expect(lowerBackdrop.inert).toBe(true)
    expect(screen.getByRole('dialog', { name: '顶层弹窗' }).parentElement).not
      .toHaveAttribute('aria-hidden')

    act(() => { controls.removeSecond() })
    expect(lowerBackdrop).not.toHaveAttribute('aria-hidden')
    expect(lowerBackdrop.inert).toBe(false)
    expect(upperOpener).toHaveFocus()

    act(() => { controls.removeFirst() })
    expect(appOpener).toHaveFocus()
    expect(appOpener.closest('.app-shell')).toHaveAttribute('aria-hidden', 'false')
    expect((appOpener.closest('.app-shell') as HTMLElement).inert).toBe(false)
  })

  it('keeps the surviving top modal focused and restores the root opener after non-LIFO removal', () => {
    const controls: SequentialStackControls = {
      removeFirst: vi.fn(),
      removeSecond: vi.fn(),
    }
    render(<SequentialDialogStack controls={controls} />)
    const appOpener = screen.getByRole('button', { name: '打开底层' })
    appOpener.focus()
    fireEvent.click(appOpener)
    const lowerDialog = screen.getByRole('dialog', { name: '底层弹窗' })
    const lowerBackdrop = lowerDialog.parentElement as HTMLElement
    const upperOpener = screen.getByRole('button', { name: '打开顶层' })
    upperOpener.focus()
    fireEvent.click(upperOpener)
    const upperDialog = screen.getByRole('dialog', { name: '顶层弹窗' })

    act(() => { controls.removeFirst() })
    expect(lowerBackdrop.isConnected).toBe(false)
    expect(lowerBackdrop).toHaveAttribute('aria-hidden', 'true')
    expect(lowerBackdrop.inert).toBe(true)
    expect(upperDialog).toHaveFocus()
    expect(appOpener).not.toHaveFocus()
    expect(appOpener.closest('.app-shell')).toHaveAttribute('aria-hidden', 'true')
    expect((appOpener.closest('.app-shell') as HTMLElement).inert).toBe(true)

    act(() => { controls.removeSecond() })
    expect(lowerBackdrop).not.toHaveAttribute('aria-hidden')
    expect(lowerBackdrop.inert).toBe(false)
    expect(appOpener).toHaveFocus()
    expect(appOpener.closest('.app-shell')).toHaveAttribute('aria-hidden', 'false')
    expect((appOpener.closest('.app-shell') as HTMLElement).inert).toBe(false)
  })

  it('keeps the shell mounted for the 120ms exit before settling an action', () => {
    vi.useFakeTimers()
    try {
      const onClosed = vi.fn()
      render(<ClosingDialogHarness onClosed={onClosed} />)

      fireEvent.click(screen.getByRole('button', { name: '确认' }))
      expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'closing')
      expect(onClosed).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(119) })
      expect(screen.getByRole('dialog')).toBeVisible()
      act(() => { vi.advanceTimersByTime(1) })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(onClosed).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects form submission after close starts even when Enter submits during the exit animation', () => {
    vi.useFakeTimers()
    try {
      const onClosed = vi.fn()
      const onSubmit = vi.fn()
      render(<ClosingFormDialogHarness onClosed={onClosed} onSubmit={onSubmit} />)

      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      expect(onSubmit).toHaveBeenCalledOnce()
      const dialog = screen.getByRole('dialog', { name: '提交退出动画' })
      expect(dialog.parentElement).toHaveAttribute('data-state', 'closing')

      fireEvent.keyDown(screen.getByRole('textbox', { name: '名称' }), { key: 'Enter' })
      fireEvent.submit(dialog)

      expect(onSubmit).toHaveBeenCalledOnce()
      act(() => { vi.advanceTimersByTime(120) })
      expect(onClosed).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['app-shell', 'preferences-page'])(
    'inherits the current %s theme when focus starts on the document body',
    (className) => {
      function RootThemeHarness() {
        const [open, setOpen] = useState(false)
        return (
          <main
            className={className}
            style={{ '--theme-color-rgb': '37 99 235' } as CSSProperties}
          >
            <button onClick={() => setOpen(true)} type="button">打开根主题弹窗</button>
            {open && <ArkdownDialog onCancel={vi.fn()} title="根主题弹窗" />}
          </main>
        )
      }
      document.body.focus()
      render(<RootThemeHarness />)
      fireEvent.click(screen.getByRole('button', { name: '打开根主题弹窗' }))

      expect(screen.getByRole('dialog', { name: '根主题弹窗' }).parentElement)
        .toHaveStyle({ '--theme-color-rgb': '37 99 235' })
    },
  )

  it('deduplicates repeated Escape dismissal while the exit animation is running', () => {
    vi.useFakeTimers()
    try {
      const onClosed = vi.fn()
      render(<ClosingDialogHarness onClosed={onClosed} />)

      fireEvent.keyDown(window, { key: 'Escape' })
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'closing')
      expect(onClosed).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(120) })
      expect(onClosed).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not close for an action that does not request dismissal', () => {
    const onClosed = vi.fn()
    render(<ClosingDialogHarness onClosed={onClosed} />)

    fireEvent.click(screen.getByRole('button', { name: '异步操作' }))

    expect(screen.getByRole('dialog').parentElement).toHaveAttribute('data-state', 'open')
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('settles dismissal immediately when reduced motion is requested', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    })
    try {
      const onClosed = vi.fn()
      render(<ClosingDialogHarness onClosed={onClosed} />)

      fireEvent.click(screen.getByRole('button', { name: '确认' }))

      expect(onClosed).toHaveBeenCalledOnce()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    } finally {
      if (descriptor) Object.defineProperty(window, 'matchMedia', descriptor)
      else Reflect.deleteProperty(window, 'matchMedia')
    }
  })

  it('completes an accepted action exactly once when externally unmounted at 119ms', async () => {
    vi.useFakeTimers()
    try {
      const accepted = vi.fn()
      const view = render(
        <ArkdownDialog
          actions={({ requestClose }) => (
            <button onClick={() => requestClose(accepted)} type="button">保存</button>
          )}
          onCancel={vi.fn()}
          title="外部卸载"
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: '保存' }))
      act(() => { vi.advanceTimersByTime(119) })
      expect(accepted).not.toHaveBeenCalled()
      await act(async () => {
        view.unmount()
        await Promise.resolve()
      })
      expect(accepted).toHaveBeenCalledOnce()
      act(() => { vi.advanceTimersByTime(1_000) })
      expect(accepted).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('completes an accepted Escape cancellation when externally unmounted at 119ms', async () => {
    vi.useFakeTimers()
    try {
      const cancelled = vi.fn()
      const view = render(<ArkdownDialog onCancel={cancelled} title="外部取消" />)

      fireEvent.keyDown(window, { key: 'Escape' })
      act(() => { vi.advanceTimersByTime(119) })
      expect(cancelled).not.toHaveBeenCalled()
      await act(async () => {
        view.unmount()
        await Promise.resolve()
      })
      expect(cancelled).toHaveBeenCalledOnce()
      act(() => { vi.advanceTimersByTime(1_000) })
      expect(cancelled).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not repeat a timer-completed action when the shell later unmounts', async () => {
    vi.useFakeTimers()
    try {
      const accepted = vi.fn()
      const view = render(
        <ArkdownDialog
          actions={({ requestClose }) => (
            <button onClick={() => requestClose(accepted)} type="button">确认</button>
          )}
          onCancel={vi.fn()}
          title="完成后卸载"
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: '确认' }))
      act(() => { vi.advanceTimersByTime(120) })
      expect(accepted).toHaveBeenCalledOnce()
      await act(async () => {
        view.unmount()
        await Promise.resolve()
      })
      expect(accepted).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves a mount-effect close request through StrictMode effect replay', () => {
    vi.useFakeTimers()
    try {
      const accepted = vi.fn()
      render(
        <StrictMode>
          <ArkdownDialog onCancel={vi.fn()} title="StrictMode 退出">
            {({ requestClose }) => (
              <CloseOnMount onClosed={accepted} requestClose={requestClose} />
            )}
          </ArkdownDialog>
        </StrictMode>,
      )

      act(() => { vi.advanceTimersByTime(119) })
      expect(accepted).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(1) })
      expect(accepted).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the modal above base tips and below modal tips, with reduced-motion support', () => {
    const css = readFileSync(
      path.join(process.cwd(), 'src/renderer/modal/arkdown-dialog.css'),
      'utf8',
    )
    expect(css).toMatch(/\.arkdown-dialog-backdrop\s*\{[^}]*z-index:\s*22000/s)
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(css).toMatch(/background:\s*rgb\(0 0 0 \/ 48%\)/)
    expect(css).toMatch(/border-radius:\s*10px/)
    expect(css).toMatch(/arkdown-dialog-(?:backdrop|surface)-in\s+160ms/)
    expect(css).toMatch(/arkdown-dialog-(?:backdrop|surface)-out\s+120ms/)
    expect(css).not.toMatch(/\.arkdown-dialog:focus-visible\s*\{/)
  })

  it('uses a 17px title while keeping descriptions at the 13px helper level', () => {
    const css = readFileSync(
      path.join(process.cwd(), 'src/renderer/modal/arkdown-dialog.css'),
      'utf8',
    )
    expect(css).toMatch(/\.arkdown-dialog__title\s*\{[^}]*font-size:\s*17px/s)
    expect(css).toMatch(/\.arkdown-dialog__description\s*\{[^}]*font-size:\s*13px/s)
  })

  it('keeps forced-colors keyboard focus visible inside action button bounds', () => {
    const css = readFileSync(
      path.join(process.cwd(), 'src/renderer/modal/arkdown-dialog.css'),
      'utf8',
    )
    expect(css).toMatch(
      /@media\s*\(forced-colors:\s*active\)\s*\{[\s\S]*?\.arkdown-dialog__actions button:focus-visible\s*\{[^}]*outline:\s*2px solid Highlight;[^}]*outline-offset:\s*-3px;[^}]*box-shadow:\s*none;/s,
    )
  })

  it('keeps primary actions on the preference confirmation palette in every tone and scheme', () => {
    const css = readFileSync(
      path.join(process.cwd(), 'src/renderer/modal/arkdown-dialog.css'),
      'utf8',
    )
    expect(css).toMatch(/--arkdown-dialog-primary-surface:\s*#4183c4/i)
    expect(css).toMatch(/--arkdown-dialog-primary-hover:\s*#3677b7/i)
    expect(css).toMatch(/--arkdown-dialog-primary-pressed:\s*#2f699f/i)
    expect(css.match(/--arkdown-dialog-primary-surface:/g)).toHaveLength(1)
    expect(css.match(/--arkdown-dialog-primary-hover:/g)).toHaveLength(1)
    expect(css.match(/--arkdown-dialog-primary-pressed:/g)).toHaveLength(1)
    expect(css).not.toMatch(
      /\.arkdown-dialog\[data-tone="danger"\][^{]*\.arkdown-dialog__primary/,
    )
    expect(css).toMatch(
      /\.arkdown-dialog__actions \.arkdown-dialog__danger:not\(\.arkdown-dialog__primary\):not\(:disabled\)/,
    )
    expect(css).toMatch(
      /\.arkdown-dialog__actions \.arkdown-dialog__danger:not\(\.arkdown-dialog__primary\):hover:not\(:disabled\)/,
    )
    expect(css).toMatch(
      /\.arkdown-dialog__actions \.arkdown-dialog__danger:not\(\.arkdown-dialog__primary\):active:not\(:disabled\)/,
    )

    render(
      <ArkdownDialog
        actions={<button className="arkdown-dialog__primary" type="button">删除</button>}
        onCancel={vi.fn()}
        title="危险确认"
        tone="danger"
      />,
    )
    const backdrop = screen.getByRole('dialog', { name: '危险确认' }).parentElement!
    for (const state of ['surface', 'hover', 'pressed']) {
      expect(backdrop.style.getPropertyValue(`--arkdown-dialog-primary-${state}`)).toBe('')
    }
  })

  it('maps the shared surface, text, action, focus, and danger tokens for both color schemes', () => {
    const css = readFileSync(
      path.join(process.cwd(), 'src/renderer/modal/arkdown-dialog.css'),
      'utf8',
    )
    for (const token of [
      'surface',
      'border',
      'text',
      'helper',
      'error',
      'action-surface',
      'action-border',
      'action-text',
      'action-hover',
      'action-pressed',
      'disabled-opacity',
      'focus',
      'danger-surface',
      'danger-hover',
      'danger-pressed',
    ]) {
      expect(css).toContain(`--arkdown-dialog-${token}:`)
    }
    expect(css).toMatch(
      /@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*--arkdown-dialog-surface:\s*#202124/,
    )
    expect(css).toMatch(/\.arkdown-dialog\s*\{[\s\S]*background:\s*var\(--arkdown-dialog-surface\)/)
    expect(css).toMatch(/\.arkdown-dialog__description\s*\{[\s\S]*color:\s*var\(--arkdown-dialog-helper\)/)
    expect(css).toMatch(/\.arkdown-dialog__description\s*\{[^}]*white-space:\s*pre-wrap/s)
  })

  it('defaults dialog tips to the modal layer while preserving other backdrop data', () => {
    render(
      <TooltipProvider>
        <ArkdownDialog
          actions={<button data-tooltip="弹窗内提示" type="button">操作</button>}
          backdropData={{
            'data-extra-marker': 'preserved',
            'data-tooltip-layer': 'context-menu',
          }}
          onCancel={vi.fn()}
          title="提示分层"
        />
      </TooltipProvider>,
    )

    const backdrop = screen.getByRole('dialog').parentElement!
    expect(backdrop).toHaveAttribute('data-extra-marker', 'preserved')
    expect(backdrop).toHaveAttribute('data-tooltip-layer', 'modal')
    fireEvent.focusIn(screen.getByRole('button', { name: '操作' }))
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-tooltip-layer', 'modal')
  })

  it('is the shell used by every renderer business modal in scope', () => {
    const files = [
      'src/renderer/workspace/WorkspaceNameDialog.tsx',
      'src/renderer/workspace/FolderDropDialog.tsx',
      'src/renderer/workspace/ContextWorkspaceSidebar.tsx',
      'src/renderer/settings/AddModelDialog.tsx',
      'src/renderer/settings/ScreenshotOcrRemoveDialog.tsx',
      'src/renderer/settings/SearchPreferencesDialog.tsx',
      'src/renderer/sticky-notes/StickyNoteFirstUseDialog.tsx',
      'src/renderer/sticky-notes/StickyNoteNameDialog.tsx',
    ]
    for (const file of files) {
      expect(readFileSync(path.join(process.cwd(), file), 'utf8'), file).toContain('<ArkdownDialog')
    }
  })
})
