import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { readDefaultApplicationsInstallationId } from '../../src/main/default-applications/installation'
import { SettingsStore } from '../../src/main/settings/settings-store'

const roots: string[] = []
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-installation-id-')); roots.push(root); return root }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('supports portable packages and legacy installations without a marker', async () => {
  expect(await readDefaultApplicationsInstallationId(await fixture())).toBeUndefined()
})

it.each(['utf8', 'utf16le'] as const)('reads the installer entry in %s without treating other INI sections as its identity', async encoding => {
  const root = await fixture()
  const contents = '\uFEFF[Other]\r\nInstance=20260920060000-111\r\n[ArkdownStartup]\r\nInstance=20260920070000-12345\r\n'
  await writeFile(path.join(root, '.arkdown-installation.ini'), contents, encoding)
  expect(await readDefaultApplicationsInstallationId(root)).toBe('20260920070000-12345')
})

it.each(['[Other]\nInstance=20260920070000-12345', '[ArkdownStartup]\nInstance=bad', 'x'.repeat(2048)])('ignores unrelated, malformed and oversized markers', async contents => {
  const root = await fixture()
  await writeFile(path.join(root, '.arkdown-installation.ini'), contents)
  expect(await readDefaultApplicationsInstallationId(root)).toBeUndefined()
})

it('ignores a directory in place of the optional marker', async () => {
  const root = await fixture()
  await mkdir(path.join(root, '.arkdown-installation.ini'))
  expect(await readDefaultApplicationsInstallationId(root)).toBeUndefined()
})

it('persists the release and installation identity alongside the unchanged user workspace', async () => {
  const root = await fixture()
  const state = { starts: 2, handled: true, version: '1.0.2', installationId: '20260920070000-12345' }
  await new SettingsStore(root).save({ lastWorkspace: 'C:/Notes', defaultApplicationsPrompt: state })
  expect(await new SettingsStore(root).load()).toMatchObject({ lastWorkspace: 'C:/Notes', defaultApplicationsPrompt: state })
})
