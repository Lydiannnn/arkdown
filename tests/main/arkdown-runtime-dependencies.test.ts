import { expect, it, vi } from 'vitest'
import {
  createArkdownRuntimeDependencies,
  runWithArkdownRuntimeStartupRollback,
  type ArkdownRuntimeShutdownDependencies,
} from '../../src/main/arkdown-runtime-dependencies'
import type {
  WindowsWorkspaceCommitProcessOptions,
} from '../../src/main/workspace/windows-workspace-commit-process'
import type {
  WindowsWorkspaceCommitAdapter,
  WorkspaceAiCommitOutcome,
} from '../../src/main/workspace/workspace-ai-file-service'
import { createScreenshotQuitGate } from '../../src/main/screenshot-translation/screenshot-shutdown'
import type { CanonicalFileIdentity } from '../../src/main/documents/document-identity'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function shutdownDependencies() {
  return {
    docx: { dispose: vi.fn(async () => undefined) },
    documentConversion: { dispose: vi.fn(async () => undefined) },
    screenshot: { dispose: vi.fn(async () => undefined) },
  }
}

it('rejects a failed per-window finalizer and still waits for all other shutdown work', async () => {
  const resources = shutdownDependencies()
  const report = vi.fn()
  const runtime = shutdownRuntime(resources, report)
  const failed = runtime.registerWindowCleanup(async () => { throw new Error('private path') })
  await expect(failed.disposeWindow()).rejects.toThrow('Arkdown window cleanup failed')
  expect(failed.disposeWindow()).toBe(failed.disposeWindow())
  const pending = deferred()
  runtime.registerWindowCleanup(() => pending.promise)
  const closing = runtime.dispose()
  const observed = expect(closing).rejects.toThrow('Arkdown runtime cleanup failed')
  await Promise.resolve()
  expect(resources.docx.dispose).not.toHaveBeenCalled()
  pending.resolve()
  await observed
  expect(resources.docx.dispose).toHaveBeenCalledOnce()
  expect(resources.documentConversion.dispose).toHaveBeenCalledOnce()
  expect(resources.screenshot.dispose).toHaveBeenCalledOnce()
  expect(report).toHaveBeenCalledWith('WINDOW_CLEANUP_FAILED')
})

function adapterFactory() {
  const adapter: WindowsWorkspaceCommitAdapter = {
    commit: vi.fn(async (): Promise<WorkspaceAiCommitOutcome> => ({
      status: 'rejected', reason: 'unsupported',
    })),
  }
  return {
    adapter,
    create: vi.fn((_options: WindowsWorkspaceCommitProcessOptions) => adapter),
  }
}

function shutdownRuntime(
  shutdown: ArkdownRuntimeShutdownDependencies,
  reportDiagnostic?: (code: string) => void,
) {
  return createArkdownRuntimeDependencies({
    app: { isPackaged: false, getAppPath: () => 'C:\\src\\Arkdown' },
    process: { platform: 'linux', arch: 'x64', resourcesPath: 'C:\\ignored' },
    shutdown,
    reportDiagnostic,
  })
}

it('constructs one packaged x64 adapter from the four trusted Electron location values', () => {
  const factory = adapterFactory()
  const runtime = createArkdownRuntimeDependencies({
    app: {
      isPackaged: true,
      getAppPath: vi.fn(() => 'C:\\Program Files\\Arkdown\\resources\\app.asar'),
    },
    process: {
      platform: 'win32',
      arch: 'x64',
      resourcesPath: 'C:\\Program Files\\Arkdown\\resources',
    },
    shutdown: shutdownDependencies(),
    createWorkspaceCommitAdapter: factory.create,
  })

  expect(runtime.workspaceCommitAdapter).toBe(factory.adapter)
  expect(factory.create).toHaveBeenCalledOnce()
  expect(factory.create).toHaveBeenCalledWith({
    location: {
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\Arkdown\\resources',
      appPath: 'C:\\Program Files\\Arkdown\\resources\\app.asar',
      arch: 'x64',
    },
  })
})

it('owns one process-wide open-document registry and boundary for every window authority', async () => {
  const runtime = shutdownRuntime(shutdownDependencies())
  const firstTarget = {
    windowId: 11,
    workspaceId: 'workspace-a',
    generation: 'generation-a',
    fileIdentity: '1.2' as unknown as CanonicalFileIdentity,
  }
  const secondTarget = {
    ...firstTarget,
    windowId: 12,
    workspaceId: 'workspace-b',
    generation: 'generation-b',
  }
  const reservation = await runtime.openDocumentRegistry.reserve(firstTarget)
  await runtime.openDocumentRegistry.register(reservation, {
    captureReadSnapshot: vi.fn(),
    planReplacement: vi.fn(),
    applyTransaction: vi.fn(),
    queryOutcome: vi.fn(),
  } as never)

  await expect(runtime.workspaceAiEditorBoundary.lookup(firstTarget)).resolves.toMatchObject({
    status: 'open',
  })
  await expect(runtime.workspaceAiEditorBoundary.lookup(secondTarget)).resolves.toEqual({
    status: 'ambiguous',
  })
})

it('disposes the complete runtime on startup failure and preserves the startup error', async () => {
  const order: string[] = []
  const startupError = new Error('startup failed')
  const runtime = shutdownRuntime({
    docx: { dispose: vi.fn(async () => { order.push('docx') }) },
    documentConversion: { dispose: vi.fn(async () => { order.push('conversion') }) },
    screenshot: { dispose: vi.fn(async () => { order.push('screenshot') }) },
  })
  runtime.registerWindowCleanup(async () => { order.push('window') })

  await expect(runWithArkdownRuntimeStartupRollback(runtime, async () => {
    throw startupError
  })).rejects.toBe(startupError)

  expect(order).toEqual(['window', 'docx', 'conversion', 'screenshot'])
})

it('preserves the startup error when runtime rollback itself reports cleanup failure', async () => {
  const startupError = new Error('startup failed')
  const runtime = shutdownRuntime({
    docx: { dispose: vi.fn(async () => { throw new Error('cleanup failed') }) },
    documentConversion: { dispose: vi.fn(async () => undefined) },
    screenshot: { dispose: vi.fn(async () => undefined) },
  })

  await expect(runWithArkdownRuntimeStartupRollback(runtime, async () => {
    throw startupError
  })).rejects.toBe(startupError)
})

it('constructs one development arm64 adapter without a direct helper-path downgrade', () => {
  const factory = adapterFactory()
  const runtime = createArkdownRuntimeDependencies({
    app: {
      isPackaged: false,
      getAppPath: () => 'C:\\src\\Arkdown',
    },
    process: {
      platform: 'win32',
      arch: 'arm64',
      resourcesPath: 'C:\\ignored\\resources',
    },
    shutdown: shutdownDependencies(),
    createWorkspaceCommitAdapter: factory.create,
  })

  expect(runtime.workspaceCommitAdapter).toBe(factory.adapter)
  expect(factory.create).toHaveBeenCalledOnce()
  expect(factory.create).toHaveBeenCalledWith({
    location: {
      isPackaged: false,
      resourcesPath: 'C:\\ignored\\resources',
      appPath: 'C:\\src\\Arkdown',
      arch: 'arm64',
    },
  })
})

it.each([
  { platform: 'linux', arch: 'x64' },
  { platform: 'win32', arch: 'ia32' },
])('fails closed without constructing an adapter on $platform/$arch', ({ platform, arch }) => {
  const factory = adapterFactory()
  const runtime = createArkdownRuntimeDependencies({
    app: { isPackaged: false, getAppPath: () => 'C:\\src\\Arkdown' },
    process: {
      platform,
      arch,
      resourcesPath: 'C:\\ignored\\resources',
    },
    shutdown: shutdownDependencies(),
    createWorkspaceCommitAdapter: factory.create,
  })

  expect(runtime.workspaceCommitAdapter).toBeUndefined()
  expect(factory.create).not.toHaveBeenCalled()
})

it('does not dispose the app-global Docx service when multiple windows close', async () => {
  const shutdown = shutdownDependencies()
  const runtime = shutdownRuntime(shutdown)
  const closed = vi.fn()

  const first = runtime.registerWindowCleanup(async () => { closed('first') })
  const second = runtime.registerWindowCleanup(async () => { closed('second') })
  await Promise.all([first.disposeWindow(), second.disposeWindow()])
  first.unregister()
  second.unregister()

  expect(closed).toHaveBeenCalledTimes(2)
  expect(shutdown.docx.dispose).not.toHaveBeenCalled()
  expect(shutdown.documentConversion.dispose).not.toHaveBeenCalled()
  expect(shutdown.screenshot.dispose).not.toHaveBeenCalled()
})

it('drains every tracked window cleanup before disposing Docx once and later runtimes in order', async () => {
  const firstWindow = deferred()
  const secondWindow = deferred()
  const docx = deferred()
  const conversion = deferred()
  const screenshot = deferred()
  const order: string[] = []
  const shutdown = {
    docx: { dispose: vi.fn(() => { order.push('docx'); return docx.promise }) },
    documentConversion: {
      dispose: vi.fn(() => { order.push('document-conversion'); return conversion.promise }),
    },
    screenshot: {
      dispose: vi.fn(() => { order.push('screenshot'); return screenshot.promise }),
    },
  }
  const runtime = shutdownRuntime(shutdown)
  runtime.registerWindowCleanup(() => firstWindow.promise.then(() => { order.push('window-1') }))
  runtime.registerWindowCleanup(() => secondWindow.promise.then(() => { order.push('window-2') }))

  const firstDispose = runtime.dispose()
  const repeatedDispose = runtime.dispose()
  expect(repeatedDispose).toBe(firstDispose)
  await Promise.resolve()
  expect(shutdown.docx.dispose).not.toHaveBeenCalled()

  secondWindow.resolve()
  await Promise.resolve()
  expect(shutdown.docx.dispose).not.toHaveBeenCalled()
  firstWindow.resolve()
  await vi.waitFor(() => expect(shutdown.docx.dispose).toHaveBeenCalledOnce())
  expect(order).toEqual(['window-2', 'window-1', 'docx'])
  expect(shutdown.documentConversion.dispose).not.toHaveBeenCalled()

  docx.resolve()
  await vi.waitFor(() => expect(shutdown.documentConversion.dispose).toHaveBeenCalledOnce())
  conversion.resolve()
  await vi.waitFor(() => expect(shutdown.screenshot.dispose).toHaveBeenCalledOnce())
  screenshot.resolve()
  await expect(firstDispose).resolves.toBeUndefined()
  expect(order).toEqual([
    'window-2', 'window-1', 'docx', 'document-conversion', 'screenshot',
  ])
  expect(shutdown.docx.dispose).toHaveBeenCalledOnce()
})

it('seals an empty registry synchronously and rejects late cleanup without starting it', async () => {
  const shutdown = shutdownDependencies()
  const runtime = shutdownRuntime(shutdown)
  const lateCleanup = vi.fn(async () => undefined)

  const disposing = runtime.dispose()

  expect(() => runtime.registerWindowCleanup(lateCleanup))
    .toThrow('Arkdown runtime cleanup registration is closed')
  await disposing
  expect(lateCleanup).not.toHaveBeenCalled()
})

it('rejects late registration while the sealed snapshot is still draining', async () => {
  const activeWindow = deferred()
  const shutdown = shutdownDependencies()
  const runtime = shutdownRuntime(shutdown)
  const activeCleanup = vi.fn(() => activeWindow.promise)
  const lateCleanup = vi.fn(async () => undefined)
  runtime.registerWindowCleanup(activeCleanup)

  const disposing = runtime.dispose()
  expect(() => runtime.registerWindowCleanup(lateCleanup))
    .toThrow('Arkdown runtime cleanup registration is closed')
  await vi.waitFor(() => expect(activeCleanup).toHaveBeenCalledOnce())
  expect(lateCleanup).not.toHaveBeenCalled()
  expect(shutdown.docx.dispose).not.toHaveBeenCalled()

  activeWindow.resolve()
  await disposing
})

it('awaits an idempotent early window cleanup during final shutdown after unregister', async () => {
  const windowCleanup = deferred()
  const shutdown = shutdownDependencies()
  const runtime = shutdownRuntime(shutdown)
  const callback = vi.fn(() => windowCleanup.promise)
  const registration = runtime.registerWindowCleanup(callback)

  const early = registration.disposeWindow()
  const repeated = registration.disposeWindow()
  registration.unregister()
  registration.unregister()
  expect(repeated).toBe(early)
  await Promise.resolve()
  expect(callback).toHaveBeenCalledOnce()

  const disposing = runtime.dispose()
  await Promise.resolve()
  expect(shutdown.docx.dispose).not.toHaveBeenCalled()
  windowCleanup.resolve()
  await disposing
  await early
  expect(callback).toHaveBeenCalledOnce()
  expect(shutdown.docx.dispose).toHaveBeenCalledOnce()
})

it('never invokes a cleanup unregistered before window close or shutdown', async () => {
  const shutdown = shutdownDependencies()
  const runtime = shutdownRuntime(shutdown)
  const callback = vi.fn(async () => undefined)
  const registration = runtime.registerWindowCleanup(callback)

  registration.unregister()
  registration.unregister()
  const skipped = registration.disposeWindow()
  const repeated = registration.disposeWindow()
  expect(repeated).toBe(skipped)
  await skipped
  await runtime.dispose()

  expect(callback).not.toHaveBeenCalled()
})

it('continues every cleanup after failures and lets the quit gate exit with fixed diagnostics', async () => {
  const diagnostics: string[] = []
  const shutdown = {
    docx: { dispose: vi.fn(async () => { throw new Error('C:\\private\\docx.tmp') }) },
    documentConversion: {
      dispose: vi.fn(async () => { throw new Error('private conversion detail') }),
    },
    screenshot: {
      dispose: vi.fn(async () => { throw new Error('private screenshot detail') }),
    },
  }
  const runtime = shutdownRuntime(shutdown, (code) => diagnostics.push(code))
  const healthyWindowCleanup = vi.fn(async () => undefined)
  runtime.registerWindowCleanup(async () => { throw new Error('C:\\private\\window.md') })
  runtime.registerWindowCleanup(healthyWindowCleanup)
  const quit = vi.fn()
  const gate = createScreenshotQuitGate({
    coordinator: runtime,
    shortcut: { dispose: vi.fn() },
    quit,
    reportDiagnostic: (code) => diagnostics.push(code),
  })

  gate.handleWillQuit({ preventDefault: vi.fn() })
  await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())

  expect(shutdown.docx.dispose).toHaveBeenCalledOnce()
  expect(shutdown.documentConversion.dispose).toHaveBeenCalledOnce()
  expect(shutdown.screenshot.dispose).toHaveBeenCalledOnce()
  expect(healthyWindowCleanup).toHaveBeenCalledOnce()
  expect(diagnostics).toEqual([
    'WINDOW_CLEANUP_FAILED',
    'DOCX_DISPOSE_FAILED',
    'DOCUMENT_CONVERSION_DISPOSE_FAILED',
    'SCREENSHOT_RUNTIME_DISPOSE_FAILED',
    'COORDINATOR_DISPOSE_FAILED',
  ])
  expect(JSON.stringify(diagnostics)).not.toContain('private')
})
