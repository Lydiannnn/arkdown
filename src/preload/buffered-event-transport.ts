export interface BufferedEventTransport<T> {
  subscribe(listener: (value: T) => void): () => void
}

export interface PreparedBufferedValue<T> {
  value: T
  groupKey: string
  byteLength: number
  phase: 'started' | 'progress' | 'terminal'
}

export type BufferedEventPolicy<T> =
  | { mode: 'latest' }
  | {
      mode: 'queue'
      maxPending: number
      maxPendingBytes: number
      maxClosedGroups: number
      prepare(value: T): PreparedBufferedValue<T> | undefined
      overflow(groupKey: string): PreparedBufferedValue<T>
      onOverflow?(groupKey: string): void
    }

export function createBufferedEventTransport<T>(
  register: (listener: (value: T) => void) => void,
  policy: BufferedEventPolicy<T> = { mode: 'latest' },
): BufferedEventTransport<T> {
  const listeners = new Set<(value: T) => void>()
  const pending: PreparedBufferedValue<T>[] = []
  const activeGroups = new Set<string>()
  const closedGroups = new Set<string>()
  let pendingBytes = 0

  const removeGroup = (groupKey: string): number => {
    const firstIndex = pending.findIndex((event) => event.groupKey === groupKey)
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (pending[index]!.groupKey !== groupKey) continue
      pendingBytes -= pending[index]!.byteLength
      pending.splice(index, 1)
    }
    return firstIndex
  }

  const groupFootprint = (groupKey: string) => {
    let count = 0
    let byteLength = 0
    for (const event of pending) {
      if (event.groupKey !== groupKey) continue
      count += 1
      byteLength += event.byteLength
    }
    return { count, byteLength }
  }

  // Set iteration order provides a fixed-cap FIFO of recently closed IDs.
  const markClosed = (groupKey: string) => {
    if (policy.mode !== 'queue' || closedGroups.has(groupKey)) return
    closedGroups.add(groupKey)
    while (closedGroups.size > policy.maxClosedGroups) {
      const oldest = closedGroups.values().next().value
      if (oldest === undefined) return
      closedGroups.delete(oldest)
    }
  }

  const replaceGroupWithFailure = (groupKey: string): boolean => {
    if (policy.mode !== 'queue') return false
    const failure = policy.overflow(groupKey)
    const footprint = groupFootprint(groupKey)
    if (
      footprint.count <= 1
      && footprint.byteLength <= failure.byteLength
    ) return false

    const firstIndex = removeGroup(groupKey)
    pending.splice(firstIndex, 0, failure)
    pendingBytes += failure.byteLength
    markClosed(groupKey)
    activeGroups.delete(groupKey)
    policy.onOverflow?.(groupKey)
    return true
  }

  const hasCapacityFor = (event: PreparedBufferedValue<T>) => (
    pending.length < (policy.mode === 'queue' ? policy.maxPending : 0)
    && pendingBytes + event.byteLength
      <= (policy.mode === 'queue' ? policy.maxPendingBytes : 0)
  )

  const retainOverflow = (groupKey: string) => {
    if (policy.mode !== 'queue') return
    activeGroups.delete(groupKey)
    removeGroup(groupKey)
    markClosed(groupKey)
    const failure = policy.overflow(groupKey)

    while (!hasCapacityFor(failure)) {
      const candidate = pending.find((event) => {
        const footprint = groupFootprint(event.groupKey)
        const candidateFailure = policy.overflow(event.groupKey)
        return (
          footprint.count > 1
          || footprint.byteLength > candidateFailure.byteLength
        )
      })
      if (!candidate || !replaceGroupWithFailure(candidate.groupKey)) break
    }

    policy.onOverflow?.(groupKey)
    if (!hasCapacityFor(failure)) return
    pending.push(failure)
    pendingBytes += failure.byteLength
  }

  register((value) => {
    if (policy.mode === 'queue') {
      const prepared = policy.prepare(value)
      if (!prepared) return

      if (closedGroups.has(prepared.groupKey)) return
      if (prepared.phase === 'started') {
        if (activeGroups.has(prepared.groupKey)) return
        if (activeGroups.size >= policy.maxPending) {
          if (listeners.size === 0) {
            retainOverflow(prepared.groupKey)
          } else {
            markClosed(prepared.groupKey)
            policy.onOverflow?.(prepared.groupKey)
            const failure = policy.overflow(prepared.groupKey)
            for (const listener of listeners) listener(failure.value)
          }
          return
        }
        activeGroups.add(prepared.groupKey)
      } else {
        if (!activeGroups.has(prepared.groupKey)) return
        if (prepared.phase === 'terminal') activeGroups.delete(prepared.groupKey)
      }

      if (listeners.size !== 0) {
        for (const listener of listeners) listener(prepared.value)
        return
      }
      if (!hasCapacityFor(prepared)) {
        retainOverflow(prepared.groupKey)
        return
      }
      pending.push(prepared)
      pendingBytes += prepared.byteLength
      return
    }

    if (listeners.size === 0) {
      pending.splice(0, pending.length, {
        value,
        groupKey: '',
        byteLength: 0,
        phase: 'progress',
      })
      return
    }
    for (const listener of listeners) listener(value)
  })

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (pending.length > 0) {
        const replay = pending.splice(0, pending.length)
        for (const { value } of replay) listener(value)
        pendingBytes = 0
      }
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
