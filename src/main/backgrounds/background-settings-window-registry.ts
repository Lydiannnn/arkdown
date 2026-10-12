import type {
  BackgroundPresentation,
  BackgroundSettings,
  BackgroundTarget,
  BackgroundApplyResult,
} from '../../shared/background-settings'
import type { BackgroundIpcService } from '../ipc/register-ipc'
import type { BackgroundPresentationEvent } from './background-workflow'

export interface BackgroundSettingsWindow {
  show(): void
  focus(): void
  close(): void
  once(event: 'ready-to-show' | 'closed', listener: () => void): void
}

export interface BackgroundSettingsWindowRegistration {
  dispose(): void
}

export interface BackgroundSettingsWindowWorkflow {
  begin(
    target: BackgroundTarget,
    deliver: (event: BackgroundPresentationEvent) => void,
    token?: object,
  ): Promise<BackgroundPresentation>
  get(target: BackgroundTarget): Promise<BackgroundPresentation>
  getSession(target: BackgroundTarget): Promise<BackgroundPresentation>
  choose(target: BackgroundTarget): Promise<BackgroundPresentation | null>
  remove(target: BackgroundTarget): Promise<BackgroundPresentation>
  preview(target: BackgroundTarget, settings: BackgroundSettings): Promise<void>
  apply(target: BackgroundTarget, settings: BackgroundSettings): Promise<BackgroundApplyResult>
  cancel(target: BackgroundTarget, token?: object): Promise<void>
  end(target: BackgroundTarget, token?: object): void
}

export interface BackgroundSettingsWindowRegistryOptions {
  workflow: BackgroundSettingsWindowWorkflow
  createWindow(target: BackgroundTarget): BackgroundSettingsWindow
  register(
    window: BackgroundSettingsWindow,
    service: BackgroundIpcService,
  ): BackgroundSettingsWindowRegistration
  reportError?(error: unknown): void
}

interface WindowEntry {
  owner: object
  target: BackgroundTarget
  window: BackgroundSettingsWindow | null
  registration: BackgroundSettingsWindowRegistration | null
  opening: Promise<void>
  ready: boolean
  closed: boolean
  service: BackgroundIpcService | null
}

function keyFor(target: BackgroundTarget): string {
  return target.kind === 'main' ? 'main' : `sticky-note:${target.noteId}`
}

function copyTarget(target: BackgroundTarget): BackgroundTarget {
  return target.kind === 'main'
    ? { kind: 'main' }
    : { kind: 'sticky-note', noteId: target.noteId }
}

function sameTarget(left: BackgroundTarget, right: BackgroundTarget): boolean {
  return left.kind === right.kind
    && (left.kind === 'main' || left.noteId === (right as { noteId: string }).noteId)
}

export class BackgroundSettingsWindowRegistry {
  private readonly entries = new Map<string, WindowEntry>()
  private readonly reportError: (error: unknown) => void

  constructor(private readonly options: BackgroundSettingsWindowRegistryOptions) {
    this.reportError = options.reportError ?? (() => undefined)
  }

  serviceFor(
    originDeliver: (event: BackgroundPresentationEvent) => void,
    owner: object = originDeliver,
  ): BackgroundIpcService {
    return {
      open: (target) => this.open(target, originDeliver, owner),
      get: (target) => this.options.workflow.get(target),
      choose: (target) => this.serviceForTarget(target).choose(target),
      remove: (target) => this.serviceForTarget(target).remove(target),
      preview: (target, settings) => this.serviceForTarget(target).preview(target, settings),
      apply: (target, settings) => this.serviceForTarget(target).apply(target, settings),
      cancel: (target) => this.serviceForTarget(target).cancel(target),
    }
  }

  private serviceForTarget(target: BackgroundTarget): BackgroundIpcService {
    const entry = this.entries.get(keyFor(target))
    if (!entry?.service) throw new Error('Background settings session is unavailable')
    return entry.service
  }

  private scopedService(entry: WindowEntry): BackgroundIpcService {
    const requireTarget = (target: BackgroundTarget) => {
      if (!sameTarget(entry.target, target)) throw new Error('Background settings target mismatch')
      if (entry.closed || this.entries.get(keyFor(target)) !== entry) {
        throw new Error('Background settings session is unavailable')
      }
    }
    return {
      open: async (target) => {
        requireTarget(target)
        await this.open(target, () => undefined, entry.owner)
      },
      get: async (target) => {
        requireTarget(target)
        return this.options.workflow.getSession(target)
      },
      choose: async (target) => {
        requireTarget(target)
        return this.options.workflow.choose(target)
      },
      remove: async (target) => {
        requireTarget(target)
        return this.options.workflow.remove(target)
      },
      preview: async (target, settings) => {
        requireTarget(target)
        await this.options.workflow.preview(target, settings)
      },
      apply: async (target, settings) => {
        requireTarget(target)
        return this.options.workflow.apply(target, settings)
      },
      cancel: async (target) => {
        requireTarget(target)
        const closing = this.closeEntry(entry)
        entry.window?.close()
        await closing
      },
    }
  }

  async open(
    target: BackgroundTarget,
    originDeliver: (event: BackgroundPresentationEvent) => void,
    owner: object = originDeliver,
  ): Promise<void> {
    const key = keyFor(target)
    const existing = this.entries.get(key)
    if (existing) {
      await existing.opening
      if (existing.ready) existing.window?.show()
      existing.window?.focus()
      return
    }

    const entry: WindowEntry = {
      owner,
      target: copyTarget(target),
      window: null,
      registration: null,
      opening: Promise.resolve(),
      ready: false,
      closed: false,
      service: null,
    }
    this.entries.set(key, entry)
    entry.opening = this.startEntry(entry, originDeliver)
    return entry.opening
  }

  private async startEntry(
    entry: WindowEntry,
    originDeliver: (event: BackgroundPresentationEvent) => void,
  ): Promise<void> {
    try {
      await this.options.workflow.begin(entry.target, originDeliver, entry)
      if (entry.closed || this.entries.get(keyFor(entry.target)) !== entry) return
      entry.window = this.options.createWindow(entry.target)
      entry.service = this.scopedService(entry)
      entry.registration = this.options.register(entry.window, entry.service)
      entry.window.once('ready-to-show', () => {
        if (!entry.closed && this.entries.get(keyFor(entry.target)) === entry) {
          entry.ready = true
          entry.window?.show()
        }
      })
      entry.window.once('closed', () => { void this.closeEntry(entry) })
    } catch (error) {
      if (entry.closed) return
      await this.closeEntry(entry)
      entry.window?.close()
      this.reportError(error)
      throw error
    }
  }

  private async closeEntry(entry: WindowEntry): Promise<void> {
    if (entry.closed) return
    entry.closed = true
    if (this.entries.get(keyFor(entry.target)) === entry) {
      this.entries.delete(keyFor(entry.target))
    }
    try {
      await this.options.workflow.cancel(entry.target, entry)
    } catch (error) {
      this.reportError(error)
    } finally {
      try {
        entry.registration?.dispose()
      } catch (error) {
        this.reportError(error)
      }
      try {
        this.options.workflow.end(entry.target, entry)
      } catch (error) {
        this.reportError(error)
      }
    }
  }

  serviceForOwner(
    owner: { once(event: 'closed', listener: () => void): void },
    originDeliver: (event: BackgroundPresentationEvent) => void,
  ): BackgroundIpcService {
    // Only native confirmed closure is irreversible. A close request may still be vetoed.
    owner.once('closed', () => { void this.closeForOwner(owner).catch(this.reportError) })
    return this.serviceFor(originDeliver, owner)
  }

  async closeForOwner(owner: object): Promise<void> {
    await this.closeEntries([...this.entries.values()].filter((entry) => entry.owner === owner))
  }

  async closeForTarget(target: BackgroundTarget): Promise<void> {
    const entry = this.entries.get(keyFor(target))
    await this.closeEntries(entry ? [entry] : [])
  }

  async closeAll(): Promise<void> {
    await this.closeEntries([...this.entries.values()])
  }

  private async closeEntries(entries: WindowEntry[]): Promise<void> {
    await Promise.all(entries.map((entry) => {
      const closing = this.closeEntry(entry)
      entry.window?.close()
      return closing
    }))
  }
}
