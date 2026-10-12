import { randomUUID } from 'node:crypto'
import { CLOSE_RECOVERY_CHANNELS, parseCloseRecoveryAction, parseCloseRecoveryReady, type CloseRecoveryAction, type CloseRecoveryState } from '../../shared/close-recovery'
import { type ClosePreparationAttempt } from '../../shared/close-preparation'
import { formatCloseDiagnosticSummary, type CloseDiagnosticEvent } from '../../shared/close-diagnostics'
import type { CloseAttemptSnapshot } from './close-attempt-coordinator'

export interface CloseRecoveryView {
  readonly sender: object
  readonly mainFrame: object
  readonly ready: Promise<void>
  send(state: CloseRecoveryState): void
  show(focus: boolean): void
  hide(): void
  fit?(height: number): void
  destroy(): void
}
interface Controller {
  snapshot(): CloseAttemptSnapshot | null
  returnToEditor(): Promise<boolean>
  retry(): Promise<boolean>
}
interface BindingOptions {
  release(attempt: ClosePreparationAttempt): void
  theme(): { dark: boolean; themeColor: string }
}
interface Options<Owner> {
  handle(channel: string, handler: (event: { sender: object; senderFrame: object | null }, input?: unknown) => unknown): void
  removeHandler(channel: string): void
  createView(owner: Owner, events: { close(): void; unavailable(): void }): CloseRecoveryView
  /** Only used if the independent recovery surface cannot render. No raw error payload. */
  fallback(owner: Owner, state: CloseRecoveryState): Promise<CloseRecoveryAction['action'] | undefined>
  copy(text: string): void
  record(event: CloseDiagnosticEvent): void
  version: string
  platform: CloseDiagnosticEvent['platform']
}
interface Entry<Owner> {
  owner: Owner; options: BindingOptions; windowId: string; disposed: boolean
  controller: Controller | null; snapshot: CloseAttemptSnapshot | null
  view: CloseRecoveryView | null; ready: boolean; surfaceReady: boolean; visible: boolean; broken: boolean
  startupTimer?: ReturnType<typeof setTimeout>
  ai: { attempt: ClosePreparationAttempt; resolve(value: boolean): void; promise: Promise<boolean> } | null
  acting: boolean; fallbackBusy: boolean; fallbackKey: string; released: string; diagnosticKey: string
}
const identity = (value: ClosePreparationAttempt) => `${value.attemptId}:${value.generation}`
const same = (a: ClosePreparationAttempt | null, b: ClosePreparationAttempt) => !!a && identity(a) === identity(b)

/** An independent, main-owned recovery route. Renderer input never grants close authority. */
export function createCloseRecoveryHost<Owner>(options: Options<Owner>) {
  const entries = new Set<Entry<Owner>>()
  const senders = new Map<object, Entry<Owner>>()
  let disposed = false
  const current = (entry: Entry<Owner>) => !entry.disposed ? entry.controller?.snapshot() ?? entry.snapshot : null
  const stateFor = (entry: Entry<Owner>): CloseRecoveryState | null => {
    const snapshot = current(entry)
    if (!snapshot || ['cancelled', 'closed'].includes(snapshot.state)) return null
    let theme = { dark: false, themeColor: '#c82929' }
    try { theme = entry.options.theme() } catch { /* Theme read cannot control closing. */ }
    return { attemptId: snapshot.attemptId, generation: snapshot.generation, stage: snapshot.progress.stage,
      feedback: snapshot.progress.feedback, error: snapshot.error, rendererUnavailable: snapshot.rendererUnavailable !== null,
      elapsedMs: snapshot.progress.elapsedMs, canReturn: snapshot.canReturn, canRetry: snapshot.canRetry,
      confirmAi: same(entry.ai?.attempt ?? null, snapshot), dark: theme.dark === true,
      themeColor: /^#[0-9a-f]{6}$/iu.test(theme.themeColor) ? theme.themeColor : '#c82929' }
  }
  const diagnostic = (entry: Entry<Owner>, snapshot: CloseAttemptSnapshot): CloseDiagnosticEvent => ({
    version: options.version, platform: options.platform, windowId: entry.windowId, attemptId: snapshot.attemptId,
    stage: snapshot.progress.stage, event: snapshot.error ? 'error'
      : ['no-progress', 'long-wait'].includes(snapshot.progress.feedback) ? 'timeout'
        : ['cancelled', 'closed'].includes(snapshot.state) ? 'exit' : 'enter',
    stageElapsedMs: snapshot.progress.stageElapsedMs, pending: snapshot.progress.pending,
    errorCode: snapshot.error ?? (snapshot.rendererUnavailable ? 'renderer-process-gone' : null),
  })
  const decide = (entry: Entry<Owner>, value: boolean) => {
    const pending = entry.ai
    entry.ai = null
    if (!pending) return false
    pending.resolve(value)
    return true
  }
  const shouldPresent = (state: CloseRecoveryState | null) => !!state && (state.confirmAi || state.error !== null
    || state.rendererUnavailable || !['hidden', 'await-user'].includes(state.feedback))
  const fallbackKey = (entry: Entry<Owner>, state: CloseRecoveryState) =>
    `${identity(state)}:${state.stage}:${state.error}:${state.canReturn}:${state.canRetry}:${state.confirmAi}:${current(entry)?.revealRevision ?? 0}`
  const act = async (entry: Entry<Owner>, command: CloseRecoveryAction): Promise<boolean> => {
    const snapshot = current(entry)
    if (!snapshot || !same(snapshot, command) || ['cancelled', 'closed'].includes(snapshot.state) || entry.acting) return false
    if (command.action === 'copy') {
      const text = formatCloseDiagnosticSummary(diagnostic(entry, snapshot))
      if (!text) return false
      try { options.copy(text); return true } catch { return false }
    }
    if (command.action === 'continue-using' || command.action === 'stop-ai-and-close') {
      if (!same(entry.ai?.attempt ?? null, command)) return false
      return decide(entry, command.action === 'stop-ai-and-close')
    }
    if (!entry.controller || !(command.action === 'return' ? snapshot.canReturn : snapshot.canRetry)) return false
    entry.acting = true
    try { return await (command.action === 'return' ? entry.controller.returnToEditor() : entry.controller.retry()) }
    catch { return false }
    finally { entry.acting = false }
  }
  const fallback = (entry: Entry<Owner>, state: CloseRecoveryState) => {
    const key = fallbackKey(entry, state)
    if (entry.fallbackBusy || entry.fallbackKey === key || entry.disposed) return
    entry.fallbackBusy = true
    void Promise.resolve().then(() => {
      const latest = stateFor(entry)
      if (!latest || !shouldPresent(latest) || fallbackKey(entry, latest) !== key) return undefined
      entry.fallbackKey = key
      return options.fallback(entry.owner, latest)
    }).then(action => {
      if (action) return act(entry, { attemptId: state.attemptId, generation: state.generation, action })
    }).catch(() => { /* No fabricated approval or successful close on fallback failure. */ })
      .finally(() => { entry.fallbackBusy = false; if (!entry.disposed) present(entry) })
  }
  const failView = (entry: Entry<Owner>, view: CloseRecoveryView) => {
    if (entry.disposed || entry.view !== view || entry.broken) return
    entry.broken = true; entry.ready = false; entry.visible = false
    clearTimeout(entry.startupTimer); entry.startupTimer = undefined
    senders.delete(view.sender)
    try { view.destroy() } catch { /* Only our recovery child is affected. */ }
    present(entry)
  }
  const present = (entry: Entry<Owner>) => {
    if (entry.disposed) return
    // Readiness is independent from visibility while a business dialog owns input.
    if (entry.ready && entry.surfaceReady) {
      clearTimeout(entry.startupTimer); entry.startupTimer = undefined
    }
    const state = stateFor(entry)
    const visible = shouldPresent(state)
    if (!visible || !state) {
      if (entry.visible) { try { entry.view?.hide() } catch { /* Presentation only. */ } }
      entry.visible = false
      return
    }
    if (entry.broken) { fallback(entry, state); return }
    if (!entry.view) {
      try {
        const view = options.createView(entry.owner, {
          close: () => {
            const value = stateFor(entry)
            if (!value) return
            if (value.confirmAi) decide(entry, false)
            else if (value.canReturn) void act(entry, { ...value, action: 'return' })
          },
          unavailable: () => { if (entry.view) failView(entry, entry.view) },
        })
        entry.view = view; senders.set(view.sender, entry)
        entry.startupTimer = setTimeout(() => failView(entry, view), 8000)
        entry.startupTimer.unref?.()
        void view.ready.then(() => {
          if (!entry.disposed && entry.view === view && !entry.broken) { entry.ready = true; present(entry) }
        }, () => failView(entry, view))
      } catch { entry.broken = true; fallback(entry, state) }
      return
    }
    if (!entry.ready) return
    try {
      entry.view.send(state)
      if (!entry.surfaceReady) return
      if (!entry.visible) { entry.view.show(state.confirmAi); entry.visible = true }
    } catch { failView(entry, entry.view) }
  }
  const authorized = (event: { sender: object; senderFrame: object | null }) => {
    const entry = senders.get(event.sender)
    return entry && !entry.disposed && entry.view?.sender === event.sender && entry.view.mainFrame === event.senderFrame ? entry : undefined
  }
  options.handle(CLOSE_RECOVERY_CHANNELS.get, event => {
    const entry = authorized(event)
    return entry ? stateFor(entry) : null
  })
  options.handle(CLOSE_RECOVERY_CHANNELS.action, (event, input) => {
    const entry = authorized(event), command = parseCloseRecoveryAction(input)
    return entry && command ? act(entry, command) : false
  })
  options.handle(CLOSE_RECOVERY_CHANNELS.ready, (event, input) => {
    const entry = authorized(event), attempt = parseCloseRecoveryReady(input)
    const state = entry && stateFor(entry)
    if (!entry || !attempt || !state || !same(state, attempt)) return false
    if (attempt.height !== undefined) {
      try { entry.view?.fit?.(attempt.height) } catch { return false }
    }
    entry.surfaceReady = true
    present(entry)
    return true
  })
  const disposeEntry = (entry: Entry<Owner>) => {
    if (entry.disposed) return
    entry.disposed = true; entries.delete(entry); decide(entry, false)
    clearTimeout(entry.startupTimer); entry.startupTimer = undefined
    if (entry.view) {
      senders.delete(entry.view.sender)
      try { entry.view.destroy() } catch { /* Never destroys the owning document window. */ }
    }
  }
  return {
    attach(owner: Owner, bindingOptions: BindingOptions) {
      if (disposed) throw new Error('Close recovery host disposed')
      const entry: Entry<Owner> = { owner, options: bindingOptions, windowId: randomUUID(), disposed: false,
        controller: null, snapshot: null, view: null, ready: false, surfaceReady: false, visible: false, broken: false,
        ai: null, acting: false, fallbackBusy: false, fallbackKey: '', released: '', diagnosticKey: '' }
      entries.add(entry)
      return {
        bind(controller: Controller) { entry.controller = controller },
        notify(snapshot: CloseAttemptSnapshot) {
          if (entry.disposed) return
          entry.snapshot = snapshot
          const key = `${identity(snapshot)}:${snapshot.state}:${snapshot.progress.stage}:${snapshot.error}:${snapshot.progress.feedback}:${snapshot.rendererUnavailable}`
          if (entry.diagnosticKey !== key) {
            entry.diagnosticKey = key
            try { options.record(diagnostic(entry, snapshot)) } catch { /* Never a close prerequisite. */ }
          }
          if (entry.ai && !same(entry.ai.attempt, snapshot)) decide(entry, false)
          if (snapshot.state === 'cancelled' && entry.released !== identity(snapshot)) {
            entry.released = identity(snapshot)
            try { entry.options.release({ attemptId: snapshot.attemptId, generation: snapshot.generation }) } catch { /* Renderer may already be gone. */ }
          }
          if (snapshot.state === 'closed') disposeEntry(entry)
          else present(entry)
        },
        confirmStopAi(attempt: ClosePreparationAttempt): Promise<boolean> {
          if (entry.disposed || !same(current(entry), attempt)) return Promise.resolve(false)
          if (entry.ai && same(entry.ai.attempt, attempt)) return entry.ai.promise
          decide(entry, false)
          let resolve!: (value: boolean) => void
          const promise = new Promise<boolean>(yes => { resolve = yes })
          entry.ai = { attempt: Object.freeze({ ...attempt }), resolve, promise }
          present(entry)
          return promise
        },
        dispose: () => disposeEntry(entry),
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of [...entries]) disposeEntry(entry)
      options.removeHandler(CLOSE_RECOVERY_CHANNELS.get)
      options.removeHandler(CLOSE_RECOVERY_CHANNELS.action)
      options.removeHandler(CLOSE_RECOVERY_CHANNELS.ready)
    },
  }
}
