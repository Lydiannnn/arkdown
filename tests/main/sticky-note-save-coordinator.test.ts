import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StickyNoteSaveCoordinator } from '../../src/main/sticky-notes/sticky-note-save-coordinator'
import type { StickyNoteDocument, StickyNoteSaveState } from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const NOTE_A = '00000000-0000-4000-8000-000000000001'
const NOTE_B = '00000000-0000-4000-8000-000000000002'

function document(noteId: string, markdown: string): StickyNoteDocument {
  const timestamp = '2026-07-31T03:00:00.000Z'
  return {
    record: {
      id: noteId,
      name: noteId === NOTE_A ? '甲' : '乙',
      status: 'active',
      markdownRelativePath: `active/${noteId}/便签.md`,
      resourcesRelativePath: `active/${noteId}/resources`,
      style: { mode: 'preset', colorPresetId: 'yellow', texturePresetId: 'plain' },
      background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      released: false,
      pinned: false,
      windowBounds: null,
      lastOpenedAt: null,
      fontSizePx: 13,
      lineSpacingMode: 'compact',
    },
    markdown,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-31T03:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('StickyNoteSaveCoordinator', () => {
  it('waits 2000ms of silence before writing and deduplicates already saved content', async () => {
    const writeMarkdown = vi.fn(async (noteId: string, markdown: string) =>
      document(noteId, markdown))
    const coordinator = new StickyNoteSaveCoordinator({ store: { writeMarkdown } })
    const states: StickyNoteSaveState[] = []
    coordinator.subscribe((noteId, state) => {
      if (noteId === NOTE_A) states.push(state)
    })

    coordinator.stage(NOTE_A, '第一版')
    await vi.advanceTimersByTimeAsync(1999)
    expect(writeMarkdown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(writeMarkdown).toHaveBeenCalledTimes(1)
    expect(writeMarkdown).toHaveBeenCalledWith(NOTE_A, '第一版')
    expect(states.map(({ status }) => status)).toEqual(['saving', 'saved'])
    expect(states.at(-1)).toEqual({
      status: 'saved',
      revision: 1,
      savedAt: '2026-07-31T03:00:02.000Z',
    })

    coordinator.stage(NOTE_A, '第一版')
    await vi.advanceTimersByTimeAsync(2000)
    expect(writeMarkdown).toHaveBeenCalledTimes(1)
  })

  it('takes a five-second snapshot even while continued typing resets the debounce timer', async () => {
    const writeMarkdown = vi.fn(async (noteId: string, markdown: string) =>
      document(noteId, markdown))
    const coordinator = new StickyNoteSaveCoordinator({ store: { writeMarkdown } })

    coordinator.stage(NOTE_A, '0')
    for (let index = 1; index <= 12; index += 1) {
      await vi.advanceTimersByTimeAsync(400)
      coordinator.stage(NOTE_A, String(index))
    }
    expect(writeMarkdown).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(200)

    expect(writeMarkdown).toHaveBeenCalledTimes(1)
    expect(writeMarkdown).toHaveBeenCalledWith(NOTE_A, '12')
  })

  it('keeps one write in flight and writes only the latest staged revision afterwards', async () => {
    const first = deferred<StickyNoteDocument>()
    const second = deferred<StickyNoteDocument>()
    const writeMarkdown = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const coordinator = new StickyNoteSaveCoordinator({ store: { writeMarkdown } })

    coordinator.stage(NOTE_A, '第一版')
    await vi.advanceTimersByTimeAsync(2000)
    expect(writeMarkdown).toHaveBeenCalledWith(NOTE_A, '第一版')

    coordinator.stage(NOTE_A, '不应写入')
    coordinator.stage(NOTE_A, '最终版本')
    await vi.advanceTimersByTimeAsync(2000)
    expect(writeMarkdown).toHaveBeenCalledTimes(1)

    first.resolve(document(NOTE_A, '第一版'))
    await Promise.resolve()
    await Promise.resolve()
    expect(writeMarkdown).toHaveBeenCalledTimes(2)
    expect(writeMarkdown).toHaveBeenLastCalledWith(NOTE_A, '最终版本')

    second.resolve(document(NOTE_A, '最终版本'))
    await coordinator.flush(NOTE_A)
    expect(coordinator.state(NOTE_A)).toMatchObject({ status: 'saved', revision: 3 })
  })

  it('flushes immediately for close and removes a successfully disposed note state', async () => {
    const writeMarkdown = vi.fn(async (noteId: string, markdown: string) =>
      document(noteId, markdown))
    const coordinator = new StickyNoteSaveCoordinator({ store: { writeMarkdown } })

    coordinator.stage(NOTE_A, '关闭前内容')
    const saved = await coordinator.flush(NOTE_A)

    expect(saved).toMatchObject({ status: 'saved', revision: 1 })
    expect(writeMarkdown).toHaveBeenCalledTimes(1)
    await coordinator.dispose(NOTE_A)
    expect(coordinator.state(NOTE_A)).toEqual({ status: 'idle' })
  })

  it('retains failed content and succeeds when explicitly retried', async () => {
    const writeMarkdown = vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementationOnce(async (noteId: string, markdown: string) =>
        document(noteId, markdown))
    const coordinator = new StickyNoteSaveCoordinator({ store: { writeMarkdown } })

    coordinator.stage(NOTE_A, '不能丢失')
    const failed = await coordinator.flush(NOTE_A)
    expect(failed).toEqual({ status: 'error', revision: 1, message: 'disk full' })

    const saved = await coordinator.flush(NOTE_A)
    expect(saved).toMatchObject({ status: 'saved', revision: 1 })
    expect(writeMarkdown).toHaveBeenNthCalledWith(1, NOTE_A, '不能丢失')
    expect(writeMarkdown).toHaveBeenNthCalledWith(2, NOTE_A, '不能丢失')
  })

  it('allows different notes to save independently in parallel', async () => {
    const writes = new Map<string, ReturnType<typeof deferred<StickyNoteDocument>>>()
    const writeMarkdown = vi.fn((noteId: string, markdown: string) => {
      const operation = deferred<StickyNoteDocument>()
      writes.set(noteId, operation)
      return operation.promise
    })
    const coordinator = new StickyNoteSaveCoordinator({ store: { writeMarkdown } })
    coordinator.stage(NOTE_A, '甲内容')
    coordinator.stage(NOTE_B, '乙内容')

    const flushing = coordinator.flushAll()
    await Promise.resolve()
    expect(writeMarkdown).toHaveBeenCalledTimes(2)

    writes.get(NOTE_A)?.resolve(document(NOTE_A, '甲内容'))
    await Promise.resolve()
    expect(coordinator.state(NOTE_A)).toMatchObject({ status: 'saved' })
    expect(coordinator.state(NOTE_B)).toMatchObject({ status: 'saving' })

    writes.get(NOTE_B)?.resolve(document(NOTE_B, '乙内容'))
    await flushing
    expect(coordinator.state(NOTE_B)).toMatchObject({ status: 'saved' })
  })
})
