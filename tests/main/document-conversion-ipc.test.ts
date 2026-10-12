import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  registerDocumentConversionIpc,
} from '../../src/main/ipc/register-ipc'
import {
  DOCUMENT_CONVERSION_COMPONENT_STATE_CHANNEL,
  IPC_CHANNELS,
} from '../../src/shared/contracts'
import type {
  ConvertedDocument,
  DocumentConversionComponentState,
} from '../../src/shared/document-conversion'
import type { ResolvedConvertibleDocument } from '../../src/main/workspace/workspace-service'

const firstRequestId = '123e4567-e89b-42d3-a456-426614174000'
const secondRequestId = '123e4567-e89b-42d3-a456-426614174001'
const thirdRequestId = '123e4567-e89b-42d3-a456-426614174002'

const absentState = (): DocumentConversionComponentState => ({
  revision: 0,
  source: 'packaged',
  status: 'absent',
  installedVersion: null,
  availableVersion: '0.1.7-py3.12.10',
  progress: null,
  errorCode: null,
  busy: false,
})

const convertedDocument = (): ConvertedDocument => ({
  source: {
    absolutePath: 'C:\\workspace\\folder\\report.pdf',
    fileName: 'report.pdf',
    format: 'pdf',
    bytes: 42,
    modifiedAtMs: 1_725_000_000_000,
  },
  markdown: '# Converted',
  converterVersion: '0.1.7-py3.12.10',
  fingerprint: 'a'.repeat(64),
  warnings: ['版式可能变化'],
})

const resolvedDocument = (): ResolvedConvertibleDocument => ({
  canonicalPath: 'C:\\workspace\\folder\\report.pdf',
  fileName: 'report.pdf',
  format: 'pdf',
  bytes: 42,
  modifiedAtMs: 1_725_000_000_000,
} as ResolvedConvertibleDocument)

class FakeWebContents extends EventEmitter {
  readonly mainFrame = {}
  readonly send = vi.fn()
  private destroyed = false

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroyForTest(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function ipcMainFixture() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
        if (handlers.has(channel)) throw new Error(`duplicate handler: ${channel}`)
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
  }
}

function dependencies() {
  let stateListener: ((state: DocumentConversionComponentState) => void) | undefined
  const componentManager = {
    getState: vi.fn(() => absentState()),
    install: vi.fn(async () => absentState()),
    cancelInstall: vi.fn(async () => absentState()),
    remove: vi.fn(async () => absentState()),
    subscribe: vi.fn((listener: (state: DocumentConversionComponentState) => void) => {
      stateListener = listener
      return vi.fn()
    }),
  }
  return {
    workspace: {
      resolveExistingConvertibleDocument: vi.fn(
        async (_relativePath: string) => resolvedDocument() as never,
      ),
    },
    componentManager,
    conversions: {
      convertResolved: vi.fn(
        async (_resolved: ResolvedConvertibleDocument, _signal: AbortSignal) => convertedDocument(),
      ),
    },
    emitState: (state: DocumentConversionComponentState) => stateListener?.(state),
  }
}

function eventFor(sender: FakeWebContents) {
  return { sender, senderFrame: sender.mainFrame }
}

describe('document conversion IPC', () => {
  it('returns only parsed caller-owned component state snapshots', async () => {
    const { ipcMain, handlers } = ipcMainFixture()
    const deps = dependencies()
    const state = {
      ...absentState(),
      status: 'installing' as const,
      progress: { phase: 'reading' as const, receivedBytes: 2, totalBytes: 10 },
      busy: true,
    }
    deps.componentManager.getState.mockReturnValue(state)
    const sender = new FakeWebContents(7)
    const registration = registerDocumentConversionIpc({
      ipcMain, window: { webContents: sender }, ...deps,
    })

    const result = await handlers.get(IPC_CHANNELS.getDocumentConversionComponentState)!(
      eventFor(sender),
    )
    expect(result).toEqual({ ok: true, value: state })
    expect((result as { value: unknown }).value).not.toBe(state)
    expect((result as { value: { progress: unknown } }).value.progress).not.toBe(state.progress)

    registration.dispose()
  })

  it('accepts only exact request schemas and never accepts renderer output paths', async () => {
    const { ipcMain, handlers } = ipcMainFixture()
    const deps = dependencies()
    const sender = new FakeWebContents(8)
    const registration = registerDocumentConversionIpc({
      ipcMain, window: { webContents: sender }, ...deps,
    })
    const convert = handlers.get(IPC_CHANNELS.convertWorkspaceDocument)!

    for (const input of [
      { requestId: 'not-a-uuid', relativePath: 'folder/report.pdf' },
      { requestId: firstRequestId, relativePath: 'C:\\private\\report.pdf' },
      { requestId: firstRequestId, relativePath: 'https://example.test/report.pdf' },
      { requestId: firstRequestId, relativePath: 'folder/report.pdf', outputPath: 'C:\\private\\out.md' },
    ]) {
      await expect(convert(eventFor(sender), input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      })
    }
    expect(deps.workspace.resolveExistingConvertibleDocument).not.toHaveBeenCalled()
    expect(deps.conversions.convertResolved).not.toHaveBeenCalled()

    registration.dispose()
  })

  it('resolves a workspace-relative source in main and parses a cloned conversion result', async () => {
    const { ipcMain, handlers } = ipcMainFixture()
    const deps = dependencies()
    const trusted = resolvedDocument()
    const resultValue = convertedDocument()
    deps.workspace.resolveExistingConvertibleDocument.mockResolvedValue(trusted as never)
    deps.conversions.convertResolved.mockResolvedValue(resultValue)
    const sender = new FakeWebContents(9)
    const registration = registerDocumentConversionIpc({
      ipcMain, window: { webContents: sender }, ...deps,
    })

    const result = await handlers.get(IPC_CHANNELS.convertWorkspaceDocument)!(eventFor(sender), {
      requestId: firstRequestId,
      relativePath: 'folder/report.pdf',
    }) as { ok: true; value: ConvertedDocument }

    expect(result).toEqual({ ok: true, value: resultValue })
    expect(deps.workspace.resolveExistingConvertibleDocument).toHaveBeenCalledWith('folder/report.pdf')
    expect(deps.conversions.convertResolved).toHaveBeenCalledWith(
      trusted,
      expect.any(AbortSignal),
    )
    expect(result.value).not.toBe(resultValue)
    expect(result.value.source).not.toBe(resultValue.source)
    expect(result.value.warnings).not.toBe(resultValue.warnings)

    registration.dispose()
  })

  it.each([
    ['a normalized dot-dot alias', {
      ...convertedDocument().source,
      absolutePath: 'C:\\workspace\\folder\\sub\\..\\report.pdf',
    }],
    ['a Windows case alias', {
      ...convertedDocument().source,
      absolutePath: 'c:\\WORKSPACE\\FOLDER\\report.pdf',
    }],
    ['a mismatched file name', {
      ...convertedDocument().source,
      fileName: 'REPORT.PDF',
    }],
    ['a mismatched format', {
      ...convertedDocument().source,
      format: 'pptx' as const,
    }],
    ['a mismatched byte count', {
      ...convertedDocument().source,
      bytes: 41,
    }],
    ['a mismatched modification time', {
      ...convertedDocument().source,
      modifiedAtMs: 1_725_000_000_001,
    }],
  ])('rejects converted source metadata with %s', async (_label, forgedSource) => {
    const { ipcMain, handlers } = ipcMainFixture()
    const deps = dependencies()
    deps.conversions.convertResolved.mockResolvedValue({
      ...convertedDocument(),
      source: forgedSource,
    })
    const sender = new FakeWebContents(10)
    const registration = registerDocumentConversionIpc({
      ipcMain, window: { webContents: sender }, ...deps,
    })

    await expect(handlers.get(IPC_CHANNELS.convertWorkspaceDocument)!(eventFor(sender), {
      requestId: firstRequestId,
      relativePath: 'folder/report.pdf',
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_RESPONSE' } })

    registration.dispose()
  })

  it('binds install and conversion cancellation to sender.id plus requestId', async () => {
    const { ipcMain, handlers } = ipcMainFixture()
    const deps = dependencies()
    let releaseInstall!: () => void
    deps.componentManager.install.mockImplementation(() => new Promise((resolve) => {
      releaseInstall = () => resolve(absentState())
    }))
    const first = new FakeWebContents(11)
    const second = new FakeWebContents(12)
    const firstRegistration = registerDocumentConversionIpc({
      ipcMain, window: { webContents: first }, ...deps,
    })
    const secondRegistration = registerDocumentConversionIpc({
      ipcMain, window: { webContents: second }, ...deps,
    })
    const install = handlers.get(IPC_CHANNELS.installDocumentConversionComponent)!
    const cancel = handlers.get(IPC_CHANNELS.cancelDocumentConversionComponentInstall)!
    const pending = install(eventFor(first), { requestId: firstRequestId })
    await vi.waitFor(() => expect(deps.componentManager.install).toHaveBeenCalledOnce())

    await expect(cancel(eventFor(second), { requestId: firstRequestId })).resolves.toMatchObject({
      ok: false, error: { code: 'INVALID_INPUT' },
    })
    expect(deps.componentManager.cancelInstall).not.toHaveBeenCalled()
    await expect(cancel(eventFor(first), { requestId: firstRequestId })).resolves.toEqual({
      ok: true, value: null,
    })
    expect(deps.componentManager.cancelInstall).toHaveBeenCalledWith(`11:${firstRequestId}`)
    releaseInstall()
    await pending

    await expect(handlers.get(IPC_CHANNELS.cancelWorkspaceDocumentConversion)!(eventFor(first), {
      requestId: secondRequestId,
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

    firstRegistration.dispose()
    secondRegistration.dispose()
  })

  it('cancels only a destroyed webContents owner and releases its lifecycle listener', async () => {
    const { ipcMain, handlers } = ipcMainFixture()
    const deps = dependencies()
    const signals = new Map<string, AbortSignal>()
    deps.conversions.convertResolved.mockImplementation((resolved, signal) => {
      signals.set(resolved.canonicalPath, signal)
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    deps.workspace.resolveExistingConvertibleDocument.mockImplementation(async (relativePath) => {
      const canonicalPath = `C:\\workspace\\${relativePath.replaceAll('/', '\\')}`
      const fileName = canonicalPath.split('\\').at(-1)!
      return {
        canonicalPath,
        fileName,
        format: 'pdf',
        bytes: 42,
        modifiedAtMs: 1_725_000_000_000,
      } as never
    })
    let releaseInstall!: () => void
    deps.componentManager.install.mockImplementation(() => new Promise((resolve) => {
      releaseInstall = () => resolve(absentState())
    }))
    const first = new FakeWebContents(13)
    const second = new FakeWebContents(14)
    const firstRegistration = registerDocumentConversionIpc({
      ipcMain, window: { webContents: first }, ...deps,
    })
    const secondRegistration = registerDocumentConversionIpc({
      ipcMain, window: { webContents: second }, ...deps,
    })
    const convert = handlers.get(IPC_CHANNELS.convertWorkspaceDocument)!
    const installPending = handlers.get(IPC_CHANNELS.installDocumentConversionComponent)!(
      eventFor(first),
      { requestId: thirdRequestId },
    )
    const firstPending = convert(eventFor(first), {
      requestId: firstRequestId, relativePath: 'first.pdf',
    })
    const secondPending = convert(eventFor(second), {
      requestId: secondRequestId, relativePath: 'second.pdf',
    })
    await vi.waitFor(() => expect(signals.size).toBe(2))

    first.destroyForTest()
    await vi.waitFor(() => expect(signals.get('C:\\workspace\\first.pdf')?.aborted).toBe(true))
    expect(deps.componentManager.cancelInstall).toHaveBeenCalledWith(`13:${thirdRequestId}`)
    expect(signals.get('C:\\workspace\\second.pdf')?.aborted).toBe(false)
    expect(first.listenerCount('destroyed')).toBe(0)

    releaseInstall()
    await installPending
    await firstPending
    secondRegistration.dispose()
    await secondPending
    firstRegistration.dispose()
  })

  it('broadcasts only parsed cloned component states to registered renderers', () => {
    const { ipcMain } = ipcMainFixture()
    const deps = dependencies()
    const first = new FakeWebContents(15)
    const second = new FakeWebContents(16)
    const firstRegistration = registerDocumentConversionIpc({
      ipcMain, window: { webContents: first }, ...deps,
    })
    const secondRegistration = registerDocumentConversionIpc({
      ipcMain, window: { webContents: second }, ...deps,
    })
    const state = absentState()

    deps.emitState({ ...state, extra: true } as DocumentConversionComponentState)
    expect(first.send).not.toHaveBeenCalled()
    expect(second.send).not.toHaveBeenCalled()
    deps.emitState(state)

    for (const sender of [first, second]) {
      expect(sender.send).toHaveBeenCalledWith(
        DOCUMENT_CONVERSION_COMPONENT_STATE_CHANNEL,
        expect.objectContaining({ status: 'absent' }),
      )
      expect(sender.send.mock.calls[0]![1]).not.toBe(state)
    }

    firstRegistration.dispose()
    secondRegistration.dispose()
  })
})
