interface BeforeQuitEvent {
  preventDefault(): void
}

interface ArknoteQuitGuardOptions {
  quitApp(): void
  flushAndQuit(): Promise<void>
  reportError(error: unknown): void
}

export interface ArknoteQuitGuard {
  quitApp(): void
  handleBeforeQuit(event: BeforeQuitEvent): void
}

export function createArknoteQuitGuard(
  options: ArknoteQuitGuardOptions,
): ArknoteQuitGuard {
  let allowQuit = false
  return {
    quitApp: () => {
      allowQuit = true
      try {
        options.quitApp()
      } catch (error) {
        allowQuit = false
        throw error
      }
    },
    handleBeforeQuit: (event) => {
      if (allowQuit) return
      event.preventDefault()
      void options.flushAndQuit().catch(options.reportError)
    },
  }
}
