import type { StickyNoteDocument } from '../../shared/sticky-notes'
import type { ArknoteLaunchCommand } from './arknote-second-instance'
import { StickyNoteSaveCoordinator } from '../sticky-notes/sticky-note-save-coordinator'
import { ARKNOTE_AUTOSTART_ARGUMENT } from '../sticky-notes/sticky-note-autostart'

export const ARKNOTE_SAVE_DEBOUNCE_MS = 2_000
export const ARKNOTE_SAVE_SNAPSHOT_MS = 5_000

const INITIAL_LAUNCH_FLAGS: Readonly<Record<string, ArknoteLaunchCommand>> = {
  '--open-box': 'open-box',
  '--new-note': 'new-note',
  '--open-settings': 'open-settings',
}

export function initialArknoteLaunchCommand(
  argv: readonly string[],
): ArknoteLaunchCommand | undefined {
  for (const value of argv) {
    const command = INITIAL_LAUNCH_FLAGS[value]
    if (command) return command
  }
  return argv.includes(ARKNOTE_AUTOSTART_ARGUMENT) ? undefined : 'open-box'
}

export interface ArknoteMutationGate {
  pauseAndDrain(): Promise<void>
  resume(): void
}

export class ArknoteMutationGateRegistry implements ArknoteMutationGate {
  private readonly gates = new Set<ArknoteMutationGate>()
  private readonly drained = new Set<ArknoteMutationGate>()
  private paused = false

  register(gate: ArknoteMutationGate): () => void {
    this.gates.add(gate)
    return () => {
      this.gates.delete(gate)
      this.drained.delete(gate)
    }
  }

  async pauseAndDrain(): Promise<void> {
    this.paused = true
    while (this.paused) {
      const pending = [...this.gates].filter((gate) => !this.drained.has(gate))
      if (pending.length === 0) return
      await Promise.all(pending.map(async (gate) => {
        await gate.pauseAndDrain()
        if (this.gates.has(gate)) this.drained.add(gate)
      }))
    }
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.drained.clear()
    for (const gate of this.gates) gate.resume()
  }
}

interface ArknoteStoreTarget {
  initialize(): Promise<unknown>
}

interface ArknoteSessionTarget {
  restore(argv: readonly string[]): Promise<number>
  captureAndFlush(): Promise<void>
}

interface ArknotePipeTarget {
  start(): Promise<void>
  stop(): Promise<void>
  broadcast(event: unknown): void
}

interface ArknoteTrayTarget {
  initialize(): void
  destroy(): void
}

interface ArknoteWindowTarget {
  closeAll(options: { flush: boolean; preserveSessionState: boolean }): Promise<void>
}

export interface ArknoteServiceRuntimeOptions {
  launchArguments: readonly string[]
  store: ArknoteStoreTarget
  session: ArknoteSessionTarget
  pipe: ArknotePipeTarget
  tray: ArknoteTrayTarget
  windows: ArknoteWindowTarget
  mutations: ArknoteMutationGate
  prepareToQuit?(): Promise<boolean>
  cancelQuitPreparation?(): void
  openBox(): Promise<void>
  createNote(): Promise<void>
  openSettings(): Promise<void>
  quitApp(): void
}

export function createArknoteSaveCoordinator(
  store: { writeMarkdown(noteId: string, markdown: string): Promise<StickyNoteDocument> },
): StickyNoteSaveCoordinator {
  return new StickyNoteSaveCoordinator({
    store,
    debounceMs: ARKNOTE_SAVE_DEBOUNCE_MS,
    snapshotMs: ARKNOTE_SAVE_SNAPSHOT_MS,
  })
}

export class ArknoteServiceRuntime {
  private initializePromise: Promise<void> | null = null
  private quitPromise: Promise<void> | null = null
  private quitPreparation: Promise<void> | null = null
  private updatePrepared = false
  private disposed = false
  private acceptingCommands = true
  private commandTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: ArknoteServiceRuntimeOptions) {}

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise
    this.initializePromise = (async () => {
      await this.options.store.initialize()
      await this.options.pipe.start()
      this.options.tray.initialize()
      const restoreArguments = this.options.launchArguments.includes(ARKNOTE_AUTOSTART_ARGUMENT)
        ? this.options.launchArguments
        : [...this.options.launchArguments, ARKNOTE_AUTOSTART_ARGUMENT]
      await this.options.session.restore(restoreArguments)
    })()
    return this.initializePromise
  }

  execute(command: ArknoteLaunchCommand): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Arknote 服务已停止'))
    if (!this.acceptingCommands) return Promise.reject(new Error('Arknote 正在退出'))

    const operation = this.commandTail
      .catch(() => undefined)
      .then(async () => {
        await this.initialize()
        switch (command) {
          case 'open-box': return this.options.openBox()
          case 'new-note': return this.options.createNote()
          case 'open-settings': return this.options.openSettings()
        }
      })
    this.commandTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  async prepareUpdateQuit(): Promise<void> {
    if (this.quitPromise || this.disposed) throw new Error('Arknote 正在退出')
    try { await this.prepareWindowsForQuit(); this.updatePrepared = true }
    catch (error) {
      this.options.cancelQuitPreparation?.(); this.options.mutations.resume(); this.acceptingCommands = true
      throw error
    }
  }
  async cancelUpdateQuit(): Promise<void> {
    if (this.quitPromise || this.disposed) throw new Error('Arknote 正在退出')
    await this.quitPreparation?.catch(() => {})
    if (!this.updatePrepared) return
    this.options.cancelQuitPreparation?.(); this.options.mutations.resume(); this.acceptingCommands = true
    this.quitPreparation = null; this.updatePrepared = false
    await this.options.session.restore([ARKNOTE_AUTOSTART_ARGUMENT])
  }
  private prepareWindowsForQuit(): Promise<void> {
    if (this.quitPreparation) return this.quitPreparation
    this.acceptingCommands = false
    const operation = (async () => {
      await this.commandTail
      if (this.options.prepareToQuit && !await this.options.prepareToQuit()) throw new Error('设置尚未保存，已取消退出，请重试。')
      await this.options.mutations.pauseAndDrain()
      await this.options.session.captureAndFlush()
      await this.options.windows.closeAll({ flush: false, preserveSessionState: true })
    })().catch(error => {
      this.quitPreparation = null; throw error
    })
    this.quitPreparation = operation; return operation
  }
  flushAndQuit(): Promise<void> {
    if (this.quitPromise) return this.quitPromise
    this.acceptingCommands = false
    const operation = (async () => {
      try {
        await this.prepareWindowsForQuit()
        // Preparation still owes the update client an acknowledgement. Only an
        // actual quit may disconnect clients through service-stopping.
        this.options.pipe.broadcast({ type: 'service-stopping' })
        this.options.tray.destroy()
        await this.options.pipe.stop()
        this.options.quitApp()
        this.disposed = true
      } catch (error) {
        if (!this.disposed) {
          try { this.options.cancelQuitPreparation?.() } catch { /* Preserve the original exit failure. */ }
          this.options.mutations.resume()
          this.acceptingCommands = true
          this.quitPromise = null
          this.quitPreparation = null
        }
        throw error
      }
    })()
    this.quitPromise = operation
    return operation
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.acceptingCommands = false
    await this.options.mutations.pauseAndDrain()
    await this.options.windows.closeAll({
      flush: false,
      preserveSessionState: true,
    })
    this.options.tray.destroy()
    await this.options.pipe.stop()
    this.disposed = true
  }
}
