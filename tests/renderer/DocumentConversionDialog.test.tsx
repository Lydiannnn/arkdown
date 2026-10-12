import { readFile } from 'node:fs/promises'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DocumentConversionDialog } from '../../src/renderer/document-conversion/DocumentConversionDialog'
import type {
  DocumentConversionController,
  DocumentConversionState,
} from '../../src/renderer/document-conversion/use-document-conversion'
import type { ConvertedDocument } from '../../src/shared/document-conversion'

function converted(
  markdown: string,
  fileName = '<img src=x onerror=alert(1)>.pdf',
): ConvertedDocument {
  return Object.freeze({
    source: Object.freeze({
      absolutePath: `C:\\workspace\\${fileName}`,
      fileName,
      format: 'pdf' as const,
      bytes: 10,
      modifiedAtMs: 1_800_000_000_000,
    }),
    markdown,
    converterVersion: '0.1.7-py3.12.10',
    fingerprint: 'a'.repeat(64),
    warnings: Object.freeze([] as string[]),
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function controller(
  state: DocumentConversionState,
  overrides: Partial<DocumentConversionController> = {},
): DocumentConversionController {
  return {
    state,
    begin: vi.fn(),
    install: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    accept: vi.fn(() => state.status === 'preview' ? state.converted : null),
    ...overrides,
  }
}

describe('DocumentConversionDialog', () => {
  it('names the source as text, focuses the safe action, traps focus, and restores the trigger on Escape', async () => {
    const trigger = document.createElement('button')
    trigger.textContent = '打开报告'
    document.body.append(trigger)
    const conversion = controller({
      status: 'install-required',
      relativePath: 'docs/<img src=x onerror=alert(1)>.pdf',
      fileName: '<img src=x onerror=alert(1)>.pdf',
      format: 'pdf',
      source: 'packaged',
      actionLabel: '安装',
      message: '转换此文档需要安装文档转换组件。',
    })
    const idle = controller({ status: 'idle' })
    const view = render(<DocumentConversionDialog controller={idle} />)
    trigger.focus()
    view.rerender(<DocumentConversionDialog controller={conversion} />)

    const dialog = screen.getByRole('dialog', { name: '转换文档预览' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByText('<img src=x onerror=alert(1)>.pdf')).toBeVisible()
    expect(within(dialog).getByText('PDF')).toBeVisible()
    expect(dialog.querySelector('img')).toBeNull()
    const install = within(dialog).getByRole('button', { name: '安装' })
    const cancel = within(dialog).getByRole('button', { name: '取消' })
    expect(install).toHaveClass('document-conversion-dialog__primary--standard')
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(cancel, { key: 'Tab' })
    expect(install).toHaveFocus()
    fireEvent.keyDown(install, { key: 'Tab', shiftKey: true })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(conversion.cancel).toHaveBeenCalledOnce()
    await waitFor(() => expect(trigger).toHaveFocus())

    view.unmount()
    trigger.remove()
  })

  it('shows semantic local install progress and native disabled actions', () => {
    const conversion = controller({
      status: 'installing',
      relativePath: 'report.pdf',
      fileName: 'report.pdf',
      format: 'pdf',
      source: 'packaged',
      progressPercent: 25,
      progressText: '正在校验组件，25%',
    })
    render(<DocumentConversionDialog controller={conversion} />)

    const preparationNote = screen.getByText('首次启用插件大约需要1分钟进行准备')
    expect(screen.getByRole('status')).toHaveTextContent('正在校验组件，25%')
    const progress = screen.getByRole('progressbar', { name: '文档转换组件安装进度' })
    expect(preparationNote).toHaveClass('document-conversion-dialog__preparation-note')
    expect(
      preparationNote.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(progress).toHaveAttribute('aria-valuenow', '25')
    expect(progress).toHaveAttribute('aria-valuetext', '正在校验组件，25%')
    const installing = screen.getByRole('button', { name: '正在安装' })
    expect(installing).toBeDisabled()
    expect(installing).toHaveClass('document-conversion-dialog__primary--standard')
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled()
  })

  it('announces conversion progress and offers cancellation without layout-shifting controls', () => {
    const conversion = controller({
      status: 'converting',
      relativePath: 'slides.pptx',
      fileName: 'slides.pptx',
      format: 'pptx',
    })
    render(<DocumentConversionDialog controller={conversion} />)

    expect(screen.getByRole('status')).toHaveTextContent('正在转换文档')
    expect(screen.getByRole('progressbar', { name: '文档转换进度' }))
      .not.toHaveAttribute('value')
    expect(screen.getByRole('button', { name: '正在转换' })).toBeDisabled()
    expect(screen.queryByText('首次启用插件大约需要1分钟进行准备')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(conversion.cancel).toHaveBeenCalledOnce()
    expect(document.querySelector('.document-conversion-dialog__body'))
      .toHaveClass('document-conversion-dialog__body--progress')
  })

  it('renders preview only through safe read-only Markdown with no executable or loading DOM', () => {
    const markdown = [
      '# Safe heading',
      '<script>window.__unsafe = true</script>',
      '<img src="https://attacker.invalid/pixel" onerror="window.__unsafe = true">',
      '[script](javascript:alert(1))',
      '[file](file:///C:/secret.txt)',
      '![network](https://attacker.invalid/pixel.png)',
      '![file image](file:///C:/secret.png)',
      '<b>raw html</b>',
    ].join('\n\n')
    const result = converted(markdown)
    const conversion = controller({
      status: 'preview',
      relativePath: 'unsafe.pdf',
      fileName: result.source.fileName,
      format: 'pdf',
      converted: result,
    })
    render(<DocumentConversionDialog controller={conversion} />)
    const dialog = screen.getByRole('dialog', { name: '转换文档预览' })

    expect(screen.getByRole('heading', { name: 'Safe heading' })).toBeVisible()
    expect(screen.getByText('转换结果仅保留可提取结构，可能不包含原始版式。'))
      .toHaveClass('document-conversion-dialog__notice')
    expect(dialog.querySelector('script')).toBeNull()
    expect(dialog.querySelector('[onerror]')).toBeNull()
    expect(dialog.querySelector('[contenteditable]')).toBeNull()
    expect(dialog.querySelectorAll('img')).toHaveLength(2)
    expect(dialog.querySelector('img[src]')).toBeNull()
    expect(screen.getByText('script').closest('a')).not.toHaveAttribute('href')
    expect(screen.getByText('file').closest('a')).not.toHaveAttribute('href')
    expect(dialog).not.toHaveTextContent('window.__unsafe')
    expect(dialog.querySelector('b')).toBeNull()
    expect(dialog).toHaveTextContent('raw html')
  })

  it('locks preview acceptance while adoption is pending and keeps preview when adoption declines', async () => {
    let resolve!: (value: boolean) => void
    const adoption = new Promise<boolean>((done) => { resolve = done })
    const onAccept = vi.fn(() => adoption)
    const result = converted('# Preview')
    const conversion = controller({
      status: 'preview',
      relativePath: 'report.pdf',
      fileName: 'report.pdf',
      format: 'pdf',
      converted: result,
    })
    render(<DocumentConversionDialog controller={conversion} onAccept={onAccept} />)

    const create = screen.getByRole('button', { name: '新建 Markdown' })
    expect(create).toHaveClass('document-conversion-dialog__primary--standard')
    act(() => {
      fireEvent.click(create)
      fireEvent.click(create)
    })
    expect(onAccept).toHaveBeenCalledOnce()
    expect(onAccept).toHaveBeenCalledWith(result)
    expect(create).toBeDisabled()

    await act(async () => {
      resolve(false)
      await adoption
    })
    expect(create).toBeEnabled()
    expect(conversion.cancel).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeVisible()
  })

  it('invalidates an escaped preview attempt so its late result cannot close or unlock a new preview', async () => {
    const firstAdoption = deferred<boolean>()
    const secondAdoption = deferred<boolean>()
    const firstResult = converted('# First', 'first.pdf')
    const secondResult = converted('# Second', 'second.pdf')
    const cancel = vi.fn()
    const onAccept = vi.fn((value: ConvertedDocument) => (
      value === firstResult ? firstAdoption.promise : secondAdoption.promise
    ))
    const firstController = controller({
      status: 'preview',
      relativePath: 'first.pdf',
      fileName: 'first.pdf',
      format: 'pdf',
      converted: firstResult,
    }, { cancel })
    const secondController = controller({
      status: 'preview',
      relativePath: 'second.pdf',
      fileName: 'second.pdf',
      format: 'pdf',
      converted: secondResult,
    }, { cancel })
    const view = render(
      <DocumentConversionDialog controller={firstController} onAccept={onAccept} />,
    )

    fireEvent.click(screen.getByRole('button', { name: '新建 Markdown' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(cancel).toHaveBeenCalledOnce()

    view.rerender(
      <DocumentConversionDialog controller={secondController} onAccept={onAccept} />,
    )
    const secondCreate = screen.getByRole('button', { name: '新建 Markdown' })
    expect(screen.getByText('second.pdf')).toBeVisible()
    expect(secondCreate).toBeEnabled()
    fireEvent.click(secondCreate)
    expect(onAccept).toHaveBeenCalledTimes(2)
    expect(onAccept).toHaveBeenLastCalledWith(secondResult)
    expect(secondCreate).toBeDisabled()

    await act(async () => {
      firstAdoption.resolve(true)
      await firstAdoption.promise
    })

    expect(cancel).toHaveBeenCalledOnce()
    expect(screen.getByText('second.pdf')).toBeVisible()
    expect(secondCreate).toBeDisabled()

    await act(async () => {
      secondAdoption.resolve(false)
      await secondAdoption.promise
    })
    expect(secondCreate).toBeEnabled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not cancel a synchronously replaced owner before the new preview rerenders', async () => {
    const adoption = deferred<boolean>()
    const firstResult = converted('# First', 'first.pdf')
    const secondResult = converted('# Second', 'second.pdf')
    let currentPreview: ConvertedDocument | null = firstResult
    const cancel = vi.fn()
    const begin = vi.fn(() => {
      currentPreview = secondResult
    })
    const mutableController = controller({
      status: 'preview',
      relativePath: 'first.pdf',
      fileName: 'first.pdf',
      format: 'pdf',
      converted: firstResult,
    }, {
      accept: vi.fn(() => currentPreview),
      begin,
      cancel,
    })
    render(
      <DocumentConversionDialog
        controller={mutableController}
        onAccept={() => adoption.promise}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '新建 Markdown' }))
    act(() => mutableController.begin('second.pdf'))
    expect(begin).toHaveBeenCalledWith('second.pdf')
    expect(screen.getByText('first.pdf')).toBeVisible()

    await act(async () => {
      adoption.resolve(true)
      await adoption.promise
    })

    expect(cancel).not.toHaveBeenCalled()
  })

  it('keeps cancellation focusable during acceptance and invalidates the attempt on cancel', async () => {
    const adoption = deferred<boolean>()
    const result = converted('# Preview', 'report.pdf')
    const cancel = vi.fn()
    const conversion = controller({
      status: 'preview',
      relativePath: 'report.pdf',
      fileName: 'report.pdf',
      format: 'pdf',
      converted: result,
    }, { cancel })
    render(<DocumentConversionDialog controller={conversion} onAccept={() => adoption.promise} />)

    const create = screen.getByRole('button', { name: '新建 Markdown' })
    const cancelButton = screen.getByRole('button', { name: '取消' })
    fireEvent.click(create)

    expect(create).toBeDisabled()
    expect(cancelButton).toBeEnabled()
    cancelButton.focus()
    expect(cancelButton).toHaveFocus()
    fireEvent.keyDown(cancelButton, { key: 'Tab' })
    expect(cancelButton).toHaveFocus()
    fireEvent.keyDown(cancelButton, { key: 'Tab', shiftKey: true })
    expect(cancelButton).toHaveFocus()

    fireEvent.click(cancelButton)
    expect(cancel).toHaveBeenCalledOnce()
    await act(async () => {
      adoption.resolve(true)
      await adoption.promise
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('invalidates a pending acceptance on unmount without cancelling or updating afterward', async () => {
    const adoption = deferred<boolean>()
    const cancel = vi.fn()
    const result = converted('# Preview', 'report.pdf')
    const conversion = controller({
      status: 'preview',
      relativePath: 'report.pdf',
      fileName: 'report.pdf',
      format: 'pdf',
      converted: result,
    }, { cancel })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = render(
      <DocumentConversionDialog controller={conversion} onAccept={() => adoption.promise} />,
    )

    fireEvent.click(screen.getByRole('button', { name: '新建 Markdown' }))
    view.unmount()
    await act(async () => {
      adoption.resolve(true)
      await adoption.promise
    })

    expect(cancel).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('retries a bounded public failure and never displays raw details', () => {
    const conversion = controller({
      status: 'failed',
      relativePath: 'report.pdf',
      fileName: 'report.pdf',
      format: 'pdf',
      message: '文档转换未能完成，请重试。',
      retryKind: 'conversion',
    })
    render(<DocumentConversionDialog controller={conversion} />)

    expect(screen.getByRole('alert')).toHaveTextContent('文档转换未能完成，请重试。')
    expect(document.body).not.toHaveTextContent('python')
    const retry = screen.getByRole('button', { name: '重试' })
    expect(retry).toHaveClass('document-conversion-dialog__primary--standard')
    fireEvent.click(retry)
    expect(conversion.retry).toHaveBeenCalledOnce()
  })

  it('uses a large scrollable modal, native disabled visuals, a standard blue adoption action, and reduced motion', async () => {
    const css = await readFile('src/renderer/document-conversion/document-conversion.css', 'utf8')

    expect(css).toMatch(/\.document-conversion-dialog\s*\{[^}]*width:\s*min\(880px,/s)
    expect(css).toMatch(/\.document-conversion-dialog__body\s*\{[^}]*overflow:\s*auto;/s)
    expect(css).toMatch(/accent-color:\s*rgb\(var\(--theme-color-rgb,/s)
    expect(css).toMatch(/button:disabled\s*\{[^}]*var\(--control-disabled-opacity\)/s)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    expect(css).toMatch(/__primary--standard:not\(:disabled\)\s*\{[^}]*background:\s*#4183c4;[^}]*border-color:\s*#4183c4;/s)
    expect(css).toMatch(/__primary--standard:hover:not\(:disabled\)\s*\{[^}]*background:\s*#3677b7;[^}]*border-color:\s*#3677b7;/s)
    expect(css).toMatch(/__primary--standard:active:not\(:disabled\)\s*\{[^}]*background:\s*#2f699f;[^}]*border-color:\s*#2f699f;/s)
    expect(css).toMatch(/__primary--standard:disabled:focus-visible\s*\{[^}]*outline:\s*none;/s)
  })
})
