import { expect, it, vi } from 'vitest'
import { DeferredStartupMaintenance, liveStartupMaintenanceWindow } from '../../src/main/deferred-startup-maintenance'

it('uses a surviving window when the most recently shown window closes before maintenance', () => {
  const first = { isDestroyed: () => false }
  let closed = false
  const second = { isDestroyed: () => closed }
  const windows = new Set([first, second])
  expect(liveStartupMaintenanceWindow(windows, second)).toBe(second)
  closed = true
  expect(liveStartupMaintenanceWindow(windows, second)).toBe(first)
  windows.delete(first)
  expect(liveStartupMaintenanceWindow(windows, second)).toBeUndefined()
})

it('does no maintenance before presentation and schedules only one run', async () => {
  vi.useFakeTimers()
  const run = vi.fn(async () => {})
  try {
    const maintenance = new DeferredStartupMaintenance({ run, report: () => {} })
    await vi.runAllTimersAsync()
    expect(run).not.toHaveBeenCalled()
    maintenance.schedule()
    maintenance.schedule()
    expect(run).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledOnce()
    maintenance.schedule()
    await vi.runAllTimersAsync()
    expect(run).toHaveBeenCalledOnce()
    await maintenance.dispose()
  } finally { vi.useRealTimers() }
})

it('closing before the scheduled run does not initialize optional services', async () => {
  vi.useFakeTimers()
  const run = vi.fn(async () => {})
  try {
    const maintenance = new DeferredStartupMaintenance({ run, report: () => {} })
    maintenance.schedule()
    await maintenance.dispose()
    maintenance.schedule()
    await vi.runAllTimersAsync()
    expect(run).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})

it('shutdown waits for the started transaction even when it fails', async () => {
  vi.useFakeTimers()
  let fail!: (error: Error) => void
  const pending = new Promise<void>((_resolve, reject) => { fail = reject })
  const report = vi.fn()
  try {
    const maintenance = new DeferredStartupMaintenance({ run: () => pending, report })
    maintenance.schedule()
    await vi.runAllTimersAsync()
    let disposed = false
    const closing = maintenance.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    fail(new Error('native failed'))
    await closing
    expect(disposed).toBe(true)
    expect(report).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers() }
})
