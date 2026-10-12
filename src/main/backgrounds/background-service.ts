import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  copyBackgroundSettings,
  normalizeBackgroundSettings,
  type BackgroundPresentation,
  type BackgroundSettings,
  type BackgroundApplyResult,
  type ObservedMainBackgroundSnapshot,
} from '../../shared/background-settings'
import type { SettingsAuthority } from '../settings/settings-authority'
import type { BackgroundControls, CheckedSettingsPatch, SettingsTransactionSnapshot } from '../settings/settings-transaction-types'

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.bmp', '.svg'])
const MAIN_BACKGROUND_DIRECTORY = ['backgrounds', 'main'] as const

export type MainBackgroundSettingsUpdater = Pick<SettingsAuthority, 'readFresh' | 'getDisplaySnapshot' | 'apply'>
type ObservedPresentation = BackgroundPresentation & { observed: ObservedMainBackgroundSnapshot }

function observe(snapshot: SettingsTransactionSnapshot): ObservedMainBackgroundSnapshot {
  const settings = normalizeBackgroundSettings(snapshot.settings.mainBackground)
  return { revision: snapshot.revision, settings, fieldRevisions: Object.fromEntries(
    Object.keys(settings).map(field => [field, snapshot.fieldRevisions.fields[`mainBackground.${field}`] ?? 0]),
  ) as ObservedMainBackgroundSnapshot['fieldRevisions'] }
}

export type MainBackgroundImageUpdate =
  | { kind: 'keep' }
  | { kind: 'remove' }
  | { kind: 'replace'; sourceAbsolutePath: string }

export interface MainBackgroundServiceOptions {
  dataRoot: string
  settings: MainBackgroundSettingsUpdater
  createId: () => string
  urlFor: (absolutePath: string) => string | Promise<string>
}

function supportedExtension(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase()
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error('仅支持 PNG、JPEG、WebP、AVIF、BMP 和 SVG 图片')
  }
  return extension
}

function managedRelativePath(fileName: string): string {
  return [...MAIN_BACKGROUND_DIRECTORY, fileName].join('/')
}

function isMissingResourceError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  const { code } = error as NodeJS.ErrnoException
  return code === 'ENOENT' || code === 'FILE_NOT_FOUND'
}

export class MainBackgroundService {
  private readonly directory: string
  private applyQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: MainBackgroundServiceOptions) {
    this.directory = path.join(options.dataRoot, ...MAIN_BACKGROUND_DIRECTORY)
  }

  private async validateSource(sourceAbsolutePath: string): Promise<string> {
    if (!path.isAbsolute(sourceAbsolutePath)) throw new Error('背景图片路径必须是绝对路径')
    const extension = supportedExtension(sourceAbsolutePath)
    const source = await lstat(sourceAbsolutePath)
    if (!source.isFile() || source.isSymbolicLink()) throw new Error('背景图片必须是本地普通文件')
    return extension
  }

  private resolveManagedImage(relativePath: string | null): string | null {
    if (relativePath === null) return null
    const normalized = relativePath.replaceAll('\\', '/')
    const prefix = `${MAIN_BACKGROUND_DIRECTORY.join('/')}/`
    if (!normalized.startsWith(prefix) || normalized.slice(prefix.length).includes('/')) return null
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(normalized).toLowerCase())) return null
    const absolutePath = path.resolve(this.options.dataRoot, ...normalized.split('/'))
    const directoryPrefix = `${path.resolve(this.directory)}${path.sep}`
    return absolutePath.startsWith(directoryPrefix) ? absolutePath : null
  }

  private async presentation(settings: BackgroundSettings): Promise<BackgroundPresentation> {
    const absolutePath = this.resolveManagedImage(settings.imageRelativePath)
    let imageUrl: string | null = null
    if (absolutePath !== null) {
      try {
        imageUrl = await this.options.urlFor(absolutePath)
      } catch (error) {
        if (!isMissingResourceError(error)) throw error
      }
    }
    return {
      settings: copyBackgroundSettings(settings),
      imageUrl,
    }
  }

  async get(): Promise<BackgroundPresentation> {
    await this.applyQueue
    const current = await this.options.settings.readFresh()
    return this.presentation(normalizeBackgroundSettings(current.settings.mainBackground))
  }

  async open(): Promise<ObservedPresentation> {
    await this.applyQueue
    const observed = observe(await this.options.settings.readFresh())
    return { ...await this.presentation(observed.settings), observed }
  }

  async preview(sourceAbsolutePath: string): Promise<string> {
    await this.validateSource(sourceAbsolutePath)
    return this.options.urlFor(sourceAbsolutePath)
  }

  apply(
    requestedSettings: BackgroundSettings,
    imageUpdate: MainBackgroundImageUpdate,
    assertCurrent: () => void = () => undefined,
    observed?: ObservedMainBackgroundSnapshot,
  ): Promise<BackgroundApplyResult & { observed?: ObservedMainBackgroundSnapshot }> {
    if (!observed) return Promise.reject(new Error('Background settings observation is required'))
    const original = structuredClone(observed)
    const requested = copyBackgroundSettings(requestedSettings)
    const image = { ...imageUpdate }
    const applying = this.applyQueue.then(() => this.applyInOrder(requested, image, assertCurrent, original))
    this.applyQueue = applying.catch(() => undefined)
    return applying
  }

  private async applyInOrder(
    requestedSettings: BackgroundSettings,
    imageUpdate: MainBackgroundImageUpdate,
    assertCurrent: () => void,
    observed: ObservedMainBackgroundSnapshot,
  ): Promise<BackgroundApplyResult & { observed?: ObservedMainBackgroundSnapshot }> {
    assertCurrent()
    const controls = normalizeBackgroundSettings(requestedSettings)
    let copiedAbsolutePath: string | null = null
    let nextRelativePath = observed.settings.imageRelativePath

    if (imageUpdate.kind === 'remove') {
      nextRelativePath = null
    } else if (imageUpdate.kind === 'replace') {
      const extension = await this.validateSource(imageUpdate.sourceAbsolutePath)
      const id = this.options.createId()
      if (!id || path.basename(id) !== id) throw new Error('无效的背景图片资源 ID')
      const fileName = `${id}${extension}`
      copiedAbsolutePath = path.join(this.directory, fileName)
      await mkdir(this.directory, { recursive: true })
      await copyFile(imageUpdate.sourceAbsolutePath, copiedAbsolutePath, constants.COPYFILE_EXCL)
      nextRelativePath = managedRelativePath(fileName)
    }

    const changes: CheckedSettingsPatch<BackgroundControls> = {}
    for (const field of Object.keys(controls) as (keyof BackgroundSettings)[]) {
      if (field === 'imageRelativePath' || controls[field] === observed.settings[field]) continue
      Object.assign(changes, { [field]: { value: controls[field], expected: {
        value: observed.settings[field], revision: observed.fieldRevisions[field],
      } } })
    }
    let committed: SettingsTransactionSnapshot
    try {
      assertCurrent()
      const result = await this.options.settings.apply({ baseRevision: observed.revision, operations: [{
        kind: 'main-background.apply', changes,
        image: imageUpdate.kind === 'keep' ? { kind: 'keep' } : {
          ...(imageUpdate.kind === 'remove' ? { kind: 'remove' as const }
            : { kind: 'replace' as const, relativePath: nextRelativePath! }),
          expected: { value: observed.settings.imageRelativePath, revision: observed.fieldRevisions.imageRelativePath },
        },
      }] })
      if (result.status === 'conflict') {
        if (copiedAbsolutePath !== null) await rm(copiedAbsolutePath, { force: true }).catch(() => undefined)
        return { status: 'conflict' }
      }
      if (result.status === 'invalid') throw new Error('Background settings command is invalid')
      // cleanupPending is an acknowledged commit, never candidate rollback authority.
      committed = result.snapshot
    } catch (error) {
      if (copiedAbsolutePath !== null) await rm(copiedAbsolutePath, { force: true }).catch(() => undefined)
      throw error
    }

    const next = normalizeBackgroundSettings(committed.settings.mainBackground)
    const oldAbsolutePath = imageUpdate.kind === 'keep' ? null : this.resolveManagedImage(observed.settings.imageRelativePath)
    const newAbsolutePath = this.resolveManagedImage(next.imageRelativePath)
    if (oldAbsolutePath !== null && oldAbsolutePath !== newAbsolutePath) {
      await rm(oldAbsolutePath, { force: true }).catch(() => undefined)
    }
    return { ...await this.presentation(next), observed: observe(committed) }
  }
}
