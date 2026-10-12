import path from 'node:path'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import type {
  StickyNoteDocument,
  StickyNoteImportResult,
  StickyNoteRecord,
  StickyNoteSaveState,
  StickyNoteSummary,
} from '../../src/shared/sticky-notes'
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

function document(markdown = '# 内容'): StickyNoteDocument {
  return { record: record(), markdown }
}

function createHarness() {
  const summary: StickyNoteSummary = { record: record(), excerpt: '内容' }
  const imported: StickyNoteImportResult = { note: document(), warnings: [] }
  const saved: StickyNoteSaveState = {
    status: 'saved',
    revision: 1,
    savedAt: TIMESTAMP,
  }
  const stickyNotes = {
    list: vi.fn(async () => [summary]),
    search: vi.fn(async () => [{
      noteId: NOTE_ID,
      name: '便签',
      excerpt: '内容',
      archivedAt: null,
    }]),
    read: vi.fn(async () => document()),
    create: vi.fn(async () => document()),
    rename: vi.fn(async () => document()),
    archive: vi.fn(async () => document()),
    restore: vi.fn(async () => document()),
    restoreArchived: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    importFile: vi.fn(async () => imported),
    importSelection: vi.fn(async () => imported),
    stageSave: vi.fn(),
    flushSave: vi.fn(async () => saved),
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    reclaim: vi.fn(async () => undefined),
    setPinned: vi.fn(async () => undefined),
    setStyle: vi.fn(async () => record()),
    setLineSpacingMode: vi.fn(async () => undefined),
    resizeToContent: vi.fn(async () => undefined),
  }
  const chooseStickyNoteImage = vi.fn(async () => '![](resources/00000000-0000-4000-8000-000000000099.png)')
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(),
    chooseStickyNoteImage,
    workspace: {} as never,
    documents: {} as never,
    stickyNotes,
    getStickyNoteForegroundSourceId: () => undefined,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
  })
  return { stickyNotes, operations, summary, imported, saved, chooseStickyNoteImage }
}

const invalidInput = {
  ok: false,
  error: { code: 'INVALID_INPUT', message: '请求参数无效' },
}

describe('sticky-note IPC operations', () => {
  it('dispatches the fixed sticky-note operations with reconstructed inputs', async () => {
    const { stickyNotes, operations, summary, imported, saved, chooseStickyNoteImage } = createHarness()
    const absolutePath = path.resolve('tests/fixtures/note.md')
    const style = {
      mode: 'preset' as const,
      colorPresetId: 'blue' as const,
      texturePresetId: 'grid' as const,
    }

    await expect(operations.listStickyNotes({ status: 'active' }))
      .resolves.toEqual({ ok: true, value: [summary] })
    await expect(operations.searchStickyNotes({ status: 'active', query: '内容' }))
      .resolves.toEqual({
        ok: true,
        value: [{ noteId: NOTE_ID, name: '便签', excerpt: '内容', archivedAt: null }],
      })
    await expect(operations.readStickyNote({ noteId: NOTE_ID }))
      .resolves.toEqual({ ok: true, value: document() })
    await operations.createStickyNote({ name: '便签', markdown: '# 内容', style })
    await operations.renameStickyNote({ noteId: NOTE_ID, name: '新名称' })
    await operations.archiveStickyNote({ noteId: NOTE_ID })
    await operations.restoreStickyNote({ noteId: NOTE_ID })
    await operations.restoreArchivedStickyNotes({ noteIds: [NOTE_ID] })
    await operations.deleteStickyNote({ noteId: NOTE_ID })
    await expect(operations.importStickyNote({ absolutePath }))
      .resolves.toEqual({ ok: true, value: imported })
    const selectionImport = {
      markdown: '![图片](C:\\Notes\\image.png)',
      localResources: [{
        originalReference: 'C:\\Notes\\image.png',
        absolutePath: 'C:\\Notes\\image.png',
      }],
    }
    await expect(operations.importStickyNoteSelection(selectionImport))
      .resolves.toEqual({ ok: true, value: imported })
    await operations.stageStickyNoteSave({ noteId: NOTE_ID, markdown: '# 新内容' })
    await expect(operations.flushStickyNoteSave({ noteId: NOTE_ID }))
      .resolves.toEqual({ ok: true, value: saved })
    await operations.openStickyNote({ noteId: NOTE_ID, query: '内容' })
    await operations.closeStickyNote({ noteId: NOTE_ID })
    await operations.releaseStickyNote({ noteId: NOTE_ID })
    await operations.reclaimStickyNote({ noteId: NOTE_ID })
    await operations.setStickyNotePinned({ noteId: NOTE_ID, pinned: true })
    await operations.setStickyNoteStyle({ noteId: NOTE_ID, style })
    await expect(operations.chooseStickyNoteImage({ noteId: NOTE_ID })).resolves.toEqual({
      ok: true, value: '![](resources/00000000-0000-4000-8000-000000000099.png)',
    })
    await operations.resizeStickyNoteToContent({
      noteId: NOTE_ID,
      measurement: { scrollWidth: 450, scrollHeight: 700 },
    })

    expect(stickyNotes.list).toHaveBeenCalledWith('active')
    expect(stickyNotes.search).toHaveBeenCalledWith({ status: 'active', query: '内容' })
    expect(stickyNotes.restoreArchived).toHaveBeenCalledWith([NOTE_ID])
    expect(stickyNotes.create).toHaveBeenCalledWith({ name: '便签', markdown: '# 内容', style })
    expect(stickyNotes.rename).toHaveBeenCalledWith(NOTE_ID, '新名称')
    expect(stickyNotes.importFile).toHaveBeenCalledWith(absolutePath)
    expect(stickyNotes.importSelection).toHaveBeenCalledWith(selectionImport)
    expect(stickyNotes.stageSave).toHaveBeenCalledWith(NOTE_ID, '# 新内容')
    expect(stickyNotes.open).toHaveBeenCalledWith(NOTE_ID, '内容')
    expect(stickyNotes.setPinned).toHaveBeenCalledWith(NOTE_ID, true)
    expect(stickyNotes.setStyle).toHaveBeenCalledWith(NOTE_ID, style)
    expect(chooseStickyNoteImage).toHaveBeenCalledWith(NOTE_ID)
    expect(stickyNotes.resizeToContent).toHaveBeenCalledWith(
      NOTE_ID, { scrollWidth: 450, scrollHeight: 700 },
    )
  })

  it.each([
    ['listStickyNotes', { status: 'unknown' }],
    ['searchStickyNotes', { status: 'active', query: '' }],
    ['searchStickyNotes', { status: 'active', query: 'x'.repeat(501) }],
    ['readStickyNote', { noteId: `${NOTE_ID.slice(0, -1)}g` }],
    ['readStickyNote', { noteId: NOTE_ID, extra: true }],
    ['createStickyNote', { name: '便签', markdown: 'x'.repeat(8 * 1024 * 1024 + 1) }],
    ['renameStickyNote', { noteId: NOTE_ID, name: 'bad/name' }],
    ['importStickyNote', { absolutePath: 'relative.md' }],
    ['importStickyNoteSelection', {
      markdown: '![图片](relative.png)',
      localResources: [{ originalReference: 'relative.png', absolutePath: 'relative.png' }],
    }],
    ['stageStickyNoteSave', { noteId: NOTE_ID, markdown: 'x'.repeat(8 * 1024 * 1024 + 1) }],
    ['setStickyNotePinned', { noteId: NOTE_ID, pinned: 1 }],
    ['chooseStickyNoteImage', { noteId: 'bad' }],
    ['resizeStickyNoteToContent', {
      noteId: NOTE_ID,
      measurement: { scrollWidth: 450, scrollHeight: 700, width: 999 },
    }],
    ['resizeStickyNoteToContent', {
      noteId: NOTE_ID,
      measurement: { scrollWidth: 20_000, scrollHeight: 700 },
    }],
    ['setStickyNoteStyle', {
      noteId: NOTE_ID,
      style: { mode: 'preset', colorPresetId: 'unknown', texturePresetId: 'plain' },
    }],
    ['setStickyNoteStyle', {
      noteId: NOTE_ID,
      style: {
        mode: 'independent',
        color: '#FFFFFF',
        texture: {
          pattern: 'grid',
          foregroundColor: '#000000',
          opacityPercent: 10.5,
          scalePx: 16,
        },
      },
    }],
  ])('rejects invalid %s input without dispatching', async (operationName, input) => {
    const { stickyNotes, operations } = createHarness()
    const result = await (
      operations[operationName as keyof typeof operations] as (value: unknown) => Promise<unknown>
    )(input)

    expect(result).toEqual(invalidInput)
    expect(Object.values(stickyNotes).every((operation) => operation.mock.calls.length === 0))
      .toBe(true)
  })
})


describe('Arkdown Arknote IPC proxy', () => {
  function proxyHarness(foregroundSourceId?: string) {
    const summary: StickyNoteSummary = { record: record(), excerpt: '内容' }
    const imported: StickyNoteImportResult = { note: document(), warnings: [] }
    const saved: StickyNoteSaveState = { status: 'saved', revision: 1, savedAt: TIMESTAMP }
    const responses: Record<string, unknown> = {
      'note.list': [summary],
      'note.search': [{ noteId: NOTE_ID, name: '便签', excerpt: '内容', archivedAt: null }],
      'note.read': document(), 'note.create': document(), 'note.rename': document(),
      'note.archive': document(), 'note.restore': document(),
      'note.restore-archived-batch': null, 'note.delete': null,
      'note.import-file': imported, 'note.import-selection': imported,
      'note.stage-save': null, 'note.flush-save': saved, 'note.open': null,
      'note.close': null, 'note.release': null, 'note.reclaim': null,
      'note.pin': null, 'note.style': record(), 'note.line-spacing': null, 'note.resize': null,
    }
    const arknote = {
      openBox: vi.fn(async () => undefined),
      request: vi.fn(async (command: string, _payload: unknown, parser: (value: unknown) => unknown) => {
        const parsed = parser(responses[command])
        if (parsed === undefined) throw new Error('strict parser rejected fixture')
        return parsed
      }),
    }
    const operations = createIpcOperations({
      chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never, arknote: arknote as never,
      getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(),
      getStickyNoteForegroundSourceId: () => foregroundSourceId,
    })
    return { arknote, operations }
  }

  it('adds the initiating Arkdown window media source only to the internal note-open command', async () => {
    const foregroundSourceId = 'window:317:0'
    const { arknote, operations } = proxyHarness(foregroundSourceId)

    await expect(operations.openStickyNote({ noteId: NOTE_ID }))
      .resolves.toEqual({ ok: true, value: null })
    expect(arknote.request).toHaveBeenCalledWith(
      'note.open',
      { noteId: NOTE_ID, foregroundSourceId },
      expect.any(Function),
    )
  })

  it('connects through the Arknote runtime before opening the embedded box', async () => {
    const { arknote, operations } = proxyHarness()

    await expect(operations.connectArknote()).resolves.toEqual({ ok: true, value: null })
    expect(arknote.openBox).toHaveBeenCalledOnce()
  })

  it('maps the compatible sticky-note API to fixed Arknote commands and payloads', async () => {
    const { arknote, operations } = proxyHarness()
    const absolutePath = path.resolve('tests/fixtures/note.md')
    const style = { mode: 'preset' as const, colorPresetId: 'blue' as const, texturePresetId: 'grid' as const }
    const selection = { markdown: '# selection', localResources: [] }
    await operations.listStickyNotes({ status: 'active' })
    await operations.searchStickyNotes({ status: 'active', query: '内容' })
    await operations.readStickyNote({ noteId: NOTE_ID })
    await operations.createStickyNote({ name: '便签', markdown: '# 内容', style })
    await operations.renameStickyNote({ noteId: NOTE_ID, name: '新名称' })
    await operations.archiveStickyNote({ noteId: NOTE_ID }); await operations.restoreStickyNote({ noteId: NOTE_ID })
    await operations.restoreArchivedStickyNotes({ noteIds: [NOTE_ID] })
    await operations.deleteStickyNote({ noteId: NOTE_ID }); await operations.importStickyNote({ absolutePath })
    await operations.importStickyNoteSelection(selection)
    await operations.stageStickyNoteSave({ noteId: NOTE_ID, markdown: '# 新内容' })
    await operations.flushStickyNoteSave({ noteId: NOTE_ID })
    await operations.openStickyNote({ noteId: NOTE_ID, query: '内容' })
    await operations.closeStickyNote({ noteId: NOTE_ID }); await operations.releaseStickyNote({ noteId: NOTE_ID })
    await operations.reclaimStickyNote({ noteId: NOTE_ID }); await operations.setStickyNotePinned({ noteId: NOTE_ID, pinned: true })
    await operations.setStickyNoteStyle({ noteId: NOTE_ID, style })
    await operations.resizeStickyNoteToContent({ noteId: NOTE_ID, measurement: { scrollWidth: 450, scrollHeight: 700 } })
    expect(arknote.request.mock.calls.map(([command, payload]) => [command, payload])).toEqual([
      ['note.list', { status: 'active' }], ['note.search', { status: 'active', query: '内容' }],
      ['note.read', { noteId: NOTE_ID }], ['note.create', { name: '便签', markdown: '# 内容', style }],
      ['note.rename', { noteId: NOTE_ID, name: '新名称' }], ['note.archive', { noteId: NOTE_ID }],
      ['note.restore', { noteId: NOTE_ID }],
      ['note.restore-archived-batch', { noteIds: [NOTE_ID] }],
      ['note.delete', { noteId: NOTE_ID }],
      ['note.import-file', { absolutePath }], ['note.import-selection', selection],
      ['note.stage-save', { noteId: NOTE_ID, markdown: '# 新内容' }], ['note.flush-save', { noteId: NOTE_ID }],
      ['note.open', { noteId: NOTE_ID, findQuery: '内容' }], ['note.close', { noteId: NOTE_ID }],
      ['note.release', { noteId: NOTE_ID }], ['note.reclaim', { noteId: NOTE_ID }],
      ['note.pin', { noteId: NOTE_ID, pinned: true }], ['note.style', { noteId: NOTE_ID, style }],
      ['note.resize', { noteId: NOTE_ID, measurement: { scrollWidth: 450, scrollHeight: 700 } }],
    ])
  })

  it('sends the line-spacing mutation through the Arknote pipe', async () => {
    const { arknote, operations } = proxyHarness()

    await expect(operations.setStickyNoteLineSpacingMode({
      noteId: NOTE_ID,
      lineSpacingMode: 'standard',
    })).resolves.toEqual({ ok: true, value: null })
    expect(arknote.request).toHaveBeenCalledWith(
      'note.line-spacing',
      { noteId: NOTE_ID, lineSpacingMode: 'standard' },
      expect.any(Function),
    )
  })

  it('fails closed when Arknote returns a malformed successful response', async () => {
    const { arknote, operations } = proxyHarness()
    arknote.request.mockImplementationOnce(async (_command, _payload, parser) => {
      const parsed = parser({ record: record(), markdown: '# 内容', extra: true })
      if (parsed === undefined) throw new Error('Arknote response format is incompatible')
      return parsed
    })
    await expect(operations.readStickyNote({ noteId: NOTE_ID })).resolves.toEqual({
      ok: false, error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
    })
  })
})

describe('Arkdown sticky-note ownership boundary', () => {
  it('does not import or construct Arknote-owned resources', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/main/arkdown-main.ts'), 'utf8')
    for (const forbidden of [
      'StickyNoteStore', 'StickyNoteSaveCoordinator', 'StickyNoteSearchIndex',
      'StickyNoteWindowManager', 'StickyNoteSessionState', 'StickyNoteTray',
      'StickyNoteAutostart', 'StickyNoteAppLifecycle', 'createStickyNoteWindow',
      'registerStickyNoteWindowIpc',
    ]) expect(source).not.toContain(forbidden)
  })
})


it('persists only strict sticky-note line-spacing modes through the IPC operation', async () => {
  const { stickyNotes, operations } = createHarness()

  await expect(operations.setStickyNoteLineSpacingMode({
    noteId: NOTE_ID,
    lineSpacingMode: 'standard',
  })).resolves.toEqual({ ok: true, value: null })
  expect(stickyNotes.setLineSpacingMode).toHaveBeenCalledWith(NOTE_ID, 'standard')
  for (const input of [
    { noteId: NOTE_ID, lineSpacingMode: 'dense' },
    { noteId: 'malformed', lineSpacingMode: 'compact' },
    { noteId: NOTE_ID, lineSpacingMode: 'compact', extra: true },
  ]) await expect(operations.setStickyNoteLineSpacingMode(input)).resolves.toEqual(invalidInput)
  expect(stickyNotes.setLineSpacingMode).toHaveBeenCalledTimes(1)
})

it('validates and dispatches archived batch deletion as one IPC operation', async () => {
  const deleteArchived = vi.fn(async () => undefined)
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(),
    workspace: {} as never,
    documents: {} as never,
    stickyNotes: { deleteArchived } as never,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
  })
  const operation = operations.deleteArchivedStickyNotes

  expect(operation).toBeTypeOf('function')
  if (!operation) return

  await expect(operation({ noteIds: [NOTE_ID, NOTE_ID] }))
    .resolves.toEqual({ ok: true, value: null })
  expect(deleteArchived).toHaveBeenCalledWith([NOTE_ID, NOTE_ID])

  const invalidPayloads = [
    { noteIds: [] },
    { noteIds: ['malformed'] },
    { noteIds: Array.from({ length: 100_001 }, () => NOTE_ID) },
    { noteIds: [NOTE_ID], extra: true },
  ]
  for (const payload of invalidPayloads) {
    await expect(operation(payload)).resolves.toEqual(invalidInput)
  }
  expect(deleteArchived).toHaveBeenCalledTimes(1)
})

it('sends archived batch deletion through the Arknote pipe and fails closed on a non-null reply', async () => {
  const request = vi.fn(async (
    _command: string,
    _payload: unknown,
    parser: (value: unknown) => unknown,
  ) => parser(null))
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(),
    workspace: {} as never,
    documents: {} as never,
    arknote: { request } as never,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
  })
  const operation = operations.deleteArchivedStickyNotes

  expect(operation).toBeTypeOf('function')
  if (!operation) return

  await expect(operation({ noteIds: [NOTE_ID, NOTE_ID] }))
    .resolves.toEqual({ ok: true, value: null })
  expect(request).toHaveBeenCalledWith(
    'note.delete-archived-batch',
    { noteIds: [NOTE_ID, NOTE_ID] },
    expect.any(Function),
  )

  request.mockImplementationOnce(async (_command, _payload, parser) => {
    const parsed = parser({ deleted: true })
    if (parsed === undefined) throw new Error('Arknote response format is incompatible')
    return parsed
  })
  await expect(operation({ noteIds: [NOTE_ID] })).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })
})
