import { parseMermaidViewerSnapshot, type MermaidViewerSnapshot } from '../../shared/mermaid-viewer'
import { appError } from '../../shared/public-errors'
import { validateSvg } from '../assets/mermaid-image-export-service'

export interface MermaidViewerOwner {
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}

export interface MermaidViewerWindow extends MermaidViewerOwner {
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  destroy(): void
}

export interface MermaidViewerHandle {
  window: MermaidViewerWindow
  load(): Promise<void>
  dispose(): void
}

interface ViewerEntry {
  handle: MermaidViewerHandle
  loaded: Promise<void>
  close(): void
}

interface OwnerEntry {
  viewers: Map<string, ViewerEntry>
  closed(): void
}

const MAX_VIEWERS_PER_OWNER = 4

export class MermaidViewerManager<Owner extends MermaidViewerOwner> {
  private readonly owners = new WeakMap<Owner, OwnerEntry>()

  constructor(private readonly dependencies: {
    createWindow(owner: Owner, snapshot: MermaidViewerSnapshot): MermaidViewerHandle
  }) {}

  async open(owner: Owner, input: MermaidViewerSnapshot): Promise<void> {
    if (owner.isDestroyed()) throw appError('OPERATION_FAILED')
    const parsed = parseMermaidViewerSnapshot(input)
    if (!parsed) throw appError('INVALID_INPUT')
    validateSvg(parsed.svgDataUrl)
    const snapshot = Object.freeze({ ...parsed })
    const key = JSON.stringify(snapshot)
    let state = this.owners.get(owner)
    const existing = state?.viewers.get(key)
    if (existing) {
      await existing.loaded
      this.show(owner, existing.handle.window)
      return
    }
    if (state && state.viewers.size >= MAX_VIEWERS_PER_OWNER) {
      throw appError('MERMAID_VIEWER_LIMIT_REACHED')
    }
    // Construct synchronously, then reserve the slot before starting any asynchronous work.
    const handle = this.dependencies.createWindow(owner, snapshot)
    if (!state) {
      const viewers = new Map<string, ViewerEntry>()
      const closed = () => { for (const entry of [...viewers.values()]) entry.close() }
      state = { viewers, closed }
      this.owners.set(owner, state)
      owner.once('closed', closed)
    }
    const ownerState = state
    let finished = false
    let rejectClosed!: (error: Error) => void
    const closedDuringLoad = new Promise<never>((_resolve, reject) => { rejectClosed = reject })
    const cleanup = () => {
      if (finished) return
      finished = true
      handle.window.removeListener('closed', cleanup)
      ownerState.viewers.delete(key)
      if (ownerState.viewers.size === 0) {
        owner.removeListener('closed', ownerState.closed)
        this.owners.delete(owner)
      }
      rejectClosed(appError('OPERATION_FAILED'))
      handle.dispose()
    }
    const close = () => {
      cleanup()
      if (!handle.window.isDestroyed()) handle.window.destroy()
    }
    const entry: ViewerEntry = { handle, loaded: Promise.resolve(), close }
    ownerState.viewers.set(key, entry)
    handle.window.once('closed', cleanup)
    // Attach the rejection handler before load, including a synchronous load failure.
    entry.loaded = Promise.race([
      closedDuringLoad,
      new Promise<void>((resolve, reject) => {
        try { resolve(handle.load()) } catch (error) { reject(error) }
      }),
    ]).then(() => {
      if (finished || owner.isDestroyed() || handle.window.isDestroyed()) {
        throw appError('OPERATION_FAILED')
      }
    }).catch(error => {
      close()
      throw error
    })
    if (owner.isDestroyed()) close()
    await entry.loaded
    this.show(owner, handle.window)
  }

  private show(owner: Owner, window: MermaidViewerWindow): void {
    if (owner.isDestroyed() || window.isDestroyed()) throw appError('OPERATION_FAILED')
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}
