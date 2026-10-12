export class ArknoteTaskbarPreferenceError extends Error {
  constructor(readonly code: 'save-failed' | 'apply-failed') { super(code); this.name = 'ArknoteTaskbarPreferenceError' }
}

/** One user action may retry native application without rewriting an already saved value. */
export function createArknoteTaskbarPreferenceChange(hidden: boolean,
  dependencies: Parameters<typeof applyArknoteTaskbarPreference>[1]): () => Promise<void> {
  let committed = false
  return () => applyArknoteTaskbarPreference(hidden, {
    windows: dependencies.windows,
    persist: async value => {
      if (committed) return
      await dependencies.persist(value)
      committed = true
    },
  })
}

/** Persistence is the source of truth. This never closes, recreates or moves a note. */
export async function applyArknoteTaskbarPreference(hidden: boolean, dependencies: {
  persist(hidden: boolean): Promise<void>
  windows(): Iterable<{ isDestroyed(): boolean; setSkipTaskbar(hidden: boolean): void }>
}): Promise<void> {
  try { await dependencies.persist(hidden) }
  catch { throw new ArknoteTaskbarPreferenceError('save-failed') }
  let failed = false
  for (const window of dependencies.windows()) {
    try { if (!window.isDestroyed()) window.setSkipTaskbar(hidden) }
    catch {
      try { if (!window.isDestroyed()) failed = true }
      catch { failed = true }
    }
  }
  if (failed) throw new ArknoteTaskbarPreferenceError('apply-failed')
}
