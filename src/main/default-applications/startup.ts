import { normalizeDefaultApplicationsPrompt } from '../../shared/default-applications'
import type { SettingsUpdater } from '../settings/settings-coordinator'
import type { DefaultApplicationsService } from './service'
import { PublicError } from '../../shared/public-errors'
import type { SettingsAuthority } from '../settings/settings-authority'
import type { SettingsTransactionSnapshot } from '../settings/settings-transaction-types'

type StartupSettings = SettingsUpdater | {
  authority: Pick<SettingsAuthority, 'recordApplicationStart' | 'markApplicationOfferHandled' | 'markApplicationCloseOfferHandled' | 'readFresh'>
}

/** Only a user-approved native enable attempt can warrant a setup-failed dialog. */
export class DefaultApplicationsEnableError extends Error {
  readonly code: PublicError['code'] | undefined
  constructor(cause: unknown, readonly bookkeepingError?: unknown) {
    super(cause instanceof Error ? cause.message : 'Default applications setup failed', { cause })
    this.name = 'DefaultApplicationsEnableError'
    this.code = cause instanceof PublicError ? cause.code : undefined
  }
}

/** One instance per ordinary main process; never installed in Arknote or workers. */
export class DefaultApplicationsStartup {
  private readyStarted = false
  private closeStarted = false
  private start: Promise<void> | undefined
  private installationId: string | undefined
  private tail = Promise.resolve()
  private readonly startupOffer = new AbortController()
  constructor(private readonly settings: StartupSettings,
    private readonly service: Pick<DefaultApplicationsService, 'getStatus' | 'setEnabled'>,
    private readonly version: string,
    private readonly readInstallationId: () => Promise<string | undefined> = async () => undefined) {}
  onReady(prompt: (signal?: AbortSignal) => Promise<boolean>): Promise<void> {
    if (this.readyStarted) return this.tail
    this.readyStarted = true
    return this.enqueue('startup', prompt)
  }
  onClose(prompt: () => Promise<boolean>): Promise<void> {
    if (this.closeStarted) return this.tail
    this.closeStarted = true
    return this.enqueue('close', prompt)
  }
  /** Workspace selection takes priority over an optional startup offer that has not appeared. */
  deferStartupOffer(): void { this.startupOffer.abort() }
  private enqueue(trigger: 'startup' | 'close', prompt: (signal?: AbortSignal) => Promise<boolean>): Promise<void> {
    const pending = this.tail.then(async () => {
      await (this.start ??= this.recordStart())
      await this.offer(trigger, prompt)
    })
    this.tail = pending.catch(() => undefined)
    return pending
  }
  private async recordStart(): Promise<void> {
    const installationId = await this.readInstallationId()
    this.installationId = installationId
    if ('authority' in this.settings) {
      await this.settings.authority.recordApplicationStart(this.version, installationId)
    } else await this.settings.update((current) => {
      const previous = normalizeDefaultApplicationsPrompt(current.defaultApplicationsPrompt)
      const changed = previous.version !== this.version || previous.installationId !== installationId
      return { ...current, defaultApplicationsPrompt: {
        starts: Math.min(2, previous.starts + 1), handled: changed ? false : previous.handled,
        ...(!changed && previous.closeHandled ? { closeHandled: true } : {}),
        version: this.version, ...(installationId ? { installationId } : {}),
      } }
    })
  }
  private async offer(trigger: 'startup' | 'close', prompt: (signal?: AbortSignal) => Promise<boolean>): Promise<void> {
    // A queued close observes the completed startup offer, not its stale pre-dialog revision.
    const observed: SettingsTransactionSnapshot | undefined = 'authority' in this.settings
      ? await this.settings.authority.readFresh() : undefined
    const state = normalizeDefaultApplicationsPrompt('authority' in this.settings
      ? observed!.settings.defaultApplicationsPrompt : this.settings.get().defaultApplicationsPrompt)
    if (state.version !== this.version || state.installationId !== this.installationId) return
    if (trigger === 'startup' ? state.starts !== 2 || state.handled : state.closeHandled) return
    const signal = trigger === 'startup' ? this.startupOffer.signal : undefined
    if (signal?.aborted) return
    const status = await this.service.getStatus()
    if (signal?.aborted) return
    let incomplete = false
    let accepted = false
    if (!(status.markdown && status.text)) {
      try { accepted = await prompt(signal) }
      catch (error) {
        // A prompt cancelled before presentation is not the user's "No".
        if (signal?.aborted && error instanceof Error && error.name === 'AbortError') return
        throw error
      }
    }
    if (accepted) {
      try {
        const applied = await this.service.setEnabled(true)
        incomplete = !(applied.markdown && applied.text)
      } catch (error) { throw new DefaultApplicationsEnableError(error) }
    }
    // Transient errors remain retryable. A completed attempt or explicit "No" consumes the offer.
    try {
      if ('authority' in this.settings) {
        if (trigger === 'close') await this.settings.authority.markApplicationCloseOfferHandled(observed!)
        else await this.settings.authority.markApplicationOfferHandled(observed!)
      }
      else await this.settings.update((current) => ({ ...current, defaultApplicationsPrompt: {
        ...normalizeDefaultApplicationsPrompt(current.defaultApplicationsPrompt),
        ...(trigger === 'close' ? { closeHandled: true } : { starts: 2, handled: true }),
      } }))
    } catch (error) {
      if (incomplete) throw new DefaultApplicationsEnableError(new PublicError('DEFAULT_APPLICATIONS_NOT_APPLIED'), error)
      throw error
    }
    if (incomplete) throw new DefaultApplicationsEnableError(new PublicError('DEFAULT_APPLICATIONS_NOT_APPLIED'))
  }
}
