import type { ArknotePreferences } from '../../shared/arknote-preferences'
import type { EditorAppearancePreferences } from '../../shared/editor-appearance-preferences'
import type { BrowserSearchPreferences } from '../../shared/search-preferences'
import type { LayoutPreferences } from '../../shared/layout-preferences'
import { SHORTCUT_DEFINITIONS } from '../../shared/keyboard-shortcuts'

export interface PreferenceUpdate {
  search?: Partial<BrowserSearchPreferences>
  appearance?: Partial<EditorAppearancePreferences>
  layout?: Partial<LayoutPreferences>
  arknote?: Partial<ArknotePreferences>
}

export interface PreferenceUpdateQueue {
  enqueue(update: PreferenceUpdate): void
  outstanding(): PreferenceUpdate
  /** Idle only. Use drain when successful persistence is required. */
  settled(): Promise<void>
  drain(): Promise<PreferenceDrainOutcome>
}

export type ExternalPreferenceCategory = 'shell.documentOpenMenu' | 'shell.markdownShellNew' | `shortcut.${string}` | 'models'
export type PreferenceCategory = keyof PreferenceUpdate | ExternalPreferenceCategory
export type PreferenceFailure = { ok: false; message: string; persisted: boolean }
export type PreferenceBatchResult = Partial<Record<PreferenceCategory, { ok: true } | PreferenceFailure>>
export type PreferenceDrainOutcome = { ok: true } | { ok: false; failedCategories: readonly PreferenceCategory[] }
export interface PreferencePersistenceSnapshot {
  /** Category attempts, including coalesced queued categories; not fields or files. */
  outstandingCategories: number
  completedCategories: number
  failures: Partial<Record<PreferenceCategory, PreferenceFailure>>
}
interface QueueOptions {
  /** Pending ownership starts immediately, including this UI coalescing delay. */
  coalesceMs?: number
  write(update: PreferenceUpdate): Promise<PreferenceBatchResult>
  onSettled(): void
  onError(error: unknown): void
}
export interface PreferencePersistence {
  createQueue(options: QueueOptions): PreferenceUpdateQueue
  /** Register before invoking a finite external control; rejection remains a close-blocking failure. */
  runExternal<T>(category: ExternalPreferenceCategory, operation: () => Promise<T>): Promise<T>
  drain(): Promise<PreferenceDrainOutcome>
  snapshot(): PreferencePersistenceSnapshot
}

const queuedCategories: readonly (keyof PreferenceUpdate)[] = ['search', 'appearance', 'arknote', 'layout']
const externalCategories: readonly ExternalPreferenceCategory[] = ['shell.documentOpenMenu', 'shell.markdownShellNew', 'models',
  'shortcut.resetAll', ...SHORTCUT_DEFINITIONS.map(item => `shortcut.${item.id}` as const)]
const categories: readonly PreferenceCategory[] = [...queuedCategories, ...externalCategories]
const editedCategories = (update: PreferenceUpdate) => queuedCategories.filter(category => update[category] !== undefined)
const failed = (): PreferenceFailure => ({ ok: false, message: '设置保存失败，请重新调整该设置以重试。', persisted: false })
function notify(callback: () => void): void {
  try { callback() } catch { /* Observer failure cannot change persistence or stop later writes. */ }
}

function mergeUpdates(previous: PreferenceUpdate, next: PreferenceUpdate): PreferenceUpdate {
  return {
    ...(previous.search || next.search ? { search: { ...previous.search, ...next.search } } : {}),
    ...(previous.appearance || next.appearance
      ? { appearance: { ...previous.appearance, ...next.appearance } } : {}),
    ...(previous.arknote || next.arknote
      ? { arknote: { ...previous.arknote, ...next.arknote } } : {}),
    ...(previous.layout || next.layout ? { layout: { ...previous.layout, ...next.layout } } : {}),
  }
}

/** One App-lifetime result owner; queues still own scheduling and never replay writes. */
export function createPreferencePersistence(): PreferencePersistence {
  const failures: Partial<Record<PreferenceCategory, PreferenceFailure>> = {}
  const latestAttempt: Partial<Record<PreferenceCategory, number>> = {}
  const pending = new Map<Promise<void>, () => number>()
  let attempt = 0
  let completedCategories = 0
  const drain = async (): Promise<PreferenceDrainOutcome> => {
    while (pending.size > 0) await Promise.all([...pending.keys()])
    const failedCategories = categories.filter(category => failures[category] !== undefined)
    return failedCategories.length ? { ok: false, failedCategories } : { ok: true }
  }
  return {
    drain,
    runExternal: (category, operation) => {
      if (!externalCategories.includes(category)) return Promise.reject(new Error('PREFERENCE_CATEGORY_INVALID'))
      const generation = ++attempt
      latestAttempt[category] = generation
      const running = Promise.resolve().then(operation)
      const completion = running.then(() => {
        if (latestAttempt[category] === generation) delete failures[category]
      }, (error: unknown) => {
        if (latestAttempt[category] === generation) failures[category] = {
          ok: false, message: error instanceof Error ? error.message : failed().message, persisted: false,
        }
      }).finally(() => { completedCategories += 1; pending.delete(completion) })
      pending.set(completion, () => 1)
      return running
    },
    snapshot: () => ({
      outstandingCategories: [...pending.values()].reduce((total, count) => total + count(), 0),
      completedCategories,
      failures: structuredClone(failures),
    }),
    createQueue: options => {
      let queued: PreferenceUpdate = {}
      let inFlight: PreferenceUpdate = {}
      let running: Promise<void> | null = null
      const hasQueued = () => editedCategories(queued).length > 0
      const start = () => {
        if (running || !hasQueued()) return
        // One microtask coalesces one interaction. Register its drain immediately,
        // so closing before that microtask still observes the queued work.
        const work = Promise.resolve().then(async () => {
          while (hasQueued()) {
            if (options.coalesceMs) await new Promise<void>(resolve => setTimeout(resolve, options.coalesceMs))
            inFlight = queued
            queued = {}
            const batchCategories = editedCategories(inFlight)
            const generation = ++attempt
            for (const category of batchCategories) latestAttempt[category] = generation
            let result: PreferenceBatchResult = {}
            try { result = await options.write(inFlight) }
            catch (error) { notify(() => options.onError(error)) }
            for (const category of batchCategories) {
              if (latestAttempt[category] !== generation) continue
              const outcome = result?.[category] ?? failed()
              if (outcome.ok) delete failures[category]
              else failures[category] = { ...outcome }
            }
            completedCategories += batchCategories.length
            inFlight = {}
            notify(options.onSettled)
          }
        }).finally(() => {
          pending.delete(work)
          running = null
          start()
        })
        running = work
        pending.set(work, () => editedCategories(inFlight).length + editedCategories(queued).length)
      }
      return {
        enqueue: update => { queued = mergeUpdates(queued, update); start() },
        outstanding: () => mergeUpdates(inFlight, queued),
        settled: async () => { while (running) await running },
        drain,
      }
    },
  }
}

export function createPreferenceUpdateQueue(options: QueueOptions): PreferenceUpdateQueue {
  return createPreferencePersistence().createQueue(options)
}
