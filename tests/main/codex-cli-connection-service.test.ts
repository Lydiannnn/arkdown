import { describe, expect, it, vi } from 'vitest'
import { CodexCliConnectionService } from '../../src/main/codex/codex-cli-connection-service'
import type {
  CodexCliConnectionTester,
  CodexCliProbeResult,
} from '../../src/main/codex/codex-cli-connection-test'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import type { SettingsUpdater } from '../../src/main/settings/settings-coordinator'
import type { AppSettings } from '../../src/main/settings/settings-store'
import type { LargeModelSettings } from '../../src/shared/large-model-settings'

const FIRST_TESTED_AT = '2026-09-01T00:00:00.000Z'
const SECOND_TESTED_AT = '2026-09-01T00:01:00.000Z'
const THIRD_TESTED_AT = '2026-09-01T00:02:00.000Z'
const SECOND_CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440001'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function settings(codexCli: LargeModelSettings['codexCli'] = null): LargeModelSettings {
  return {
    version: 6,
    codexCli,
    connections: [{
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Existing API',
      provider: 'other',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://models.example.com',
      modelId: 'existing-model',
      apiKeyHint: '••••cret',
      status: 'connected',
      lastTestedAt: '2026-08-31T00:00:00.000Z',
      capabilityOverride: { contextWindowTokens: 200000 },
    }],
    selectionTranslation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'auto',
      privacyNoticeAccepted: false,
    },
    screenshotTranslation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'auto',
    },
    aiConversation: {
      connectionId: '550e8400-e29b-41d4-a716-446655440000',
      thinkingMode: 'enabled' as const, reasoningEffort: 'max',
      writePolicy: 'workspace-grant',
    },
  }
}

function settingsWithConcurrentStandardApiChange(
  codexCli: LargeModelSettings['codexCli'],
): LargeModelSettings {
  const changed = settings(codexCli)
  changed.connections.push({
    id: SECOND_CONNECTION_ID,
    name: 'New API from another consumer',
    provider: 'other',
    accessType: 'standard-api',
    protocol: 'openai',
    baseUrl: 'https://new.example.com',
    modelId: 'new-model',
    apiKeyHint: '••••new',
    status: 'untested',
    lastTestedAt: null,
    capabilityOverride: null,
  })
  changed.selectionTranslation.connectionId = SECOND_CONNECTION_ID
  changed.screenshotTranslation.connectionId = SECOND_CONNECTION_ID
  return changed
}

class DelayedSettingsUpdater implements SettingsUpdater {
  private current: AppSettings
  readonly updateStarted = deferred()
  readonly allowUpdate = deferred()

  constructor(initial: AppSettings) {
    this.current = structuredClone(initial)
  }

  get(): AppSettings {
    return structuredClone(this.current)
  }

  async update(mutator: (settings: AppSettings) => AppSettings): Promise<void> {
    this.updateStarted.resolve()
    await this.allowUpdate.promise
    this.current = structuredClone(mutator(this.get()))
  }

  applyConcurrentModels(models: LargeModelSettings): void {
    this.current = { ...this.current, models: structuredClone(models) }
  }
}

function createHarness(options: {
  initial?: LargeModelSettings
  responses: () => Promise<CodexCliProbeResult>
  nowIso?: () => string
}): {
  service: CodexCliConnectionService
  tester: CodexCliConnectionTester
  coordinator: SettingsCoordinator
  save: ReturnType<typeof vi.fn>
} {
  const save = vi.fn(async () => undefined)
  const coordinator = new SettingsCoordinator(
    { save },
    { lastWorkspace: null, models: options.initial ?? settings() } satisfies AppSettings,
  )
  const tester: CodexCliConnectionTester = {
    test: vi.fn(options.responses),
    dispose: vi.fn(async () => undefined),
  }
  return {
    service: new CodexCliConnectionService(coordinator, tester, { nowIso: options.nowIso }),
    tester,
    coordinator,
    save,
  }
}

describe('CodexCliConnectionService', () => {
  it('persists the complete summary after a successful first test', async () => {
    const { service, coordinator, save } = createHarness({
      responses: async () => ({ status: 'connected', cliVersion: 'codex-cli 0.144.1' }),
      nowIso: () => FIRST_TESTED_AT,
    })

    const result = await service.test()

    expect(result).toEqual({
      status: 'connected',
      settings: settings({
        cliVersion: 'codex-cli 0.144.1',
        status: 'connected',
        lastTestedAt: FIRST_TESTED_AT,
      }),
    })
    expect(save).toHaveBeenCalledTimes(1)
    const persisted = save.mock.calls[0]?.[0].models as LargeModelSettings
    expect(result.settings).not.toBe(persisted)
    expect(result.settings.codexCli).not.toBe(persisted.codexCli)
    expect(coordinator.get().models?.codexCli).toEqual({
      cliVersion: 'codex-cli 0.144.1',
      status: 'connected',
      lastTestedAt: FIRST_TESTED_AT,
    })
  })

  it('returns a first failure without saving or creating a Codex summary', async () => {
    const { service, coordinator, save } = createHarness({
      responses: async () => ({ status: 'not-found' }),
      nowIso: () => FIRST_TESTED_AT,
    })

    await expect(service.test()).resolves.toEqual({ status: 'not-found', settings: settings() })
    expect(save).not.toHaveBeenCalled()
    expect(coordinator.get().models?.codexCli).toBeNull()
  })

  it('normalizes a connected probe without a version to an unsaved first-test failure', async () => {
    const { service, coordinator, save } = createHarness({
      responses: async () => ({ status: 'connected' }),
      nowIso: () => FIRST_TESTED_AT,
    })

    await expect(service.test()).resolves.toEqual({
      status: 'incompatible-response',
      settings: settings(),
    })
    expect(save).not.toHaveBeenCalled()
    expect(coordinator.get().models?.codexCli).toBeNull()
  })

  it('persists a failed re-test with the prior CLI version and current status', async () => {
    const { service, coordinator, save } = createHarness({
      initial: settings({
        cliVersion: 'codex-cli 0.144.1',
        status: 'connected',
        lastTestedAt: FIRST_TESTED_AT,
      }),
      responses: async () => ({ status: 'timeout' }),
      nowIso: () => SECOND_TESTED_AT,
    })

    await expect(service.test()).resolves.toEqual({
      status: 'timeout',
      settings: settings({
        cliVersion: 'codex-cli 0.144.1',
        status: 'timeout',
        lastTestedAt: SECOND_TESTED_AT,
      }),
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(coordinator.get().models?.codexCli).toEqual({
      cliVersion: 'codex-cli 0.144.1',
      status: 'timeout',
      lastTestedAt: SECOND_TESTED_AT,
    })
  })

  it('normalizes a versionless connected re-test while preserving the prior version', async () => {
    const { service, coordinator, save } = createHarness({
      initial: settings({
        cliVersion: 'codex-cli 0.144.1',
        status: 'connected',
        lastTestedAt: FIRST_TESTED_AT,
      }),
      responses: async () => ({ status: 'connected' }),
      nowIso: () => SECOND_TESTED_AT,
    })

    await expect(service.test()).resolves.toEqual({
      status: 'incompatible-response',
      settings: settings({
        cliVersion: 'codex-cli 0.144.1',
        status: 'incompatible-response',
        lastTestedAt: SECOND_TESTED_AT,
      }),
    })
    expect(save).toHaveBeenCalledTimes(1)
    expect(coordinator.get().models?.codexCli).toEqual({
      cliVersion: 'codex-cli 0.144.1',
      status: 'incompatible-response',
      lastTestedAt: SECOND_TESTED_AT,
    })
  })

  it('replaces a prior summary after a successful re-test', async () => {
    const { service } = createHarness({
      initial: settings({
        cliVersion: 'codex-cli 0.144.1',
        status: 'timeout',
        lastTestedAt: FIRST_TESTED_AT,
      }),
      responses: async () => ({ status: 'connected', cliVersion: 'codex-cli 0.145.0' }),
      nowIso: () => SECOND_TESTED_AT,
    })

    await expect(service.test()).resolves.toEqual({
      status: 'connected',
      settings: settings({
        cliVersion: 'codex-cli 0.145.0',
        status: 'connected',
        lastTestedAt: SECOND_TESTED_AT,
      }),
    })
  })

  it('serializes concurrent operations before beginning the next probe', async () => {
    let releaseFirst!: () => void
    const firstProbe = new Promise<Awaited<ReturnType<CodexCliConnectionTester['test']>>>((resolve) => {
      releaseFirst = () => resolve({ status: 'connected', cliVersion: 'codex-cli 0.144.1' })
    })
    const { service, tester } = createHarness({
      responses: vi.fn()
        .mockImplementationOnce(async () => firstProbe)
        .mockResolvedValueOnce({ status: 'not-logged-in' }),
      nowIso: vi.fn().mockReturnValueOnce(FIRST_TESTED_AT).mockReturnValueOnce(SECOND_TESTED_AT),
    })

    const first = service.test()
    const second = service.test()
    await Promise.resolve()
    expect(tester.test).toHaveBeenCalledTimes(1)

    releaseFirst()
    await expect(first).resolves.toMatchObject({ status: 'connected' })
    await expect(second).resolves.toMatchObject({
      status: 'not-logged-in',
      settings: { codexCli: { cliVersion: 'codex-cli 0.144.1', status: 'not-logged-in' } },
    })
    expect(tester.test).toHaveBeenCalledTimes(2)
  })

  it('uses the default clock when nowIso is explicitly undefined', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(THIRD_TESTED_AT))
    try {
      const { service } = createHarness({
        responses: async () => ({ status: 'connected', cliVersion: 'codex-cli 0.144.1' }),
      })

      await expect(service.test()).resolves.toMatchObject({
        status: 'connected',
        settings: { codexCli: { lastTestedAt: THIRD_TESTED_AT } },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['a failed re-test', 'test' as const, 'timeout' as const],
    ['removal', 'remove' as const, null],
  ])('preserves concurrent standard API changes during %s', async (_label, action, expectedStatus) => {
    const initialCodex = {
      cliVersion: 'codex-cli 0.144.1',
      status: 'connected' as const,
      lastTestedAt: FIRST_TESTED_AT,
    }
    const updater = new DelayedSettingsUpdater({
      lastWorkspace: null,
      models: settings(initialCodex),
    })
    const service = new CodexCliConnectionService(
      updater,
      {
        test: async () => ({ status: 'timeout' }),
        dispose: async () => undefined,
      },
      { nowIso: () => SECOND_TESTED_AT },
    )

    const operation = action === 'test' ? service.test() : service.remove()
    await updater.updateStarted.promise
    updater.applyConcurrentModels(settingsWithConcurrentStandardApiChange(initialCodex))
    updater.allowUpdate.resolve()
    await operation

    expect(updater.get().models).toMatchObject({
      connections: [
        { id: '550e8400-e29b-41d4-a716-446655440000' },
        { id: SECOND_CONNECTION_ID, name: 'New API from another consumer' },
      ],
      selectionTranslation: { connectionId: SECOND_CONNECTION_ID },
      screenshotTranslation: { connectionId: SECOND_CONNECTION_ID },
      codexCli: expectedStatus === null ? null : {
        cliVersion: 'codex-cli 0.144.1',
        status: expectedStatus,
        lastTestedAt: SECOND_TESTED_AT,
      },
    })
  })

  it('continues queued operations after a probe rejects', async () => {
    const { service, tester } = createHarness({
      responses: vi.fn()
        .mockRejectedValueOnce(new Error('probe unavailable'))
        .mockResolvedValueOnce({ status: 'connected', cliVersion: 'codex-cli 0.144.1' }),
      nowIso: () => FIRST_TESTED_AT,
    })

    const rejected = service.test()
    const succeeding = service.test()

    await expect(rejected).rejects.toThrow('probe unavailable')
    await expect(succeeding).resolves.toMatchObject({ status: 'connected' })
    expect(tester.test).toHaveBeenCalledTimes(2)
  })

  it('disposes the tester once, rejects active and queued work, and blocks future operations', async () => {
    const activeProbe = deferred<CodexCliProbeResult>()
    const save = vi.fn(async () => undefined)
    const coordinator = new SettingsCoordinator(
      { save },
      { lastWorkspace: null, models: settings() } satisfies AppSettings,
    )
    const tester = {
      test: vi.fn(async () => activeProbe.promise),
      dispose: vi.fn(async () => activeProbe.resolve({ status: 'timeout' })),
    }
    const service = new CodexCliConnectionService(coordinator, tester)

    const running = service.test()
    const queued = service.remove()
    await vi.waitFor(() => expect(tester.test).toHaveBeenCalledOnce())

    const firstDispose = service.dispose()
    const repeatedDispose = service.dispose()

    await expect(firstDispose).resolves.toBeUndefined()
    await expect(repeatedDispose).resolves.toBeUndefined()
    await expect(running).rejects.toThrow('Codex CLI connection service is disposed')
    await expect(queued).rejects.toThrow('Codex CLI connection service is disposed')
    await expect(service.test()).rejects.toThrow('Codex CLI connection service is disposed')
    await expect(service.remove()).rejects.toThrow('Codex CLI connection service is disposed')
    expect(tester.dispose).toHaveBeenCalledOnce()
    expect(save).not.toHaveBeenCalled()
  })

  it('allows an exact cleanup retry after tester disposal rejects', async () => {
    const cleanupFailure = new Error('child still active')
    const tester: CodexCliConnectionTester = {
      test: vi.fn(async () => ({ status: 'not-found' as const })),
      dispose: vi.fn()
        .mockRejectedValueOnce(cleanupFailure)
        .mockResolvedValueOnce(undefined),
    }
    const coordinator = new SettingsCoordinator(
      { save: vi.fn(async () => undefined) },
      { lastWorkspace: null, models: settings() } satisfies AppSettings,
    )
    const service = new CodexCliConnectionService(coordinator, tester)

    await expect(service.dispose()).rejects.toBe(cleanupFailure)
    await expect(service.dispose()).resolves.toBeUndefined()
    expect(tester.dispose).toHaveBeenCalledTimes(2)
    await expect(service.test()).rejects.toThrow('Codex CLI connection service is disposed')
  })

  it('removes only the Codex summary and returns the SettingsUpdater defensive copy', async () => {
    const initial = settings({
      cliVersion: 'codex-cli 0.144.1',
      status: 'connected',
      lastTestedAt: FIRST_TESTED_AT,
    })
    const { service, coordinator, save } = createHarness({
      initial,
      responses: async () => ({ status: 'connected', cliVersion: 'unused' }),
    })

    const result = await service.remove()

    expect(result).toEqual(settings())
    expect(result).not.toBe(coordinator.get().models)
    expect(result.connections).not.toBe(coordinator.get().models?.connections)
    expect(save).toHaveBeenCalledTimes(1)
    expect(coordinator.get().models?.codexCli).toBeNull()
    expect(coordinator.get().models?.connections).toEqual(initial.connections)
    expect(coordinator.get().models?.selectionTranslation).toEqual(initial.selectionTranslation)
    expect(coordinator.get().models?.screenshotTranslation).toEqual(initial.screenshotTranslation)
  })
})
