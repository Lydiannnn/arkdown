import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ArknoteCommandRouter } from '../../src/main/arknote/arknote-command-router'
import type { ArknoteLaunchCommand } from '../../src/main/arknote/arknote-second-instance'

describe('ArknoteCommandRouter', () => {
  it('routes only whitelisted launch commands to the Arknote service runtime', async () => {
    const execute = vi.fn(async (_command: ArknoteLaunchCommand) => undefined)
    const router = new ArknoteCommandRouter({
      executeLaunchCommand: execute,
      quit: vi.fn(async () => undefined),
    })

    await router.handle('launch.open-box', {})
    await router.handle('launch.new-note', {})
    await router.handle('launch.open-settings', {})

    expect(execute.mock.calls.map(([command]) => command)).toEqual([
      'open-box',
      'new-note',
      'open-settings',
    ])
    await expect(router.handle('launch.open-box', { path: 'C:\\secret.txt' }))
      .rejects.toThrow('Arknote 命令参数无效')
  })

  it('rejects new mutations while stopping but keeps health checks observable', async () => {
    const create = vi.fn(async () => ({ id: 'created' }))
    const router = new ArknoteCommandRouter({
      executeLaunchCommand: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      notes: { create },
    })
    router.setAcceptingMutations(false)

    await expect(router.handle('note.create', { name: 'new note' }))
      .rejects.toThrow('Arknote 正在退出')
    await expect(router.handle('health.ping', {})).resolves.toEqual({ ready: true })
    expect(create).not.toHaveBeenCalled()
  })

  it('pauses new pipe mutations and drains a mutation already in flight', async () => {
    let finishCreate: (() => void) | undefined
    const createPending = new Promise<void>((resolve) => { finishCreate = resolve })
    const create = vi.fn(async () => {
      await createPending
      return { id: 'created' }
    })
    const router = new ArknoteCommandRouter({
      executeLaunchCommand: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      notes: { create },
    })

    const inFlight = router.handle('note.create', { name: 'first' })
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    let drained = false
    const drain = router.pauseAndDrain().then(() => { drained = true })

    await expect(router.handle('note.create', { name: 'second' }))
      .rejects.toThrow('Arknote 正在退出')
    expect(drained).toBe(false)

    finishCreate?.()
    await inFlight
    await drain
    expect(drained).toBe(true)
  })

  it('strictly validates every imported selection resource and the 512-item boundary', async () => {
    const importSelection = vi.fn(async () => ({ imported: true }))
    const router = new ArknoteCommandRouter({
      executeLaunchCommand: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      notes: { importSelection },
    })
    const resource = {
      originalReference: 'assets/photo.png',
      absolutePath: path.resolve('assets/photo.png'),
    }

    await expect(router.handle('note.import-selection', {
      markdown: '![photo](assets/photo.png)',
      localResources: Array.from({ length: 512 }, () => ({ ...resource })),
    })).resolves.toEqual({ imported: true })
    expect(importSelection).toHaveBeenCalledTimes(1)

    const invalidPayloads = [
      { markdown: 'text', localResources: [], extra: true },
      { markdown: 'text', localResources: [{ ...resource, extra: true }] },
      {
        markdown: 'text',
        localResources: [{ ...resource, absolutePath: 'relative/photo.png' }],
      },
      {
        markdown: 'text',
        localResources: Array.from({ length: 513 }, () => ({ ...resource })),
      },
    ]
    for (const payload of invalidPayloads) {
      await expect(router.handle('note.import-selection', payload)).rejects.toThrow()
    }
    expect(importSelection).toHaveBeenCalledTimes(1)
  })

  it('trims and bounds find and search queries while rejecting extra fields', async () => {
    const noteId = '123e4567-e89b-42d3-a456-426614174000'
    const open = vi.fn(async () => undefined)
    const search = vi.fn(async () => [])
    const router = new ArknoteCommandRouter({
      executeLaunchCommand: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      notes: { open, search },
    })

    await router.handle('note.open', {
      noteId,
      findQuery: '  needle  ',
      foregroundSourceId: 'window:317:0',
    })
    await router.handle('note.search', { status: 'active', query: '  haystack  ' })
    expect(open).toHaveBeenCalledWith(noteId, 'needle', 'window:317:0')
    expect(search).toHaveBeenCalledWith({ status: 'active', query: 'haystack' })

    await expect(router.handle('note.open', { noteId, findQuery: '   ' })).rejects.toThrow()
    await expect(router.handle('note.open', {
      noteId,
      findQuery: 'x'.repeat(501),
    })).rejects.toThrow()
    await expect(router.handle('note.open', {
      noteId,
      findQuery: 'valid',
      extra: true,
    })).rejects.toThrow()
    await expect(router.handle('note.open', {
      noteId,
      foregroundSourceId: 'screen:317:0',
    })).rejects.toThrow()
    await expect(router.handle('note.search', {
      status: 'active',
      query: '   ',
    })).rejects.toThrow()
    await expect(router.handle('note.search', {
      status: 'active',
      query: 'x'.repeat(501),
    })).rejects.toThrow()
    await expect(router.handle('note.search', {
      status: 'active',
      query: 'valid',
      extra: true,
    })).rejects.toThrow()
  })

  it('serializes every successful void note command as explicit null', async () => {
    const noteId = '123e4567-e89b-42d3-a456-426614174000'
    const complete = vi.fn(async () => undefined)
    const router = new ArknoteCommandRouter({
      executeLaunchCommand: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      notes: {
        delete: complete,
        open: complete,
        close: complete,
        release: complete,
        reclaim: complete,
        setPinned: complete,
        resizeToContent: complete,
      },
    })

    await expect(router.handle('note.delete', { noteId })).resolves.toBeNull()
    await expect(router.handle('note.open', { noteId })).resolves.toBeNull()
    await expect(router.handle('note.close', { noteId })).resolves.toBeNull()
    await expect(router.handle('note.release', { noteId })).resolves.toBeNull()
    await expect(router.handle('note.reclaim', { noteId })).resolves.toBeNull()
    await expect(router.handle('note.pin', { noteId, pinned: true })).resolves.toBeNull()
    await expect(router.handle('note.resize', {
      noteId, measurement: { scrollWidth: 450, scrollHeight: 700 },
    })).resolves.toBeNull()
  })


  it('routes only a strict complete active-note order', async () => {
    const first = '123e4567-e89b-42d3-a456-426614174000'
    const second = '123e4567-e89b-42d3-a456-426614174001'
    const reorder = vi.fn(async () => [])
    const router = new ArknoteCommandRouter({
      executeLaunchCommand: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
      notes: { reorder },
    })

    await expect(router.handle('note.reorder', { noteIds: [second, first] }))
      .resolves.toEqual([])
    expect(reorder).toHaveBeenCalledWith([second, first])
    await expect(router.handle('note.reorder', { noteIds: [first], extra: true }))
      .rejects.toThrow()
    await expect(router.handle('note.reorder', { noteIds: [first, first] }))
      .rejects.toThrow()
  })
  it('rejects unknown command names instead of silently succeeding', async () => {
    const router = new ArknoteCommandRouter({
      executeLaunchCommand: vi.fn(async () => undefined),
      quit: vi.fn(async () => undefined),
    })

    await expect(router.handle('note.unknown' as never, {})).rejects.toThrow()
  })
})


it('routes only strict compact or standard line-spacing payloads', async () => {
  const noteId = '123e4567-e89b-42d3-a456-426614174000'
  const setLineSpacingMode = vi.fn(async () => undefined)
  const router = new ArknoteCommandRouter({
    executeLaunchCommand: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    notes: { setLineSpacingMode },
  })

  await expect(router.handle('note.line-spacing', {
    noteId,
    lineSpacingMode: 'standard',
  })).resolves.toBeNull()
  expect(setLineSpacingMode).toHaveBeenCalledWith(noteId, 'standard')
  for (const payload of [
    { noteId, lineSpacingMode: 'dense' },
    { noteId: 'bad', lineSpacingMode: 'compact' },
    { noteId, lineSpacingMode: 'compact', extra: true },
  ]) await expect(router.handle('note.line-spacing', payload)).rejects.toThrow()
  expect(setLineSpacingMode).toHaveBeenCalledTimes(1)
})

it('routes only strict non-empty archived batch-restore payloads', async () => {
  const first = '123e4567-e89b-42d3-a456-426614174000'
  const second = '123e4567-e89b-42d3-a456-426614174001'
  const restoreArchived = vi.fn(async () => undefined)
  const router = new ArknoteCommandRouter({
    executeLaunchCommand: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    notes: { restoreArchived },
  })

  await expect(router.handle('note.restore-archived-batch', {
    noteIds: [first, first, second],
  })).resolves.toBeNull()
  expect(restoreArchived).toHaveBeenCalledWith([first, first, second])
  for (const payload of [
    { noteIds: [] },
    { noteIds: ['malformed'] },
    { noteIds: Array.from({ length: 100_001 }, () => first) },
    { noteIds: [first], extra: true },
  ]) await expect(router.handle('note.restore-archived-batch', payload)).rejects.toThrow()
  expect(restoreArchived).toHaveBeenCalledTimes(1)
})

it('routes only strict non-empty archived batch-delete payloads', async () => {
  const first = '123e4567-e89b-42d3-a456-426614174000'
  const second = '123e4567-e89b-42d3-a456-426614174001'
  const deleteArchived = vi.fn(async () => undefined)
  const router = new ArknoteCommandRouter({
    executeLaunchCommand: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    notes: { deleteArchived },
  })

  await expect(router.handle('note.delete-archived-batch', {
    noteIds: [first, first, second],
  })).resolves.toBeNull()
  expect(deleteArchived).toHaveBeenCalledWith([first, first, second])

  const invalidPayloads = [
    { noteIds: [] },
    { noteIds: ['malformed'] },
    { noteIds: Array.from({ length: 100_001 }, () => first) },
    { noteIds: [first], extra: true },
  ]
  for (const payload of invalidPayloads) {
    await expect(router.handle('note.delete-archived-batch', payload))
      .rejects.toThrow()
  }
  expect(deleteArchived).toHaveBeenCalledTimes(1)
})

it('routes a strict transient theme preview without writing settings', async () => {
  const previewThemeColor = vi.fn(async () => undefined)
  const set = vi.fn(async () => undefined)
  const router = new ArknoteCommandRouter({
    executeLaunchCommand: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    settings: { get: vi.fn(), set, previewThemeColor },
  })

  await expect(router.handle('settings.preview-theme', { themeColor: '#2563EB' }))
    .resolves.toBeNull()
  expect(previewThemeColor).toHaveBeenCalledWith('#2563EB')
  expect(set).not.toHaveBeenCalled()
  await expect(router.handle('settings.preview-theme', { themeColor: 'blue' })).rejects.toThrow()
  await expect(router.handle('settings.preview-theme', {
    themeColor: '#2563EB',
    persist: true,
  })).rejects.toThrow()
})
