import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import {
  DEFAULT_BACKGROUND_SETTINGS,
  type BackgroundPresentation,
  type BackgroundSettings,
} from '../../src/shared/background-settings'
import {
  MainBackgroundService,
} from '../../src/main/backgrounds/background-service'
import { reduceSettingsTransaction } from '../../src/main/settings/settings-transaction-reducer'
import type { SettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-types'
import type { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/main/settings/settings-store'
import { createMainBackgroundBackend } from '../../src/main/backgrounds/background-backends'
import { BackgroundWorkflow } from '../../src/main/backgrounds/background-workflow'
import { BackgroundSettingsWindowRegistry } from '../../src/main/backgrounds/background-settings-window-registry'
import type { BackgroundIpcService } from '../../src/main/ipc/register-ipc'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function fixture(options: { failUpdate?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-background-'))
  roots.push(root)
  let current: AppSettings = {
    ...DEFAULT_SETTINGS,
    mainBackground: { ...DEFAULT_BACKGROUND_SETTINGS },
  }
  const updater: { get(): AppSettings; update(mutator: (settings: AppSettings) => AppSettings): Promise<void> } = {
    get: () => current,
    update: vi.fn(async (mutator) => {
      if (options.failUpdate) throw new Error('settings write failed')
      current = mutator(current)
    }),
  }
  let snapshot: SettingsTransactionSnapshot = { settings: current, revision: 0, minimumBaseRevision: 0,
    fieldRevisions: { fields: {}, connections: {}, tombstones: {} } }
  const authority: Pick<SettingsAuthority, 'readFresh' | 'getDisplaySnapshot' | 'apply'> = {
    readFresh: async () => structuredClone({ ...snapshot, settings: current }),
    getDisplaySnapshot: () => structuredClone({ ...snapshot, settings: current }),
    apply: async request => {
      let outcome: Awaited<ReturnType<SettingsAuthority['apply']>> | undefined
      await updater.update(settings => {
        const result = reduceSettingsTransaction({ ...snapshot, settings }, request)
        if (result.status === 'prepared') {
          snapshot = result.snapshot
          outcome = { status: 'committed', cleanupPending: false, snapshot: structuredClone(snapshot) }
          return snapshot.settings
        }
        outcome = result
        return settings
      })
      return outcome!
    },
  }
  let sequence = 0
  const actualService = new MainBackgroundService({
    dataRoot: root,
    settings: authority,
    createId: () => `background-${++sequence}`,
    urlFor: async (absolutePath) => {
      await stat(absolutePath)
      return `preview:${absolutePath}`
    },
  })
  // Direct calls below represent new user actions; workflow calls explicitly pass
  // their retained opening observation through the same service.
  const service = {
    get: () => actualService.get(), open: () => actualService.open(), preview: (source: string) => actualService.preview(source),
    apply: async (...args: Parameters<MainBackgroundService['apply']>) => {
      const observation = args[3] ?? (await actualService.open()).observed
      const result = await actualService.apply(args[0], args[1], args[2], observation)
      if ('status' in result) throw new Error('Background settings conflict')
      return { settings: result.settings, imageUrl: result.imageUrl, ...(args[3] ? { observed: result.observed } : {}) }
    },
  }
  return { root, service, updater, settings: () => current }
}

function customizedSettings(): BackgroundSettings {
  return {
    ...DEFAULT_BACKGROUND_SETTINGS,
    imageOpacityPercent: 64,
    maskType: 'diagonal-bottom-right',
    maskOpacityPercent: 18,
    maskTransitionPercent: 72,
  }
}

it('copies a replacement into the managed main-background directory before persisting it', async () => {
  const { root, service, settings } = await fixture()
  const source = path.join(root, 'source.png')
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  await writeFile(source, bytes)

  const result = await service.apply(customizedSettings(), {
    kind: 'replace',
    sourceAbsolutePath: source,
  })

  expect(settings().mainBackground).toEqual({
    ...customizedSettings(),
    imageRelativePath: 'backgrounds/main/background-1.png',
  })
  expect(await readFile(path.join(root, 'backgrounds', 'main', 'background-1.png')))
    .toEqual(bytes)
  expect(result).toEqual({
    settings: settings().mainBackground,
    imageUrl: `preview:${path.join(root, 'backgrounds', 'main', 'background-1.png')}`,
  })
})

it('keeps the old managed image when changing controls and removes it only after replacement', async () => {
  const { root, service, settings } = await fixture()
  const first = path.join(root, 'first.jpg')
  const second = path.join(root, 'second.webp')
  await writeFile(first, 'first')
  await writeFile(second, 'second')

  await service.apply(customizedSettings(), { kind: 'replace', sourceAbsolutePath: first })
  const firstRelativePath = settings().mainBackground!.imageRelativePath!
  const controlsOnly = { ...customizedSettings(), imageOpacityPercent: 31 }
  await service.apply(controlsOnly, { kind: 'keep' })
  expect(settings().mainBackground).toEqual({
    ...controlsOnly,
    imageRelativePath: firstRelativePath,
  })
  expect((await stat(path.join(root, ...firstRelativePath.split('/')))).isFile()).toBe(true)

  await service.apply(controlsOnly, { kind: 'replace', sourceAbsolutePath: second })
  await expect(stat(path.join(root, ...firstRelativePath.split('/')))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(settings().mainBackground!.imageRelativePath)
    .toBe('backgrounds/main/background-2.webp')
})

it('removes the managed image after persisting an explicit removal', async () => {
  const { root, service, settings } = await fixture()
  const source = path.join(root, 'source.bmp')
  await writeFile(source, 'bitmap')
  await service.apply(customizedSettings(), { kind: 'replace', sourceAbsolutePath: source })
  const previous = settings().mainBackground!.imageRelativePath!

  const result = await service.apply(customizedSettings(), { kind: 'remove' })

  expect(result).toEqual({
    settings: { ...customizedSettings(), imageRelativePath: null },
    imageUrl: null,
  })
  await expect(stat(path.join(root, ...previous.split('/')))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('degrades a missing managed image to an empty presentation without losing its controls', async () => {
  const { root, service, settings } = await fixture()
  const source = path.join(root, 'source.png')
  await writeFile(source, 'png')
  await service.apply(customizedSettings(), { kind: 'replace', sourceAbsolutePath: source })
  const relativePath = settings().mainBackground!.imageRelativePath!
  await rm(path.join(root, ...relativePath.split('/')))

  await expect(service.get()).resolves.toEqual({
    settings: settings().mainBackground,
    imageUrl: null,
  })
})

it.each(['gif'])('does not present a persisted unsupported .%s main background', async (extension) => {
  const { root, service, updater, settings } = await fixture()
  const relativePath = `backgrounds/main/untrusted.${extension}`
  const absolutePath = path.join(root, ...relativePath.split('/'))
  await mkdir(path.dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, 'unsupported')
  await updater.update((current) => ({
    ...current,
    mainBackground: { ...customizedSettings(), imageRelativePath: relativePath },
  }))

  await expect(service.get()).resolves.toEqual({
    settings: settings().mainBackground,
    imageUrl: null,
  })
})

it('rejects unsupported, missing, non-file, relative, and symbolic-link sources', async () => {
  const { root, service } = await fixture()
  const gif = path.join(root, 'animated.gif')
  await writeFile(gif, 'gif')
  for (const sourceAbsolutePath of [gif, root, 'relative.png', path.join(root, 'missing.png')]) {
    await expect(service.preview(sourceAbsolutePath)).rejects.toBeTruthy()
  }

  const png = path.join(root, 'source.png')
  const link = path.join(root, 'linked.png')
  await writeFile(png, 'png')
  try {
    await symlink(png, link)
    await expect(service.preview(link)).rejects.toBeTruthy()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  }
})

it('rolls back a copied replacement when settings persistence fails', async () => {
  const { root, service } = await fixture({ failUpdate: true })
  const source = path.join(root, 'source.avif')
  await writeFile(source, 'avif')

  await expect(service.apply(customizedSettings(), {
    kind: 'replace',
    sourceAbsolutePath: source,
  })).rejects.toThrow('settings write failed')

  const directory = path.join(root, 'backgrounds', 'main')
  expect(await readdir(directory).catch(() => [])).toEqual([])
})

it('previews, persists and reopens an ordinary SVG through the managed image path', async () => {
  const { root, service } = await fixture()
  const source = path.join(root, 'wallpaper.svg')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>'
  await writeFile(source, svg, 'utf8')
  await expect(service.preview(source)).resolves.toBe(`preview:${source}`)
  const applied = await service.apply(customizedSettings(), { kind: 'replace', sourceAbsolutePath: source })
  expect(applied.settings.imageRelativePath).toBe('backgrounds/main/background-1.svg')
  await expect(readFile(path.join(root, applied.settings.imageRelativePath!), 'utf8')).resolves.toBe(svg)
  await expect(service.get()).resolves.toEqual(applied)
})

it('settles an admitted transaction after cancellation and serializes the new save after it', async () => {
  const { service, updater, settings } = await fixture()
  let release!: () => void
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
  const pending = new Promise<void>((resolve) => { release = resolve })
  const update = updater.update
  updater.update = async (mutator) => { entered(); await pending; await update(mutator) }
  let active = true
  const old = service.apply({ ...customizedSettings(), imageOpacityPercent: 11 }, { kind: 'keep' }, () => {
    if (!active) throw new Error('stale session')
  })
  const settled = expect(old).resolves.toMatchObject({ settings: { imageOpacityPercent: 11 } })
  await enteredPromise
  active = false
  updater.update = update
  const fresh = service.apply({ ...customizedSettings(), imageOpacityPercent: 88 }, { kind: 'keep' })
  release()
  await settled
  await fresh
  expect(settings().mainBackground!.imageOpacityPercent).toBe(88)
})

it('serializes an already committed old write before a newer accepted save', async () => {
  const { service, updater, settings } = await fixture()
  let release!: () => void
  let entered!: () => void
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
  const pending = new Promise<void>((resolve) => { release = resolve })
  const update = updater.update
  updater.update = async (mutator) => {
    const snapshot = mutator(await updater.get())
    entered()
    await pending
    await update(() => snapshot)
  }
  const old = service.apply({ ...customizedSettings(), imageOpacityPercent: 11 }, { kind: 'keep' })
  await enteredPromise
  updater.update = update
  const fresh = service.apply({ ...customizedSettings(), imageOpacityPercent: 88 }, { kind: 'keep' })
  await Promise.resolve()
  release()
  await Promise.all([old, fresh])
  expect(settings().mainBackground!.imageOpacityPercent).toBe(88)
})

it('initializes a reopened main session from the accepted pending commit and keeps its newer save', async () => {
  const { service, updater, settings } = await fixture()
  const main = { kind: 'main' as const }
  const broadcast = vi.fn()
  const workflow = new BackgroundWorkflow({
    backend: createMainBackgroundBackend(service),
    chooseSource: async () => null,
    broadcast,
  })
  const scopedServices: BackgroundIpcService[] = []
  let reopenedPresentation: Promise<BackgroundPresentation> | undefined
  const registry = new BackgroundSettingsWindowRegistry({
    workflow,
    createWindow: () => {
      const listeners = new Map<string, () => void>()
      return {
        show() {}, focus() {},
        close: () => listeners.get('closed')?.(),
        once: (event, listener) => { listeners.set(event, listener) },
      }
    },
    register: (_window, scoped) => {
      scopedServices.push(scoped)
      // Match the settings renderer's initial read as soon as its window is registered.
      if (scopedServices.length === 2) reopenedPresentation = scoped.get(main)
      return { dispose() {} }
    },
  })
  const owner = {}
  const oldEvents = vi.fn()
  await registry.serviceFor(oldEvents, owner).open(main)

  let release!: () => void
  let entered!: () => void
  const writerEntered = new Promise<void>((resolve) => { entered = resolve })
  const pendingWriter = new Promise<void>((resolve) => { release = resolve })
  const update = updater.update
  updater.update = async (mutator) => {
    const snapshot = mutator(await updater.get())
    entered()
    await pendingWriter
    await update(() => snapshot)
  }
  const oldApply = scopedServices[0]!.apply(main, { ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 11 })
    .then(() => null, (error: unknown) => error)
  await writerEntered
  const closing = registry.closeForOwner(owner)
  const reopened = registry.serviceFor(vi.fn(), {}).open(main)
  // Drain the promise-only initial-read path while the writer remains explicitly blocked.
  await setImmediate()
  updater.update = update
  release()
  const [oldResult] = await Promise.all([oldApply, closing, reopened])
  const initial = await reopenedPresentation!
  const persistedAfterCommit = settings().mainBackground!.imageOpacityPercent
  const refreshCount = broadcast.mock.calls.length + oldEvents.mock.calls.length
  await scopedServices[1]!.apply(main, { ...initial.settings, imageOpacityPercent: 88 })

  expect(oldResult).toMatchObject({ message: 'Background settings session is unavailable' })
  expect(initial.settings.imageOpacityPercent).toBe(11)
  expect(persistedAfterCommit).toBe(11)
  expect(refreshCount).toBe(0)
  expect(settings().mainBackground!.imageOpacityPercent).toBe(88)
  await expect(scopedServices[1]!.get(main)).resolves.toMatchObject({
    settings: { imageOpacityPercent: 88 },
  })
  await registry.closeAll()
})
