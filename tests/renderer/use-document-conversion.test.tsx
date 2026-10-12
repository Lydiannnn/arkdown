import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocumentConversion } from '../../src/renderer/document-conversion/use-document-conversion'
import type { ArkdownApi } from '../../src/shared/contracts'
import type {
  ConvertedDocument,
  DocumentConversionComponentSource,
  DocumentConversionComponentState,
} from '../../src/shared/document-conversion'

function componentState(
  source: DocumentConversionComponentSource,
  overrides: Partial<DocumentConversionComponentState> = {},
): DocumentConversionComponentState {
  return {
    revision: 1,
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

const absent = componentState('packaged')
const installed = componentState('packaged', {
  status: 'installed',
  installedVersion: '0.1.7-py3.12.10',
})

function converted(fileName = 'report.pdf', markdown = '# Report'): ConvertedDocument {
  return {
    source: {
      absolutePath: `C:\\workspace\\${fileName}`,
      fileName,
      format: fileName.split('.').at(-1) as ConvertedDocument['source']['format'],
      bytes: 128,
      modifiedAtMs: 1_800_000_000_000,
    },
    markdown,
    converterVersion: '0.1.7-py3.12.10',
    fingerprint: 'a'.repeat(64),
    warnings: [],
  }
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

function api(overrides: Partial<ArkdownApi> = {}): ArkdownApi {
  return {
    getDocumentConversionComponentState: vi.fn().mockResolvedValue({ ok: true, value: installed }),
    installDocumentConversionComponent: vi.fn().mockResolvedValue({ ok: true, value: installed }),
    cancelDocumentConversionComponentInstall: vi.fn().mockResolvedValue({ ok: true, value: null }),
    convertWorkspaceDocument: vi.fn().mockResolvedValue({ ok: true, value: converted() }),
    cancelWorkspaceDocumentConversion: vi.fn().mockResolvedValue({ ok: true, value: null }),
    onDocumentConversionComponentState: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as ArkdownApi
}

function expectUuid(value: unknown) {
  expect(value).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  )
}

beforeEach(() => {
  window.arkdown = {} as ArkdownApi
})

describe('useDocumentConversion', () => {
  it('validates a convertible relative path before calling optional APIs', async () => {
    const getState = vi.fn()
    const convertDocument = vi.fn()
    window.arkdown = api({
      getDocumentConversionComponentState: getState,
      convertWorkspaceDocument: convertDocument,
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('../private.pdf'))

    expect(result.current.state.status).toBe('failed')
    expect(getState).not.toHaveBeenCalled()
    expect(convertDocument).not.toHaveBeenCalled()
    expect(result.current.state).toMatchObject({
      status: 'failed',
      message: '无法转换此文档，请重新选择。',
    })
  })

  it('prompts for a missing packaged or future HTTPS component without installing silently', async () => {
    for (const source of ['packaged', 'https'] as const) {
      const install = vi.fn()
      window.arkdown = api({
        getDocumentConversionComponentState: vi.fn().mockResolvedValue({
          ok: true,
          value: componentState(source),
        }),
        installDocumentConversionComponent: install,
      })
      const { result, unmount } = renderHook(() => useDocumentConversion())

      act(() => result.current.begin('docs/report.pdf'))
      await waitFor(() => expect(result.current.state.status).toBe('install-required'))

      expect(result.current.state).toMatchObject({
        status: 'install-required',
        source,
        actionLabel: source === 'https' ? '下载' : '安装',
        message: '转换此文档需要安装文档转换组件。',
      })
      expect(install).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('installs with its own UUID and automatically resumes the original conversion exactly once', async () => {
    const installComponent = vi.fn().mockResolvedValue({
      ok: true,
      value: componentState('packaged', {
        revision: 3,
        status: 'installed',
        installedVersion: '0.1.7-py3.12.10',
      }),
    })
    const convertDocument = vi.fn().mockResolvedValue({ ok: true, value: converted() })
    window.arkdown = api({
      getDocumentConversionComponentState: vi.fn().mockResolvedValue({ ok: true, value: absent }),
      installDocumentConversionComponent: installComponent,
      convertWorkspaceDocument: convertDocument,
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('docs/report.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => {
      result.current.install()
      result.current.install()
    })

    await waitFor(() => expect(result.current.state.status).toBe('preview'))
    expect(installComponent).toHaveBeenCalledOnce()
    expect(convertDocument).toHaveBeenCalledOnce()
    const installId = installComponent.mock.calls[0]![0]
    const [relativePath, conversionId] = convertDocument.mock.calls[0]!
    expectUuid(installId)
    expectUuid(conversionId)
    expect(conversionId).not.toBe(installId)
    expect(relativePath).toBe('docs/report.pdf')
  })

  it.each([
    ['DOCUMENT_CONVERSION_PACKAGE_MISSING', '当前安装包缺少文档转换组件。'],
    ['DOCUMENT_CONVERSION_COMPONENT_INVALID', '文档转换组件校验失败，请重新安装。'],
  ] as const)('preserves the authoritative %s install failure and retries installation', async (
    errorCode,
    message,
  ) => {
    const failed = componentState('packaged', {
      revision: 3,
      status: 'failed',
      errorCode,
    })
    const installComponent = vi.fn().mockResolvedValue({ ok: true, value: failed })
    const convertDocument = vi.fn()
    window.arkdown = api({
      getDocumentConversionComponentState: vi.fn().mockResolvedValue({ ok: true, value: absent }),
      installDocumentConversionComponent: installComponent,
      convertWorkspaceDocument: convertDocument,
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('docs/report.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())

    await waitFor(() => expect(result.current.state.status).toBe('failed'))
    expect(result.current.state).toMatchObject({
      status: 'failed',
      message,
      retryKind: 'install',
    })
    expect(convertDocument).not.toHaveBeenCalled()

    act(() => result.current.retry())
    await waitFor(() => expect(installComponent).toHaveBeenCalledTimes(2))
    expect(convertDocument).not.toHaveBeenCalled()
  })

  it('does not let an older install failure overwrite a newer authoritative installed event', async () => {
    const installResult = deferred<{
      ok: false
      error: { code: 'OPERATION_FAILED'; message: string }
    }>()
    let listener: ((state: DocumentConversionComponentState) => void) | undefined
    const convertDocument = vi.fn().mockResolvedValue({ ok: true, value: converted() })
    window.arkdown = api({
      getDocumentConversionComponentState: vi.fn().mockResolvedValue({ ok: true, value: absent }),
      installDocumentConversionComponent: vi.fn((_requestId: string) => installResult.promise),
      convertWorkspaceDocument: convertDocument,
      onDocumentConversionComponentState: vi.fn((next) => {
        listener = next
        return () => undefined
      }),
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('report.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    act(() => listener?.(componentState('packaged', {
      revision: 4,
      status: 'installed',
      installedVersion: '0.1.7-py3.12.10',
    })))
    await act(async () => {
      installResult.resolve({
        ok: false,
        error: { code: 'OPERATION_FAILED', message: 'older transport failure' },
      })
      await installResult.promise
    })

    await waitFor(() => expect(result.current.state.status).toBe('preview'))
    expect(convertDocument).toHaveBeenCalledOnce()
    expect(result.current.state).not.toMatchObject({ status: 'failed' })
  })

  it('cancels an owned install quietly and never cancels it twice during unmount', async () => {
    const pendingInstall = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const installComponent = vi.fn((_requestId: string) => pendingInstall.promise)
    const cancelInstall = vi.fn().mockRejectedValue(new Error('private cancel failure'))
    window.arkdown = api({
      getDocumentConversionComponentState: vi.fn().mockResolvedValue({ ok: true, value: absent }),
      installDocumentConversionComponent: installComponent,
      cancelDocumentConversionComponentInstall: cancelInstall,
    })
    const { result, unmount } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('report.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    await waitFor(() => expect(result.current.state.status).toBe('installing'))
    const requestId = installComponent.mock.calls[0]![0]
    act(() => result.current.cancel())

    expect(result.current.state).toEqual({ status: 'idle' })
    expect(cancelInstall).toHaveBeenCalledOnce()
    expect(cancelInstall).toHaveBeenCalledWith(requestId)
    expect(result.current.state).not.toHaveProperty('message')
    unmount()
    expect(cancelInstall).toHaveBeenCalledOnce()

    pendingInstall.resolve({ ok: true, value: installed })
  })

  it('waits for a superseded install cancellation before querying and continuing the new owner', async () => {
    const pendingInstall = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const pendingCancel = deferred<{ ok: true; value: null }>()
    const getState = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: absent })
      .mockResolvedValueOnce({ ok: true, value: componentState('packaged', {
        revision: 2,
        status: 'installed',
        installedVersion: '0.1.7-py3.12.10',
      }) })
    const installComponent = vi.fn((_requestId: string) => pendingInstall.promise)
    const cancelInstall = vi.fn(() => pendingCancel.promise)
    const convertDocument = vi.fn().mockResolvedValue({
      ok: true,
      value: converted('second.pptx', '# Second'),
    })
    window.arkdown = api({
      getDocumentConversionComponentState: getState,
      installDocumentConversionComponent: installComponent,
      cancelDocumentConversionComponentInstall: cancelInstall,
      convertWorkspaceDocument: convertDocument,
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('first.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    await waitFor(() => expect(result.current.state.status).toBe('installing'))
    const installRequestId = installComponent.mock.calls[0]![0]

    act(() => result.current.begin('second.pptx'))

    expect(cancelInstall).toHaveBeenCalledOnce()
    expect(cancelInstall).toHaveBeenCalledWith(installRequestId)
    expect(getState).toHaveBeenCalledOnce()
    expect(convertDocument).not.toHaveBeenCalled()

    await act(async () => {
      pendingCancel.resolve({ ok: true, value: null })
      await pendingCancel.promise
    })

    await waitFor(() => expect(result.current.state.status).toBe('preview'))
    expect(getState).toHaveBeenCalledTimes(2)
    expect(convertDocument).toHaveBeenCalledOnce()
    expect(convertDocument).toHaveBeenCalledWith('second.pptx', expect.any(String))
    pendingInstall.resolve({ ok: true, value: installed })
  })

  it('continues the replacement quietly after the superseded install cancellation rejects', async () => {
    const pendingInstall = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const pendingCancel = deferred<{ ok: true; value: null }>()
    const getState = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: absent })
      .mockResolvedValueOnce({ ok: true, value: installed })
    const cancelInstall = vi.fn(() => pendingCancel.promise)
    const convertDocument = vi.fn().mockResolvedValue({
      ok: true,
      value: converted('second.pptx', '# Second'),
    })
    window.arkdown = api({
      getDocumentConversionComponentState: getState,
      installDocumentConversionComponent: vi.fn(() => pendingInstall.promise),
      cancelDocumentConversionComponentInstall: cancelInstall,
      convertWorkspaceDocument: convertDocument,
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('first.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    await waitFor(() => expect(result.current.state.status).toBe('installing'))
    act(() => result.current.begin('second.pptx'))
    expect(getState).toHaveBeenCalledOnce()

    await act(async () => {
      pendingCancel.reject(new Error('private cancel failure'))
      try {
        await pendingCancel.promise
      } catch {
        // The controller must absorb cancellation transport failures.
      }
    })

    await waitFor(() => expect(result.current.state.status).toBe('preview'))
    expect(result.current.state).toMatchObject({
      status: 'preview',
      relativePath: 'second.pptx',
    })
    expect(cancelInstall).toHaveBeenCalledOnce()
    expect(convertDocument).toHaveBeenCalledOnce()
    pendingInstall.resolve({ ok: true, value: installed })
  })

  it('lets only the latest replacement continue after a shared install cancellation barrier', async () => {
    const pendingInstall = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const pendingCancel = deferred<{ ok: true; value: null }>()
    const getState = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: absent })
      .mockResolvedValue({ ok: true, value: installed })
    const cancelInstall = vi.fn(() => pendingCancel.promise)
    const convertDocument = vi.fn((_relativePath: string) => Promise.resolve({
      ok: true as const,
      value: converted('third.xlsx', '# Third'),
    }))
    window.arkdown = api({
      getDocumentConversionComponentState: getState,
      installDocumentConversionComponent: vi.fn(() => pendingInstall.promise),
      cancelDocumentConversionComponentInstall: cancelInstall,
      convertWorkspaceDocument: convertDocument,
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('first.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    await waitFor(() => expect(result.current.state.status).toBe('installing'))
    act(() => {
      result.current.begin('second.pptx')
      result.current.begin('third.xlsx')
    })

    expect(cancelInstall).toHaveBeenCalledOnce()
    expect(getState).toHaveBeenCalledOnce()
    expect(convertDocument).not.toHaveBeenCalled()

    await act(async () => {
      pendingCancel.resolve({ ok: true, value: null })
      await pendingCancel.promise
    })

    await waitFor(() => expect(result.current.state.status).toBe('preview'))
    expect(getState).toHaveBeenCalledTimes(2)
    expect(convertDocument).toHaveBeenCalledOnce()
    expect(convertDocument).toHaveBeenCalledWith('third.xlsx', expect.any(String))
    expect(result.current.state).toMatchObject({ status: 'preview', relativePath: 'third.xlsx' })
    pendingInstall.resolve({ ok: true, value: installed })
  })

  it('does not continue a replacement after unmount while install cancellation is pending', async () => {
    const pendingInstall = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const pendingCancel = deferred<{ ok: true; value: null }>()
    const getState = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: absent })
      .mockResolvedValueOnce({ ok: true, value: installed })
    const cancelInstall = vi.fn(() => pendingCancel.promise)
    const convertDocument = vi.fn()
    const unsubscribe = vi.fn()
    window.arkdown = api({
      getDocumentConversionComponentState: getState,
      installDocumentConversionComponent: vi.fn(() => pendingInstall.promise),
      cancelDocumentConversionComponentInstall: cancelInstall,
      convertWorkspaceDocument: convertDocument,
      onDocumentConversionComponentState: vi.fn(() => unsubscribe),
    })
    const { result, unmount } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('first.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    await waitFor(() => expect(result.current.state.status).toBe('installing'))
    act(() => result.current.begin('second.pptx'))
    unmount()

    expect(cancelInstall).toHaveBeenCalledOnce()
    expect(getState).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()

    await act(async () => {
      pendingCancel.resolve({ ok: true, value: null })
      await pendingCancel.promise
    })

    expect(getState).toHaveBeenCalledOnce()
    expect(convertDocument).not.toHaveBeenCalled()
    expect(cancelInstall).toHaveBeenCalledOnce()
    pendingInstall.resolve({ ok: true, value: installed })
  })

  it('bounds an unresponsive install cancellation and publishes the replacement before a busy retry failure', async () => {
    const pendingInstall = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const neverSettlingCancel = deferred<{ ok: true; value: null }>()
    const getState = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: absent })
      .mockResolvedValueOnce({ ok: true, value: componentState('packaged', {
        revision: 2,
        status: 'installing',
        progress: null,
        busy: true,
      }) })
    const cancelInstall = vi.fn(() => neverSettlingCancel.promise)
    const convertDocument = vi.fn()
    window.arkdown = api({
      getDocumentConversionComponentState: getState,
      installDocumentConversionComponent: vi.fn(() => pendingInstall.promise),
      cancelDocumentConversionComponentInstall: cancelInstall,
      convertWorkspaceDocument: convertDocument,
    })
    const { result, unmount } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('first.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    await waitFor(() => expect(result.current.state.status).toBe('installing'))

    vi.useFakeTimers()
    try {
      act(() => result.current.begin('second.pptx'))

      expect(result.current.state).toMatchObject({
        status: 'converting',
        relativePath: 'second.pptx',
        fileName: 'second.pptx',
      })
      expect(cancelInstall).toHaveBeenCalledOnce()
      expect(getState).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(999)
      })
      expect(getState).toHaveBeenCalledOnce()
      expect(result.current.state).toMatchObject({
        status: 'converting',
        relativePath: 'second.pptx',
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(getState).toHaveBeenCalledTimes(2)
      expect(result.current.state).toMatchObject({
        status: 'failed',
        relativePath: 'second.pptx',
        retryKind: 'query',
        message: '文档转换组件正在由其他界面安装，请稍后重试。',
      })
      expect(convertDocument).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      unmount()
      vi.clearAllTimers()
      vi.useRealTimers()
      pendingInstall.resolve({ ok: true, value: installed })
      await pendingInstall.promise
    }
  })

  it('continues the replacement conversion when the bounded authoritative query is installed', async () => {
    const pendingInstall = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const neverSettlingCancel = deferred<{ ok: true; value: null }>()
    const getState = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: absent })
      .mockResolvedValueOnce({ ok: true, value: componentState('packaged', {
        revision: 2,
        status: 'installed',
        installedVersion: '0.1.7-py3.12.10',
      }) })
    const convertDocument = vi.fn().mockResolvedValue({
      ok: true,
      value: converted('second.pptx', '# Second'),
    })
    window.arkdown = api({
      getDocumentConversionComponentState: getState,
      installDocumentConversionComponent: vi.fn(() => pendingInstall.promise),
      cancelDocumentConversionComponentInstall: vi.fn(() => neverSettlingCancel.promise),
      convertWorkspaceDocument: convertDocument,
    })
    const { result, unmount } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('first.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    await waitFor(() => expect(result.current.state.status).toBe('installing'))

    vi.useFakeTimers()
    try {
      act(() => result.current.begin('second.pptx'))
      expect(result.current.state).toMatchObject({
        status: 'converting',
        relativePath: 'second.pptx',
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(getState).toHaveBeenCalledTimes(2)
      expect(convertDocument).toHaveBeenCalledOnce()
      expect(convertDocument).toHaveBeenCalledWith('second.pptx', expect.any(String))
      expect(result.current.state).toMatchObject({
        status: 'preview',
        relativePath: 'second.pptx',
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      unmount()
      vi.clearAllTimers()
      vi.useRealTimers()
      pendingInstall.resolve({ ok: true, value: installed })
      await pendingInstall.promise
    }
  })

  it('replaces a superseded handoff timer so only C continues after the bounded wait', async () => {
    const pendingInstall = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const neverSettlingCancel = deferred<{ ok: true; value: null }>()
    const getState = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: absent })
      .mockResolvedValueOnce({ ok: true, value: installed })
    const convertDocument = vi.fn().mockResolvedValue({
      ok: true,
      value: converted('third.xlsx', '# Third'),
    })
    window.arkdown = api({
      getDocumentConversionComponentState: getState,
      installDocumentConversionComponent: vi.fn(() => pendingInstall.promise),
      cancelDocumentConversionComponentInstall: vi.fn(() => neverSettlingCancel.promise),
      convertWorkspaceDocument: convertDocument,
    })
    const { result, unmount } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('first.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    await waitFor(() => expect(result.current.state.status).toBe('installing'))

    vi.useFakeTimers()
    try {
      act(() => result.current.begin('second.pptx'))
      expect(vi.getTimerCount()).toBe(1)
      act(() => result.current.begin('third.xlsx'))

      expect(result.current.state).toMatchObject({
        status: 'converting',
        relativePath: 'third.xlsx',
        fileName: 'third.xlsx',
      })
      expect(vi.getTimerCount()).toBe(1)
      expect(getState).toHaveBeenCalledOnce()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })

      expect(getState).toHaveBeenCalledTimes(2)
      expect(convertDocument).toHaveBeenCalledOnce()
      expect(convertDocument).toHaveBeenCalledWith('third.xlsx', expect.any(String))
      expect(result.current.state).toMatchObject({ status: 'preview', relativePath: 'third.xlsx' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      unmount()
      vi.clearAllTimers()
      vi.useRealTimers()
      pendingInstall.resolve({ ok: true, value: installed })
      await pendingInstall.promise
    }
  })

  it('clears a pending handoff timer on unmount without a later query or conversion', async () => {
    const pendingInstall = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const neverSettlingCancel = deferred<{ ok: true; value: null }>()
    const getState = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: absent })
      .mockResolvedValueOnce({ ok: true, value: installed })
    const convertDocument = vi.fn()
    window.arkdown = api({
      getDocumentConversionComponentState: getState,
      installDocumentConversionComponent: vi.fn(() => pendingInstall.promise),
      cancelDocumentConversionComponentInstall: vi.fn(() => neverSettlingCancel.promise),
      convertWorkspaceDocument: convertDocument,
    })
    const { result, unmount } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('first.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    await waitFor(() => expect(result.current.state.status).toBe('installing'))

    vi.useFakeTimers()
    try {
      act(() => result.current.begin('second.pptx'))
      expect(vi.getTimerCount()).toBe(1)
      unmount()
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(2_000)

      expect(getState).toHaveBeenCalledOnce()
      expect(convertDocument).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
      pendingInstall.resolve({ ok: true, value: installed })
      await pendingInstall.promise
    }
  })

  it('cancels an owned conversion quietly and ignores its result after cancellation', async () => {
    const pendingConversion = deferred<{ ok: true; value: ConvertedDocument }>()
    const convertDocument = vi.fn((_relativePath: string, _requestId: string) => pendingConversion.promise)
    const cancelConversion = vi.fn().mockResolvedValue({ ok: true, value: null })
    window.arkdown = api({
      convertWorkspaceDocument: convertDocument,
      cancelWorkspaceDocumentConversion: cancelConversion,
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('report.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('converting'))
    const requestId = convertDocument.mock.calls[0]![1]
    act(() => result.current.cancel())
    expect(result.current.state).toEqual({ status: 'idle' })
    expect(cancelConversion).toHaveBeenCalledWith(requestId)

    await act(async () => {
      pendingConversion.resolve({ ok: true, value: converted() })
      await pendingConversion.promise
    })
    expect(result.current.state).toEqual({ status: 'idle' })
  })

  it('keeps generation tokens and request ownership out of the public state union', async () => {
    const pendingConversion = deferred<{ ok: true; value: ConvertedDocument }>()
    window.arkdown = api({
      convertWorkspaceDocument: vi.fn(
        (_relativePath: string, _requestId: string) => pendingConversion.promise,
      ),
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('report.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('converting'))

    expect(Reflect.ownKeys(result.current.state).sort()).toEqual([
      'fileName', 'format', 'relativePath', 'status',
    ])
    expect(result.current.state).not.toHaveProperty('generation')
    expect(result.current.state).not.toHaveProperty('token')
    expect(result.current.state).not.toHaveProperty('conversionRequestId')
    pendingConversion.resolve({ ok: true, value: converted() })
  })

  it('supersedes the first file, cancels only its owner, and ignores its late result', async () => {
    const first = deferred<{ ok: true; value: ConvertedDocument }>()
    const secondDocument = converted('second.pptx', '# Second')
    const convertDocument = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ ok: true, value: secondDocument })
    const cancelConversion = vi.fn().mockResolvedValue({ ok: true, value: null })
    window.arkdown = api({
      convertWorkspaceDocument: convertDocument,
      cancelWorkspaceDocumentConversion: cancelConversion,
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('first.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('converting'))
    const firstId = convertDocument.mock.calls[0]![1]
    act(() => result.current.begin('second.pptx'))
    await waitFor(() => expect(result.current.state.status).toBe('preview'))

    expect(cancelConversion).toHaveBeenCalledOnce()
    expect(cancelConversion).toHaveBeenCalledWith(firstId)
    expect(convertDocument.mock.calls[1]![1]).not.toBe(firstId)
    expect(result.current.accept()?.source.fileName).toBe('second.pptx')

    await act(async () => {
      first.resolve({ ok: true, value: converted('first.pdf', '# First') })
      await first.promise
    })
    expect(result.current.accept()?.source.fileName).toBe('second.pptx')
  })

  it('retries a public conversion failure with a fresh UUID and hides raw error details', async () => {
    const convertDocument = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'DOCUMENT_CONVERSION_FAILED', message: 'C:\\secret\\python traceback' },
      })
      .mockResolvedValueOnce({ ok: true, value: converted() })
    window.arkdown = api({ convertWorkspaceDocument: convertDocument })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('report.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('failed'))
    expect(result.current.state).toMatchObject({
      status: 'failed',
      message: '文档转换未能完成，请重试。',
    })
    expect(JSON.stringify(result.current.state)).not.toContain('secret')
    const firstId = convertDocument.mock.calls[0]![1]

    act(() => {
      result.current.retry()
      result.current.retry()
    })
    await waitFor(() => expect(result.current.state.status).toBe('preview'))
    expect(convertDocument).toHaveBeenCalledTimes(2)
    expect(convertDocument.mock.calls[1]![1]).not.toBe(firstId)
  })

  it('keeps authoritative revision ordering and ignores component events after owner change', async () => {
    const installResult = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const secondConversion = deferred<{ ok: true; value: ConvertedDocument }>()
    let listener: ((state: DocumentConversionComponentState) => void) | undefined
    const getState = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: absent })
      .mockResolvedValueOnce({ ok: true, value: componentState('packaged', {
        revision: 8,
        status: 'installed',
        installedVersion: '0.1.7-py3.12.10',
      }) })
    const convertDocument = vi.fn(() => secondConversion.promise)
    window.arkdown = api({
      getDocumentConversionComponentState: getState,
      installDocumentConversionComponent: vi.fn(() => installResult.promise),
      convertWorkspaceDocument: convertDocument,
      onDocumentConversionComponentState: vi.fn((next) => {
        listener = next
        return () => undefined
      }),
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('first.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    act(() => listener?.(componentState('packaged', {
      revision: 7,
      status: 'installing',
      progress: { phase: 'extracting', receivedBytes: 3, totalBytes: 4 },
      busy: true,
    })))
    expect(result.current.state).toMatchObject({ status: 'installing', progressPercent: 75 })

    act(() => result.current.begin('second.pptx'))
    await waitFor(() => expect(result.current.state.status).toBe('converting'))
    act(() => listener?.(componentState('packaged', {
      revision: 99,
      status: 'failed',
      errorCode: 'DOCUMENT_CONVERSION_INSTALL_FAILED',
    })))
    expect(result.current.state).toMatchObject({ status: 'converting', relativePath: 'second.pptx' })

    await act(async () => {
      installResult.resolve({ ok: true, value: componentState('packaged', {
        revision: 6,
        status: 'installed',
        installedVersion: '0.1.7-py3.12.10',
      }) })
      secondConversion.resolve({ ok: true, value: converted('second.pptx') })
      await Promise.all([installResult.promise, secondConversion.promise])
    })
    expect(result.current.state).toMatchObject({ status: 'preview' })
    expect(convertDocument).toHaveBeenCalledOnce()
  })

  it('continues from the newer authoritative component state instead of publishing a stale query failure', async () => {
    const installResult = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    const staleSecondQuery = deferred<{ ok: true; value: DocumentConversionComponentState }>()
    let listener: ((state: DocumentConversionComponentState) => void) | undefined
    const getState = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: absent })
      .mockReturnValueOnce(staleSecondQuery.promise)
    const convertDocument = vi.fn().mockResolvedValue({
      ok: true,
      value: converted('second.pptx'),
    })
    window.arkdown = api({
      getDocumentConversionComponentState: getState,
      installDocumentConversionComponent: vi.fn((_requestId: string) => installResult.promise),
      convertWorkspaceDocument: convertDocument,
      onDocumentConversionComponentState: vi.fn((next) => {
        listener = next
        return () => undefined
      }),
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('first.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('install-required'))
    act(() => result.current.install())
    act(() => listener?.(componentState('packaged', {
      revision: 9,
      status: 'installed',
      installedVersion: '0.1.7-py3.12.10',
    })))
    act(() => result.current.begin('second.pptx'))

    await act(async () => {
      staleSecondQuery.resolve({ ok: true, value: componentState('packaged', {
        revision: 8,
        status: 'absent',
      }) })
      await staleSecondQuery.promise
    })

    await waitFor(() => expect(result.current.state.status).toBe('preview'))
    expect(convertDocument).toHaveBeenCalledOnce()
    expect(convertDocument).toHaveBeenCalledWith('second.pptx', expect.any(String))
    expect(result.current.state).not.toMatchObject({
      status: 'failed',
      message: expect.stringContaining('状态已更新'),
    })
    installResult.resolve({ ok: true, value: installed })
  })

  it('unsubscribes and cancels only current owned work on unmount', async () => {
    const pending = deferred<{ ok: true; value: ConvertedDocument }>()
    const cancelConversion = vi.fn().mockResolvedValue({ ok: true, value: null })
    const unsubscribe = vi.fn()
    const convertDocument = vi.fn((_relativePath: string, _requestId: string) => pending.promise)
    window.arkdown = api({
      convertWorkspaceDocument: convertDocument,
      cancelWorkspaceDocumentConversion: cancelConversion,
      onDocumentConversionComponentState: vi.fn(() => unsubscribe),
    })
    const { result, unmount } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('report.pdf'))
    await waitFor(() => expect(convertDocument).toHaveBeenCalledOnce())
    const requestId = convertDocument.mock.calls[0]![1]
    unmount()

    expect(cancelConversion).toHaveBeenCalledOnce()
    expect(cancelConversion).toHaveBeenCalledWith(requestId)
    expect(unsubscribe).toHaveBeenCalledOnce()
    pending.resolve({ ok: true, value: converted() })
  })

  it('returns one deeply immutable preview snapshot without changing the preview state', async () => {
    const mutable = converted()
    mutable.warnings = ['layout']
    window.arkdown = api({
      convertWorkspaceDocument: vi.fn().mockResolvedValue({ ok: true, value: mutable }),
    })
    const { result } = renderHook(() => useDocumentConversion())

    act(() => result.current.begin('report.pdf'))
    await waitFor(() => expect(result.current.state.status).toBe('preview'))
    const accepted = result.current.accept()!

    expect(Object.isFrozen(accepted)).toBe(true)
    expect(Object.isFrozen(accepted.source)).toBe(true)
    expect(Object.isFrozen(accepted.warnings)).toBe(true)
    expect(result.current.accept()).toBe(accepted)
    expect(result.current.state.status).toBe('preview')
  })
})
