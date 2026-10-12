// Bundled by the integration test so each child has real, independent module state.
import { mkdir } from 'node:fs/promises'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'
import { installWindowBoundsSaveOnClose } from '../../src/main/settings/window-bounds-close'
import { TransactionalModelConnectionService } from '../../src/main/models/transactional-model-connection-service'

const root = process.argv[2]!
const connectionId = '550e8400-e29b-41d4-a716-446655440001'
const authority = new SettingsAuthority(new SettingsTransactionStore(root, {
  isAvailable: () => true,
  // Synthetic fixture only. Never loads Electron safeStorage or user credentials.
  encrypt: (value) => Buffer.from(value, 'utf8'),
  decrypt: (value) => value.toString('utf8'),
}))
const service = new TransactionalModelConnectionService(authority, { testConnection: async () => undefined },
  { listModels: async () => { throw new Error('Synthetic catalog must not be queried') } },
  { createId: () => connectionId, nowIso: () => '2026-10-04T00:00:00.000Z' })

process.on('message', async (message: { id: number; command: string }) => {
  try {
    if (message.command === 'load') {
      await mkdir(root, { recursive: true })
      await authority.migrateStartupSettings()
    }
    if (message.command === 'add-model') {
      const result = await service.connect(await service.getSettings(), {
        name: 'Synthetic concurrent connection', provider: 'deepseek', accessType: 'standard-api',
        protocol: 'openai', baseUrl: 'https://synthetic.invalid', modelId: 'deepseek-chat',
        apiKey: 'synthetic-test-only',
      })
      if (result.status !== 'committed') throw new Error('Synthetic model did not commit')
    }
    if (message.command === 'remove-model') await service.delete(await service.getSettings(), connectionId)
    if (message.command === 'refresh') await authority.readFresh()
    if (message.command === 'close') {
      await new Promise<void>((resolve, reject) => {
        let closeListener: ((event: { preventDefault(): void }) => void) | undefined
        const controller = installWindowBoundsSaveOnClose({
          on: (_event, listener) => { closeListener = listener },
          getSize: () => [1200, 800], getPosition: () => [80, 60], close: () => { controller.closed(); resolve() },
        }, {
          saveWindowBounds: windowBounds => authority.saveWindowBounds(windowBounds),
          prepareRendererClose: async () => ({ status: 'ready' }), reportError: reject,
        })
        closeListener!({ preventDefault() {} })
      })
    }
    if (message.command === 'exit') {
      authority.dispose()
      process.disconnect!()
      return
    }
    // Capture the cache before a credential read refreshes it, so a stale close
    // result cannot be hidden by the assertion's own read.
    const snapshot = authority.getDisplaySnapshot()
    let hasSyntheticCredential = false
    try { hasSyntheticCredential = (await authority.readExecution({ connectionId })).apiKey === 'synthetic-test-only' }
    catch { /* No connection before connect or after deletion. */ }
    process.send!({ id: message.id, value: {
      pid: process.pid,
      connectionIds: snapshot.settings.models?.connections.map((connection) => connection.id) ?? [],
      hasSyntheticCredential,
      windowBounds: snapshot.settings.windowBounds,
    } })
  } catch (error) {
    process.send!({ id: message.id, error: error instanceof Error ? error.message : String(error) })
  }
})
