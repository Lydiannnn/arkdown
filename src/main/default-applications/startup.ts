import { normalizeDefaultApplicationsPrompt } from '../../shared/default-applications'
import type { SettingsUpdater } from '../settings/settings-coordinator'
import type { DefaultApplicationsService } from './service'
import { PublicError } from '../../shared/public-errors'
import type { SettingsAuthority } from '../settings/settings-authority'
import type { SettingsTransactionSnapshot } from '../settings/settings-transaction-types'

type StartupSettings = SettingsUpdater | {
  authority: Pick<SettingsAuthority, 'recordApplicationStart' | 'markApplicationOfferHandled'>
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
  private started = false
  constructor(private readonly settings: StartupSettings,
    private readonly service: Pick<DefaultApplicationsService, 'getStatus' | 'setEnabled'>,
    private readonly version: string,
    private readonly readInstallationId: () => Promise<string | undefined> = async () => undefined) {}
  async onReady(prompt: () => Promise<boolean>) {
    if (this.started) return
    this.started = true
    const installationId = await this.readInstallationId()
    let observed: SettingsTransactionSnapshot | undefined
    if ('authority' in this.settings) {
      observed = await this.settings.authority.recordApplicationStart(this.version, installationId)
    } else await this.settings.update((current) => {
      const previous = normalizeDefaultApplicationsPrompt(current.defaultApplicationsPrompt)
      const changed = previous.version !== this.version || previous.installationId !== installationId
      return { ...current, defaultApplicationsPrompt: {
        starts: Math.min(2, previous.starts + 1), handled: changed ? false : previous.handled,
        version: this.version, ...(installationId ? { installationId } : {}),
      } }
    })
    const state = normalizeDefaultApplicationsPrompt('authority' in this.settings
      ? observed!.settings.defaultApplicationsPrompt : this.settings.get().defaultApplicationsPrompt)
    if (state.starts !== 2 || state.handled) return
    const status = await this.service.getStatus()
    let incomplete = false
    if (!(status.markdown && status.text) && await prompt()) {
      try {
        const applied = await this.service.setEnabled(true)
        incomplete = !(applied.markdown && applied.text)
      } catch (error) { throw new DefaultApplicationsEnableError(error) }
    }
    // Transient errors remain retryable. A completed attempt or explicit "No" consumes the offer.
    try {
      if ('authority' in this.settings) await this.settings.authority.markApplicationOfferHandled(observed!)
      else await this.settings.update((current) => ({ ...current, defaultApplicationsPrompt: {
        ...normalizeDefaultApplicationsPrompt(current.defaultApplicationsPrompt), starts: 2, handled: true,
      } }))
    } catch (error) {
      if (incomplete) throw new DefaultApplicationsEnableError(new PublicError('DEFAULT_APPLICATIONS_NOT_APPLIED'), error)
      throw error
    }
    if (incomplete) throw new DefaultApplicationsEnableError(new PublicError('DEFAULT_APPLICATIONS_NOT_APPLIED'))
  }
}
