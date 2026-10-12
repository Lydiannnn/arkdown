import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'
import { TransactionalModelConnectionService } from '../../src/main/models/transactional-model-connection-service'
import type { LargeModelSettings } from '../../src/shared/large-model-settings'
import type { ModelProtocolClient } from '../../src/main/models/model-protocol-client'
import type { ModelCatalogClient } from '../../src/main/models/model-catalog-client'

const fixtures: Array<{ root: string; authority: SettingsAuthority }> = []
afterEach(async () => {
  for (const { root, authority } of fixtures.splice(0)) {
    authority.dispose()
    const resolved = await realpath(root)
    if (resolved !== root || path.dirname(root) !== await realpath(tmpdir())
      || !path.basename(root).startsWith('arkdown-model-authority-test-')) throw new Error('Invalid synthetic cleanup root')
    await rm(root, { recursive: true, force: true })
  }
})

/** Real storage/finite writer; only crypto and external model transport are synthetic. */
export async function transactionalModelFixture(models: LargeModelSettings,
  protocol: Pick<ModelProtocolClient, 'testConnection'>,
  catalog: ModelCatalogClient = { listModels: async () => { throw new Error('Unexpected synthetic catalog call') } },
  identity = { createId: () => '550e8400-e29b-41d4-a716-446655440001', nowIso: () => '2026-10-04T00:00:00.000Z' }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'arkdown-model-authority-test-')))
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ lastWorkspace: null, models }), 'utf8')
  const authority = new SettingsAuthority(new SettingsTransactionStore(root, {
    isAvailable: () => true, encrypt: value => Buffer.from(value, 'utf8'), decrypt: value => value.toString('utf8'),
  }))
  fixtures.push({ root, authority })
  await authority.readFresh()
  return { root, authority, service: new TransactionalModelConnectionService(authority, protocol, catalog, identity) }
}
