import {
  MERMAID_MAX_BLOCKS,
  MERMAID_PRINT_BATCH_BUDGET_MS,
  MERMAID_QUEUE_LIMIT,
  type MermaidAppearance,
  type MermaidRenderable,
  type MermaidRegistryPort,
} from './mermaid-types'

export class MermaidRegistryCapacityError extends Error {
  readonly code = 'MERMAID_MAX_BLOCKS' as const
  readonly limit = MERMAID_MAX_BLOCKS

  constructor() {
    super(`Mermaid view registry capacity exceeded (${MERMAID_MAX_BLOCKS})`)
    this.name = 'MermaidRegistryCapacityError'
  }
}

interface TrackedTask {
  generation: number
  task: Promise<unknown>
}

function sameAppearance(left: MermaidAppearance, right: MermaidAppearance): boolean {
  return (
    left.revision === right.revision &&
    left.editorTheme === right.editorTheme &&
    left.colorScheme === right.colorScheme &&
    left.themeColor === right.themeColor &&
    left.bodyFontFamily === right.bodyFontFamily
  )
}

async function settlesWithin(task: Promise<void>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return false
  let timeout: ReturnType<typeof setTimeout> | null = null
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs)
  })
  try {
    return await Promise.race([task.then(() => true as const), expired])
  } finally {
    if (timeout !== null) clearTimeout(timeout)
  }
}

export function createMermaidViewRegistry(initialAppearance: MermaidAppearance): MermaidRegistryPort {
  let currentAppearance = { ...initialAppearance }
  let disposed = false
  let taskRevision = 0
  const views = new Map<MermaidRenderable, number>()
  let viewCount = 0
  const capacityListeners = new Set<() => void>()
  const tasks = new Map<string, TrackedTask>()

  const settle = (instanceId: string, generation: number, task: Promise<unknown>) => {
    const tracked = tasks.get(instanceId)
    if (!tracked || tracked.generation !== generation || tracked.task !== task) return
    tasks.delete(instanceId)
    taskRevision += 1
  }

  const whenIdle = async (): Promise<void> => {
    while (!disposed) {
      const revision = taskRevision
      const snapshot = [...tasks.values()].map(({ task }) => task)
      await Promise.allSettled(snapshot)
      if (revision === taskRevision) return
    }
  }

  return {
    appearance: () => ({ ...currentAppearance }),

    register: (view) => {
      if (disposed) return () => undefined
      if (viewCount >= MERMAID_MAX_BLOCKS) throw new MermaidRegistryCapacityError()
      views.set(view, (views.get(view) ?? 0) + 1)
      viewCount += 1
      let active = true
      return () => {
        if (!active) return
        active = false
        const count = views.get(view)
        if (count === undefined) return
        if (count === 1) views.delete(view)
        else views.set(view, count - 1)
        viewCount -= 1
        for (const listener of [...capacityListeners]) listener()
      }
    },

    subscribeCapacityAvailable: (listener) => {
      if (disposed) return () => undefined
      capacityListeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        capacityListeners.delete(listener)
      }
    },

    track: (instanceId, generation, task) => {
      if (disposed) return
      const previous = tasks.get(instanceId)
      if (previous && previous.generation > generation) return

      tasks.set(instanceId, { generation, task })
      taskRevision += 1
      Promise.resolve(task).then(
        () => settle(instanceId, generation, task),
        () => settle(instanceId, generation, task),
      )
    },

    refreshAppearance: (next) => {
      if (disposed || sameAppearance(currentAppearance, next)) return
      currentAppearance = { ...next }
      for (const view of views.keys()) view.refresh('theme')
    },

    renderAll: async (deadlineEpochMs) => {
      if (disposed) return
      const snapshot = [...views.keys()]
      const deadline = Math.min(
        Date.now() + MERMAID_PRINT_BATCH_BUDGET_MS,
        deadlineEpochMs ?? Number.POSITIVE_INFINITY,
      )
      let cursor = 0
      let timedOut = false
      const freezeAfterPrint = deadlineEpochMs !== undefined
      for (const view of snapshot) view.preparePrint(freezeAfterPrint)
      if (tasks.size > 0 && !await settlesWithin(whenIdle(), deadline - Date.now())) timedOut = true
      while (!timedOut && cursor < snapshot.length) {
        if (disposed) return
        if (Date.now() >= deadline) {
          timedOut = true
          break
        }
        const batch = snapshot.slice(cursor, cursor + MERMAID_QUEUE_LIMIT)
        cursor += batch.length
        for (const view of batch) view.refresh('print')
        if (!await settlesWithin(whenIdle(), deadline - Date.now())) {
          timedOut = true
          break
        }
      }
      if (disposed || !timedOut) return
      for (const view of snapshot) view.finishPrintTimeout()
      tasks.clear()
      taskRevision += 1
    },

    whenIdle,

    dispose: () => {
      if (disposed) return
      disposed = true
      views.clear()
      viewCount = 0
      capacityListeners.clear()
      tasks.clear()
      taskRevision += 1
    },
  }
}
