import { expect, it, vi } from 'vitest'
import { createPreferencePersistence, createPreferenceUpdateQueue, type PreferenceBatchResult, type PreferenceUpdate } from '../../src/renderer/settings/preference-update-queue'

const saved = (update: PreferenceUpdate): PreferenceBatchResult => Object.fromEntries(Object.keys(update).map(category => [category, { ok: true }]))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

it('tracks external attempts immediately and retains their failure after idle and unrelated success', async () => {
  const owner = createPreferencePersistence(), release = deferred()
  const operation = owner.runExternal('shell.documentOpenMenu', async () => { await release.promise; throw new Error('conflict') })
  expect(owner.snapshot().outstandingCategories).toBe(1)
  const rejected = expect(operation).rejects.toThrow('conflict')
  const draining = owner.drain()
  release.resolve()
  await rejected
  expect(await draining).toEqual({ ok: false, failedCategories: ['shell.documentOpenMenu'] })
  await owner.runExternal('shell.markdownShellNew', async () => true)
  expect(await owner.drain()).toEqual({ ok: false, failedCategories: ['shell.documentOpenMenu'] })
  expect(owner.snapshot().outstandingCategories).toBe(0)
  await owner.runExternal('shell.documentOpenMenu', async () => true)
  expect(await owner.drain()).toEqual({ ok: true })
})

it('does not let an older external completion clear a newer failed attempt', async () => {
  const owner = createPreferencePersistence(), release = deferred()
  const older = owner.runExternal('shell.documentOpenMenu', async () => release.promise)
  await expect(owner.runExternal('shell.documentOpenMenu', async () => { throw new Error('newer conflict') })).rejects.toThrow()
  release.resolve()
  await older
  expect(await owner.drain()).toEqual({ ok: false, failedCategories: ['shell.documentOpenMenu'] })
})

it('bounds external shortcut result keys to the stable action catalog', async () => {
  const owner = createPreferencePersistence(), work = vi.fn(async () => {})
  await expect(owner.runExternal('shortcut.arbitrary-path', work)).rejects.toThrow('PREFERENCE_CATEGORY_INVALID')
  expect(work).not.toHaveBeenCalled()
  expect(owner.snapshot().outstandingCategories).toBe(0)
  await owner.runExternal('shortcut.file.save', work)
  expect(work).toHaveBeenCalledOnce()
})

it('coalesces unsent changes by category and keeps the last value of each edited field', async () => {
  const write = vi.fn(async (update: PreferenceUpdate) => saved(update))
  const queue = createPreferenceUpdateQueue({ write, onSettled: vi.fn(), onError: vi.fn() })
  queue.enqueue({ appearance: { minimumContentMarginPx: 70, bodyLatinFont: 'Arial' } })
  queue.enqueue({ search: { provider: 'google', customTemplate: '' } })
  queue.enqueue({ appearance: { minimumContentMarginPx: 50 } })
  await queue.settled()
  expect(write).toHaveBeenCalledExactlyOnceWith({
    search: { provider: 'google', customTemplate: '' },
    appearance: { minimumContentMarginPx: 50, bodyLatinFont: 'Arial' },
  })
  expect(queue.outstanding()).toEqual({})
})

it('serializes writes and retains a newer value even when it returns to the original value', async () => {
  const started = deferred()
  const release = deferred()
  const write = vi.fn(async (update: PreferenceUpdate) => {
    if (write.mock.calls.length === 1) {
      started.resolve()
      await release.promise
    }
    return saved(update)
  })
  const queue = createPreferenceUpdateQueue({ write, onSettled: vi.fn(), onError: vi.fn() })
  queue.enqueue({ appearance: { minimumContentMarginPx: 90 } })
  await Promise.race([started.promise, Promise.resolve().then(() => Promise.resolve())])
  expect(write).toHaveBeenCalledTimes(1)
  queue.enqueue({ appearance: { minimumContentMarginPx: 50, maximumContentWidthPx: 900 } })
  expect(queue.outstanding()).toEqual({
    appearance: { minimumContentMarginPx: 50, maximumContentWidthPx: 900 },
  })
  expect(write).toHaveBeenCalledTimes(1)
  release.resolve()
  await queue.settled()
  expect(write).toHaveBeenNthCalledWith(2, {
    appearance: { minimumContentMarginPx: 50, maximumContentWidthPx: 900 },
  })
})

it('reports a failed batch but still drains later edits without replaying the failed batch', async () => {
  const release = deferred()
  const failure = new Error('preference write failed')
  const onError = vi.fn()
  const write = vi.fn(async (update: PreferenceUpdate) => {
    if (write.mock.calls.length === 1) {
      await release.promise
      throw failure
    }
    return saved(update)
  })
  const queue = createPreferenceUpdateQueue({ write, onSettled: vi.fn(), onError })
  queue.enqueue({ search: { provider: 'google', customTemplate: '' } })
  await Promise.resolve()
  expect(write).toHaveBeenCalledTimes(1)
  queue.enqueue({ search: { provider: 'bing', customTemplate: '' } })
  release.resolve()
  await queue.settled()
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
  expect(write).toHaveBeenCalledTimes(2)
  expect(write).toHaveBeenLastCalledWith({ search: { provider: 'bing', customTemplate: '' } })
  expect(queue.outstanding()).toEqual({})
})

it('includes changes enqueued during settlement in the same drain', async () => {
  const write = vi.fn(async (update: PreferenceUpdate) => saved(update))
  const onSettled = vi.fn(() => {
    if (onSettled.mock.calls.length === 1) {
      queue.enqueue({ arknote: { launchAtLogin: true } })
    }
  })
  const queue = createPreferenceUpdateQueue({ write, onSettled, onError: vi.fn() })
  queue.enqueue({ search: { provider: 'google', customTemplate: '' } })
  await queue.settled()
  expect(write).toHaveBeenCalledTimes(2)
  expect(write).toHaveBeenLastCalledWith({ arknote: { launchAtLogin: true } })
})

it('retains per-category failure after settlement and unrelated successful writes', async () => {
  const queue = createPreferenceUpdateQueue({
    write: async update => update.search ? { search: { ok: false, message: 'failed', persisted: false } } : saved(update),
    onSettled: vi.fn(), onError: vi.fn(),
  })
  queue.enqueue({ search: { provider: 'google', customTemplate: '' } })
  await queue.settled()
  expect(await queue.drain()).toEqual({ ok: false, failedCategories: ['search'] })
  queue.enqueue({ appearance: { bodyLatinFont: 'Arial' } })
  expect(await queue.drain()).toEqual({ ok: false, failedCategories: ['search'] })
})

it('clears failure only after the same category acknowledges successful retry', async () => {
  const retry = deferred()
  const persistence = createPreferencePersistence()
  const write = vi.fn(async (update: PreferenceUpdate): Promise<PreferenceBatchResult> => {
    if (write.mock.calls.length === 1) return { search: { ok: false, message: 'failed', persisted: false } }
    await retry.promise
    return saved(update)
  })
  const queue = persistence.createQueue({ write, onSettled: vi.fn(), onError: vi.fn() })
  queue.enqueue({ search: { provider: 'google', customTemplate: '' } })
  await queue.drain()
  queue.enqueue({ search: { provider: 'bing', customTemplate: '' } })
  await Promise.resolve()
  expect(persistence.snapshot()).toMatchObject({ outstandingCategories: 1, completedCategories: 1, failures: { search: { persisted: false } } })
  let completed = false
  const drain = persistence.drain().then(result => { completed = true; return result })
  await Promise.resolve()
  expect(completed).toBe(false)
  retry.resolve()
  expect(await drain).toEqual({ ok: true })
  expect(persistence.snapshot()).toEqual({ outstandingCategories: 0, completedCategories: 2, failures: {} })
})

it('records explicit partial batch success and fails closed for a missing category result', async () => {
  const persistence = createPreferencePersistence()
  const queue = persistence.createQueue({ write: async () => ({ search: { ok: true } }), onSettled: vi.fn(), onError: vi.fn() })
  queue.enqueue({ search: { provider: 'google', customTemplate: '' }, appearance: { bodyLatinFont: 'Arial' } })
  expect(await queue.drain()).toEqual({ ok: false, failedCategories: ['appearance'] })
  expect(persistence.snapshot().failures.appearance?.persisted).toBe(false)
})

it('retains saved-but-not-applied details without automatically replaying persistence', async () => {
  const persistence = createPreferencePersistence()
  const write = vi.fn(async (): Promise<PreferenceBatchResult> => ({ arknote: { ok: false, message: 'saved; apply failed', persisted: true } }))
  const queue = persistence.createQueue({ write, onSettled: vi.fn(), onError: vi.fn() })
  queue.enqueue({ arknote: { launchAtLogin: true } })
  expect(await queue.drain()).toEqual({ ok: false, failedCategories: ['arknote'] })
  expect(await queue.drain()).toEqual({ ok: false, failedCategories: ['arknote'] })
  expect(persistence.snapshot().failures.arknote).toEqual({ ok: false, message: 'saved; apply failed', persisted: true })
  expect(write).toHaveBeenCalledOnce()
})

it('shares failure and pending ownership across replacement shell queues', async () => {
  const persistence = createPreferencePersistence()
  const pending = deferred()
  const old = persistence.createQueue({ write: async () => { await pending.promise; throw new Error('old failed') }, onSettled: vi.fn(), onError: vi.fn() })
  old.enqueue({ search: { provider: 'google', customTemplate: '' } })
  const replacement = persistence.createQueue({ write: async update => saved(update), onSettled: vi.fn(), onError: vi.fn() })
  replacement.enqueue({ arknote: { launchAtLogin: true } })
  const drain = persistence.drain()
  pending.resolve()
  expect(await drain).toEqual({ ok: false, failedCategories: ['search'] })
  replacement.enqueue({ search: { provider: 'bing', customTemplate: '' } })
  expect(await persistence.drain()).toEqual({ ok: true })
})

it('does not let an older successful completion erase a newer failure', async () => {
  const persistence = createPreferencePersistence()
  const oldCompletion = deferred()
  const old = persistence.createQueue({ write: async update => { await oldCompletion.promise; return saved(update) }, onSettled: vi.fn(), onError: vi.fn() })
  old.enqueue({ search: { provider: 'google', customTemplate: '' } })
  await Promise.resolve()
  const newer = persistence.createQueue({ write: async () => ({ search: { ok: false, message: 'new failed', persisted: false } }), onSettled: vi.fn(), onError: vi.fn() })
  newer.enqueue({ search: { provider: 'bing', customTemplate: '' } })
  await newer.settled()
  oldCompletion.resolve()
  expect(await persistence.drain()).toEqual({ ok: false, failedCategories: ['search'] })
})

it('does not let notification failures poison later writes or the success barrier', async () => {
  const write = vi.fn(async (update: PreferenceUpdate) => {
    if (write.mock.calls.length === 1) throw new Error('failed')
    return saved(update)
  })
  const queue = createPreferenceUpdateQueue({ write, onSettled: () => { throw new Error('observer') }, onError: () => { throw new Error('observer') } })
  queue.enqueue({ search: { provider: 'google', customTemplate: '' } })
  expect(await queue.drain()).toEqual({ ok: false, failedCategories: ['search'] })
  queue.enqueue({ search: { provider: 'bing', customTemplate: '' } })
  expect(await queue.drain()).toEqual({ ok: true })
})

it('merges only explicitly edited search fields and includes layout failure in the success barrier', async () => {
  const write = vi.fn(async (): Promise<PreferenceBatchResult> => ({
    search: { ok: true }, layout: { ok: false, message: 'layout conflict', persisted: false },
  }))
  const queue = createPreferenceUpdateQueue({ write, onSettled: vi.fn(), onError: vi.fn() })
  queue.enqueue({ search: { provider: 'custom' }, layout: { leftSidebarWidth: 300 } })
  queue.enqueue({ search: { customTemplate: 'https://example.com/?q={query}' }, layout: { rightSidebarWidth: 500 } })
  expect(await queue.drain()).toEqual({ ok: false, failedCategories: ['layout'] })
  expect(write).toHaveBeenCalledExactlyOnceWith({ search: { provider: 'custom', customTemplate: 'https://example.com/?q={query}' },
    layout: { leftSidebarWidth: 300, rightSidebarWidth: 500 } })
})

it('registers a delayed layout coalescing batch in drain before its timer runs', async () => {
  vi.useFakeTimers()
  try {
    const write = vi.fn(async (update: PreferenceUpdate) => saved(update))
    const queue = createPreferenceUpdateQueue({ write, coalesceMs: 180, onSettled: vi.fn(), onError: vi.fn() })
    queue.enqueue({ layout: { leftSidebarWidth: 310 } })
    let drained = false
    const drain = queue.drain().then(result => { drained = true; return result })
    await vi.advanceTimersByTimeAsync(179)
    expect(write).not.toHaveBeenCalled()
    expect(drained).toBe(false)
    queue.enqueue({ layout: { leftSidebarWidth: 320, rightSidebarWidth: 600 } })
    await vi.advanceTimersByTimeAsync(1)
    expect(await drain).toEqual({ ok: true })
    expect(write).toHaveBeenCalledExactlyOnceWith({ layout: { leftSidebarWidth: 320, rightSidebarWidth: 600 } })
  } finally { vi.useRealTimers() }
})
