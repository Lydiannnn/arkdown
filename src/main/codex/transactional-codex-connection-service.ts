import type { CodexCliConnectionStatus, CodexCliConnectionSummary } from '../../shared/large-model-settings'
import type { PublicModelMutationResult, PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import type { SettingsAuthority } from '../settings/settings-authority'
import { publicModelMutation, requireModelObservation } from '../settings/settings-command-adapter'
import { reduceSettingsTransaction } from '../settings/settings-transaction-reducer'
import type { SettingsTransactionRequest } from '../settings/settings-transaction-types'
import type { CodexCliConnectionTester } from './codex-cli-connection-test'

export interface TransactionalCodexTestResult { status?: CodexCliConnectionStatus; mutation: PublicModelMutationResult }

/** Synthetic-testable adapter; production composition must switch all writers together. */
export class TransactionalCodexConnectionService {
  private tail: Promise<void> = Promise.resolve()
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly authority: SettingsAuthority, private readonly tester: CodexCliConnectionTester,
    private readonly nowIso: () => string) {}

  test(observation: PublicModelSettingsSnapshot): Promise<TransactionalCodexTestResult> {
    const observed = requireModelObservation(observation)
    return this.enqueue(async () => {
      this.assertActive()
      const guard = this.request(observed, observed.settings.codexCli)
      const before = reduceSettingsTransaction(await this.authority.readFresh(), guard)
      this.assertActive()
      if (before.status === 'conflict') return { mutation: publicModelMutation(before) }
      if (before.status !== 'unchanged') throw new Error('SETTINGS_COMMAND_INVALID')
      const probe = await this.tester.test()
      this.assertActive()
      const status = probe.status === 'connected' && typeof probe.cliVersion !== 'string' ? 'incompatible-response' : probe.status
      let value: CodexCliConnectionSummary | null = observed.settings.codexCli
      if (status === 'connected') value = { ...(value ?? {}), cliVersion: probe.cliVersion!, status,
        lastTestedAt: this.nowIso(), ...(probe.models ? { models: structuredClone(probe.models) } : {}) }
      else if (value) value = { ...value, status, lastTestedAt: this.nowIso() }
      // A failed first probe remains absent; applying the null guard still validates its original revision.
      return { status, mutation: publicModelMutation(await this.authority.apply(this.request(observed, value))) }
    })
  }

  remove(observation: PublicModelSettingsSnapshot): Promise<PublicModelMutationResult> {
    const observed = requireModelObservation(observation)
    return this.enqueue(async () => {
      this.assertActive()
      return publicModelMutation(await this.authority.apply(this.request(observed, null)))
    })
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    const pending = this.tail
    const operation = (async () => {
      let failure: unknown
      try { await this.tester.dispose() } catch (error) { failure = error }
      await pending
      if (failure !== undefined) throw failure
    })()
    this.disposal = operation
    void operation.catch(() => { if (this.disposal === operation) this.disposal = undefined })
    return operation
  }

  private request(observed: PublicModelSettingsSnapshot, value: CodexCliConnectionSummary | null): SettingsTransactionRequest {
    const expected = { value: observed.settings.codexCli, revision: observed.observation.fields['models.codexCli'] ?? 0 }
    return { baseRevision: observed.observation.revision, operations: [value === null
      ? { kind: 'codex-cli.remove', expected } : { kind: 'codex-cli.record-test', value, expected }] }
  }

  private assertActive(): void { if (this.disposed) throw new Error('Codex CLI connection service is disposed') }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Codex CLI connection service is disposed'))
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
