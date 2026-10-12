import { expect, it, vi } from 'vitest'
import { BackgroundWorkflow } from '../../src/main/backgrounds/background-workflow'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const main = { kind: 'main' as const }
const persisted = {
  settings: {
    ...DEFAULT_BACKGROUND_SETTINGS,
    imageRelativePath: 'backgrounds/main/current.png',
  },
  imageUrl: 'asset://current',
}

function harness() {
  const backend = {
    get: vi.fn(async () => persisted),
    previewSource: vi.fn(async (_target, source: string) => `preview:${source}`),
    apply: vi.fn(async (_target, settings, update) => ({
      settings: {
        ...settings,
        imageRelativePath: update.kind === 'remove'
          ? null
          : update.kind === 'replace'
            ? 'backgrounds/main/replacement.png'
            : persisted.settings.imageRelativePath,
      },
      imageUrl: update.kind === 'remove' ? null : 'asset://applied',
    })),
  }
  const chooseSource = vi.fn(async (): Promise<string | null> => 'C:\\pictures\\replacement.webp')
  const broadcast = vi.fn()
  const workflow = new BackgroundWorkflow({ backend, chooseSource, broadcast })
  return { workflow, backend, chooseSource, broadcast }
}

it('keeps pending replacement private until apply and broadcasts only the applied result', async () => {
  const { workflow, backend, broadcast } = harness()
  const preview = vi.fn()
  await workflow.begin(main, preview)

  await expect(workflow.choose(main)).resolves.toEqual({
    settings: persisted.settings,
    imageUrl: 'preview:C:\\pictures\\replacement.webp',
  })
  const controls = {
    ...DEFAULT_BACKGROUND_SETTINGS,
    imageRelativePath: 'C:\\untrusted\\escape.png',
    imageOpacityPercent: 47,
  }
  await workflow.preview(main, controls)

  expect(preview).toHaveBeenLastCalledWith({
    target: main,
    presentation: {
      settings: { ...controls, imageRelativePath: persisted.settings.imageRelativePath },
      imageUrl: 'preview:C:\\pictures\\replacement.webp',
    },
    phase: 'preview',
  })
  expect(broadcast).not.toHaveBeenCalled()

  const applied = await workflow.apply(main, controls)
  expect(backend.apply).toHaveBeenCalledWith(
    main,
    { ...controls, imageRelativePath: persisted.settings.imageRelativePath },
    { kind: 'replace', sourceAbsolutePath: 'C:\\pictures\\replacement.webp' },
    expect.any(Function),
  )
  expect(broadcast).toHaveBeenCalledWith({
    target: main,
    presentation: applied,
    phase: 'applied',
  })
})

it('restores the persisted presentation on cancel without broadcasting it', async () => {
  const { workflow, backend, broadcast } = harness()
  const preview = vi.fn()
  await workflow.begin(main, preview)
  await workflow.remove(main)

  await workflow.cancel(main)

  expect(backend.apply).not.toHaveBeenCalled()
  expect(preview).toHaveBeenLastCalledWith({
    target: main,
    presentation: persisted,
    phase: 'restore',
  })
  expect(broadcast).not.toHaveBeenCalled()
})

it('leaves the current pending image untouched when image selection is cancelled', async () => {
  const { workflow, chooseSource } = harness()
  const preview = vi.fn()
  await workflow.begin(main, preview)
  chooseSource.mockResolvedValueOnce(null)

  await expect(workflow.choose(main)).resolves.toBeNull()
  expect(preview).not.toHaveBeenCalled()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

it('does not let a late begin replace a newer session', async () => {
  const { workflow, backend } = harness()
  const pending = deferred<typeof persisted>()
  backend.get.mockReturnValueOnce(pending.promise)
  const oldEvents = vi.fn()
  const old = workflow.begin(main, oldEvents)
  const rejected = expect(old).rejects.toThrow('unavailable')
  workflow.end(main)
  const newEvents = vi.fn()
  await workflow.begin(main, newEvents)
  pending.resolve(persisted)
  await rejected
  await workflow.preview(main, DEFAULT_BACKGROUND_SETTINGS)
  expect(oldEvents).not.toHaveBeenCalled()
  expect(newEvents).toHaveBeenCalledOnce()
})

it.each(['chooser', 'preview-source'] as const)('rejects a late %s after close and reopen', async (stage) => {
  const { workflow, backend, chooseSource } = harness()
  const pending = deferred<string>()
  if (stage === 'chooser') chooseSource.mockReturnValueOnce(pending.promise)
  else backend.previewSource.mockReturnValueOnce(pending.promise)
  const oldEvents = vi.fn()
  await workflow.begin(main, oldEvents)
  const old = workflow.choose(main)
  const rejected = expect(old).rejects.toThrow('unavailable')
  await Promise.resolve()
  workflow.end(main)
  const newEvents = vi.fn()
  await workflow.begin(main, newEvents)
  pending.resolve('C:\\late.png')
  await rejected
  await workflow.preview(main, DEFAULT_BACKGROUND_SETTINGS)
  expect(oldEvents).not.toHaveBeenCalled()
  expect(newEvents).toHaveBeenCalledOnce()
})

it('does not restore or delete a replacement session when an old cancel resolves', async () => {
  const { workflow, backend } = harness()
  const oldEvents = vi.fn()
  await workflow.begin(main, oldEvents)
  const pending = deferred<typeof persisted>()
  backend.get.mockReturnValueOnce(pending.promise)
  const oldCancel = workflow.cancel(main)
  const newEvents = vi.fn()
  await workflow.begin(main, newEvents)
  pending.resolve(persisted)
  await oldCancel
  await workflow.preview(main, DEFAULT_BACKGROUND_SETTINGS)
  expect(oldEvents).not.toHaveBeenCalled()
  expect(newEvents).toHaveBeenCalledOnce()
})

it('invalidates an accepted apply before backend commit and suppresses its late broadcast', async () => {
  const { workflow, backend, broadcast } = harness()
  const pending = deferred<typeof persisted>()
  let commitAllowed!: () => void
  backend.apply.mockImplementationOnce(async (...args: unknown[]) => {
    commitAllowed = args[3] as () => void
    return pending.promise
  })
  await workflow.begin(main, vi.fn())
  const oldApply = workflow.apply(main, DEFAULT_BACKGROUND_SETTINGS)
  const rejected = expect(oldApply).rejects.toThrow('unavailable')
  workflow.end(main)
  await workflow.begin(main, vi.fn())
  pending.resolve(persisted)
  await rejected
  expect(() => commitAllowed()).toThrow('unavailable')
  expect(broadcast).not.toHaveBeenCalled()
  await workflow.apply(main, { ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 77 })
  expect(broadcast).toHaveBeenCalledOnce()
})
