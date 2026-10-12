import type { BrowserWindow } from 'electron'
import { SCREENSHOT_TRANSLATION_ACCELERATOR } from '../../shared/screenshot-translation'

export type ScreenshotShortcutDiagnosticCode =
  | 'REGISTRATION_CONFLICT'
  | 'REGISTRATION_FAILED'
  | 'REGISTRATION_UNVERIFIED'
  | 'VERIFICATION_FAILED'
  | 'CAPTURE_LAUNCH_FAILED'
  | 'UNREGISTER_FAILED'

export interface ScreenshotGlobalShortcutAdapter {
  register(accelerator: string, callback: () => void): boolean
  isRegistered(accelerator: string): boolean
  unregister(accelerator: string): void
}

export interface ScreenshotShortcutDependencies {
  accelerator?: string | null
  globalShortcut: ScreenshotGlobalShortcutAdapter
  getOwner(): BrowserWindow | undefined
  beginCapture(owner: BrowserWindow): void | Promise<void>
  onDiagnostic?(code: ScreenshotShortcutDiagnosticCode): void
}

export interface ScreenshotShortcutRegistration {
  registered: boolean
  replace(accelerator: string | null, persist: () => Promise<void>): Promise<boolean>
  suspend(): boolean
  resume(): boolean
  dispose(): void
}

export function registerScreenshotTranslationShortcut(
  dependencies: ScreenshotShortcutDependencies,
): ScreenshotShortcutRegistration {
  let disposed = false
  let accelerator = dependencies.accelerator === undefined ? SCREENSHOT_TRANSLATION_ACCELERATOR : dependencies.accelerator
  const owned = new Set<string>()
  let suspended = false
  let resumeRequired = false
  let verified = false

  const report = (code: ScreenshotShortcutDiagnosticCode): void => {
    try {
      dependencies.onDiagnostic?.(code)
    } catch {
      // Diagnostics must never disturb shortcut or shutdown behavior.
    }
  }

  const launch = (key: string): void => {
    if (disposed || suspended || key !== accelerator) return
    let owner: BrowserWindow | undefined
    try {
      owner = dependencies.getOwner()
      if (!owner) return
      const result = dependencies.beginCapture(owner)
      if (result && typeof result.then === 'function') {
        void Promise.resolve(result).catch(() => report('CAPTURE_LAUNCH_FAILED'))
      }
    } catch {
      report('CAPTURE_LAUNCH_FAILED')
    }
  }

  const acquire = (key: string): boolean => {
    try {
      const registered = dependencies.globalShortcut.register(key, () => launch(key))
      if (!registered) { report('REGISTRATION_CONFLICT'); return false }
      owned.add(key)
      try {
        const valid = dependencies.globalShortcut.isRegistered(key)
        if (!valid) report('REGISTRATION_UNVERIFIED')
        return valid
      } catch {
        report('VERIFICATION_FAILED')
        return false
      }
    } catch {
      report('REGISTRATION_FAILED')
      return false
    }
  }
  const release = (key: string): boolean => {
    if (!owned.has(key)) return true
    try { dependencies.globalShortcut.unregister(key); owned.delete(key); return true }
    catch { report('UNREGISTER_FAILED'); return false }
  }
  if (accelerator !== null) verified = acquire(accelerator)

  return {
    get registered() { return !disposed && !suspended && verified },
    async replace(next, persist): Promise<boolean> {
      if (disposed) return false
      const previous = accelerator
      const newlyRegistered = next !== null && (next !== previous || suspended || !verified)
      if (newlyRegistered && !acquire(next!)) {
        if (next !== previous || suspended) release(next!)
        return false
      }
      try { await persist() } catch (error) {
        if (newlyRegistered && (next !== previous || suspended)) release(next!)
        throw error
      }
      accelerator = next
      verified = next !== null
      if (suspended) resumeRequired = next !== null
      if (previous !== null && previous !== next) release(previous)
      if (suspended && next !== null) release(next)
      return true
    },
    suspend(): boolean {
      if (disposed) return false
      if (suspended) return true
      resumeRequired = accelerator !== null && verified
      suspended = true
      if (accelerator !== null && !release(accelerator)) { suspended = false; return false }
      return true
    },
    resume(): boolean {
      if (disposed) return false
      if (!suspended) return accelerator === null || verified
      if (resumeRequired && accelerator !== null) {
        if (owned.has(accelerator)) release(accelerator)
        verified = acquire(accelerator)
        if (!verified) return false
      }
      suspended = false
      return true
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const key of owned) release(key)
    },
  }
}
