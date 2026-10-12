import type { DocumentConversionComponentManager } from './component-manager'
import type { DocumentConversionService } from './document-conversion-service'

export interface DocumentConversionRuntimeLifecycle {
  dispose(): Promise<void>
}

export async function runWithDocumentConversionStartupRollback<T>(
  lifecycle: Pick<DocumentConversionRuntimeLifecycle, 'dispose'>,
  startup: () => T | Promise<T>,
): Promise<T> {
  try {
    return await startup()
  } catch (error) {
    try { await lifecycle.dispose() } catch { /* The original startup failure remains authoritative. */ }
    throw error
  }
}

export function createDocumentConversionRuntimeLifecycle(options: {
  conversions: Pick<DocumentConversionService, 'disposeAndDrain'>
  manager: Pick<DocumentConversionComponentManager, 'dispose'>
}): DocumentConversionRuntimeLifecycle {
  let disposal: Promise<void> | undefined

  return {
    dispose() {
      disposal ??= (async () => {
        let failed = false
        try { await options.conversions.disposeAndDrain() } catch { failed = true }
        try { await options.manager.dispose() } catch { failed = true }
        if (failed) throw new Error('Document conversion runtime cleanup failed')
      })()
      return disposal
    },
  }
}
