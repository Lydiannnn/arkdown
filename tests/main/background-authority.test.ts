import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MainBackgroundService } from '../../src/main/backgrounds/background-service'
import { BackgroundWorkflow } from '../../src/main/backgrounds/background-workflow'
import { createMainBackgroundBackend } from '../../src/main/backgrounds/background-backends'
import { DEFAULT_SETTINGS } from '../../src/main/settings/settings-store'
import { reduceSettingsTransaction } from '../../src/main/settings/settings-transaction-reducer'
import type { SettingsTransactionRequest, SettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-types'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-background-authority-')); roots.push(root)
  let current: SettingsTransactionSnapshot = { settings: structuredClone(DEFAULT_SETTINGS), revision: 0,
    minimumBaseRevision: 0, fieldRevisions: { fields: {}, connections: {}, tombstones: {} } }
  const authority = {
    // Legacy entrypoints expose the unsafe behavior before the caller migration.
    get: async () => structuredClone(current.settings),
    update: async (mutator: (settings: typeof current.settings) => typeof current.settings) => {
      current.settings = mutator(current.settings)
    },
    readFresh: vi.fn(async () => structuredClone(current)), getDisplaySnapshot: () => structuredClone(current),
    apply: vi.fn(async (request: SettingsTransactionRequest) => {
      const result = reduceSettingsTransaction(current, request)
      if (result.status !== 'prepared') return result
      current = result.snapshot
      return { status: 'committed' as const, snapshot: structuredClone(current), cleanupPending: true }
    }),
  }
  let id = 0
  const service = new MainBackgroundService({ dataRoot: root, settings: authority, createId: () => `test-${++id}`,
    urlFor: async value => `asset:${value}` })
  const workflow = new BackgroundWorkflow({ backend: createMainBackgroundBackend(service),
    chooseSource: async () => path.join(root, 'source.png'), broadcast: vi.fn() })
  const external = async (field: string, value: unknown) => {
    const background = current.settings.mainBackground ?? DEFAULT_BACKGROUND_SETTINGS
    await authority.apply({ baseRevision: current.revision, operations: [{ kind: 'main-background.apply',
      changes: field === 'imageRelativePath' ? {} : { [field]: { value, expected: {
        value: background[field as keyof typeof background], revision: current.fieldRevisions.fields[`mainBackground.${field}`] ?? 0 } } },
      image: field === 'imageRelativePath' ? { kind: 'replace', relativePath: value as string, expected: {
        value: background.imageRelativePath, revision: current.fieldRevisions.fields['mainBackground.imageRelativePath'] ?? 0 } } : { kind: 'keep' },
    }] })
  }
  return { root, service, workflow, authority, external, current: () => structuredClone(current) }
}
const main = { kind: 'main' as const }

it('keeps the actual opened observation across reads and failed retries, detecting same-field ABA', async () => {
  const f = await fixture()
  await f.workflow.begin(main, vi.fn())
  await f.external('imageOpacityPercent', 70); await f.external('imageOpacityPercent', 50)
  expect((await f.workflow.get(main)).settings.imageOpacityPercent).toBe(50)
  const candidate = { ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 77 }
  expect(await f.workflow.apply(main, candidate)).toEqual({ status: 'conflict' })
  expect(await f.workflow.apply(main, candidate)).toEqual({ status: 'conflict' })
  expect(f.current().settings.mainBackground?.imageOpacityPercent).toBe(50)
})

it('serves an opened draft from the original session while display reads may refresh, and rejects invalidation before admission', async () => {
  const f = await fixture(); await f.workflow.begin(main, vi.fn())
  await f.external('imageOpacityPercent', 70)
  expect((await f.workflow.getSession(main)).settings.imageOpacityPercent).toBe(50)
  expect((await f.workflow.get(main)).settings.imageOpacityPercent).toBe(70)
  const original = await f.service.open()
  const before = f.authority.apply.mock.calls.length
  await expect(f.service.apply({ ...original.settings, imageOpacityPercent: 88 }, { kind: 'keep' },
    () => { throw new Error('stale session') }, original.observed)).rejects.toThrow('stale session')
  expect(f.authority.apply.mock.calls).toHaveLength(before)
  expect(f.current().settings.mainBackground?.imageOpacityPercent).toBe(70)
})

it('merges only edited controls and keeps a newly committed image when the open draft chose keep', async () => {
  const f = await fixture(); await f.workflow.begin(main, vi.fn())
  await f.external('imageRelativePath', 'backgrounds/main/new.png'); await f.external('maskOpacityPercent', 29)
  expect(await f.workflow.apply(main, { ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 77 })).toMatchObject({
    settings: { imageRelativePath: 'backgrounds/main/new.png', maskOpacityPercent: 29, imageOpacityPercent: 77 },
  })
})

it('deletes only an uncommitted copied candidate on conflict and retains a committed cleanup-pending image', async () => {
  const f = await fixture(); await writeFile(path.join(f.root, 'source.png'), 'synthetic')
  await f.workflow.begin(main, vi.fn()); await f.workflow.choose(main)
  await f.external('imageRelativePath', 'backgrounds/main/other.png')
  expect(await f.workflow.apply(main, DEFAULT_BACKGROUND_SETTINGS)).toEqual({ status: 'conflict' })
  expect(await readdir(path.join(f.root, 'backgrounds/main'))).toEqual([])
  await f.workflow.begin(main, vi.fn()); await f.workflow.choose(main)
  const applied = await f.workflow.apply(main, DEFAULT_BACKGROUND_SETTINGS)
  expect(applied).toMatchObject({ settings: { imageRelativePath: 'backgrounds/main/test-2.png' } })
  expect(await readFile(path.join(f.root, 'backgrounds/main/test-2.png'), 'utf8')).toBe('synthetic')
})
