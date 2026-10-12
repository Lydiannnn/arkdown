/** Observed streaming phases, never provider billing or internal computation time. */
export function createModelReasoningTimer(
  signal: AbortSignal,
  emit: (value: { active: boolean; elapsedMs: number }) => void,
  now: () => number = () => performance.now(),
) {
  let startedAt: number | null = null
  let elapsed = 0
  let disposed = false
  const update = (active: boolean) => {
    if (disposed || active === (startedAt !== null)) return
    if (active) startedAt = now()
    else {
      elapsed += Math.max(0, now() - startedAt!)
      startedAt = null
    }
    emit({ active, elapsedMs: Math.floor(elapsed) })
  }
  const dispose = () => {
    if (disposed) return
    update(false)
    disposed = true
    signal.removeEventListener('abort', dispose)
  }
  signal.addEventListener('abort', dispose, { once: true })
  if (signal.aborted) dispose()
  return { update, dispose }
}

/** Keeps transport callbacks edge-triggered, including synchronous cancellation. */
export function createModelReasoningSignal(signal: AbortSignal, emit?: (active: boolean) => void) {
  let active = false, disposed = false
  const update = (next: boolean) => {
    if (disposed || next === active) return
    active = next
    emit?.(next)
  }
  const dispose = () => {
    if (disposed) return
    update(false)
    disposed = true
    signal.removeEventListener('abort', dispose)
  }
  signal.addEventListener('abort', dispose, { once: true })
  if (signal.aborted) dispose()
  return { update, dispose }
}
