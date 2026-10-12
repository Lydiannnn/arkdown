import {
  WindowsWorkspaceCommitProcessAdapter,
  type WindowsWorkspaceCommitProcessOptions,
} from './workspace/windows-workspace-commit-process'
import type {
  WindowsWorkspaceCommitAdapter,
} from './workspace/workspace-ai-file-service'
import { OpenDocumentRegistry } from './documents/open-document-registry'
import { RegistryWorkspaceAiEditorBoundary } from './documents/workspace-ai-editor-boundary'

interface ElectronAppLocation {
  readonly isPackaged: boolean
  getAppPath(): string
}

interface RuntimeProcessLocation {
  readonly platform: string
  readonly arch: string
  readonly resourcesPath: string
}

interface AsyncDisposable {
  dispose(): void | Promise<void>
}

export interface ArkdownRuntimeShutdownDependencies {
  readonly docx: AsyncDisposable
  readonly documentConversion: AsyncDisposable
  readonly screenshot: AsyncDisposable
}

export interface ArkdownRuntimeDependencies {
  readonly workspaceCommitAdapter: WindowsWorkspaceCommitAdapter | undefined
  readonly openDocumentRegistry: OpenDocumentRegistry
  readonly workspaceAiEditorBoundary: RegistryWorkspaceAiEditorBoundary
  registerWindowCleanup(cleanup: () => void | Promise<void>): ArkdownWindowCleanupRegistration
  dispose(): Promise<void>
}

export interface ArkdownWindowCleanupRegistration {
  disposeWindow(): Promise<void>
  unregister(): void
}

export type ArkdownRuntimeShutdownDiagnosticCode =
  | 'WINDOW_CLEANUP_FAILED'
  | 'DOCX_DISPOSE_FAILED'
  | 'DOCUMENT_CONVERSION_DISPOSE_FAILED'
  | 'SCREENSHOT_RUNTIME_DISPOSE_FAILED'

export async function runWithArkdownRuntimeStartupRollback<T>(
  runtime: Pick<ArkdownRuntimeDependencies, 'dispose'>,
  startup: () => T | Promise<T>,
): Promise<T> {
  try {
    return await startup()
  } catch (error) {
    try { await runtime.dispose() } catch { /* preserve the original startup failure */ }
    throw error
  }
}

export function createArkdownRuntimeDependencies(options: {
  readonly app: ElectronAppLocation
  readonly process: RuntimeProcessLocation
  readonly shutdown: ArkdownRuntimeShutdownDependencies
  readonly createWorkspaceCommitAdapter?: (
    options: WindowsWorkspaceCommitProcessOptions,
  ) => WindowsWorkspaceCommitAdapter
  readonly reportDiagnostic?: (code: ArkdownRuntimeShutdownDiagnosticCode) => void
}): ArkdownRuntimeDependencies {
  const openDocumentRegistry = new OpenDocumentRegistry()
  const workspaceAiEditorBoundary = new RegistryWorkspaceAiEditorBoundary(openDocumentRegistry)
  interface WindowCleanupEntry {
    readonly cleanup: () => void | Promise<void>
    active: boolean
    promise?: Promise<void>
  }
  const registrations = new Set<WindowCleanupEntry>()
  const inFlightWindowCleanups = new Set<Promise<void>>()
  const skippedWindowCleanup = Promise.resolve()
  let acceptingWindowCleanups = true
  let windowCleanupFailed = false
  let shutdown: Promise<void> | undefined
  const report = (code: ArkdownRuntimeShutdownDiagnosticCode): void => {
    try { options.reportDiagnostic?.(code) } catch { /* diagnostics never own shutdown */ }
  }
  const invokeWindowCleanup = (entry: WindowCleanupEntry): Promise<void> => {
    if (entry.promise) return entry.promise
    if (!entry.active) return skippedWindowCleanup
    entry.active = false
    registrations.delete(entry)
    let tracked!: Promise<void>
    tracked = Promise.resolve()
      .then(entry.cleanup)
      .catch(() => {
        windowCleanupFailed = true
        report('WINDOW_CLEANUP_FAILED')
        throw new Error('Arkdown window cleanup failed')
      })
      .finally(() => inFlightWindowCleanups.delete(tracked))
    entry.promise = tracked
    inFlightWindowCleanups.add(tracked)
    return tracked
  }
  const registerWindowCleanup = (
    cleanup: () => void | Promise<void>,
  ): ArkdownWindowCleanupRegistration => {
    if (!acceptingWindowCleanups) {
      throw new Error('Arkdown runtime cleanup registration is closed')
    }
    const entry: WindowCleanupEntry = { cleanup, active: true }
    registrations.add(entry)
    return Object.freeze({
      disposeWindow: () => invokeWindowCleanup(entry),
      unregister: () => {
        if (!entry.active) return
        entry.active = false
        registrations.delete(entry)
      },
    })
  }
  const dispose = (): Promise<void> => {
    if (shutdown) return shutdown
    acceptingWindowCleanups = false
    const registeredWindowCleanups = [...registrations]
    registrations.clear()
    for (const entry of registeredWindowCleanups) invokeWindowCleanup(entry)
    shutdown = (async () => {
      // A failed window finalizer must reach its caller without skipping other
      // windows or process-owned cleanup during whole-runtime shutdown.
      await Promise.allSettled([...inFlightWindowCleanups])
      let failed = windowCleanupFailed
      try { await options.shutdown.docx.dispose() } catch {
        failed = true
        report('DOCX_DISPOSE_FAILED')
      }
      try { await options.shutdown.documentConversion.dispose() } catch {
        failed = true
        report('DOCUMENT_CONVERSION_DISPOSE_FAILED')
      }
      try { await options.shutdown.screenshot.dispose() } catch {
        failed = true
        report('SCREENSHOT_RUNTIME_DISPOSE_FAILED')
      }
      if (failed) throw new Error('Arkdown runtime cleanup failed')
    })()
    return shutdown
  }

  const supportedArch = options.process.arch === 'x64' || options.process.arch === 'arm64'
    ? options.process.arch
    : undefined
  if (options.process.platform !== 'win32' || supportedArch === undefined) {
    return Object.freeze({
      workspaceCommitAdapter: undefined,
      openDocumentRegistry,
      workspaceAiEditorBoundary,
      registerWindowCleanup,
      dispose,
    })
  }
  const createAdapter = options.createWorkspaceCommitAdapter
    ?? ((adapterOptions: WindowsWorkspaceCommitProcessOptions) => (
      new WindowsWorkspaceCommitProcessAdapter(adapterOptions)
    ))
  const workspaceCommitAdapter = createAdapter({
    location: {
      isPackaged: options.app.isPackaged,
      resourcesPath: options.process.resourcesPath,
      appPath: options.app.getAppPath(),
      arch: supportedArch,
    },
  })
  return Object.freeze({
    workspaceCommitAdapter,
    openDocumentRegistry,
    workspaceAiEditorBoundary,
    registerWindowCleanup,
    dispose,
  })
}
