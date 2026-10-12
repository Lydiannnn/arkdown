import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import {
  DOCUMENT_CONVERSION_COMPONENT_STATE_CHANNEL,
  IPC_CHANNELS,
} from '../../src/shared/contracts'
import type {
  ConvertedDocument,
  DocumentConversionComponentState,
} from '../../src/shared/document-conversion'

const requestId = '123e4567-e89b-42d3-a456-426614174000'

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn().mockResolvedValue({ ok: true, value: null }),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    send: electronMocks.send,
  },
  webUtils: { getPathForFile: vi.fn(() => '') },
}))

const installedState = (): DocumentConversionComponentState => ({
  revision: 7,
  source: 'packaged',
  status: 'installed',
  installedVersion: '0.1.7-py3.12.10',
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

interface StateTransport {
  subscribe(listener: (value: unknown) => void): () => void
}

function apiWithStateTransport(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  transport?: StateTransport,
) {
  return createArkdownApi(
    invoke,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    transport,
  )
}

beforeEach(() => {
  vi.resetModules()
  electronMocks.exposeInMainWorld.mockReset()
  electronMocks.invoke.mockReset().mockResolvedValue({ ok: true, value: null })
  electronMocks.on.mockReset()
  electronMocks.removeListener.mockReset()
  electronMocks.send.mockReset()
})

describe('document conversion preload API', () => {
  it('exposes only request IDs and workspace-relative paths through exact channel inputs', async () => {
    const invoke = vi.fn().mockImplementation(async (channel: string) => ({
      ok: true,
      value: channel === IPC_CHANNELS.convertWorkspaceDocument
        ? convertedDocument()
        : channel === IPC_CHANNELS.cancelDocumentConversionComponentInstall
          || channel === IPC_CHANNELS.cancelWorkspaceDocumentConversion
          ? null
          : installedState(),
    }))
    const api = apiWithStateTransport(invoke)

    await api.getDocumentConversionComponentState!()
    await api.installDocumentConversionComponent!(requestId)
    await api.cancelDocumentConversionComponentInstall!(requestId)
    await api.removeDocumentConversionComponent!()
    await api.convertWorkspaceDocument!('folder/report.pdf', requestId)
    await api.cancelWorkspaceDocumentConversion!(requestId)

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.getDocumentConversionComponentState],
      [IPC_CHANNELS.installDocumentConversionComponent, { requestId }],
      [IPC_CHANNELS.cancelDocumentConversionComponentInstall, { requestId }],
      [IPC_CHANNELS.removeDocumentConversionComponent],
      [IPC_CHANNELS.convertWorkspaceDocument, { relativePath: 'folder/report.pdf', requestId }],
      [IPC_CHANNELS.cancelWorkspaceDocumentConversion, { requestId }],
    ])
  })

  it('rejects malformed request IDs and unsafe renderer paths before IPC', async () => {
    const invoke = vi.fn()
    const api = apiWithStateTransport(invoke)

    for (const result of [
      await api.installDocumentConversionComponent!('not-a-uuid'),
      await api.cancelDocumentConversionComponentInstall!(''),
      await api.convertWorkspaceDocument!('C:\\private\\report.pdf', requestId),
      await api.convertWorkspaceDocument!('../outside.pdf', requestId),
      await api.convertWorkspaceDocument!('https://example.test/report.pdf', requestId),
      await api.convertWorkspaceDocument!('report.pdf.exe', requestId),
      await api.cancelWorkspaceDocumentConversion!('not-a-uuid'),
    ]) {
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('exact-parses and deep-clones component state and converted responses', async () => {
    const state = {
      ...installedState(),
      status: 'installing' as const,
      installedVersion: null,
      progress: { phase: 'extracting' as const, receivedBytes: 4, totalBytes: 10 },
      busy: true,
    }
    const document = convertedDocument()
    const invoke = vi.fn().mockImplementation(async (channel: string) => ({
      ok: true,
      value: channel === IPC_CHANNELS.convertWorkspaceDocument ? document : state,
    }))
    const api = apiWithStateTransport(invoke)

    const stateResult = await api.getDocumentConversionComponentState!()
    const documentResult = await api.convertWorkspaceDocument!('folder/report.pdf', requestId)

    expect(stateResult).toEqual({ ok: true, value: state })
    expect(documentResult).toEqual({ ok: true, value: document })
    if (stateResult.ok) {
      expect(stateResult.value).not.toBe(state)
      expect(stateResult.value.progress).not.toBe(state.progress)
    }
    if (documentResult.ok) {
      expect(documentResult.value).not.toBe(document)
      expect(documentResult.value.source).not.toBe(document.source)
      expect(documentResult.value.warnings).not.toBe(document.warnings)
    }
  })

  it('fails closed for malformed state and forged converted-document payloads', async () => {
    const malformedState = { ...installedState(), extra: 'private' }
    const forgedDocument = {
      ...convertedDocument(),
      source: { ...convertedDocument().source, fileName: 'different.pdf' },
    }
    const invoke = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: malformedState })
      .mockResolvedValueOnce({ ok: true, value: forgedDocument })
    const api = apiWithStateTransport(invoke)

    await expect(api.getDocumentConversionComponentState!()).resolves.toMatchObject({
      ok: false, error: { code: 'OPERATION_FAILED' },
    })
    await expect(api.convertWorkspaceDocument!('folder/report.pdf', requestId)).resolves.toMatchObject({
      ok: false, error: { code: 'OPERATION_FAILED' },
    })
  })

  it('drops malformed state events and gives listeners cloned snapshots', () => {
    let emit!: (value: unknown) => void
    const transport: StateTransport = {
      subscribe(listener) {
        emit = listener
        return vi.fn()
      },
    }
    const api = apiWithStateTransport(vi.fn(), transport)
    const listener = vi.fn()
    const unsubscribe = api.onDocumentConversionComponentState!(listener)
    const state = installedState()

    expect(emit).toBeTypeOf('function')
    emit({ ...state, extra: true })
    expect(listener).not.toHaveBeenCalled()
    emit(state)

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(state)
    expect(listener.mock.calls[0]![0]).not.toBe(state)
    unsubscribe()
  })

  it('buffers the latest valid main-process state until the renderer subscribes', async () => {
    await import('../../src/preload/index')
    const registration = electronMocks.on.mock.calls.find(
      ([channel]) => channel === DOCUMENT_CONVERSION_COMPONENT_STATE_CHANNEL,
    )
    expect(registration).toBeDefined()
    const state = installedState()
    registration![1]({}, state)
    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]![1]
    const listener = vi.fn()

    exposed.onDocumentConversionComponentState(listener)

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(state)
  })
})
