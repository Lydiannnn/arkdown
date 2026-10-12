import { readFile } from 'node:fs/promises'
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentConversionPreferencesSection } from '../../src/renderer/settings/DocumentConversionPreferencesSection'
import type { ArkdownApi } from '../../src/shared/contracts'
import type {
  DocumentConversionComponentSource,
  DocumentConversionComponentState,
} from '../../src/shared/document-conversion'

function componentState(
  source: DocumentConversionComponentSource,
  overrides: Partial<DocumentConversionComponentState> = {},
): DocumentConversionComponentState {
  return {
    revision: 0,
    source,
    status: 'absent',
    installedVersion: null,
    availableVersion: '0.1.7-py3.12.10',
    progress: null,
    errorCode: null,
    busy: false,
    ...overrides,
  }
}

const packagedAbsent = componentState('packaged')
const packagedInstalled = componentState('packaged', {
  status: 'installed',
  installedVersion: '0.1.7-py3.12.10',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function apiForState(
  state: DocumentConversionComponentState,
  overrides: Partial<ArkdownApi> = {},
): ArkdownApi {
  return {
    getDocumentConversionComponentState: vi.fn().mockResolvedValue({ ok: true, value: state }),
    onDocumentConversionComponentState: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as ArkdownApi
}

function renderSection(api: ArkdownApi) {
  window.arkdown = api
  return render(<DocumentConversionPreferencesSection />)
}

beforeEach(() => {
  window.arkdown = {} as ArkdownApi
})

describe('DocumentConversionPreferencesSection', () => {
  it('explains the local preview-and-confirm boundary while the initial query is loading', async () => {
    const query = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    renderSection(apiForState(packagedAbsent, {
      getDocumentConversionComponentState: vi.fn(() => query.promise),
    }))

    expect(screen.getByRole('heading', { level: 2, name: '文档转换' })).toHaveAttribute(
      'id', 'preferences-document-conversion-heading',
    )
    expect(screen.getByText(/本地 MarkItDown 文档转换组件/)).toHaveTextContent(
      'PDF、PPTX、XLSX、EPUB',
    )
    expect(screen.getByText(/源文件保持不变/)).toHaveTextContent('转换结果需在预览中确认')
    expect(screen.getByRole('status')).toHaveTextContent('正在获取文档转换组件状态')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()

    await act(async () => {
      query.resolve({ ok: true, value: packagedAbsent })
      await query.promise
    })
    expect(screen.getByRole('button', { name: '安装' })).toBeEnabled()
  })

  it.each([
    ['packaged', 'absent', null, '安装'],
    ['packaged', 'installing', null, '正在安装'],
    ['packaged', 'installed', '0.1.7-py3.12.10', '已安装'],
    ['packaged', 'update-available', '0.1.6-py3.12.10', '更新'],
    ['https', 'absent', null, '下载并安装'],
    ['https', 'installing', null, '正在下载'],
    ['https', 'update-available', '0.1.6-py3.12.10', '下载并更新'],
  ] as const)(
    'uses the %s %s action label %s',
    async (source, status, installedVersion, expectedLabel) => {
      const installing = status === 'installing'
      renderSection(apiForState(componentState(source, {
        status,
        installedVersion,
        progress: installing
          ? { phase: source === 'https' ? 'downloading' : 'reading', receivedBytes: 1, totalBytes: 4 }
          : null,
        busy: installing,
      })))

      const action = await screen.findByRole('button', { name: expectedLabel })
      if (installing) expect(action).toBeDisabled()
      else expect(action).toBeEnabled()
    },
  )

  it('announces phase and percentage through a semantic progress indicator without removing its slot', async () => {
    renderSection(apiForState(componentState('https', {
      status: 'installing',
      progress: { phase: 'verifying', receivedBytes: 25, totalBytes: 100 },
      busy: true,
    })))

    const progress = await screen.findByRole('progressbar', { name: '文档转换组件安装进度' })
    expect(progress).toHaveAttribute('aria-valuemin', '0')
    expect(progress).toHaveAttribute('aria-valuemax', '100')
    expect(progress).toHaveAttribute('aria-valuenow', '25')
    expect(progress).toHaveAttribute('aria-valuetext', '正在校验组件，25%')
    expect(screen.getByRole('status')).toHaveTextContent('正在校验组件，25%')
    expect(progress.parentElement).toHaveClass('document-conversion-preferences__progress-slot')
  })

  it('shows a fixed query failure and retries the current state query', async () => {
    const getState = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'OPERATION_FAILED', message: 'private transport detail' },
      })
      .mockResolvedValueOnce({ ok: true, value: packagedInstalled })
    renderSection(apiForState(packagedAbsent, { getDocumentConversionComponentState: getState }))

    expect(await screen.findByRole('alert')).toHaveTextContent('无法获取组件状态，请重试。')
    expect(screen.queryByText('private transport detail')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByRole('button', { name: '已安装' })).toBeEnabled()
    expect(getState).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['DOCUMENT_CONVERSION_PACKAGE_MISSING', '当前安装包缺少文档转换组件'],
    ['DOCUMENT_CONVERSION_COMPONENT_INVALID', '文档转换组件校验失败，请重新安装'],
    ['DOCUMENT_CONVERSION_INSTALL_FAILED', '文档转换组件安装失败，请重试'],
  ] as const)('shows the public %s install failure message', async (errorCode, message) => {
    renderSection(apiForState(componentState('packaged', {
      status: 'failed',
      errorCode,
    })))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('stays compatibility-safe when an older renderer API omits component management', async () => {
    renderSection({} as ArkdownApi)

    expect(await screen.findByRole('status')).toHaveTextContent(
      '当前版本不支持文档转换组件管理',
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('retries a failed install and synchronously locks duplicate mutation submissions', async () => {
    const firstInstall = deferred<{
      ok: false
      error: { code: 'OPERATION_FAILED'; message: string }
    }>()
    const install = vi.fn()
      .mockReturnValueOnce(firstInstall.promise)
      .mockResolvedValueOnce({ ok: true, value: packagedInstalled })
    renderSection(apiForState(packagedAbsent, { installDocumentConversionComponent: install }))

    const action = await screen.findByRole('button', { name: '安装' })
    act(() => {
      fireEvent.click(action)
      fireEvent.click(action)
    })
    expect(install).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '正在安装' })).toBeDisabled()

    await act(async () => {
      firstInstall.resolve({
        ok: false,
        error: { code: 'OPERATION_FAILED', message: 'private install detail' },
      })
      await firstInstall.promise
    })
    expect(screen.getByRole('alert')).toHaveTextContent('安装失败，请重试。')
    expect(screen.queryByText('private install detail')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByRole('button', { name: '已安装' })).toBeEnabled()
    expect(install).toHaveBeenCalledTimes(2)
  })

  it('rejects a late initial query after a newer state event, including across StrictMode lifetimes', async () => {
    const firstQuery = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const secondQuery = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const listeners: Array<(state: DocumentConversionComponentState) => void> = []
    window.arkdown = apiForState(packagedAbsent, {
      getDocumentConversionComponentState: vi.fn()
        .mockReturnValueOnce(firstQuery.promise)
        .mockReturnValueOnce(secondQuery.promise),
      onDocumentConversionComponentState: vi.fn((listener) => {
        listeners.push(listener)
        return () => undefined
      }),
    })

    render(<StrictMode><DocumentConversionPreferencesSection /></StrictMode>)
    act(() => listeners.at(-1)?.(componentState('packaged', {
      revision: 2,
      status: 'installed',
      installedVersion: '0.1.7-py3.12.10',
    })))
    await act(async () => {
      firstQuery.resolve({ ok: true, value: packagedAbsent })
      secondQuery.resolve({ ok: true, value: packagedAbsent })
      await Promise.all([firstQuery.promise, secondQuery.promise])
    })

    expect(screen.getByRole('button', { name: '已安装' })).toBeEnabled()
  })

  it('keeps a newer event when an older install response succeeds or fails', async () => {
    const installResult = deferred<{
      ok: true
      value: DocumentConversionComponentState
    }>()
    let listener: ((state: DocumentConversionComponentState) => void) | undefined
    const view = renderSection(apiForState(packagedAbsent, {
      installDocumentConversionComponent: vi.fn(() => installResult.promise),
      onDocumentConversionComponentState: vi.fn((nextListener) => {
        listener = nextListener
        return () => undefined
      }),
    }))

    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    act(() => listener?.(componentState('packaged', {
      revision: 2,
      status: 'update-available',
      installedVersion: '0.1.6-py3.12.10',
    })))
    await act(async () => {
      installResult.resolve({ ok: true, value: packagedAbsent })
      await installResult.promise
    })
    expect(screen.getByRole('button', { name: '更新' })).toBeEnabled()
    view.unmount()

    const failedInstall = deferred<never>()
    listener = undefined
    renderSection(apiForState(packagedAbsent, {
      installDocumentConversionComponent: vi.fn(() => failedInstall.promise),
      onDocumentConversionComponentState: vi.fn((nextListener) => {
        listener = nextListener
        return () => undefined
      }),
    }))
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    act(() => listener?.(componentState('packaged', {
      revision: 3,
      status: 'installed',
      installedVersion: '0.1.7-py3.12.10',
    })))
    await act(async () => {
      failedInstall.reject(new Error('private rejection'))
      try { await failedInstall.promise } catch { /* expected transport failure */ }
    })

    expect(screen.getByRole('button', { name: '已安装' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps a newer query response when delayed older or duplicate events arrive afterward', async () => {
    const query = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    let listener: ((state: DocumentConversionComponentState) => void) | undefined
    renderSection(apiForState(packagedAbsent, {
      getDocumentConversionComponentState: vi.fn(() => query.promise),
      onDocumentConversionComponentState: vi.fn((nextListener) => {
        listener = nextListener
        return () => undefined
      }),
    }))
    const installed = componentState('packaged', {
      revision: 5,
      status: 'installed',
      installedVersion: '0.1.7-py3.12.10',
    })

    await act(async () => {
      query.resolve({ ok: true, value: installed })
      await query.promise
    })
    expect(screen.getByRole('button', { name: '已安装' })).toBeEnabled()

    act(() => listener?.(componentState('packaged', { revision: 4 })))
    act(() => listener?.(componentState('packaged', { revision: 5 })))

    expect(screen.getByRole('button', { name: '已安装' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '安装' })).not.toBeInTheDocument()
  })

  it('keeps a newer mutation response when a delayed older event arrives afterward', async () => {
    const installResult = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    let listener: ((state: DocumentConversionComponentState) => void) | undefined
    renderSection(apiForState(packagedAbsent, {
      installDocumentConversionComponent: vi.fn(() => installResult.promise),
      onDocumentConversionComponentState: vi.fn((nextListener) => {
        listener = nextListener
        return () => undefined
      }),
    }))

    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    await act(async () => {
      installResult.resolve({
        ok: true,
        value: componentState('packaged', {
          revision: 6,
          status: 'installed',
          installedVersion: '0.1.7-py3.12.10',
        }),
      })
      await installResult.promise
    })
    act(() => listener?.(componentState('packaged', { revision: 5 })))

    expect(screen.getByRole('button', { name: '已安装' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: '安装' })).not.toBeInTheDocument()
  })

  it('cancels only the exact install request owned by this mounted section', async () => {
    const cancelInstall = vi.fn().mockResolvedValue({ ok: true, value: null })
    const pendingInstall = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const install = vi.fn((_requestId: string) => pendingInstall.promise)
    const api = apiForState(packagedAbsent, {
      cancelDocumentConversionComponentInstall: cancelInstall,
      installDocumentConversionComponent: install,
    })

    const idle = renderSection(api)
    await screen.findByRole('button', { name: '安装' })
    idle.unmount()
    expect(cancelInstall).not.toHaveBeenCalled()

    const active = renderSection(api)
    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    const requestId = install.mock.calls.at(-1)?.[0]
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    active.unmount()
    expect(cancelInstall).toHaveBeenCalledOnce()
    expect(cancelInstall).toHaveBeenCalledWith(requestId)
  })

  it('never offers or sends cancellation for an install owned by another renderer', async () => {
    const cancelInstall = vi.fn()
    const view = renderSection(apiForState(componentState('packaged', {
      status: 'installing',
      progress: { phase: 'extracting', receivedBytes: 3, totalBytes: 4 },
      busy: true,
    }), { cancelDocumentConversionComponentInstall: cancelInstall }))

    expect(await screen.findByRole('button', { name: '正在安装' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '取消安装' })).not.toBeInTheDocument()
    view.unmount()
    expect(cancelInstall).not.toHaveBeenCalled()
  })

  it('lets the owner cancel an active install without enabling the conflicting action', async () => {
    const installResult = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const cancelInstall = vi.fn().mockResolvedValue({ ok: true, value: null })
    const install = vi.fn((_requestId: string) => installResult.promise)
    renderSection(apiForState(packagedAbsent, {
      cancelDocumentConversionComponentInstall: cancelInstall,
      installDocumentConversionComponent: install,
    }))

    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    expect(screen.getByRole('button', { name: '正在安装' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '取消安装' }))
    expect(cancelInstall).toHaveBeenCalledWith(install.mock.calls[0]![0])
    expect(screen.getByRole('button', { name: '取消安装' })).toBeDisabled()

    await act(async () => {
      installResult.resolve({ ok: true, value: packagedAbsent })
      await installResult.promise
    })
    expect(screen.getByRole('button', { name: '安装' })).toBeEnabled()
  })

  it('synchronously locks two manual cancellation clicks to one IPC call', async () => {
    const installResult = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const cancelResult = deferred<{ ok: true; value: null }>()
    const cancelInstall = vi.fn(() => cancelResult.promise)
    renderSection(apiForState(packagedAbsent, {
      cancelDocumentConversionComponentInstall: cancelInstall,
      installDocumentConversionComponent: vi.fn(() => installResult.promise),
    }))

    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    const cancel = screen.getByRole('button', { name: '取消安装' })
    act(() => {
      fireEvent.click(cancel)
      fireEvent.click(cancel)
    })

    expect(cancelInstall).toHaveBeenCalledOnce()
    await act(async () => {
      cancelResult.resolve({ ok: true, value: null })
      installResult.resolve({ ok: true, value: componentState('packaged', { revision: 1 }) })
      await Promise.all([cancelResult.promise, installResult.promise])
    })
    expect(cancelInstall).toHaveBeenCalledOnce()
  })

  it('surrenders cancellation ownership before awaiting so unmount cannot cancel twice', async () => {
    const installResult = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const cancelResult = deferred<{ ok: true; value: null }>()
    const cancelInstall = vi.fn(() => cancelResult.promise)
    const view = renderSection(apiForState(packagedAbsent, {
      cancelDocumentConversionComponentInstall: cancelInstall,
      installDocumentConversionComponent: vi.fn(() => installResult.promise),
    }))

    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    fireEvent.click(screen.getByRole('button', { name: '取消安装' }))
    expect(cancelInstall).toHaveBeenCalledOnce()
    view.unmount()
    expect(cancelInstall).toHaveBeenCalledOnce()

    cancelResult.resolve({ ok: true, value: null })
  })

  it('drops a cancellation failure after a newer component event and does not reclaim ownership', async () => {
    const installResult = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const cancelResult = deferred<never>()
    const cancelInstall = vi.fn(() => cancelResult.promise)
    let listener: ((state: DocumentConversionComponentState) => void) | undefined
    const view = renderSection(apiForState(packagedAbsent, {
      cancelDocumentConversionComponentInstall: cancelInstall,
      installDocumentConversionComponent: vi.fn(() => installResult.promise),
      onDocumentConversionComponentState: vi.fn((nextListener) => {
        listener = nextListener
        return () => undefined
      }),
    }))

    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    fireEvent.click(screen.getByRole('button', { name: '取消安装' }))
    act(() => listener?.(componentState('packaged', {
      revision: 4,
      status: 'installed',
      installedVersion: '0.1.7-py3.12.10',
    })))
    await act(async () => {
      cancelResult.reject(new Error('private cancel failure'))
      try { await cancelResult.promise } catch { /* expected transport failure */ }
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消安装' })).not.toBeInTheDocument()
    view.unmount()
    expect(cancelInstall).toHaveBeenCalledOnce()
  })

  it('restores current cancellation ownership after failure and permits one successful retry', async () => {
    const installResult = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const cancelInstall = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'OPERATION_FAILED', message: 'private cancel detail' },
      })
      .mockResolvedValueOnce({ ok: true, value: null })
    renderSection(apiForState(packagedAbsent, {
      cancelDocumentConversionComponentInstall: cancelInstall,
      installDocumentConversionComponent: vi.fn(() => installResult.promise),
    }))

    fireEvent.click(await screen.findByRole('button', { name: '安装' }))
    fireEvent.click(screen.getByRole('button', { name: '取消安装' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('取消失败，请重试。')
    expect(screen.queryByText('private cancel detail')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '取消安装' }))
    await waitFor(() => expect(cancelInstall).toHaveBeenCalledTimes(2))
    await act(async () => {
      installResult.resolve({ ok: true, value: componentState('packaged', { revision: 1 }) })
      await installResult.promise
    })
    expect(cancelInstall).toHaveBeenCalledTimes(2)
  })

  it('disables installed removal and available updates while a runtime lease is busy', async () => {
    const remove = vi.fn()
    const install = vi.fn()
    const installedView = renderSection(apiForState(componentState('packaged', {
      revision: 8,
      status: 'installed',
      installedVersion: '0.1.7-py3.12.10',
      busy: true,
    }), { removeDocumentConversionComponent: remove }))

    const installed = await screen.findByRole('button', { name: '已安装' })
    expect(installed).toBeDisabled()
    fireEvent.click(installed)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()
    installedView.unmount()

    renderSection(apiForState(componentState('packaged', {
      revision: 9,
      status: 'update-available',
      installedVersion: '0.1.6-py3.12.10',
      busy: true,
    }), { installDocumentConversionComponent: install }))
    const update = await screen.findByRole('button', { name: '更新' })
    expect(update).toBeDisabled()
    fireEvent.click(update)
    expect(install).not.toHaveBeenCalled()
  })

  it('confirms deletion, traps focus, supports Escape, restores focus, and removes once', async () => {
    const removeResult = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const remove = vi.fn(() => removeResult.promise)
    renderSection(apiForState(packagedInstalled, { removeDocumentConversionComponent: remove }))

    const installed = await screen.findByRole('button', { name: '已安装' })
    installed.focus()
    fireEvent.click(installed)
    const firstDialog = screen.getByRole('dialog', { name: '是否删除文档转换组件？' })
    expect(within(firstDialog).getByText(/删除后将无法预览转换 PDF、PPTX、XLSX 和 EPUB/))
      .toHaveClass('preferences-confirm-dialog__hint')
    const cancel = within(firstDialog).getByRole('button', { name: '取消' })
    const confirm = within(firstDialog).getByRole('button', { name: '删除' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '是否删除文档转换组件？' }))
      .not.toBeInTheDocument())
    expect(installed).toHaveFocus()
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(installed)
    const deleteButton = within(
      screen.getByRole('dialog', { name: '是否删除文档转换组件？' }),
    ).getByRole('button', { name: '删除' })
    act(() => {
      fireEvent.click(deleteButton)
      fireEvent.click(deleteButton)
    })
    await waitFor(() => expect(remove).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: '正在删除' })).toBeDisabled()

    await act(async () => {
      removeResult.resolve({ ok: true, value: packagedAbsent })
      await removeResult.promise
    })
    expect(screen.getByRole('button', { name: '安装' })).toBeEnabled()
  })

  it('retains installed state after a remove failure and allows removal to be retried', async () => {
    const remove = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'OPERATION_FAILED', message: 'private remove detail' },
      })
      .mockResolvedValueOnce({ ok: true, value: packagedAbsent })
    renderSection(apiForState(packagedInstalled, { removeDocumentConversionComponent: remove }))

    fireEvent.click(await screen.findByRole('button', { name: '已安装' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败，请重试。')
    expect(screen.queryByText('private remove detail')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '已安装' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '已安装' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '安装' })).toBeEnabled())
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('keeps action, cancellation, progress, and the shared helper/status row mounted across loading', async () => {
    const query = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const view = renderSection(apiForState(packagedAbsent, {
      getDocumentConversionComponentState: vi.fn(() => query.promise),
    }))
    const controls = view.container.querySelector('.document-conversion-preferences__controls')
    const actions = controls?.querySelector('.document-conversion-preferences__actions')
    const progressSlot = controls?.querySelector('.document-conversion-preferences__progress-slot')
    const meta = view.container.querySelector('.document-conversion-preferences__meta')

    expect(actions).not.toBeNull()
    expect(progressSlot).not.toBeNull()
    expect(meta).toContainElement(screen.getByRole('status'))
    expect(meta).toContainElement(screen.getByText('源文件保持不变，转换结果需在预览中确认。'))

    await act(async () => {
      query.resolve({ ok: true, value: packagedAbsent })
      await query.promise
    })
    expect(controls?.querySelector('.document-conversion-preferences__actions')).toBe(actions)
    expect(controls?.querySelector('.document-conversion-preferences__progress-slot'))
      .toBe(progressSlot)
    expect(view.container.querySelector('.document-conversion-preferences__meta')).toBe(meta)
    expect(meta).toContainElement(screen.getByRole('status'))
  })

  it('defines native disabled visuals and wrapping status text', async () => {
    const css = await readFile(
      'src/renderer/settings/document-conversion-preferences.css',
      'utf8',
    )

    expect(css).toMatch(
      /\.document-conversion-preferences \.preferences-screenshot-action:disabled\s*\{[^}]*cursor:\s*default;[^}]*opacity:\s*var\(--control-disabled-opacity\);[^}]*\}/s,
    )
    expect(css).toMatch(
      /\.document-conversion-preferences \.preferences-screenshot-action:disabled:(?:hover|active)[^}]*\{[^}]*background:\s*#fff;[^}]*\}/s,
    )
    expect(css).toMatch(
      /\.document-conversion-preferences__cancel:disabled\s*\{[^}]*cursor:\s*default;[^}]*opacity:\s*var\(--control-disabled-opacity\);[^}]*\}/s,
    )
    expect(css).toMatch(
      /\.document-conversion-preferences__status\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*\}/s,
    )
  })

  it('unsubscribes and ignores late query completion after unmount', async () => {
    const query = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const unsubscribe = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const view = renderSection(apiForState(packagedAbsent, {
      getDocumentConversionComponentState: vi.fn(() => query.promise),
      onDocumentConversionComponentState: vi.fn(() => unsubscribe),
    }))
    view.unmount()

    await act(async () => {
      query.resolve({ ok: true, value: packagedInstalled })
      await query.promise
    })
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
