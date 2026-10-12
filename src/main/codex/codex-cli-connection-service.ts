import { codexCliModelConnectionId, isCodexCliConnectionId } from '../../shared/large-model-settings'
import type {
  CodexCliConnectionTestResult,
  LargeModelSettings,
} from '../../shared/large-model-settings'
import { normalizeLargeModelSettings } from '../../shared/large-model-settings'
import type { SettingsUpdater } from '../settings/settings-coordinator'
import type { CodexCliConnectionTester } from './codex-cli-connection-test'

export interface CodexCliConnectionServiceDependencies {
  nowIso(): string
}

function defaultDependencies(): CodexCliConnectionServiceDependencies {
  return { nowIso: () => new Date().toISOString() }
}

function copySettings(settings: LargeModelSettings): LargeModelSettings {
  return {
    ...(settings.floatingTranslation ? { floatingTranslation: { ...settings.floatingTranslation } } : {}),
    version: 6,
    codexCli: settings.codexCli ? structuredClone(settings.codexCli) : null,
    connections: settings.connections.map((connection) => ({
      ...connection,
      capabilityOverride: connection.capabilityOverride === null
        ? null
        : { ...connection.capabilityOverride },
    })),
    selectionTranslation: { ...settings.selectionTranslation },
    screenshotTranslation: { ...settings.screenshotTranslation },
    aiConversation: { ...settings.aiConversation },
  }
}

export class CodexCliConnectionService {
  private readonly dependencies: CodexCliConnectionServiceDependencies
  private tail = Promise.resolve()
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(
    private readonly settings: SettingsUpdater,
    private readonly tester: CodexCliConnectionTester,
    dependencies: Partial<CodexCliConnectionServiceDependencies> = {},
  ) {
    this.dependencies = { nowIso: dependencies.nowIso ?? defaultDependencies().nowIso }
  }

  test(): Promise<CodexCliConnectionTestResult> {
    if (this.disposed) return Promise.reject(this.disposedError())
    return this.enqueue(async () => {
      this.assertActive()
      const probe = await this.tester.test()
      this.assertActive()
      const status = probe.status === 'connected' && typeof probe.cliVersion !== 'string'
        ? 'incompatible-response'
        : probe.status
      const current = this.currentSettings()
      if (status !== 'connected') {
        if (current.codexCli === null) return { status, settings: current }
        const settings = await this.updateCodex((models) => (
          models.codexCli === null
            ? models
            : {
                ...models,
                codexCli: {
                  ...models.codexCli,
                  status,
                  lastTestedAt: this.dependencies.nowIso(),
                },
              }
        ))
        return { status, settings }
      }

      const settings = await this.updateCodex((models) => ({
        ...models,
        codexCli: {
          ...(models.codexCli ?? {}),
          cliVersion: probe.cliVersion!,
          status: 'connected',
          lastTestedAt: this.dependencies.nowIso(),
          ...(probe.models ? { models: [...probe.models, ...(models.codexCli?.models ?? [])
            .filter(previous => !probe.models!.some(next => next.modelId === previous.modelId)
              && [models.aiConversation, models.selectionTranslation, models.screenshotTranslation, models.floatingTranslation]
                .some(feature => feature?.connectionId === codexCliModelConnectionId(previous.modelId)))
            .map(previous => ({ ...previous, isDefault: false, unavailable: true as const }))] } : {}),
        },
      }))
      return { status, settings }
    })
  }

  remove(): Promise<LargeModelSettings> {
    if (this.disposed) return Promise.reject(this.disposedError())
    return this.enqueue(async () => {
      this.assertActive()
      return this.updateCodex((models) => ({ ...models, codexCli: null,
        ...(models.floatingTranslation ? { floatingTranslation: { ...models.floatingTranslation, connectionId: isCodexCliConnectionId(models.floatingTranslation.connectionId ?? '') ? null : models.floatingTranslation.connectionId } } : {}),
        selectionTranslation: { ...models.selectionTranslation, connectionId: isCodexCliConnectionId(models.selectionTranslation.connectionId ?? '') ? null : models.selectionTranslation.connectionId },
        screenshotTranslation: { ...models.screenshotTranslation, connectionId: isCodexCliConnectionId(models.screenshotTranslation.connectionId ?? '') ? null : models.screenshotTranslation.connectionId },
        aiConversation: { ...models.aiConversation, connectionId: isCodexCliConnectionId(models.aiConversation.connectionId ?? '') ? null : models.aiConversation.connectionId },
      }))
    })
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    const pending = this.tail
    const operation = (async () => {
      let cleanupFailure: unknown
      try {
        await this.tester.dispose()
      } catch (error) {
        cleanupFailure = error
      }
      await pending
      if (cleanupFailure !== undefined) throw cleanupFailure
    })()
    this.disposePromise = operation
    void operation.catch(() => {
      if (this.disposePromise === operation) this.disposePromise = undefined
    })
    return operation
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.tail.then(operation)
    this.tail = queued.then(() => undefined, () => undefined)
    return queued
  }

  private currentSettings(): LargeModelSettings {
    return copySettings(normalizeLargeModelSettings(this.settings.get().models))
  }

  private assertActive(): void {
    if (this.disposed) throw this.disposedError()
  }

  private disposedError(): Error {
    return new Error('Codex CLI connection service is disposed')
  }

  private async updateCodex(
    transform: (models: LargeModelSettings) => LargeModelSettings,
  ): Promise<LargeModelSettings> {
    let persisted!: LargeModelSettings
    await this.settings.update((current) => {
      persisted = copySettings(transform(normalizeLargeModelSettings(current.models)))
      return { ...current, models: copySettings(persisted) }
    })
    return copySettings(persisted)
  }
}
