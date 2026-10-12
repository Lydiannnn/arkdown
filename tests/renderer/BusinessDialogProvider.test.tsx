import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { StrictMode, useEffect, useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  BusinessDialogProvider,
  type BusinessConfirmOptions,
  type BusinessDialogController,
  useBusinessDialog,
  useOptionalBusinessDialog,
} from '../../src/renderer/modal/BusinessDialogProvider'

function CaptureController({ onReady }: { onReady(value: BusinessDialogController): void }) {
  const controller = useBusinessDialog()
  useEffect(() => onReady(controller), [controller, onReady])
  return null
}

function ConfirmOnMount({
  onRequested,
}: {
  onRequested(result: Promise<string>): void
}) {
  const controller = useBusinessDialog()
  const requestedRef = useRef(false)
  useEffect(() => {
    if (requestedRef.current) return
    requestedRef.current = true
    onRequested(controller.confirm(first))
  }, [controller, onRequested])
  return null
}

function CaptureOptionalController({
  onReady,
}: {
  onReady(value: BusinessDialogController | null): void
}) {
  const controller = useOptionalBusinessDialog()
  useEffect(() => onReady(controller), [controller, onReady])
  return null
}

const first: BusinessConfirmOptions = {
  title: '第一项',
  description: '先处理第一项',
  confirmLabel: '确认第一项',
  cancelLabel: '取消',
}

const second: BusinessConfirmOptions = {
  title: '第二项',
  confirmLabel: '确认第二项',
  cancelLabel: '取消第二项',
  discardLabel: '放弃第二项',
  tone: 'danger',
}

describe('BusinessDialogProvider', () => {
  it('offers an optional context bridge without creating a process-global fallback', () => {
    const values: Array<BusinessDialogController | null> = []
    const outside = render(
      <CaptureOptionalController onReady={(value) => { values.push(value) }} />,
    )
    expect(values).toEqual([null])
    outside.unmount()

    render(
      <BusinessDialogProvider>
        <CaptureOptionalController onReady={(value) => { values.push(value) }} />
      </BusinessDialogProvider>,
    )
    expect(values[1]).not.toBeNull()
  })

  it('wraps the main application so document workflows can consume confirmations', () => {
    const app = readFileSync(
      path.join(process.cwd(), 'src/renderer/app/App.tsx'),
      'utf8',
    )
    expect(app).toContain('<BusinessDialogProvider>')
  })

  it('queues confirmations and settles each promise exactly once', async () => {
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )

    let firstResult!: Promise<string>
    let secondResult!: Promise<string>
    act(() => {
      firstResult = controller.confirm(first)
      secondResult = controller.confirm(second)
    })

    expect(screen.getByRole('dialog', { name: '第一项' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '确认第一项' }))
    expect(await firstResult).toBe('confirm')

    expect(await screen.findByRole('dialog', { name: '第二项' })).toHaveAttribute(
      'data-tone',
      'default',
    )
    fireEvent.click(screen.getByRole('button', { name: '放弃第二项' }))
    expect(await secondResult).toBe('discard')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('restores the original opener after the final queued dialog closes', async () => {
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <button type="button">原始触发器</button>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )
    const opener = screen.getByRole('button', { name: '原始触发器' })
    opener.focus()
    act(() => {
      void controller.confirm(first)
      void controller.confirm(second)
    })

    fireEvent.click(screen.getByRole('button', { name: '确认第一项' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认第二项' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })

  it('queues alert, prompt, and confirm requests with their native-compatible results', async () => {
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )

    let alertSettled = 0
    let promptResult!: Promise<string | null>
    let confirmResult!: Promise<string>
    act(() => {
      void controller.alert({
        title: '读取失败',
        description: '无法读取剪贴板内容。',
        confirmLabel: '知道了',
        tone: 'danger',
      }).then(() => { alertSettled += 1 })
      promptResult = controller.prompt({
        title: '图片替代文本',
        defaultValue: '旧文本',
        inputLabel: '图片替代文本',
        confirmLabel: '确定',
        cancelLabel: '取消',
      })
      confirmResult = controller.confirm(first)
    })

    const alert = screen.getByRole('alertdialog', { name: '读取失败' })
    expect(alert).toHaveAttribute('data-tone', 'danger')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    await waitFor(() => expect(alertSettled).toBe(1))

    const prompt = await screen.findByRole('dialog', { name: '图片替代文本' })
    const input = screen.getByRole('textbox', { name: '图片替代文本' })
    expect(input).toHaveValue('旧文本')
    fireEvent.change(input, { target: { value: '新的替代文本' } })
    fireEvent.submit(prompt)
    await expect(promptResult).resolves.toBe('新的替代文本')

    expect(await screen.findByRole('dialog', { name: '第一项' })).toBeVisible()
    fireEvent.keyDown(window, { key: 'Escape' })
    await expect(confirmResult).resolves.toBe('cancel')
    expect(alertSettled).toBe(1)
  })

  it('uses standard fields for both existing opt-ins and ordinary editor prompts', async () => {
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )
    let standardResult!: Promise<string | null>
    let ordinaryResult!: Promise<string | null>
    act(() => {
      standardResult = controller.prompt({ title: '便签名', fieldStyle: 'standard' })
      ordinaryResult = controller.prompt({ title: '图片替代文本', defaultValue: '原有文本' })
    })

    const standardInput = screen.getByRole('textbox', { name: '便签名' })
    expect(standardInput.closest('label')).toHaveClass('arkdown-dialog__prompt-field')
    fireEvent.change(standardInput, { target: { value: '新名称' } })
    fireEvent.submit(screen.getByRole('dialog', { name: '便签名' }))
    await expect(standardResult).resolves.toBe('新名称')

    const ordinaryInput = await screen.findByRole('textbox', { name: '图片替代文本' })
    expect(ordinaryInput).toHaveValue('原有文本')
    expect(ordinaryInput.closest('label')).toHaveClass('arkdown-dialog__prompt-field')
    fireEvent.keyDown(window, { key: 'Escape' })
    await expect(ordinaryResult).resolves.toBeNull()
  })

  it('preserves prompt defaults and resolves cancellation as null', async () => {
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )
    let result!: Promise<string | null>
    act(() => {
      result = controller.prompt({
        title: '代码语言',
        defaultValue: 'typescript',
        inputLabel: '代码语言',
      })
    })

    expect(screen.getByRole('textbox', { name: '代码语言' })).toHaveValue('typescript')
    fireEvent.keyDown(window, { key: 'Escape' })

    await expect(result).resolves.toBeNull()
  })

  it('remains available after the StrictMode effect replay used by the application root', () => {
    let controller!: BusinessDialogController
    render(
      <StrictMode>
        <BusinessDialogProvider>
          <CaptureController onReady={(value) => { controller = value }} />
        </BusinessDialogProvider>
      </StrictMode>,
    )

    act(() => { void controller.confirm(first) })

    expect(screen.getByRole('dialog', { name: '第一项' })).toBeVisible()
  })

  it('preserves a descendant mount-effect confirmation through StrictMode replay', async () => {
    let result!: Promise<string>
    render(
      <StrictMode>
        <BusinessDialogProvider>
          <ConfirmOnMount onRequested={(value) => { result = value }} />
        </BusinessDialogProvider>
      </StrictMode>,
    )

    expect(screen.getByRole('dialog', { name: '第一项' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '确认第一项' }))
    await expect(result).resolves.toBe('confirm')
  })

  it('settles active and queued work as cancel when the provider unmounts', async () => {
    let controller!: BusinessDialogController
    const view = render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )

    let active!: Promise<string>
    let queued!: Promise<string>
    act(() => {
      active = controller.confirm(first)
      queued = controller.confirm(second)
    })
    view.unmount()

    await expect(active).resolves.toBe('cancel')
    await expect(queued).resolves.toBe('cancel')
  })

  it('settles mixed active and queued work with each API cancellation result on unmount', async () => {
    let controller!: BusinessDialogController
    const view = render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )

    let alertSettled = 0
    let promptResult!: Promise<string | null>
    let confirmResult!: Promise<string>
    act(() => {
      void controller.alert({ title: '提示' }).then(() => { alertSettled += 1 })
      promptResult = controller.prompt({ title: '输入', defaultValue: '默认值' })
      confirmResult = controller.confirm(first)
    })
    view.unmount()
    await act(async () => { await Promise.resolve() })

    expect(alertSettled).toBe(1)
    await expect(promptResult).resolves.toBeNull()
    await expect(confirmResult).resolves.toBe('cancel')
  })

  it('immediately cancels confirmations from a retained controller after unmount', async () => {
    let controller!: BusinessDialogController
    const view = render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )
    view.unmount()

    let retainedResult: string | undefined
    controller.confirm(first).then((result) => { retainedResult = result })
    await act(async () => { await Promise.resolve() })

    expect(retainedResult).toBe('cancel')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ignores repeated settlement events without consuming the next FIFO request', async () => {
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )

    let firstResult!: Promise<string>
    let secondResult!: Promise<string>
    act(() => {
      firstResult = controller.confirm(first)
      secondResult = controller.confirm(second)
    })
    const firstConfirm = screen.getByRole('button', { name: '确认第一项' })
    act(() => {
      firstConfirm.click()
      firstConfirm.click()
    })

    await expect(firstResult).resolves.toBe('confirm')
    expect(await screen.findByRole('dialog', { name: '第二项' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '取消第二项' }))
    await expect(secondResult).resolves.toBe('cancel')
  })

  it('renders save confirmation actions left-to-right with only Save emphasized', () => {
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )
    act(() => {
      void controller.confirm({
        title: '保存更改',
        confirmLabel: '保存',
        discardLabel: '不保存',
        cancelLabel: '取消',
      })
    })

    const dialog = screen.getByRole('dialog', { name: '保存更改' })
    expect(dialog).toHaveAttribute('data-tone', 'default')
    const save = screen.getByRole('button', { name: '保存' })
    const discard = screen.getByRole('button', { name: '不保存' })
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(screen.getAllByRole('button')).toEqual([save, discard, cancel])
    expect(save).toHaveAccessibleName('保存')
    expect(save).toHaveClass('arkdown-dialog__primary')
    expect(save).not.toHaveClass('arkdown-dialog__danger')
    expect(discard).toHaveAccessibleName('不保存')
    expect(discard).not.toHaveClass('arkdown-dialog__danger', 'arkdown-dialog__primary')
    expect(cancel).toHaveAccessibleName('取消')
    expect(cancel).not.toHaveClass('arkdown-dialog__danger', 'arkdown-dialog__primary')
  })

  it('preserves cancel-first order for two-action confirmations', () => {
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )
    act(() => { void controller.confirm(first) })

    const cancel = screen.getByRole('button', { name: '取消' })
    const confirm = screen.getByRole('button', { name: '确认第一项' })
    expect(screen.getAllByRole('button')).toEqual([cancel, confirm])
    expect(cancel).not.toHaveClass('arkdown-dialog__primary')
    expect(confirm).toHaveClass('arkdown-dialog__primary')
  })

  it('allows one two-action confirmation to opt into confirm-first order', () => {
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )
    act(() => {
      void controller.confirm({
        title: '从磁盘重新加载',
        confirmLabel: '继续',
        cancelLabel: '取消',
        actionOrder: 'confirm-cancel',
      })
    })

    const proceed = screen.getByRole('button', { name: '继续' })
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(screen.getAllByRole('button')).toEqual([proceed, cancel])
    expect(proceed).toHaveClass('arkdown-dialog__primary')
    expect(cancel).not.toHaveClass('arkdown-dialog__primary')
  })

  it('tabs through save confirmation actions in their left-to-right order', async () => {
    const user = userEvent.setup()
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )
    act(() => {
      void controller.confirm({
        title: '保存更改',
        confirmLabel: '保存',
        discardLabel: '不保存',
        cancelLabel: '取消',
      })
    })

    const save = screen.getByRole('button', { name: '保存' })
    const discard = screen.getByRole('button', { name: '不保存' })
    const cancel = screen.getByRole('button', { name: '取消' })
    expect(screen.getByRole('dialog', { name: '保存更改' })).toHaveFocus()
    await user.tab()
    expect(save).toHaveFocus()
    await user.tab()
    expect(discard).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()
    await user.tab()
    expect(save).toHaveFocus()
  })

  it('maps Escape to cancel without exposing native confirmation UI', async () => {
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )
    let result!: Promise<string>
    act(() => { result = controller.confirm(first) })

    fireEvent.keyDown(window, { key: 'Escape' })

    await expect(result).resolves.toBe('cancel')
  })

  it('settles queued Escape and backdrop dismissals once and in FIFO order', async () => {
    let controller!: BusinessDialogController
    render(
      <BusinessDialogProvider>
        <CaptureController onReady={(value) => { controller = value }} />
      </BusinessDialogProvider>,
    )
    let firstResult!: Promise<string>
    let secondResult!: Promise<string>
    act(() => {
      firstResult = controller.confirm(first)
      secondResult = controller.confirm(second)
    })

    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: '第一项' }).parentElement)
      .toHaveAttribute('data-state', 'closing')
    await expect(firstResult).resolves.toBe('cancel')

    const queuedDialog = await screen.findByRole('dialog', { name: '第二项' })
    fireEvent.mouseDown(queuedDialog.parentElement!)
    fireEvent.mouseDown(queuedDialog.parentElement!)
    expect(queuedDialog.parentElement).toHaveAttribute('data-state', 'closing')
    await expect(secondResult).resolves.toBe('cancel')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('preserves an accepted provider result when externally unmounted at 119ms', async () => {
    vi.useFakeTimers()
    try {
      let controller!: BusinessDialogController
      const view = render(
        <BusinessDialogProvider>
          <CaptureController onReady={(value) => { controller = value }} />
        </BusinessDialogProvider>,
      )
      let result!: Promise<string>
      act(() => { result = controller.confirm(first) })

      fireEvent.click(screen.getByRole('button', { name: '确认第一项' }))
      act(() => { vi.advanceTimersByTime(119) })
      await act(async () => {
        view.unmount()
        await Promise.resolve()
      })

      await expect(result).resolves.toBe('confirm')
      act(() => { vi.advanceTimersByTime(1_000) })
      await expect(result).resolves.toBe('confirm')
    } finally {
      vi.useRealTimers()
    }
  })
})
