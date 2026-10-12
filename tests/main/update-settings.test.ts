// @vitest-environment node
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'
const roots: string[] = []
const first = '11111111-1111-4111-8111-111111111111'; const second = '22222222-2222-4222-8222-222222222222'
const cipher = { isAvailable: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it('commits one UUID across concurrent authorities, preserves old settings and survives reload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ark-update-settings-')); roots.push(root)
  const file = path.join(root, 'settings.json'); const original = JSON.stringify({ lastWorkspace: 'preserved', lastFolderPickerPath: 'C:/picked' })
  await writeFile(file, original)
  const a = new SettingsAuthority(new SettingsTransactionStore(root, cipher)); const b = new SettingsAuthority(new SettingsTransactionStore(root, cipher))
  await a.readFresh(); expect(await readFile(file, 'utf8')).toBe(original)
  const ids = await Promise.all([a.ensureUpdateInstallationId(first), b.ensureUpdateInstallationId(second)])
  expect(ids[0]).toBe(ids[1]); expect([first, second]).toContain(ids[0])
  const next = new SettingsAuthority(new SettingsTransactionStore(root, cipher))
  expect(await next.ensureUpdateInstallationId(second)).toBe(ids[0])
  expect((await next.readFresh()).settings).toMatchObject({ lastWorkspace: 'preserved', lastFolderPickerPath: 'C:/picked', applicationUpdate: { installationId: ids[0] } })
  await expect(next.ensureUpdateInstallationId('invalid')).rejects.toThrow()
})
it('does not use a candidate when persistence fails or its outcome is unknown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ark-update-settings-')); roots.push(root)
  const store = new SettingsTransactionStore(root, cipher); const apply = vi.spyOn(store, 'apply').mockRejectedValue(new Error('unknown outcome'))
  await expect(new SettingsAuthority(store).ensureUpdateInstallationId(first)).rejects.toThrow('unknown outcome')
  expect(apply).toHaveBeenCalledOnce()
})
