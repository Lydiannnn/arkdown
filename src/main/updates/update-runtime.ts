import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { type UpdateChannel, type UpdateSnapshot } from '../../shared/app-update'
import { readUpdateIdentity } from './update-identity'
import { requestUpdateDecision, type UpdateTransport } from './update-http'
import { UpdateEventSender } from './update-events'
import { AppUpdateService } from './update-service'
import type { UpdateWindowPort } from './update-ipc'
import type { UpdateArtifact } from './update-protocol'
import { UpdateCache, updateArtifactKey } from './update-cache'
import { UpdateDownloadManager, type DownloadProgress } from './update-download'
import { UpdatePreferences } from './update-preferences'
import { UpdatePackageInvalidError } from './update-errors'

export function createAppUpdateRuntime(options: {
  version: string; isPackaged: boolean; resourcesPath: string; executablePath: string; channel: UpdateChannel
  ensureInstallationId(candidate: string): Promise<string>
  openWebsite(url: string): Promise<void>
  requestExit(): void
  transport?: UpdateTransport
  updateRoot?: string
  requestInstall?(artifact: UpdateArtifact, verifiedFile: string): Promise<void>
}) {
  const namespace = createHash('sha256').update(path.resolve(options.executablePath).toLowerCase() + ':' + options.channel).digest('hex')
  const directory = path.join(options.updateRoot ?? path.join(path.dirname(options.executablePath), 'portable-data', 'updates'), namespace)
  const preferences = new UpdatePreferences(directory), cache = new UpdateCache(path.join(directory, 'downloads'))
  let progressListener: ((progress: DownloadProgress) => void) | undefined
  const downloader = new UpdateDownloadManager(cache, options.transport, progress => progressListener?.(progress))
  const events = new UpdateEventSender(options, options.transport)
  const check = async (signal: AbortSignal) => {
    const identity = await readUpdateIdentity({ appVersion: options.version, ...options })
    if (!identity || signal.aborted) return undefined
    const installationId = await options.ensureInstallationId(randomUUID())
    if (signal.aborted) return undefined
    return requestUpdateDecision(identity, installationId, signal, options.transport)
  }
  const service = new AppUpdateService({ currentVersion: options.version,
    check,
    sendEvent: type => events.send(type), openWebsite: options.openWebsite, requestExit: options.requestExit,
    readSkippedVersion: () => preferences.readSkippedVersion(), skipVersion: version => preferences.skipVersion(version),
    getVerified: artifact => cache.getVerified(artifact),
    download: (artifact, progress) => { progressListener = progress; return downloader.start(artifact) },
    cancelDownload: () => downloader.cancel(),
    requestInstall: async (artifact, verifiedFile) => {
      const decision = await check(new AbortController().signal)
      if (!decision) throw new Error('暂时无法确认此版本是否仍可安装，请检查网络后重试。')
      if (!decision.artifact || updateArtifactKey(decision.artifact) !== updateArtifactKey(artifact)) throw new Error('此更新已撤回或发生变化，请重新启动 Arkdown 后检查更新。')
      try { if (await cache.getVerified(artifact) !== verifiedFile) throw new UpdatePackageInvalidError() }
      catch { throw new UpdatePackageInvalidError() }
      if (!options.requestInstall) throw new Error('当前构建尚未包含更新安装助手。')
      await options.requestInstall(artifact, verifiedFile)
    },
  })
  return {
    service,
    bind(ownerId: number, isAlive: () => boolean): UpdateWindowPort {
      return { isAlive, getState: () => service.getSnapshot(ownerId),
        about: input => input.open ? service.aboutOpened(ownerId, input.interactionId) : service.aboutClosed(ownerId, input.interactionId),
        openWebsite: () => service.openWebsite(ownerId),
        requestExit: () => { if (!service.getSnapshot(ownerId).candidate?.required) throw new Error('No required update'); service.requestRequiredExit(ownerId) },
        protect: () => service.protectWork(ownerId),
        action: input => service.action(ownerId, input),
        isWorkBlocked: () => service.isWorkBlocked(),
        noteWorkStarted: () => service.noteWorkStarted(ownerId),
      }
    },
    attach(ownerId: number, listener: (snapshot: UpdateSnapshot) => void) { return service.subscribe(ownerId, listener) },
    dispose() { service.dispose(); events.dispose() },
  }
}
