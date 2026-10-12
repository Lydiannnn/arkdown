import { describe, expect, it, vi } from 'vitest'
import {
  createArkdownApi,
  type StickyNoteEventTransport,
} from '../../src/preload/arkdown-api'
import {
  IPC_CHANNELS,
  type StickyNoteDocument,
  type StickyNoteEvent,
  type StickyNoteRecord,
} from '../../src/shared/contracts'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'
const TIMESTAMP = '2026-07-31T03:00:00.000Z'

function record(overrides: Partial<StickyNoteRecord> = {}): StickyNoteRecord {
  return {
    id: NOTE_ID,
    name: '便签',
    status: 'active',
    markdownRelativePath: `active/${NOTE_ID}/便签.md`,
    resourcesRelativePath: `active/${NOTE_ID}/resources`,
    style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
    background: { ...DEFAULT_BACKGROUND_SETTINGS },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    archivedAt: null,
    released: false,
    pinned: false,
    windowBounds: null,
    lastOpenedAt: null,
    fontSizePx: 13,
    lineSpacingMode: 'compact',
    ...overrides,
  }
}

function document(): StickyNoteDocument {
  return { record: record(), markdown: '# 内容' }
}

function transport() {
  let listener: ((payload: unknown) => void) | undefined
  return {
    value: {
      subscribe(next: (payload: unknown) => void) {
        listener = next
        return () => {
          if (listener === next) listener = undefined
        }
      },
    } satisfies StickyNoteEventTransport,
    emit(payload: unknown) {
      listener?.(payload)
    },
  }
}

const transportFailure = {
  ok: false,
  error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
}

describe('sticky-note preload API', () => {
  it('accepts presentation paths only on the read response without extending persisted document responses', async () => {
    const value = { ...document(), documentAbsolutePath: 'C:\\Arknote\\notes\\active\\' + NOTE_ID + '\\便签.md' }
    const api = createArkdownApi(async () => ({ ok: true, value }))
    await expect(api.readStickyNote(NOTE_ID)).resolves.toEqual({ ok: true, value })
    await expect(api.createStickyNote({ name: '便签' })).resolves.toEqual(transportFailure)
    const importApi = createArkdownApi(async () => ({ ok: true, value: { note: value, warnings: [] } }))
    await expect(importApi.importStickyNote('C:\\Source\\note.md')).resolves.toEqual(transportFailure)
  })

  it.each(['resources/note.md', 'file:///C:/note.md', 'C:\\note.png', 'C:\\bad\0note.md', null])(
    'rejects an invalid note presentation base %s', async (documentAbsolutePath) => {
      const api = createArkdownApi(async () => ({ ok: true, value: { ...document(), documentAbsolutePath } }))
      await expect(api.readStickyNote(NOTE_ID)).resolves.toEqual(transportFailure)
    },
  )

  it('invokes fixed channels with exact public payload shapes', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: null })
    const api = createArkdownApi(invoke)
    const style = {
      mode: 'preset' as const,
      colorPresetId: 'blue' as const,
      texturePresetId: 'grid' as const,
    }

    await api.connectArknote!()
    await api.listStickyNotes('active')
    await api.reorderStickyNotes!([NOTE_ID])
    await api.searchStickyNotes('active', '内容')
    await api.readStickyNote(NOTE_ID)
    await api.createStickyNote({ name: '便签', markdown: '# 内容', style })
    await api.renameStickyNote(NOTE_ID, '新名称')
    await api.archiveStickyNote(NOTE_ID)
    await api.restoreStickyNote(NOTE_ID)
    await api.restoreArchivedStickyNotes!([NOTE_ID])
    await api.deleteStickyNote(NOTE_ID)
    await api.importStickyNote('C:\\Notes\\note.md')
    await api.importStickyNoteSelection!({
      markdown: '![图片](C:\\Notes\\image.png)',
      localResources: [{
        originalReference: 'C:\\Notes\\image.png',
        absolutePath: 'C:\\Notes\\image.png',
      }],
    })
    await api.stageStickyNoteSave(NOTE_ID, '# 新内容')
    await api.flushStickyNoteSave(NOTE_ID)
    await api.openStickyNote(NOTE_ID)
    await api.closeStickyNote(NOTE_ID)
    await api.releaseStickyNote(NOTE_ID)
    await api.reclaimStickyNote(NOTE_ID)
    await api.setStickyNotePinned(NOTE_ID, true)
    await api.setStickyNoteStyle(NOTE_ID, style)
    await api.resizeStickyNoteToContent(
      NOTE_ID, { scrollWidth: 450, scrollHeight: 700 },
    )

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.connectArknote],
      [IPC_CHANNELS.listStickyNotes, { status: 'active' }],
      [IPC_CHANNELS.reorderStickyNotes, { noteIds: [NOTE_ID] }],
      [IPC_CHANNELS.searchStickyNotes, { status: 'active', query: '内容' }],
      [IPC_CHANNELS.readStickyNote, { noteId: NOTE_ID }],
      [IPC_CHANNELS.createStickyNote, { name: '便签', markdown: '# 内容', style }],
      [IPC_CHANNELS.renameStickyNote, { noteId: NOTE_ID, name: '新名称' }],
      [IPC_CHANNELS.archiveStickyNote, { noteId: NOTE_ID }],
      [IPC_CHANNELS.restoreStickyNote, { noteId: NOTE_ID }],
      [IPC_CHANNELS.restoreArchivedStickyNotes, { noteIds: [NOTE_ID] }],
      [IPC_CHANNELS.deleteStickyNote, { noteId: NOTE_ID }],
      [IPC_CHANNELS.importStickyNote, { absolutePath: 'C:\\Notes\\note.md' }],
      [IPC_CHANNELS.importStickyNoteSelection, {
        markdown: '![图片](C:\\Notes\\image.png)',
        localResources: [{
          originalReference: 'C:\\Notes\\image.png',
          absolutePath: 'C:\\Notes\\image.png',
        }],
      }],
      [IPC_CHANNELS.stageStickyNoteSave, { noteId: NOTE_ID, markdown: '# 新内容' }],
      [IPC_CHANNELS.flushStickyNoteSave, { noteId: NOTE_ID }],
      [IPC_CHANNELS.openStickyNote, { noteId: NOTE_ID }],
      [IPC_CHANNELS.closeStickyNote, { noteId: NOTE_ID }],
      [IPC_CHANNELS.releaseStickyNote, { noteId: NOTE_ID }],
      [IPC_CHANNELS.reclaimStickyNote, { noteId: NOTE_ID }],
      [IPC_CHANNELS.setStickyNotePinned, { noteId: NOTE_ID, pinned: true }],
      [IPC_CHANNELS.setStickyNoteStyle, { noteId: NOTE_ID, style }],
      [IPC_CHANNELS.resizeStickyNoteToContent, {
        noteId: NOTE_ID, measurement: { scrollWidth: 450, scrollHeight: 700 },
      }],
    ])
  })

  it('reconstructs valid sticky documents instead of returning transport objects', async () => {
    const source = document()
    const api = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value: source }))

    const result = await api.readStickyNote(NOTE_ID)

    expect(result).toEqual({ ok: true, value: source })
    if (result.ok) {
      expect(result.value).not.toBe(source)
      expect(result.value.record).not.toBe(source.record)
      expect(result.value.record.style).not.toBe(source.record.style)
    }
  })

  it.each([
    { ...document(), extra: true },
    { record: record({ id: `${NOTE_ID.slice(0, -1)}g` }), markdown: '# 内容' },
    { record: record({ windowBounds: { x: 1, y: 2, width: 320.5, height: 320 } }), markdown: '# 内容' },
    { record: record(), markdown: 'x'.repeat(8 * 1024 * 1024 + 1) },
  ])('fails closed for malformed sticky-note responses', async (value) => {
    const api = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value }))
    await expect(api.readStickyNote(NOTE_ID)).resolves.toEqual(transportFailure)
  })

  it('validates sticky-note search results before exposing them', async () => {
    const value = [{ noteId: NOTE_ID, name: '计划', excerpt: '命中内容', archivedAt: null }]
    const api = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value }))

    await expect(api.searchStickyNotes('active', '命中')).resolves.toEqual({ ok: true, value })

    const malformed = createArkdownApi(vi.fn().mockResolvedValue({
      ok: true,
      value: [{ ...value[0], extra: true }],
    }))
    await expect(malformed.searchStickyNotes('active', '命中')).resolves.toEqual(transportFailure)
  })

  it('delivers only strict Arknote lifecycle events and releases handlers', () => {
    const service = transport()
    const api = createArkdownApi(
      vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, service.value,
    )
    const handler = vi.fn()
    const unsubscribe = api.onArknoteServiceEvent!(handler)

    service.emit({ type: 'service-stopping' })
    service.emit({ type: 'service-disconnected' })
    service.emit({ type: 'service-stopping', extra: true })
    service.emit({ type: 'index-changed', noteId: NOTE_ID })

    expect(handler.mock.calls.map(([event]) => event)).toEqual([
      { type: 'service-stopping' },
      { type: 'service-disconnected' },
    ])
    unsubscribe()
    service.emit({ type: 'service-disconnected' })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('delivers only strict sticky-note events and releases unsubscribed handlers', () => {
    const source = transport()
    const api = createArkdownApi(
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      source.value,
    )
    const handler = vi.fn()
    const unsubscribe = api.onStickyNoteEvent(handler)
    const events: StickyNoteEvent[] = [
      { type: 'index-changed', noteId: NOTE_ID },
      { type: 'save-state', noteId: NOTE_ID, state: { status: 'saving', revision: 3 } },
      { type: 'window-state', noteId: NOTE_ID, open: true, pinned: false },
      { type: 'find-request', noteId: NOTE_ID, query: '内容' },
    ]

    for (const event of events) source.emit(event)
    for (const malformed of [
      { type: 'index-changed', noteId: NOTE_ID, extra: true },
      { type: 'save-state', noteId: NOTE_ID, state: { status: 'saving', revision: 1.5 } },
      { type: 'window-state', noteId: `${NOTE_ID.slice(0, -1)}g`, open: true, pinned: false },
      { type: 'find-request', noteId: NOTE_ID, query: '' },
      Object.assign(Object.create({ type: 'index-changed' }), { noteId: NOTE_ID }),
    ]) source.emit(malformed)

    expect(handler.mock.calls.map(([event]) => event)).toEqual(events)
    events.forEach((event, index) => expect(handler.mock.calls[index]?.[0]).not.toBe(event))
    unsubscribe()
    source.emit({ type: 'index-changed', noteId: NOTE_ID })
    expect(handler).toHaveBeenCalledTimes(events.length)
  })
})


it('exposes the line-spacing setter on its fixed IPC channel', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: null })
  const api = createArkdownApi(invoke)

  const setLineSpacingMode = api.setStickyNoteLineSpacingMode
  if (!setLineSpacingMode) throw new Error('missing line-spacing API')
  await expect(setLineSpacingMode(NOTE_ID, 'standard'))
    .resolves.toEqual({ ok: true, value: null })
  expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.setStickyNoteLineSpacingMode, {
    noteId: NOTE_ID,
    lineSpacingMode: 'standard',
  })
})

it('exposes archived batch deletion on its fixed channel and fails closed on malformed success', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: null })
  const api = createArkdownApi(invoke)
  const deleteArchived = api.deleteArchivedStickyNotes

  expect(deleteArchived).toBeTypeOf('function')
  if (!deleteArchived) return

  await expect(deleteArchived([NOTE_ID, NOTE_ID]))
    .resolves.toEqual({ ok: true, value: null })
  expect(invoke).toHaveBeenCalledWith(
    IPC_CHANNELS.deleteArchivedStickyNotes,
    { noteIds: [NOTE_ID, NOTE_ID] },
  )

  invoke.mockResolvedValueOnce({ ok: true, value: { deleted: true } })
  await expect(deleteArchived([NOTE_ID])).resolves.toEqual(transportFailure)
})
