import { appError } from '../../shared/public-errors'
import { SCREENSHOT_OCR_BUNDLED_VERSION } from '../../shared/screenshot-ocr-manifest'
import type { ScreenshotOcrModelState, ScreenshotOcrTier } from '../../shared/screenshot-ocr-models'
import type { ScreenshotOcrModelManager, ScreenshotOcrModelManagerOptions } from './screenshot-ocr-model-manager'

export interface LazyScreenshotOcrModelManager extends Omit<ScreenshotOcrModelManager,
  'acquireTier' | 'resolveActiveTier' | 'reportTierUnavailable'> {
  initialize(): Promise<void>
  acquireTier(): Promise<ReturnType<ScreenshotOcrModelManager['acquireTier']>>
  resolveActiveTier(): Promise<ScreenshotOcrTier>
  reportTierUnavailable(tier: ScreenshotOcrTier): Promise<void>
}

type ManagerFactory = (options: ScreenshotOcrModelManagerOptions) => Promise<ScreenshotOcrModelManager>

async function defaultFactory(options: ScreenshotOcrModelManagerOptions): Promise<ScreenshotOcrModelManager> {
  const [{ createScreenshotOcrModelManager }, { verifyScreenshotOcrArchiveInWorker }] = await Promise.all([
    import('./screenshot-ocr-model-manager'), import('./screenshot-ocr-validation'),
  ])
  return createScreenshotOcrModelManager({ ...options,
    verifyArchive: options.verifyArchive ?? verifyScreenshotOcrArchiveInWorker })
}

/** Storage, recovery, and model validation start only when an actual consumer requests them. */
export function createLazyScreenshotOcrModelManager(
  options: ScreenshotOcrModelManagerOptions,
  createManager: ManagerFactory = defaultFactory,
): LazyScreenshotOcrModelManager {
  let manager: ScreenshotOcrModelManager | undefined
  let initialization: Promise<ScreenshotOcrModelManager> | undefined
  let disposed = false
  let disposal: Promise<void> | undefined
  const snapshot = (): ScreenshotOcrModelState => manager?.getState() ?? {
    activeTier: 'small', bundledVersion: SCREENSHOT_OCR_BUNDLED_VERSION,
    mediumVersion: null, availableMediumVersion: null, status: 'bundled-small',
    progress: null, errorCode: null,
  }
  const emit = (state: ScreenshotOcrModelState): void => {
    if (disposed) return
    try { options.onState?.(state) } catch { /* observers do not own model state */ }
  }
  const ready = async (): Promise<ScreenshotOcrModelManager> => {
    if (disposed) throw appError('OPERATION_FAILED')
    initialization ??= Promise.resolve().then(() => createManager({ ...options, onState: emit })).then(value => {
      manager = value
      emit(value.getState())
      return value
    })
    const value = await initialization
    if (disposed) throw appError('OPERATION_FAILED')
    return value
  }
  const use = async <T>(operation: (value: ScreenshotOcrModelManager) => T): Promise<Awaited<T>> => {
    const value = await ready()
    if (disposed) throw appError('OPERATION_FAILED')
    return await operation(value)
  }
  return {
    getState: snapshot,
    getObservedState: () => use(value => value.getObservedState()),
    initialize: () => use(() => undefined),
    acquireTier: () => use(async value => {
      await options.settings.readFresh()
      if (disposed) throw appError('OPERATION_FAILED')
      const lease = value.acquireTier()
      if (lease.tier !== 'medium') return lease
      try {
        // A peer may have disabled Medium between the fresh read and lease
        // publication. Once leased, its mutation path cannot pass the reader check.
        await options.settings.readFresh()
        if (disposed) throw appError('OPERATION_FAILED')
        if (value.resolveActiveTier() === 'medium') return lease
        lease.release()
        return { tier: 'small' as const, release() {} }
      } catch (error) {
        lease.release()
        throw error
      }
    }),
    resolveActiveTier: () => use(async value => {
      await options.settings.readFresh()
      if (disposed) throw appError('OPERATION_FAILED')
      return value.resolveActiveTier()
    }),
    reportTierUnavailable: tier => use(value => value.reportTierUnavailable(tier)),
    resolveActiveResource: name => use(value => value.resolveActiveResource(name)),
    downloadMedium: observed => { const captured = structuredClone(observed); return use(value => value.downloadMedium(captured)) },
    cancelMediumDownload: () => use(value => value.cancelMediumDownload()),
    removeMedium: observed => { const captured = structuredClone(observed); return use(value => value.removeMedium(captured)) },
    dispose() {
      disposed = true
      disposal ??= (async () => {
        // A failed factory owns no manager. Never start one solely for shutdown.
        const value = await initialization?.catch(() => undefined)
        await value?.dispose()
      })()
      return disposal
    },
  }
}
