// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
import { prepareUpdateHelper } from '../../src/main/updates/update-helper'

it('launches the handoff helper outside the parent lifetime while retaining acknowledgement pipes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-update-launch-'))
  const resources = path.join(root, 'app', 'resources'), bytes = Buffer.from('synthetic-build-bytes')
  const trust = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn() })
  child.stdin.on('data', data => {
    const request = JSON.parse(data.toString())
    child.stdout.write(JSON.stringify({ type: request.type === 'revoke' ? 'revoked' : 'ready' }) + '\n')
  })
  let protectedAtLaunch = false
  spawn.mockImplementation((file: string) => {
    try { writeFileSync(file, 'replaced between verification and process creation') }
    catch (error) { protectedAtLaunch = ['EACCES', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') }
    return child
  })
  try {
    await mkdir(path.join(resources, 'application-updater'), { recursive: true })
    await mkdir(path.join(resources, 'sticky-note-native-surface'), { recursive: true })
    // Keep the loaded DLL outside the disposable tree; Windows holds its image
    // until this worker exits. Only the directory junction is test-owned.
    await symlink(path.resolve('native/sticky-note-surface/dist/x64'), path.join(resources, 'sticky-note-native-surface/x64'), 'junction')
    await writeFile(path.join(resources, 'application-updater', 'Arkdown.Update.exe'), bytes)
    const file = path.join(root, 'verified.zip'); await writeFile(file, bytes)
    const handoff = await prepareUpdateHelper({ resourcesPath: resources, executablePath: path.join(root, 'app', 'Arkdown.exe'),
      version: '1.0.4', verifiedFile: file, trust,
      artifact: { version: '1.0.5', channel: 'stable', edition: 'Lite', kind: 'portable', filename: 'update.zip', url: 'https://download.cotax.tech/update.zip', ...trust } })
    await handoff.revoke()
    expect(protectedAtLaunch).toBe(true)
    expect(spawn).toHaveBeenCalledWith(expect.any(String), ['--stdio'], expect.objectContaining({ detached: true, windowsHide: true, shell: false, stdio: 'pipe' }))
  } finally {
    await unlink(path.join(resources, 'sticky-note-native-surface/x64')).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
