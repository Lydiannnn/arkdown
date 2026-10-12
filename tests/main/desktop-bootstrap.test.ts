import { beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ mode: 'arkdown', events: [] as string[], schemes: vi.fn(), quit: vi.fn(), fail: false,
  packaged: false, inspect: vi.fn(), ack: vi.fn(), reportUpdate: vi.fn(async () => {}), progress: vi.fn(async () => {}), forward: vi.fn(async () => {}) }))
vi.mock('electron', () => ({ app: {
  setName: () => fixture.events.push('profile'), setPath: vi.fn(), quit: fixture.quit,
  get isPackaged() { return fixture.packaged }, getVersion: () => '1.0.4', getPath: () => 'C:\\test', once: vi.fn(),
}, protocol: { registerSchemesAsPrivileged: (schemes: unknown) => { fixture.events.push('schemes'); fixture.schemes(schemes) } } }))
vi.mock('../../src/main/updates/update-restart', () => ({ inspectUpdateStartup: fixture.inspect, acknowledgeUpdateRestart: fixture.ack }))
vi.mock('../../src/main/updates/update-launch-gate', () => ({ notifyUpdateLaunchBlocked: fixture.progress }))
vi.mock('../../src/main/updates/update-startup-recovery', () => ({ showUpdateStartupFailure: fixture.reportUpdate, showUpdateInProgress: fixture.progress }))
vi.mock('../../src/main/updates/launch-broker', () => ({ ArkdownLaunchBroker: class { async claim() { return true } async close() {} forwardToRunning = fixture.forward } }))
vi.mock('../../src/main/branding', () => ({ configureApplicationBranding: () => fixture.events.push('branding') }))
vi.mock('../../src/main/app-mode', async importOriginal => ({
  ...await importOriginal<object>(), desktopAppMode: () => fixture.mode,
}))
vi.mock('../../src/main/arkdown-main', () => {
  fixture.events.push('load arkdown')
  return { startArkdown: async () => { fixture.events.push('start arkdown'); if (fixture.fail) throw new Error('failure') } }
})
vi.mock('../../src/main/arknote-main', () => {
  fixture.events.push('load arknote')
  return { startArknote: async () => { fixture.events.push('start arknote') } }
})
beforeEach(() => { vi.resetModules(); fixture.events.length = 0; fixture.schemes.mockClear(); fixture.quit.mockClear(); fixture.fail = false;
  fixture.packaged = false; fixture.inspect.mockReset(); fixture.ack.mockReset(); fixture.reportUpdate.mockClear(); fixture.progress.mockClear(); fixture.forward.mockReset().mockResolvedValue(undefined) })

it('queues a gated document launch in the existing owner without initializing a new editor', async () => {
  fixture.mode = 'arkdown'; fixture.packaged = true; fixture.inspect.mockResolvedValue({ blockedByUpdate: true })
  await import('../../src/main/main'); await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce())
  expect(fixture.forward).toHaveBeenCalledOnce(); expect(fixture.events).not.toContain('start arkdown'); expect(fixture.progress).not.toHaveBeenCalled()
})
it.each(['arkdown', 'arknote'])('delegates the unavailable-queue notice to the external helper and exits without opening an in-tree dialog for %s', async mode => {
  fixture.mode = mode; fixture.packaged = true; fixture.inspect.mockResolvedValue({ blockedByUpdate: true }); fixture.forward.mockRejectedValue(new Error('owner already sealed'))
  await import('../../src/main/main'); await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce())
  expect(fixture.progress).toHaveBeenCalledWith(expect.any(String), mode); expect(fixture.events).not.toContain('start ' + mode)
})

it('registers both Arkdown schemes in one synchronous call before loading the selected app', async () => {
  fixture.mode = 'arkdown'
  await import('../../src/main/main')
  await vi.waitFor(() => expect(fixture.events).toContain('start arkdown'))
  expect(fixture.events).toEqual(['branding', 'schemes', 'load arkdown', 'start arkdown'])
  expect(fixture.schemes).toHaveBeenCalledOnce()
  expect(fixture.schemes.mock.calls[0]![0].map((scheme: { scheme: string }) => scheme.scheme)).toEqual(['arkdown-asset', 'arkdown-ocr'])
})

it('configures the isolated Arknote profile and only asset privileges before loading Arknote', async () => {
  fixture.mode = 'arknote'
  await import('../../src/main/main')
  await vi.waitFor(() => expect(fixture.events).toContain('start arknote'))
  expect(fixture.events).toEqual(['branding', 'profile', 'schemes', 'load arknote', 'start arknote'])
  expect(fixture.schemes).toHaveBeenCalledOnce()
  expect(fixture.schemes.mock.calls[0]![0]).toHaveLength(1)
})

it('retains fatal startup error handling for a rejected async entrypoint', async () => {
  fixture.mode = 'arkdown'; fixture.fail = true
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await import('../../src/main/main')
    await vi.waitFor(() => expect(fixture.quit).toHaveBeenCalledOnce())
  } finally { report.mockRestore() }
})

it('explains invalid update metadata before quitting without opening a document', async () => {
  fixture.mode = 'arkdown'; fixture.packaged = true
  const error = new Error('更新记录无效')
  fixture.inspect.mockRejectedValue(error)
  await import('../../src/main/main')
  await vi.waitFor(() => expect(fixture.reportUpdate).toHaveBeenCalledWith(expect.any(String), error))
  expect(fixture.events).not.toContain('start arkdown')
  expect(fixture.quit).toHaveBeenCalledOnce()
})

it('keeps a successfully started editor alive if writing the update acknowledgement fails', async () => {
  fixture.mode = 'arkdown'; fixture.packaged = true
  fixture.inspect.mockResolvedValue({ restart: { token: 'test' } })
  fixture.ack.mockRejectedValue(new Error('acknowledgement unavailable'))
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await import('../../src/main/main')
    await vi.waitFor(() => expect(fixture.ack).toHaveBeenCalledOnce())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(fixture.quit).not.toHaveBeenCalled()
  } finally { report.mockRestore() }
})
