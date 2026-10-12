// @vitest-environment node
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { uninstallAssociationInclude } from '../../scripts/build-uninstall-associations'
import { assertTestCleanupRoot, observeNativeTestExit } from '../../native/application-updater/tests/native-test-processes'

const repo = process.cwd()
const compiler = path.join(repo, '.superpowers/windows-installers/tools/InnoSetup/ISCC.exe')
it.skipIf(process.platform !== 'win32' || !existsSync(compiler))('checks installer script syntax with Inno output disabled and never creates a Setup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-inno-compile-'))
  const pids: number[] = []
  try {
    const payload = path.join(root, 'payload.iss'), cleanup = path.join(root, 'cleanup.iss')
    const fixture = path.join(root, 'fixture.txt'), content = 'compile-only fixture'
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex')
    await writeFile(fixture, content, 'utf8')
    await writeFile(payload, `Source: "${fixture}"; DestDir: "{app}"; Flags: ignoreversion\n`, 'utf8')
    await writeFile(cleanup, (await uninstallAssociationInclude(repo)).include, 'utf8')
    // This validates Pascal/section syntax only. The fixture is never packaged
    // or executed; production behavior requires the audited complete payload.
    const running = promisify(execFile)(compiler, ['--output=no', '/DAppVersion=1.0.4', '/DEdition=Lite', '/DVersionMS=65536', '/DVersionLS=262144',
      '/DRepoRoot=' + repo, '/DOutputDir=' + root, '/DPayloadFileList=' + payload, '/DAssociationCleanupIncludeFile=' + cleanup,
      '/DInstallerFinalizeHelper=' + fixture, '/DInstallerFinalizeHelperSha256=' + sha256, '/DInstalledManifestSha256=' + sha256,
      path.join(repo, 'installer/windows/Arkdown.iss')], { windowsHide: true, encoding: 'utf8', timeout: 30_000 })
    if (running.child.pid) pids.push(running.child.pid)
    const result = await running
    expect(result.stdout).toContain('Output was disabled.')
    expect((await readdir(root)).sort()).toEqual(['cleanup.iss', 'fixture.txt', 'payload.iss'])
  } finally {
    await observeNativeTestExit(root, compiler, pids)
    assertTestCleanupRoot(root, os.tmpdir(), 'arkdown-inno-compile-')
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
