import { expect, it, vi } from 'vitest'
import * as runtime from './support/runtime'

it('caps every launch attempt by the remaining shared deadline', async () => {
  const launchWithDeadline = (runtime as unknown as { launchElectronWithDeadline?: Function }).launchElectronWithDeadline
  expect(launchWithDeadline).toBeTypeOf('function')
  if (!launchWithDeadline) return
  let now = 0
  const timeouts: number[] = []
  const launch = vi.fn(async (timeoutMs: number) => {
    timeouts.push(timeoutMs)
    now += timeoutMs
    throw new Error('Process failed to launch!')
  })
  await expect(launchWithDeadline({
    attemptTimeoutMs: 400,
    delay: async (milliseconds: number) => { now += milliseconds },
    dispose: vi.fn(async () => undefined),
    isAlive: () => true,
    launch,
    now: () => now,
    retryDelayMs: 100,
    stabilityDelayMs: 0,
    totalTimeoutMs: 1_000,
  })).rejects.toThrow('Electron launch deadline expired')
  expect(timeouts).toEqual([400, 400])
  expect(now).toBe(1_000)
})

it('disposes every transient candidate before retrying', async () => {
  const launchWithDeadline = (runtime as unknown as { launchElectronWithDeadline?: Function }).launchElectronWithDeadline
  expect(launchWithDeadline).toBeTypeOf('function')
  if (!launchWithDeadline) return
  let now = 0
  const candidates = [{ id: 1 }, { id: 2 }]
  const dispose = vi.fn(async () => undefined)
  const result = await launchWithDeadline({
    attemptTimeoutMs: 500,
    delay: async (milliseconds: number) => { now += milliseconds },
    dispose,
    isAlive: (candidate: { id: number }) => candidate.id === 2,
    launch: vi.fn(async () => candidates.shift()),
    now: () => now,
    retryDelayMs: 10,
    stabilityDelayMs: 20,
    totalTimeoutMs: 1_000,
  })
  expect(result).toEqual({ id: 2 })
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(dispose).toHaveBeenCalledWith({ id: 1 }, expect.any(AbortSignal))
})


it('aborts a hung launch and requests exact cleanup at the absolute deadline', async () => {
  vi.useFakeTimers()
  try {
    let signal: AbortSignal | undefined
    const terminate = vi.fn()
    const launch = vi.fn((_timeoutMs: number, currentSignal?: AbortSignal) => {
      signal = currentSignal
      return new Promise<{ id: number }>(() => undefined)
    })
    const pending = runtime.launchElectronWithDeadline({
      attemptTimeoutMs: 1_000,
      dispose: vi.fn(async () => undefined),
      isAlive: () => true,
      launch,
      retryDelayMs: 0,
      stabilityDelayMs: 0,
      terminate,
      totalTimeoutMs: 1_000,
    })
    const outcome = Promise.race([
      pending.then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error)),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 1_001)),
    ])

    await vi.advanceTimersByTimeAsync(1_001)

    await expect(outcome).resolves.toBe('Electron launch deadline expired')
    expect(signal?.aborted).toBe(true)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledWith(undefined)
  } finally {
    vi.useRealTimers()
  }
})

it('aborts a hung dispose and terminates the exact transient candidate', async () => {
  vi.useFakeTimers()
  try {
    const candidate = { id: 7 }
    let disposeSignal: AbortSignal | undefined
    const terminate = vi.fn()
    const pending = runtime.launchElectronWithDeadline({
      attemptTimeoutMs: 500,
      dispose: vi.fn((_candidate: typeof candidate, currentSignal?: AbortSignal) => {
        disposeSignal = currentSignal
        return new Promise<void>(() => undefined)
      }),
      isAlive: () => false,
      launch: vi.fn(async () => candidate),
      retryDelayMs: 0,
      stabilityDelayMs: 0,
      terminate,
      totalTimeoutMs: 500,
    })
    const outcome = Promise.race([
      pending.then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error)),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 501)),
    ])

    await vi.advanceTimersByTimeAsync(501)

    await expect(outcome).resolves.toBe('Electron launch deadline expired')
    expect(disposeSignal?.aborted).toBe(true)
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(terminate).toHaveBeenCalledWith(candidate)
  } finally {
    vi.useRealTimers()
  }
})
