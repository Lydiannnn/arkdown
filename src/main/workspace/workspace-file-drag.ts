import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { isVisibleWorkspacePath } from '../../shared/document-types'
import { appError } from '../../shared/public-errors'
import { assertWorkspaceRelativePath, resolveExistingInside } from './workspace-path'
import { queryWindowsReparsePoint } from './windows-reparse-point'
import type { WorkspaceService } from './workspace-service'

interface DragOwner {
  readonly mainFrame: unknown
  isDestroyed(): boolean
  on(event: 'did-start-navigation', listener: (details: { isSameDocument: boolean; isMainFrame: boolean }) => void): unknown
  on(event: 'render-process-gone' | 'destroyed', listener: () => void): unknown
  removeListener(event: 'did-start-navigation', listener: (details: { isSameDocument: boolean; isMainFrame: boolean }) => void): unknown
  removeListener(event: 'render-process-gone' | 'destroyed', listener: () => void): unknown
}

const inputSchema = z.object({ workspace: z.string().min(1).max(32768), relativePath: z.string().min(1).max(32768) }).strict()
const samePath = (a: string, b: string): boolean => path.normalize(a).toLocaleLowerCase('en-US') === path.normalize(b).toLocaleLowerCase('en-US')

/** Read-only saved-file drag. Native COPY/LINK owns the destination operation. */
export class WorkspaceFileDrag {
  private lifetime = 0
  private disposed = false
  private pending = false
  private readonly navigate = (details: { isSameDocument: boolean; isMainFrame: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) this.lifetime += 1
  }
  private readonly gone = (): void => { this.lifetime += 1 }
  private readonly destroyed = (): void => { this.dispose() }

  constructor(private readonly options: {
    workspace: WorkspaceService
    owner: DragOwner
    prepareNativeDrag(absolutePath: string): Promise<() => void>
    queryReparsePoint?: (absolutePath: string) => Promise<boolean>
  }) {
    options.owner.on('did-start-navigation', this.navigate)
    options.owner.on('render-process-gone', this.gone)
    options.owner.on('destroyed', this.destroyed)
  }

  async start(input: unknown, accepting: () => boolean): Promise<void> {
    const { workspace, relativePath } = inputSchema.parse(input)
    assertWorkspaceRelativePath(relativePath)
    if (!isVisibleWorkspacePath(relativePath)) throw appError('UNSUPPORTED_FILE_TYPE')
    if (this.disposed || this.pending || this.options.owner.isDestroyed() || !accepting()) throw appError('OPERATION_FAILED')
    const activation = this.options.workspace.getActivationSnapshot()
    if (!samePath(workspace, activation.root)) throw appError('INVALID_INPUT')
    const frame = this.options.owner.mainFrame, lifetime = this.lifetime
    const requireCurrent = (): void => {
      const current = this.options.workspace.getActivationSnapshot()
      if (this.disposed || this.options.owner.isDestroyed() || !accepting()
        || this.lifetime !== lifetime || this.options.owner.mainFrame !== frame
        || current.epoch !== activation.epoch || !samePath(current.root, activation.root)) throw appError('OPERATION_FAILED')
    }
    const inspect = async () => await this.options.workspace.withMutationLease(activation, async root => {
      const absolutePath = await resolveExistingInside(root, relativePath)
      if (!samePath(path.resolve(root, relativePath), absolutePath)) throw appError('INVALID_INPUT')
      if (await (this.options.queryReparsePoint ?? queryWindowsReparsePoint)(absolutePath)) throw appError('INVALID_INPUT')
      const metadata = await lstat(absolutePath, { bigint: true })
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw appError('UNSUPPORTED_FILE_TYPE')
      return { absolutePath, metadata }
    })
    this.pending = true
    try {
      const before = await inspect()
      requireCurrent()
      const beginNative = await this.options.prepareNativeDrag(before.absolutePath)
      requireCurrent()
      const after = await inspect()
      requireCurrent()
      if (!samePath(before.absolutePath, after.absolutePath)
        || (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const).some(key => before.metadata[key] !== after.metadata[key])) throw appError('INVALID_INPUT')
      // No workspace lease survives into the OS drag loop. This is admission,
      // never a receipt that a copy or shortcut was actually created.
      beginNative()
    } finally { this.pending = false }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime += 1
    this.options.owner.removeListener('did-start-navigation', this.navigate)
    this.options.owner.removeListener('render-process-gone', this.gone)
    this.options.owner.removeListener('destroyed', this.destroyed)
  }
}
