// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAppUpdateRuntime } from '../../src/main/updates/update-runtime'
import { updateFixture } from '../helpers/app-update-fixture'
import type { UpdateTransport } from '../../src/main/updates/update-http'
import { createHash } from 'node:crypto'
import { UpdateCache } from '../../src/main/updates/update-cache'
import { parseUpdateDecision } from '../../src/main/updates/update-protocol'
const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(isPackaged: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ark-update-runtime-')); roots.push(root); const resourcesPath = path.join(root, 'resources'); await mkdir(resourcesPath)
  await writeFile(path.join(resourcesPath, 'package-edition.json'), JSON.stringify({ schemaVersion: 1, edition: 'full' }))
  const transport = vi.fn<UpdateTransport>().mockImplementation(async url => url.includes('update-check') ? new Response(JSON.stringify(updateFixture())) : new Response(null, { status: 204 }))
  const ensure = vi.fn(async () => '11111111-1111-4111-8111-111111111111'), exit = vi.fn()
  const runtime = createAppUpdateRuntime({ version: '1.0.4', isPackaged, resourcesPath, executablePath: path.join(root, 'Arkdown.exe'), channel: 'stable',
    ensureInstallationId: ensure, openWebsite: async () => {}, requestExit: exit, transport })
  return { runtime, transport, ensure, exit }
}
it('does not access identity storage or network in an unpackaged run', async () => {
  const f = await fixture(false); vi.useFakeTimers(); f.runtime.service.onMainWindowReady(1)
  await vi.advanceTimersByTimeAsync(5000); expect(f.ensure).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled(); f.runtime.dispose()
})
it('binds package identity, sends no credentials, shares state and denies exit for optional updates', async () => {
  const f = await fixture(true); f.runtime.service.onMainWindowReady(1)
  // Real filesystem work after the scheduled callback must not race a fake-timer-only drain.
  await vi.waitFor(() => expect(f.transport).toHaveBeenCalled(), { timeout: 6500 })
  const [url, init] = f.transport.mock.calls[0]
  const query = new URL(url).searchParams
  expect(Object.fromEntries(query)).toEqual({ version: '1.0.4', channel: 'stable', edition: 'Full', kind: 'portable', installationId: '11111111-1111-4111-8111-111111111111' })
  expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('manual')
  await vi.waitFor(() => expect(f.runtime.bind(1, () => true).getState().candidate?.version).toBe('1.0.5'))
  f.runtime.service.onMainWindowReady(2); expect(f.runtime.bind(2, () => true).getState().candidate?.version).toBe('1.0.5')
  expect(() => f.runtime.bind(2, () => true).requestExit()).toThrow(); expect(f.exit).not.toHaveBeenCalled(); f.runtime.dispose()
}, 10000)
it('offers a fresh download when a previously verified cache file changes, then installs the replacement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ark-update-corrupt-')); roots.push(root)
  const resourcesPath = path.join(root, 'resources'), executablePath = path.join(root, 'Arkdown.exe')
  await mkdir(resourcesPath); await writeFile(path.join(resourcesPath, 'package-edition.json'), JSON.stringify({ schemaVersion: 1, edition: 'full' }))
  const bytes = Buffer.from('synthetic update data'), decision = updateFixture()
  for (const artifact of decision.release.packages) Object.assign(artifact, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  Object.assign(decision.release, decision.release.packages[1])
  let downloads = 0, installs = 0
  const transport: UpdateTransport = async url => {
    if (url.includes('update-check')) return new Response(JSON.stringify(decision))
    if (url === 'https://download.cotax.tech/package.zip') { downloads++; return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }) }
    return new Response(null, { status: 204 })
  }
  const runtime = createAppUpdateRuntime({ version: '1.0.4', isPackaged: true, resourcesPath, executablePath, channel: 'stable',
    ensureInstallationId: async () => '11111111-1111-4111-8111-111111111111', openWebsite: async () => {}, requestExit() {}, transport,
    requestInstall: async () => { installs++ } })
  try {
    runtime.service.onMainWindowReady(1)
    await vi.waitFor(() => expect(runtime.service.getSnapshot(1).candidate).not.toBeNull(), { timeout: 6500 })
    await runtime.service.action(1, 'download')
    await vi.waitFor(() => expect(runtime.service.getSnapshot(1).transfer?.phase).toBe('ready'))
    const namespace = createHash('sha256').update(path.resolve(executablePath).toLowerCase() + ':stable').digest('hex')
    const cache = new UpdateCache(path.join(root, 'portable-data/updates', namespace, 'downloads'))
    const artifact = parseUpdateDecision(decision, { version: '1.0.4', channel: 'stable', edition: 'Full', kind: 'portable' })!.artifact!
    await writeFile(cache.file(artifact), 'changed')
    await runtime.service.action(1, 'install')
    expect(installs).toBe(0)
    expect(runtime.service.getSnapshot(1).transfer).toMatchObject({ phase: 'failed', dialog: 'offer' })
    expect(runtime.service.isWorkBlocked()).toBe(false)
    await runtime.service.action(1, 'download')
    await vi.waitFor(() => expect(runtime.service.getSnapshot(1).transfer?.phase).toBe('ready'))
    await runtime.service.action(1, 'install')
    expect(downloads).toBe(2); expect(installs).toBe(1)
  } finally { runtime.dispose() }
}, 10000)
