import { act, fireEvent, render, screen } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArkdownRendererApi, ArknoteServiceEvent } from '../../src/preload/arkdown-api'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { applicationMenuApiStubs } from './application-menu-api-stubs'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'
import type { ApiResult, StickyNoteEvent, StickyNoteSummary } from '../../src/shared/contracts'

vi.mock('../../src/renderer/editor/EditorPane', () => ({
  EditorPane: forwardRef<{ flush: () => string | null }, {
    documentKey: string
    markdown: string
    onChange: (markdown: string) => void
  }>(function TestEditor({ documentKey, markdown, onChange }, ref) {
    useImperativeHandle(ref, () => ({ flush: () => null }))
    return <textarea aria-label="Markdown editor" data-document-key={documentKey} onChange={(event) => onChange(event.target.value)} value={markdown} />
  }),
}))

import { App } from '../../src/renderer/app/App'

const modelApiFailure = async () => ({
  ok: false as const,
  error: { code: 'OPERATION_FAILED' as const, message: 'Unavailable in test' },
})

function installApi(connectArknote: NonNullable<ArkdownRendererApi['connectArknote']>) {
  let serviceListener: ((event: ArknoteServiceEvent) => void) | undefined
  const noteListeners = new Set<(event: StickyNoteEvent) => void>()
  window.arkdown = {
    chooseWorkspace: vi.fn(async () => ({ ok: true as const, value: null })),
    restoreWorkspace: vi.fn(async () => ({ ok: true as const, value: null })),
    listDirectory: vi.fn(async () => ({ ok: true as const, value: [] })),
    openDroppedPath: vi.fn(), pathForDroppedFile: vi.fn(() => ''),
    createDocument: vi.fn(), readDocument: vi.fn(), peekDocument: vi.fn(),
    saveDocument: vi.fn(), revealDocument: vi.fn(), trashDocument: vi.fn(),
    getLargeModelSettings: vi.fn(modelApiFailure), connectModel: vi.fn(modelApiFailure),
    listModels: vi.fn(modelApiFailure), testModel: vi.fn(modelApiFailure),
    deleteModel: vi.fn(modelApiFailure), setSelectionTranslationSettings: vi.fn(modelApiFailure),
    acceptTranslationPrivacyNotice: vi.fn(modelApiFailure), startTranslation: vi.fn(modelApiFailure),
    cancelTranslation: vi.fn(modelApiFailure), onTranslationEvent: vi.fn(() => () => undefined),
    ...stickyNoteApiStubs,
    ...applicationMenuApiStubs,
    connectArknote,
    onStickyNoteEvent: (listener: (event: StickyNoteEvent) => void) => {
      noteListeners.add(listener)
      return () => { noteListeners.delete(listener) }
    },
    onArknoteServiceEvent: vi.fn((listener) => {
      serviceListener = listener
      return () => { if (serviceListener === listener) serviceListener = undefined }
    }),
    onPrepareClose: vi.fn(() => () => undefined),
  } as unknown as ArkdownRendererApi
  return { emit: (event: ArknoteServiceEvent) => serviceListener?.(event),
    emitNote: (event: StickyNoteEvent) => { for (const listener of noteListeners) listener(event) } }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Arkdown sticky-note service lifecycle', () => {
  it('ignores a late list failure from the stopped service and subscribes the reconnected panel once', async () => {
    const service = installApi(vi.fn(async () => ({ ok: true as const, value: null })))
    let finishOldList!: (value: ApiResult<StickyNoteSummary[]>) => void
    const list = vi.fn<ArkdownRendererApi['listStickyNotes']>()
      .mockImplementationOnce(() => new Promise(resolve => { finishOldList = resolve }))
      .mockResolvedValue({ ok: true, value: [] })
    window.arkdown.listStickyNotes = list
    render(<App />)
    const toggle = document.querySelector<HTMLButtonElement>('.sticky-note-box-toolbar-button')!
    await act(async () => { fireEvent.click(toggle) })
    act(() => service.emit({ type: 'service-stopping' }))
    await act(async () => { fireEvent.click(toggle) })
    await act(async () => { finishOldList({ ok: false, error: { code: 'OPERATION_FAILED', message: 'Old list failed' } }) })
    expect(screen.queryByText('Old list failed')).toBeNull()
    await act(async () => { service.emitNote({ type: 'index-changed', noteId: null }) })
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('does not read during shutdown and reloads cards only after an explicit reconnect', async () => {
    let connected = true
    const service = installApi(vi.fn(async () => {
      connected = true
      return { ok: true as const, value: null }
    }))
    const list = vi.fn(async () => connected
      ? { ok: true as const, value: [{ record: {
        id: '10000000-0000-4000-8000-000000000001', name: 'Retained note', status: 'active' as const,
        markdownRelativePath: 'active/one/便签.md', resourcesRelativePath: 'active/one/assets',
        style: { mode: 'preset' as const, colorPresetId: 'yellow' as const, texturePresetId: 'plain' as const },
        background: { ...DEFAULT_BACKGROUND_SETTINGS }, createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z', archivedAt: null, released: false, pinned: false,
        fontSizePx: 13, lineSpacingMode: 'compact' as const, windowBounds: null, lastOpenedAt: null,
      }, excerpt: 'Saved content' }] }
      : { ok: false as const, error: { code: 'OPERATION_FAILED' as const, message: '操作未能完成' } })
    window.arkdown.listStickyNotes = list
    render(<App />)
    const toggle = document.querySelector<HTMLButtonElement>('.sticky-note-box-toolbar-button')!
    await act(async () => { fireEvent.click(toggle) })
    expect(screen.getByRole('button', { name: 'Retained note' })).toBeInTheDocument()
    connected = false
    await act(async () => { service.emit({ type: 'service-stopping' }) })
    expect(list).toHaveBeenCalledTimes(1)
    await act(async () => { fireEvent.click(toggle) })
    expect(list).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Retained note' })).toBeInTheDocument()
    expect(screen.queryByText('操作未能完成')).toBeNull()
  })

  it('ignores a connection result from before service shutdown and permits a fresh attempt', async () => {
    let finish!: (value: { ok: true; value: null }) => void
    const connect = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValue({ ok: true, value: null })
    const service = installApi(connect)
    render(<App />)
    const toggle = document.querySelector<HTMLButtonElement>('.sticky-note-box-toolbar-button')!
    fireEvent.click(toggle)
    act(() => service.emit({ type: 'service-stopping' }))
    await act(async () => { finish({ ok: true, value: null }) })
    act(() => vi.advanceTimersByTime(40))
    expect(document.querySelector('.sticky-note-box-motion')).toBeNull()
    await act(async () => { fireEvent.click(toggle) })
    act(() => vi.advanceTimersByTime(40))
    expect(connect).toHaveBeenCalledTimes(2)
    expect(document.querySelector('.sticky-note-box-motion')).toHaveAttribute('data-open', 'true')
  })

  it('waits for Arknote connection before mounting and opening the sidebar', async () => {
    let finish: ((value: { ok: true; value: null }) => void) | undefined
    const connect = vi.fn(() => new Promise<{ ok: true; value: null }>((resolve) => { finish = resolve }))
    installApi(connect)
    render(<App />)

    fireEvent.click(document.querySelector<HTMLButtonElement>('.sticky-note-box-toolbar-button')!)
    expect(document.querySelector('.sticky-note-box-motion')).toBeNull()

    await act(async () => { finish?.({ ok: true, value: null }); await Promise.resolve() })
    act(() => vi.advanceTimersByTime(40))
    expect(document.querySelector('.sticky-note-box-motion')).toHaveAttribute('data-open', 'true')
  })

  it('keeps the sidebar closed and reports the bounded public error when startup fails', async () => {
    installApi(vi.fn(async () => ({
      ok: false as const,
      error: { code: 'OPERATION_FAILED' as const, message: 'internal detail' },
    })))
    render(<App />)

    await act(async () => {
      fireEvent.click(document.querySelector<HTMLButtonElement>('.sticky-note-box-toolbar-button')!)
      await Promise.resolve()
    })

    expect(document.querySelector('.sticky-note-box-motion')).toBeNull()
    expect(screen.getAllByText(/无法启动 Arknote/u).length).toBeGreaterThan(0)
  })

  it('animates closed once and reconnects when clicked before the stopping pipe closes', async () => {
    const connect = vi.fn(async () => ({ ok: true as const, value: null }))
    const service = installApi(connect)
    render(<App />)
    const toggle = document.querySelector<HTMLButtonElement>('.sticky-note-box-toolbar-button')!

    await act(async () => { fireEvent.click(toggle); await Promise.resolve() })
    act(() => vi.advanceTimersByTime(40))
    expect(document.querySelector('.sticky-note-box-motion')).toHaveAttribute('data-open', 'true')

    act(() => service.emit({ type: 'service-stopping' }))
    expect(document.querySelector('.sticky-note-box-motion')).toHaveAttribute('data-open', 'false')
    act(() => vi.advanceTimersByTime(100))
    expect(screen.getAllByText(/Arknote 服务已断开/u).length).toBeGreaterThan(0)

    await act(async () => { fireEvent.click(toggle); await Promise.resolve() })
    act(() => vi.advanceTimersByTime(40))

    expect(connect).toHaveBeenCalledTimes(2)
    expect(document.querySelector('.sticky-note-box-motion')).toHaveAttribute('data-open', 'true')
    expect(screen.queryByText(/Arknote 服务已断开/u)).toBeNull()
  })
})
