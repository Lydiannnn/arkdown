import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import type { PrintDocumentInput } from '../../src/shared/printing'
import {
  PrintDocumentService,
  buildPrintWindowOptions,
  type PrintSurfaceAccess,
} from '../../src/main/printing/print-document-service'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Listener = (...args: unknown[]) => void

function eventTarget() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    on: vi.fn((event: string, listener: Listener) => {
      const group = listeners.get(event) ?? new Set<Listener>()
      group.add(listener)
      listeners.set(event, group)
    }),
    once: vi.fn((event: string, listener: Listener) => {
      const wrapper: Listener = (...args) => {
        listeners.get(event)?.delete(wrapper)
        listener(...args)
      }
      const group = listeners.get(event) ?? new Set<Listener>()
      group.add(wrapper)
      listeners.set(event, group)
    }),
    removeListener: vi.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener)
    }),
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
    },
  }
}

function ownerWindow(id: number) {
  const events = eventTarget()
  const contentsEvents = eventTarget()
  let destroyed = false
  return {
    ...events,
    webContents: { ...contentsEvents, id, isDestroyed: () => destroyed },
    isDestroyed: () => destroyed,
    destroyOwner() {
      destroyed = true
      events.emit('closed')
    },
    crashOwnerRenderer() {
      contentsEvents.emit('render-process-gone')
    },
  }
}

function printWindow(id: number, print = vi.fn((
  _options: unknown,
  callback: (success: boolean, failureReason: string) => void,
) => callback(true, ''))) {
  const events = eventTarget()
  const contentsEvents = eventTarget()
  let destroyed = false
  const destroy = vi.fn(() => { destroyed = true })
  return {
    ...events,
    destroy,
    isDestroyed: () => destroyed,
    webContents: {
      ...contentsEvents,
      id,
      mainFrame: {},
      print,
      isDestroyed: () => destroyed,
      setWindowOpenHandler: vi.fn(),
    },
  }
}

const input: PrintDocumentInput = {
  markdown: '# Printed title\n\n![diagram](images/diagram.png)',
  documentName: 'plan.md',
  documentAbsolutePath: 'C:\\Docs\\plan.md',
  appearance: { ...DEFAULT_EDITOR_APPEARANCE },
}

function harness(options: {
  loadSurface?: (
    window: ReturnType<typeof printWindow>,
    token: string,
  ) => Promise<void>
  print?: Parameters<typeof printWindow>[1]
  timeoutMs?: number
} = {}) {
  const windows: ReturnType<typeof printWindow>[] = []
  const accesses = new Map<number, PrintSurfaceAccess>()
  const registrations = new Map<number, { dispose: ReturnType<typeof vi.fn> }>()
  let tokenSequence = 0
  const createWindow = vi.fn(() => {
    const window = printWindow(100 + windows.length, options.print)
    windows.push(window)
    return window
  })
  const loadSurface = vi.fn(options.loadSurface ?? (async (
    _window: ReturnType<typeof printWindow>,
    _token: string,
  ) => undefined))
  const registerSurface = vi.fn((window: ReturnType<typeof printWindow>, access: PrintSurfaceAccess) => {
    accesses.set(window.webContents.id, access)
    const registration = { dispose: vi.fn() }
    registrations.set(window.webContents.id, registration)
    return registration
  })
  const service = new PrintDocumentService({
    preloadPath: 'C:\\Arkdown\\preload.js',
    createWindow,
    loadSurface,
    registerSurface,
    randomToken: () => `00000000-0000-4000-8000-${String(++tokenSequence).padStart(12, '0')}`,
    timeoutMs: options.timeoutMs ?? 1_000,
  })
  return { accesses, createWindow, loadSurface, registrations, service, windows }
}

async function startedJob(testHarness: ReturnType<typeof harness>, owner = ownerWindow(1)) {
  const pending = testHarness.service.print(owner as never, input)
  await vi.waitFor(() => expect(testHarness.loadSurface).toHaveBeenCalledOnce())
  const surface = testHarness.windows[0]!
  const access = testHarness.accesses.get(surface.webContents.id)!
  const token = testHarness.loadSurface.mock.calls[0]![1] as string
  return { access, owner, pending, surface, token }
}

afterEach(() => vi.useRealTimers())

describe('PrintDocumentService', () => {
  it('rejects an incomplete current appearance before creating a print surface', async () => {
    const testHarness = harness({ loadSurface: async () => { throw new Error('unexpected load') } })
    const { editorTheme: _missingTheme, ...missingTheme } = input.appearance as unknown as Record<string, unknown>

    await expect(testHarness.service.print(ownerWindow(1) as never, {
      ...input,
      appearance: missingTheme,
    } as never)).rejects.toThrow()
    expect(testHarness.createWindow).not.toHaveBeenCalled()
  })

  it('creates one secure hidden surface and prints only after its token payload is consumed and ready', async () => {
    const testHarness = harness()
    const job = await startedJob(testHarness)

    expect(testHarness.createWindow).toHaveBeenCalledWith(expect.objectContaining({
      show: false,
      parent: job.owner,
      backgroundColor: '#ffffff',
      webPreferences: expect.objectContaining({
        preload: 'C:\\Arkdown\\preload.js',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      }),
    }))
    expect(job.surface.webContents.print).not.toHaveBeenCalled()
    expect(job.access.take(job.token)).toMatchObject({
      ...input,
      surfaceDeadlineEpochMs: expect.any(Number),
    })
    job.access.ready(job.token)

    await expect(job.pending).resolves.toBeUndefined()
    expect(job.surface.webContents.print).toHaveBeenCalledWith({
      silent: false,
      printBackground: true,
    }, expect.any(Function))
    expect(job.surface.destroy).toHaveBeenCalledOnce()
    expect(testHarness.registrations.get(job.surface.webContents.id)?.dispose).toHaveBeenCalledOnce()
  })

  it('keeps document content and source path out of the surface URL boundary', async () => {
    const testHarness = harness()
    const job = await startedJob(testHarness)

    expect(testHarness.loadSurface).toHaveBeenCalledWith(job.surface, job.token)
    expect(JSON.stringify(testHarness.loadSurface.mock.calls[0])).not.toContain(input.markdown)
    expect(JSON.stringify(testHarness.loadSurface.mock.calls[0])).not.toContain(input.documentAbsolutePath)

    job.access.take(job.token)
    job.access.ready(job.token)
    await job.pending
  })

  it('does not let another print surface take a token or replay an already consumed token', async () => {
    const testHarness = harness()
    const first = await startedJob(testHarness, ownerWindow(1))
    const secondPending = testHarness.service.print(ownerWindow(2) as never, {
      ...input,
      markdown: '# Other document',
      documentName: 'other.md',
      documentAbsolutePath: 'C:\\Docs\\other.md',
    })
    await vi.waitFor(() => expect(testHarness.loadSurface).toHaveBeenCalledTimes(2))
    const secondSurface = testHarness.windows[1]!
    const secondAccess = testHarness.accesses.get(secondSurface.webContents.id)!
    const secondToken = testHarness.loadSurface.mock.calls[1]![1] as string

    expect(() => secondAccess.take(first.token)).toThrow()
    expect(first.access.take(first.token)).toMatchObject({
      ...input,
      surfaceDeadlineEpochMs: expect.any(Number),
    })
    expect(() => first.access.take(first.token)).toThrow()

    first.access.ready(first.token)
    secondAccess.take(secondToken)
    secondAccess.ready(secondToken)
    await Promise.all([first.pending, secondPending])
  })

  it('rejects overlapping print requests from the same owner without creating another surface', async () => {
    const testHarness = harness()
    const owner = ownerWindow(1)
    const first = await startedJob(testHarness, owner)

    await expect(testHarness.service.print(owner as never, input)).rejects.toThrow()
    expect(testHarness.createWindow).toHaveBeenCalledOnce()

    first.access.take(first.token)
    first.access.ready(first.token)
    await first.pending
  })

  it('treats system-dialog cancellation as success and still destroys the surface once', async () => {
    const print = vi.fn((
      _options: unknown,
      callback: (success: boolean, failureReason: string) => void,
    ) => callback(false, 'Print job canceled'))
    const testHarness = harness({ print })
    const job = await startedJob(testHarness)

    job.access.take(job.token)
    job.access.ready(job.token)

    await expect(job.pending).resolves.toBeUndefined()
    expect(job.surface.destroy).toHaveBeenCalledOnce()
  })

  it('stops the render timeout before an interactive print dialog waits longer than 30 seconds', async () => {
    vi.useFakeTimers()
    let finishPrint!: (success: boolean, failureReason: string) => void
    const testHarness = harness({
      timeoutMs: 30_000,
      print: vi.fn((
        _options: unknown,
        callback: (success: boolean, failureReason: string) => void,
      ) => { finishPrint = callback }),
    })
    const pending = testHarness.service.print(ownerWindow(1) as never, input)
    const outcome = pending.then(() => 'resolved' as const, () => 'rejected' as const)
    const surface = testHarness.windows[0]!
    const access = testHarness.accesses.get(surface.webContents.id)!
    const token = testHarness.loadSurface.mock.calls[0]![1] as string

    access.take(token)
    access.ready(token)
    await vi.advanceTimersByTimeAsync(0)
    expect(surface.webContents.print).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(60_000)
    const destroyedBeforeDialogSettled = surface.destroy.mock.calls.length
    finishPrint(true, '')

    await expect(outcome).resolves.toBe('resolved')
    expect(destroyedBeforeDialogSettled).toBe(0)
    expect(surface.destroy).toHaveBeenCalledOnce()
  })

  it('rejects a ready acknowledgement at the main-owned absolute deadline before its timer callback', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    const testHarness = harness({ timeoutMs: 1_000 })
    const pending = testHarness.service.print(ownerWindow(1) as never, input)
    const surface = testHarness.windows[0]!
    const access = testHarness.accesses.get(surface.webContents.id)!
    const token = testHarness.loadSurface.mock.calls[0]![1] as string
    vi.setSystemTime(new Date(500))
    expect(access.take(token)).toMatchObject({ surfaceDeadlineEpochMs: 1_000 })

    vi.setSystemTime(new Date(1_000))
    expect(() => access.ready(token)).toThrow('Print surface timed out')
    await expect(pending).rejects.toThrow('Print surface timed out')
    expect(surface.destroy).toHaveBeenCalledOnce()
  })

  it('rejects callback and thrown print failures while cleaning up exactly once', async () => {
    const callbackFailure = harness({
      print: vi.fn((
        _options: unknown,
        callback: (success: boolean, failureReason: string) => void,
      ) => callback(false, 'Print job failed')),
    })
    const callbackJob = await startedJob(callbackFailure)
    callbackJob.access.take(callbackJob.token)
    callbackJob.access.ready(callbackJob.token)
    await expect(callbackJob.pending).rejects.toThrow()
    expect(callbackJob.surface.destroy).toHaveBeenCalledOnce()

    const thrownFailure = harness({
      print: vi.fn(() => { throw new Error('printer unavailable') }),
    })
    const thrownJob = await startedJob(thrownFailure)
    thrownJob.access.take(thrownJob.token)
    thrownJob.access.ready(thrownJob.token)
    await expect(thrownJob.pending).rejects.toThrow()
    expect(thrownJob.surface.destroy).toHaveBeenCalledOnce()
  })

  it('clears and destroys on load failure, timeout, owner close, surface close, and renderer loss', async () => {
    const loadFailure = harness({ loadSurface: async () => { throw new Error('load failed') } })
    const loadPromise = loadFailure.service.print(ownerWindow(1) as never, input)
    await expect(loadPromise).rejects.toThrow()
    expect(loadFailure.windows[0]?.destroy).toHaveBeenCalledOnce()

    vi.useFakeTimers()
    const timeoutFailure = harness({ timeoutMs: 25 })
    const timeoutOwner = ownerWindow(1)
    const timeoutPending = timeoutFailure.service.print(timeoutOwner as never, input)
    const timeoutSurface = timeoutFailure.windows[0]!
    const timeoutAccess = timeoutFailure.accesses.get(timeoutSurface.webContents.id)!
    const timeoutToken = timeoutFailure.loadSurface.mock.calls[0]![1] as string
    const timeoutRejection = expect(timeoutPending).rejects.toThrow()
    timeoutAccess.take(timeoutToken)
    await vi.advanceTimersByTimeAsync(25)
    await timeoutRejection
    expect(timeoutSurface.destroy).toHaveBeenCalledOnce()
    expect(() => timeoutAccess.ready(timeoutToken)).toThrow()
    vi.useRealTimers()

    const ownerFailure = harness()
    const ownerJob = await startedJob(ownerFailure)
    ownerJob.owner.destroyOwner()
    await expect(ownerJob.pending).rejects.toThrow()
    expect(ownerJob.surface.destroy).toHaveBeenCalledOnce()

    const surfaceFailure = harness()
    const surfaceJob = await startedJob(surfaceFailure)
    surfaceJob.surface.emit('closed')
    await expect(surfaceJob.pending).rejects.toThrow()
    expect(surfaceJob.surface.destroy).toHaveBeenCalledOnce()

    const rendererFailure = harness()
    const rendererJob = await startedJob(rendererFailure)
    rendererJob.surface.webContents.emit('render-process-gone')
    await expect(rendererJob.pending).rejects.toThrow()
    expect(rendererJob.surface.destroy).toHaveBeenCalledOnce()
  })

  it('treats owner renderer loss as terminal and removes every owner contents listener', async () => {
    const testHarness = harness({ timeoutMs: 10 })
    const owner = ownerWindow(1)
    const job = await startedJob(testHarness, owner)

    owner.crashOwnerRenderer()

    await expect(job.pending).rejects.toThrow('Print owner renderer exited')
    expect(job.surface.destroy).toHaveBeenCalledOnce()
    expect(owner.webContents.removeListener).toHaveBeenCalledWith(
      'destroyed',
      expect.any(Function),
    )
    expect(owner.webContents.removeListener).toHaveBeenCalledWith(
      'render-process-gone',
      expect.any(Function),
    )
  })
})

it('builds print-window options independently of ordinary Mica application chrome', () => {
  const options = buildPrintWindowOptions('C:\\Arkdown\\preload.js', ownerWindow(1) as never)

  expect(options).toMatchObject({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: 'C:\\Arkdown\\preload.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  expect(options).not.toHaveProperty('backgroundMaterial')
  expect(options).not.toHaveProperty('titleBarStyle')
})
