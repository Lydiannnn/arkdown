// @vitest-environment node
import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { buildApplicationUpdater } from '../../scripts/build-application-updater'

it.skipIf(process.platform !== 'win32')('returns a structured rejection through redirected pipes when launched without a console', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-updater-stdio-'))
  try {
    await cp(path.join(process.cwd(), 'native/application-updater'), path.join(root, 'native/application-updater'), { recursive: true })
    await buildApplicationUpdater(root)
    const run = promisify(execFile)(path.join(root, '.native-cache/application-updater/Arkdown.Update.exe'), ['--stdio'], {
      windowsHide: true, encoding: 'utf8', timeout: 10_000,
    })
    run.child.stdin!.on('error', () => {})
    run.child.stdin!.end('{}\n')
    const { stdout, stderr } = await run
    expect(stderr).toBe('')
    expect(stdout.trim()).not.toBe('')
    expect(JSON.parse(stdout.trim())).toMatchObject({ type: 'error', message: expect.any(String) })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
