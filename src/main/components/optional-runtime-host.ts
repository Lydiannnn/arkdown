import path from 'node:path'
import { createRuntimeComponentManager, type RuntimeComponentManager } from './runtime-component-manager'
import { RUNTIME_COMPONENT_DEFINITIONS, runtimeComponentSourceDirectory } from '../../shared/optional-component-catalog'
import { createRuntimeInstallBroker } from './runtime-install-broker'
import { createRuntimeInstallerWindow } from './runtime-installer-window'
import { createCodexRuntimeSelection } from '../codex/codex-runtime-selection'

type RuntimeId = keyof typeof RUNTIME_COMPONENT_DEFINITIONS
export function createOptionalRuntimeHost(options: {
  dataRoot: string
  resourcesPath: string
  developmentRoot?: string
  appearance(): { dark: boolean; themeColor: string }
}) {
  const managers = new Map<RuntimeId, Promise<RuntimeComponentManager>>()
  const broker = createRuntimeInstallBroker({ present: input => createRuntimeInstallerWindow(input, options.appearance()) })
  let disposed = false
  function manager(id: RuntimeId): Promise<RuntimeComponentManager> {
    if (disposed) return Promise.reject(new Error('组件已关闭'))
    let promise = managers.get(id)
    if (!promise) {
      promise = createRuntimeComponentManager({ dataRoot: options.dataRoot,
        bundledRoot: options.developmentRoot ? path.join(options.developmentRoot, '.components', runtimeComponentSourceDirectory(id), 'runtime')
          : path.join(options.resourcesPath, 'components', id), definition: RUNTIME_COMPONENT_DEFINITIONS[id] })
      managers.set(id, promise)
      void promise.catch(() => { if (managers.get(id) === promise) managers.delete(id) })
    }
    return promise
  }
  const resolve = async (id: RuntimeId) => (await manager(id)).ensureRuntime()
  const ensure = async (id: RuntimeId, signal?: AbortSignal) => broker.ensure(await manager(id), RUNTIME_COMPONENT_DEFINITIONS[id].label, signal)
  const codex = createCodexRuntimeSelection({
    resolveManaged: () => resolve('codex-cli'),
    installManaged: signal => ensure('codex-cli', signal),
  })
  return {
    resolve,
    ensure,
    resolveCodex: codex.resolve,
    ensureCodex: codex.ensure,
    async dispose() {
      disposed = true
      const codexCleanup = codex.dispose()
      await broker.dispose()
      await codexCleanup
      const loaded = await Promise.allSettled(managers.values())
      await Promise.all(loaded.filter((result): result is PromiseFulfilledResult<RuntimeComponentManager> => result.status === 'fulfilled').map(result => result.value.dispose()))
    },
  }
}
