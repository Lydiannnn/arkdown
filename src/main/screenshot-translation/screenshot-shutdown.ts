import type { ScreenshotTranslationCoordinator } from './screenshot-translation-coordinator'
import type { ScreenshotShortcutRegistration } from './screenshot-shortcut'

export type ScreenshotQuitDiagnosticCode =
  | 'SHORTCUT_DISPOSE_FAILED'
  | 'COORDINATOR_DISPOSE_FAILED'
  | 'FINAL_QUIT_FAILED'

export interface ScreenshotQuitGate {
  handleWillQuit(event: { preventDefault(): void }): void
}

export interface ScreenshotQuitAppLifecycle {
  on(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown
}

export function installScreenshotQuitGate(
  app: ScreenshotQuitAppLifecycle,
  gate: ScreenshotQuitGate,
): void {
  app.on('will-quit', gate.handleWillQuit)
}

export async function disposeScreenshotRuntime(
  coordinator: Pick<ScreenshotTranslationCoordinator, 'dispose'>,
  models: { dispose(): void | Promise<void> },
): Promise<void> {
  let failed = false
  try {
    try { await coordinator.dispose() } catch { failed = true }
  } finally {
    try { await models.dispose() } catch { failed = true }
  }
  if (failed) throw new Error('Screenshot runtime cleanup failed')
}

export function createScreenshotQuitGate(options: {
  coordinator: Pick<ScreenshotTranslationCoordinator, 'dispose'>
  shortcut: Pick<ScreenshotShortcutRegistration, 'dispose'>
  quit(): void
  reportDiagnostic?(code: ScreenshotQuitDiagnosticCode): void
}): ScreenshotQuitGate {
  let cleanup: Promise<void> | undefined
  let readyToQuit = false

  const report = (code: ScreenshotQuitDiagnosticCode) => {
    try { options.reportDiagnostic?.(code) } catch { /* diagnostics never own shutdown */ }
  }

  return {
    handleWillQuit(event) {
      if (readyToQuit) return
      event.preventDefault()
      if (cleanup) return
      try { options.shortcut.dispose() } catch { report('SHORTCUT_DISPOSE_FAILED') }
      cleanup = Promise.resolve()
        .then(() => options.coordinator.dispose())
        .catch(() => report('COORDINATOR_DISPOSE_FAILED'))
        .then(() => {
          readyToQuit = true
          try { options.quit() } catch {
            readyToQuit = false
            cleanup = undefined
            report('FINAL_QUIT_FAILED')
          }
        })
    },
  }
}
