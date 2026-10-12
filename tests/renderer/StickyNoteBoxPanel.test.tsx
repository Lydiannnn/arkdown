import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArkdownApi, StickyNoteEvent, StickyNoteSummary } from '../../src/shared/contracts'
import { StickyNoteBoxPanel } from '../../src/renderer/sticky-notes/StickyNoteBoxPanel'
import { ContextMenuProvider } from '../../src/renderer/context-menu/ContextMenuProvider'
import { BusinessDialogProvider } from '../../src/renderer/modal/BusinessDialogProvider'
import { stickyNoteApiStubs } from './sticky-note-api-stubs'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../src/shared/arknote-preferences'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const makeSummary = (index: number): StickyNoteSummary => ({
  record: {
    id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `便签${index}`,
    status: 'active',
    markdownRelativePath: `active/${index}/便签.md`,
    resourcesRelativePath: `active/${index}/assets`,
    style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
    background: { ...DEFAULT_BACKGROUND_SETTINGS },
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    archivedAt: null,
    released: false,
    pinned: false,
    fontSizePx: 13,
    lineSpacingMode: 'compact',
    windowBounds: null,
    lastOpenedAt: null,
  },
  excerpt: `内容 ${index}`,
})

function installApi(active: StickyNoteSummary[]) {
  window.arkdown = {
    ...stickyNoteApiStubs,
    listStickyNotes: vi.fn(async (status) => ({
      ok: true as const,
      value: status === 'active' ? active : [],
    })),
    openStickyNote: vi.fn(async () => ({ ok: true as const, value: null })),
  } as unknown as ArkdownApi
}

describe('StickyNoteBoxPanel', () => {
  beforeEach(() => installApi([makeSummary(1), makeSummary(2)]))

  it('lays out the header, content, and bottom tabs with the compact new-note entry', async () => {
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)

    expect(screen.getByRole('heading', { name: '便签盒子 — Arknote' })).toBeVisible()
    const panel = screen.getByRole('complementary', { name: '便签盒子' })
    expect(Array.from(panel.children).map((child) => child.className)).toEqual([
      'sticky-note-box-header',
      'sticky-note-box-content',
      'sticky-note-box-tabs',
    ])
    expect(screen.getByRole('tab', { name: '便签' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '归档' })).toHaveAttribute('aria-selected', 'false')
    const grid = await screen.findByRole('grid', { name: '便签' })
    expect(grid).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' })
    expect(within(grid).getByRole('button', { name: '新便签' })).toBeVisible()
    expect(within(grid).getByRole('button', { name: '便签1' })).toBeVisible()
  })

  it('opens an active note and refreshes when the index changes', async () => {
    const eventSink: { current: ((event: StickyNoteEvent) => void) | null } = { current: null }
    const listStickyNotes = vi.fn(async () => ({
      ok: true as const,
      value: [makeSummary(1)],
    }))
    const openStickyNote = vi.fn(async () => ({ ok: true as const, value: null }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes,
      openStickyNote,
      onStickyNoteEvent: vi.fn((handler) => {
        eventSink.current = handler
        return () => { eventSink.current = null }
      }),
    } as unknown as ArkdownApi

    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '便签1' }))
    expect(openStickyNote).toHaveBeenCalledWith(makeSummary(1).record.id)

    eventSink.current?.({ type: 'index-changed', noteId: null })
    await waitFor(() => expect(listStickyNotes).toHaveBeenCalledTimes(2))
  })

  it('keeps the grid, drag and slide animation mounted during a slow index refresh', async () => {
    const sink: { current: ((event: StickyNoteEvent) => void) | null } = { current: null }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let reads = 0
    window.arkdown.onStickyNoteEvent = vi.fn((handler) => { sink.current = handler; return () => { sink.current = null } })
    window.arkdown.listStickyNotes = vi.fn(async () => {
      if (++reads === 2) await gate
      return { ok: true as const, value: [makeSummary(1), makeSummary(2)] }
    })
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    const grid = await screen.findByRole('grid', { name: '便签' })
    const card = within(grid).getByRole('button', { name: '便签1' })
    vi.spyOn(grid, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 100))
    for (const item of within(grid).getAllByRole('button')) {
      Object.defineProperties(item, {
        offsetLeft: { get: () => Array.from(grid.children).indexOf(item) * 110 },
        offsetTop: { get: () => 0 },
        offsetWidth: { get: () => 100 },
        offsetHeight: { get: () => 100 },
      })
      vi.spyOn(item, 'getBoundingClientRect').mockImplementation(() => new DOMRect(item.offsetLeft, 0, 100, 100))
    }
    const cancel = vi.fn()
    const animate = vi.fn(() => ({ cancel }))
    Object.defineProperty(within(grid).getByRole('button', { name: '便签2' }), 'animate', { value: animate })
    const transfer = { types: ['application/x-arknote-card'], effectAllowed: 'move', setData: vi.fn() }
    fireEvent.dragStart(card, { dataTransfer: transfer })
    const over = createEvent.dragOver(grid, { dataTransfer: transfer })
    Object.defineProperties(over, { clientX: { value: 250 }, clientY: { value: 50 } })
    fireEvent(grid, over)
    expect(animate).toHaveBeenCalledOnce()
    act(() => sink.current?.({ type: 'index-changed', noteId: null }))
    expect(screen.getByRole('grid', { name: '便签' })).toBe(grid)
    expect(grid).toHaveAttribute('data-dragging', 'true')
    await act(async () => { release(); await gate })
    expect(screen.getByRole('grid', { name: '便签' })).toBe(grid)
    expect(within(grid).getByRole('button', { name: '便签1' })).toBe(card)
    expect(grid).toHaveAttribute('data-dragging', 'true')
    expect(cancel).not.toHaveBeenCalled()
    expect(within(grid).getAllByRole('button').map((item) => item.getAttribute('aria-label')))
      .toEqual(['新便签', '便签2', '便签1'])
    fireEvent.dragEnd(card, { dataTransfer: transfer })
    expect(grid).toHaveAttribute('data-dragging', 'false')
  })

  it('keeps an operation failure visible after a successful list refresh', async () => {
    const note = makeSummary(1)
    const eventSink: { current: ((event: StickyNoteEvent) => void) | null } = { current: null }
    const listStickyNotes = vi.fn(async () => ({ ok: true as const, value: [note] }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes,
      openStickyNote: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'OPERATION_FAILED' as const, message: '打开便签失败' },
      })),
      onStickyNoteEvent: vi.fn((handler) => {
        eventSink.current = handler
        return () => { eventSink.current = null }
      }),
    } as unknown as ArkdownApi

    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: note.record.name }))
    expect(await screen.findByRole('alert')).toHaveTextContent('打开便签失败')

    eventSink.current?.({ type: 'index-changed', noteId: null })
    await waitFor(() => expect(listStickyNotes).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('alert')).toHaveTextContent('打开便签失败')
  })

  it('does not retain active cards as archives when the archive list fails', async () => {
    const note = makeSummary(1)
    window.arkdown.listStickyNotes = vi.fn(async (status) => status === 'active'
      ? { ok: true as const, value: [note] }
      : { ok: false as const, error: { code: 'OPERATION_FAILED' as const, message: '归档读取失败' } })
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    expect(await screen.findByRole('button', { name: note.record.name })).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: '归档' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('归档读取失败')
    expect(screen.queryByRole('button', { name: note.record.name })).not.toBeInTheDocument()
  })

  it('ignores an older active-list refresh after switching to archives', async () => {
    const archived = { ...makeSummary(3), record: { ...makeSummary(3).record, status: 'archived' as const } }
    const sink: { current: ((event: StickyNoteEvent) => void) | null } = { current: null }
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let activeReads = 0
    window.arkdown.onStickyNoteEvent = vi.fn((handler) => { sink.current = handler; return () => { sink.current = null } })
    window.arkdown.listStickyNotes = vi.fn(async (status) => {
      if (status === 'archived') return { ok: true as const, value: [archived] }
      activeReads += 1
      if (activeReads === 2) await gate
      return { ok: true as const, value: [makeSummary(1)] }
    })
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    await screen.findByRole('button', { name: '便签1' })
    act(() => sink.current?.({ type: 'index-changed', noteId: null }))
    fireEvent.click(screen.getByRole('tab', { name: '归档' }))
    expect(await screen.findByRole('button', { name: archived.record.name })).toBeVisible()
    await act(async () => { release(); await gate })
    expect(screen.getByRole('button', { name: archived.record.name })).toBeVisible()
    expect(screen.queryByRole('button', { name: '便签1' })).not.toBeInTheDocument()
  })

  it('clears a list failure after a successful list retry', async () => {
    const note = makeSummary(1)
    const eventSink: { current: ((event: StickyNoteEvent) => void) | null } = { current: null }
    const listStickyNotes = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'OPERATION_FAILED' as const, message: '读取便签失败' },
      })
      .mockResolvedValue({ ok: true as const, value: [note] })
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes,
      onStickyNoteEvent: vi.fn((handler) => {
        eventSink.current = handler
        return () => { eventSink.current = null }
      }),
    } as unknown as ArkdownApi

    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('读取便签失败')

    eventSink.current?.({ type: 'index-changed', noteId: null })
    expect(await screen.findByRole('button', { name: note.record.name })).toBeVisible()
    expect(screen.queryByText('读取便签失败')).not.toBeInTheDocument()
  })

  it('keeps a created card when opening it fails and retries the same id without creating again', async () => {
    const existing = makeSummary(1)
    const created = makeSummary(3)
    created.record.name = '新建后打开失败'
    let wasCreated = false
    const createStickyNote = vi.fn(async () => {
      wasCreated = true
      return { ok: true as const, value: { record: created.record, markdown: '' } }
    })
    const openStickyNote = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'OPERATION_FAILED' as const, message: '窗口启动失败' },
      })
      .mockResolvedValueOnce({ ok: true as const, value: null })
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async (status) => status === 'active' && wasCreated
        ? {
            ok: false as const,
            error: { code: 'OPERATION_FAILED' as const, message: '创建后刷新失败' },
          }
        : { ok: true as const, value: status === 'active' ? [existing] : [] }),
      createStickyNote,
      openStickyNote,
    } as unknown as ArkdownApi

    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '新便签' }))
    const dialog = await screen.findByRole('dialog', { name: '创建新便签' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: '便签名' }), {
      target: { value: created.record.name },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }))

    expect(await screen.findByText('已创建，但打开失败：窗口启动失败')).toBeVisible()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '创建新便签' })).not.toBeInTheDocument())
    const createdCard = screen.getByRole('button', { name: created.record.name })
    expect(createdCard).toBeVisible()
    expect(createStickyNote).toHaveBeenCalledOnce()
    expect(openStickyNote).toHaveBeenCalledWith(created.record.id)

    fireEvent.click(createdCard)
    await waitFor(() => expect(openStickyNote).toHaveBeenCalledTimes(2))
    expect(openStickyNote).toHaveBeenLastCalledWith(created.record.id)
    expect(createStickyNote).toHaveBeenCalledOnce()
    expect(screen.queryByText('已创建，但打开失败：窗口启动失败')).not.toBeInTheDocument()
  })

  it('does not start an old-view refresh when a note operation finishes after a view switch', async () => {
    let releaseOpen = () => {}
    let releaseArchives = () => {}
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve })
    const archiveGate = new Promise<void>((resolve) => { releaseArchives = resolve })
    const archived = { ...makeSummary(3), record: { ...makeSummary(3).record, status: 'archived' as const } }
    let activeReads = 0
    window.arkdown.archiveStickyNote = vi.fn(async () => {
      await openGate
      return { ok: true as const, value: { record: archived.record, markdown: '' } }
    })
    window.arkdown.listStickyNotes = vi.fn(async (status) => {
      if (status === 'archived') {
        await archiveGate
        return { ok: true as const, value: [archived] }
      }
      activeReads += 1
      return { ok: true as const, value: [makeSummary(1)] }
    })
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    await screen.findByRole('button', { name: '便签1' })
    fireEvent.drop(screen.getByRole('button', { name: '归档便签' }), {
      dataTransfer: { getData: () => makeSummary(1).record.id },
    })
    fireEvent.click(screen.getByRole('tab', { name: '归档' }))
    await act(async () => { releaseOpen(); await openGate })
    await act(async () => { releaseArchives(); await archiveGate })
    expect(screen.getByRole('button', { name: archived.record.name })).toBeVisible()
    expect(screen.queryByRole('button', { name: '便签1' })).not.toBeInTheDocument()
    expect(activeReads).toBe(2)
  })

  it('updates one card excerpt in place when a saved summary event arrives', async () => {
    const eventSink: { current: ((event: StickyNoteEvent) => void) | null } = { current: null }
    const initial = makeSummary(1)
    const listStickyNotes = vi.fn(async () => ({
      ok: true as const,
      value: [initial],
    }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes,
      onStickyNoteEvent: vi.fn((handler) => {
        eventSink.current = handler
        return () => { eventSink.current = null }
      }),
    } as unknown as ArkdownApi

    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    expect(await screen.findByText(initial.excerpt)).toBeVisible()

    eventSink.current?.({
      type: 'note-summary-changed',
      noteId: initial.record.id,
      revision: 1,
      summary: {
        ...initial,
        record: { ...initial.record, updatedAt: '2026-08-03T03:00:00.000Z' },
        excerpt: '保存后的新摘要',
      },
    })

    expect(await screen.findByText('保存后的新摘要')).toBeVisible()
    expect(screen.queryByText(initial.excerpt)).not.toBeInTheDocument()
    expect(listStickyNotes).toHaveBeenCalledTimes(1)
  })


  it('refreshes sticky-note appearance preferences when the box regains focus', async () => {
    const getStickyNotePreferences = vi.fn(stickyNoteApiStubs.getStickyNotePreferences)
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async (status) => ({
        ok: true as const,
        value: status === 'active' ? [makeSummary(1)] : [],
      })),
      getStickyNotePreferences,
    } as unknown as ArkdownApi

    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    await waitFor(() => expect(getStickyNotePreferences).toHaveBeenCalledOnce())
    fireEvent.focus(window)
    await waitFor(() => expect(getStickyNotePreferences).toHaveBeenCalledTimes(2))
  })
  it('switches to archive without a create entry', async () => {
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: '归档' }))
    expect(screen.getByRole('tab', { name: '归档' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: '新便签' })).not.toBeInTheDocument()
  })

  it('disables creation at 35 active notes and shows the exact capacity message', async () => {
    installApi(Array.from({ length: 35 }, (_, index) => makeSummary(index + 1)))
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)

    const create = await screen.findByRole('button', { name: '新便签' })
    expect(create).toBeDisabled()
    expect(screen.getByText('标签盒子已满，建议将不常用标签进行归档')).toBeVisible()
  })

  it('opens card menus at 200 CSS pixels without a root icon gutter', async () => {
    render(<ContextMenuProvider><StickyNoteBoxPanel onClose={vi.fn()} /></ContextMenuProvider>)

    fireEvent.contextMenu(await screen.findByRole('button', { name: /1$/ }), { clientX: 80, clientY: 90 })

    expect(screen.getByRole('menu')).toHaveStyle({ width: '200px' })
    expect(screen.getByRole('menu')).toHaveClass('context-menu-root-no-icon-gutter')
  })

  it.each([
    ['材质', 'Mica', { mode: 'material', materialPresetId: 'mica-light' }],
    ['改变颜色', '蓝色', { mode: 'preset', colorPresetId: 'blue', texturePresetId: 'plain' }],
  ] as const)(
    'persists a note command from %s as the required style',
    async (submenuLabel, choiceLabel, expectedStyle) => {
      const materialNote = makeSummary(1)
      materialNote.record.style = { mode: 'material', materialPresetId: 'flowing-glass' }
      const setStickyNoteStyle = vi.fn(async () => ({ ok: true as const, value: null }))
      window.arkdown = {
        ...stickyNoteApiStubs,
        listStickyNotes: vi.fn(async (status) => ({
          ok: true as const,
          value: status === 'active' ? [materialNote] : [],
        })),
        setStickyNoteStyle,
      } as unknown as ArkdownApi

      render(<ContextMenuProvider><StickyNoteBoxPanel onClose={vi.fn()} /></ContextMenuProvider>)
      const card = await screen.findByRole('button', { name: materialNote.record.name })
      fireEvent.contextMenu(card, { clientX: 80, clientY: 90 })
      fireEvent.mouseEnter(screen.getByRole('menuitem', { name: submenuLabel }).parentElement!)
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: choiceLabel }))

      await waitFor(() => expect(setStickyNoteStyle).toHaveBeenCalledWith(
        materialNote.record.id,
        expectedStyle,
      ))
    },
  )

  it('clicking a released card closes it instead of opening another window', async () => {
    const released = makeSummary(1)
    released.record.released = true
    const closeStickyNote = vi.fn(async () => ({ ok: true as const, value: null }))
    const openStickyNote = vi.fn(async () => ({ ok: true as const, value: null }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async (status) => ({ ok: true as const, value: status === 'active' ? [released] : [] })),
      closeStickyNote,
      openStickyNote,
    } as unknown as ArkdownApi
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: released.record.name }))
    expect(closeStickyNote).toHaveBeenCalledWith(released.record.id)
    expect(openStickyNote).not.toHaveBeenCalled()
  })

  it('uses the latest display-state event when toggling a card', async () => {
    const eventSink: { current: ((event: StickyNoteEvent) => void) | null } = { current: null }
    const released = makeSummary(1)
    released.record.released = true
    const closeStickyNote = vi.fn(async () => ({ ok: true as const, value: null }))
    const openStickyNote = vi.fn(async () => ({ ok: true as const, value: null }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async (status) => ({ ok: true as const, value: status === 'active' ? [released] : [] })),
      closeStickyNote,
      openStickyNote,
      onStickyNoteEvent: vi.fn((handler) => {
        eventSink.current = handler
        return () => { eventSink.current = null }
      }),
    } as unknown as ArkdownApi

    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    const card = await screen.findByRole('button', { name: released.record.name })
    await act(async () => {
      eventSink.current?.({
        type: 'note-display-state-changed',
        noteId: released.record.id,
        revision: 2,
        displayed: false,
        pinned: false,
      })
    })
    fireEvent.click(card)

    await waitFor(() => expect(openStickyNote).toHaveBeenCalledWith(released.record.id))
    expect(closeStickyNote).not.toHaveBeenCalled()
  })

  it('archives a card dropped on the recycle target without confirmation and shows feedback', async () => {
    const archiveStickyNote = vi.fn(async () => ({ ok: true as const, value: { record: makeSummary(1).record, markdown: '' } }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async (status) => ({ ok: true as const, value: status === 'active' ? [makeSummary(1)] : [] })),
      archiveStickyNote,
    } as unknown as ArkdownApi
    const transfer = { types: ['application/x-arknote-card'], setData: vi.fn(), getData: vi.fn(() => makeSummary(1).record.id), files: [] as unknown as FileList }
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    fireEvent.dragStart(await screen.findByRole('button', { name: '便签1' }), { dataTransfer: transfer })
    fireEvent.drop(screen.getByRole('button', { name: '归档便签' }), { dataTransfer: transfer })
    await waitFor(() => expect(archiveStickyNote).toHaveBeenCalledWith(makeSummary(1).record.id))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(await screen.findByText('便签已归档')).toBeVisible()
  })

  it('persists the one-time startup hint decision', async () => {
    const setArknotePreferences = vi.fn(async (value) => ({ ok: true as const, value }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async () => ({ ok: true as const, value: [] })),
      getArknotePreferences: vi.fn(async () => ({ ok: true as const, value: DEFAULT_ARKNOTE_PREFERENCES })),
      setArknotePreferences,
    } as unknown as ArkdownApi
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '开机启动' }))
    await waitFor(() => expect(setArknotePreferences).toHaveBeenCalledWith(expect.objectContaining({
      launchAtLogin: true,
      startupHintDismissed: true,
    })))
    for (const key of ['micaAppearance', 'glassAppearances', 'materialEffects']) {
      expect(setArknotePreferences.mock.calls[0]![0]).not.toHaveProperty(key)
    }
    expect(screen.queryByText(/开机启动便签服务/)).not.toBeInTheDocument()
  })
  it('uses page-specific title and close semantics and swaps archive/delete targets', async () => {
    const onClose = vi.fn()
    const archivedNote = {
      ...makeSummary(1),
      record: {
        ...makeSummary(1).record,
        name: '归档便签1',
        status: 'archived' as const,
        archivedAt: '2026-08-01T00:00:00.000Z',
      },
    }
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async (status) => ({
        ok: true as const,
        value: status === 'active' ? [makeSummary(1)] : [archivedNote],
      })),
    } as unknown as ArkdownApi
    render(<StickyNoteBoxPanel onClose={onClose} />)

    expect(screen.getByRole('heading', { name: '便签盒子 — Arknote' })).toBeVisible()
    const archiveTarget = screen.getByRole('button', { name: '归档便签' })
    expect(screen.getByRole('tablist', { name: '便签视图' })).toContainElement(archiveTarget)
    fireEvent.click(screen.getByRole('tab', { name: '归档' }))

    expect(await screen.findByRole('heading', { name: '归档' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '归档便签' })).not.toBeInTheDocument()
    const deleteTarget = screen.getByRole('button', { name: '永久删除归档便签' })
    expect(deleteTarget.closest('.sticky-note-box-content')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '返回便签盒子' }))
    expect(await screen.findByRole('heading', { name: '便签盒子 — Arknote' })).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '关闭便签盒子' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('permanently deletes one selected archive with the exact named confirmation', async () => {
    const archivedNote = {
      ...makeSummary(1),
      record: {
        ...makeSummary(1).record,
        name: '归档便签1',
        status: 'archived' as const,
        archivedAt: '2026-08-01T00:00:00.000Z',
      },
    }
    const deleteArchivedStickyNotes = vi.fn(async () => ({ ok: true as const, value: null }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async (status) => ({ ok: true as const, value: status === 'archived' ? [archivedNote] : [] })),
      deleteArchivedStickyNotes,
    } as unknown as ArkdownApi
    render(<BusinessDialogProvider><StickyNoteBoxPanel onClose={vi.fn()} /></BusinessDialogProvider>)
    fireEvent.click(screen.getByRole('tab', { name: '归档' }))
    const card = await screen.findByRole('button', { name: archivedNote.record.name })
    fireEvent.click(card)
    const transfer = {
      types: ['application/x-arknote-card-ids'],
      getData: vi.fn(() => JSON.stringify([archivedNote.record.id])),
    }

    fireEvent.drop(screen.getByRole('button', { name: '永久删除归档便签' }), { dataTransfer: transfer })

    const dialog = await screen.findByRole('dialog', { name: '永久删除便签' })
    expect(dialog).toHaveTextContent('确定要永久删除“归档便签1”吗？此操作不可恢复。')
    fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }))
    await waitFor(() => expect(deleteArchivedStickyNotes).toHaveBeenCalledOnce())
    expect(deleteArchivedStickyNotes).toHaveBeenCalledWith([archivedNote.record.id])
    expect(screen.queryByRole('button', { name: archivedNote.record.name })).not.toBeInTheDocument()
  })

  it('permanently deletes a selected archive group in one batch with the exact count confirmation', async () => {
    const first = {
      ...makeSummary(1),
      record: { ...makeSummary(1).record, name: '归档便签1', status: 'archived' as const, archivedAt: '2026-08-02T00:00:00.000Z' },
    }
    const second = {
      ...makeSummary(2),
      record: { ...makeSummary(2).record, name: '归档便签2', status: 'archived' as const, archivedAt: '2026-08-01T00:00:00.000Z' },
    }
    const deleteArchivedStickyNotes = vi.fn(async () => ({ ok: true as const, value: null }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async (status) => ({ ok: true as const, value: status === 'archived' ? [second, first] : [] })),
      deleteArchivedStickyNotes,
    } as unknown as ArkdownApi
    render(<BusinessDialogProvider><StickyNoteBoxPanel onClose={vi.fn()} /></BusinessDialogProvider>)
    fireEvent.click(screen.getByRole('tab', { name: '归档' }))
    const grid = await screen.findByRole('grid', { name: '归档便签' })
    const cards = within(grid).getAllByRole('button')
    fireEvent.click(cards[0])
    fireEvent.click(cards[1], { ctrlKey: true })
    const orderedIds = [first.record.id, second.record.id]
    const payload = new Map<string, string>()
    const transfer = {
      types: [] as string[],
      effectAllowed: 'move',
      dropEffect: 'move',
      files: [] as unknown as FileList,
      setData: vi.fn((type: string, value: string) => {
        payload.set(type, value)
        if (!transfer.types.includes(type)) transfer.types.push(type)
      }),
      getData: vi.fn((type: string) => payload.get(type) ?? ''),
    }

    fireEvent.dragStart(cards[0], { dataTransfer: transfer })
    expect(transfer.getData('application/x-arknote-card-ids')).toBe(JSON.stringify(orderedIds))
    fireEvent.drop(screen.getByRole('button', { name: '永久删除归档便签' }), { dataTransfer: transfer })

    const dialog = await screen.findByRole('dialog', { name: '永久删除便签' })
    expect(dialog).toHaveTextContent('确定永久删除选中的 2 个便签吗？')
    fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }))
    await waitFor(() => expect(deleteArchivedStickyNotes).toHaveBeenCalledOnce())
    expect(deleteArchivedStickyNotes).toHaveBeenCalledWith(orderedIds)
    expect(within(grid).queryAllByRole('button')).toHaveLength(0)
  })

  it('retains archive selection and renders the batch API error when permanent deletion fails', async () => {
    const first = {
      ...makeSummary(1),
      record: { ...makeSummary(1).record, name: '归档便签1', status: 'archived' as const, archivedAt: '2026-08-02T00:00:00.000Z' },
    }
    const second = {
      ...makeSummary(2),
      record: { ...makeSummary(2).record, name: '归档便签2', status: 'archived' as const, archivedAt: '2026-08-01T00:00:00.000Z' },
    }
    const deleteArchivedStickyNotes = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'OPERATION_FAILED' as const, message: '永久删除失败' },
    }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async (status) => ({ ok: true as const, value: status === 'archived' ? [first, second] : [] })),
      deleteArchivedStickyNotes,
    } as unknown as ArkdownApi
    render(<BusinessDialogProvider><StickyNoteBoxPanel onClose={vi.fn()} /></BusinessDialogProvider>)
    fireEvent.click(screen.getByRole('tab', { name: '归档' }))
    const grid = await screen.findByRole('grid', { name: '归档便签' })
    const cards = within(grid).getAllByRole('button')
    fireEvent.click(cards[0])
    fireEvent.click(cards[1], { ctrlKey: true })
    const ids = [first.record.id, second.record.id]
    const transfer = { types: ['application/x-arknote-card-ids'], getData: vi.fn(() => JSON.stringify(ids)) }

    fireEvent.drop(screen.getByRole('button', { name: '永久删除归档便签' }), { dataTransfer: transfer })

    const dialog = await screen.findByRole('dialog', { name: '永久删除便签' })
    fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('永久删除失败')
    expect(deleteArchivedStickyNotes).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: first.record.name })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: second.record.name })).toHaveAttribute('aria-selected', 'true')
  })

  it('restores every selected archive and disables rename for the group', async () => {
    const first = {
      ...makeSummary(1),
      record: { ...makeSummary(1).record, name: '归档便签1', status: 'archived' as const, archivedAt: '2026-08-02T00:00:00.000Z' },
    }
    const second = {
      ...makeSummary(2),
      record: { ...makeSummary(2).record, name: '归档便签2', status: 'archived' as const, archivedAt: '2026-08-01T00:00:00.000Z' },
    }
    const restoreArchivedStickyNotes = vi.fn(async () => ({
      ok: true as const,
      value: null,
    }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async (status) => ({ ok: true as const, value: status === 'archived' ? [first, second] : [] })),
      restoreArchivedStickyNotes,
    } as unknown as ArkdownApi
    render(<ContextMenuProvider><StickyNoteBoxPanel onClose={vi.fn()} /></ContextMenuProvider>)
    fireEvent.click(screen.getByRole('tab', { name: '归档' }))
    const cards = within(await screen.findByRole('grid', { name: '归档便签' })).getAllByRole('button')
    fireEvent.click(cards[0])
    fireEvent.click(cards[1], { ctrlKey: true })
    fireEvent.contextMenu(cards[1], { clientX: 80, clientY: 90 })

    expect(screen.getByRole('menuitem', { name: '重命名' })).toBeDisabled()
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复到便签盒子' }))

    await waitFor(() => expect(restoreArchivedStickyNotes).toHaveBeenCalledOnce())
    expect(restoreArchivedStickyNotes).toHaveBeenCalledWith([first.record.id, second.record.id])
  })

  it('permanently deletes the current archive selection from its context menu', async () => {
    const first = {
      ...makeSummary(1),
      record: { ...makeSummary(1).record, name: '归档便签1', status: 'archived' as const, archivedAt: '2026-08-02T00:00:00.000Z' },
    }
    const second = {
      ...makeSummary(2),
      record: { ...makeSummary(2).record, name: '归档便签2', status: 'archived' as const, archivedAt: '2026-08-01T00:00:00.000Z' },
    }
    const deleteArchivedStickyNotes = vi.fn(async () => ({ ok: true as const, value: null }))
    const deleteStickyNote = vi.fn(async () => ({ ok: true as const, value: null }))
    window.arkdown = {
      ...stickyNoteApiStubs,
      listStickyNotes: vi.fn(async (status) => ({ ok: true as const, value: status === 'archived' ? [first, second] : [] })),
      deleteArchivedStickyNotes,
      deleteStickyNote,
    } as unknown as ArkdownApi
    render(
      <BusinessDialogProvider>
        <ContextMenuProvider><StickyNoteBoxPanel onClose={vi.fn()} /></ContextMenuProvider>
      </BusinessDialogProvider>,
    )
    fireEvent.click(screen.getByRole('tab', { name: '归档' }))
    const cards = within(await screen.findByRole('grid', { name: '归档便签' })).getAllByRole('button')
    fireEvent.click(cards[0])
    fireEvent.click(cards[1], { ctrlKey: true })
    fireEvent.contextMenu(cards[0], { clientX: 80, clientY: 90 })
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))

    const dialog = await screen.findByRole('dialog', { name: '永久删除便签' })
    fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }))
    await waitFor(() => expect(deleteArchivedStickyNotes).toHaveBeenCalledWith([first.record.id, second.record.id]))
    expect(deleteStickyNote).not.toHaveBeenCalled()
  })

  it('uses a 200 CSS pixel submenu for sticky-note card commands', async () => {
    render(<ContextMenuProvider><StickyNoteBoxPanel onClose={vi.fn()} /></ContextMenuProvider>)
    const card = await screen.findByRole('button', { name: '便签1' })

    fireEvent.contextMenu(card, { clientX: 80, clientY: 90 })
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '改变颜色' }).parentElement!)

    const menus = screen.getAllByRole('menu')
    expect(menus).toHaveLength(2)
    expect(menus[1]).toHaveStyle({ width: '200px' })
  })

  it('activates vector archive targets only during card dragging', async () => {
    render(<StickyNoteBoxPanel onClose={vi.fn()} />)
    const panel = screen.getByRole('complementary', { name: '便签盒子' })
    const card = await screen.findByRole('button', { name: '便签1' })
    const target = screen.getByRole('button', { name: '归档便签' })
    const transfer = {
      types: [] as string[],
      effectAllowed: 'move',
      setData: vi.fn((type: string) => transfer.types.push(type)),
    }

    expect(target.querySelector('.app-icon')).toHaveClass('sticky-note-drop-target-icon')
    expect(screen.getByRole('button', { name: '关闭便签盒子' }).querySelector('.app-icon'))
      .toBeInTheDocument()
    expect(panel).toHaveAttribute('data-card-dragging', 'false')
    fireEvent.dragStart(card, { dataTransfer: transfer })
    expect(panel).toHaveAttribute('data-card-dragging', 'true')
    fireEvent.dragEnd(card, { dataTransfer: transfer })
    expect(panel).toHaveAttribute('data-card-dragging', 'false')
  })

})

it('preserves the color snapshot on repeated Custom commands in the card menu', async () => {
  const note = makeSummary(1)
  note.record.style = { mode: 'independent', color: '#123456', texture: { pattern: 'none', foregroundColor: '#000000', opacityPercent: 0, scalePx: 16 } }
  const setStickyNoteStyle = vi.fn(async () => ({ ok: true as const, value: null }))
  window.arkdown = { ...stickyNoteApiStubs, listStickyNotes: vi.fn(async (status) => ({ ok: true as const, value: status === 'active' ? [note] : [] })), setStickyNoteStyle } as unknown as ArkdownApi
  render(<ContextMenuProvider><StickyNoteBoxPanel onClose={vi.fn()} /></ContextMenuProvider>)
  const card = await screen.findByRole('button', { name: note.record.name })
  for (let index = 0; index < 2; index += 1) {
    fireEvent.contextMenu(card, { clientX: 80, clientY: 90 })
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: '改变颜色' }).parentElement!)
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '自定义' }))
    await waitFor(() => expect(setStickyNoteStyle).toHaveBeenCalledTimes(index + 1))
    expect(setStickyNoteStyle).toHaveBeenLastCalledWith(note.record.id, note.record.style)
  }
})
