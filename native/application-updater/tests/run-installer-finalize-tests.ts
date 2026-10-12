// Standalone native tests; no Inno fixture or original legacy MANUAL is created.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildApplicationUpdater } from '../../../scripts/build-application-updater.ts'
import { assertTestCleanupRoot, observeNativeTestExit } from './native-test-processes.ts'

if (process.platform !== 'win32') throw new Error('Native tests require Windows')
const execute = promisify(execFile)
const repo = path.resolve(import.meta.dirname, '../../..')
const source = path.join(repo, 'native/application-updater/src')
const output = path.join(repo, '.native-cache/application-updater/installer-finalize-tests')
await mkdir(output, { recursive: true })
const executable = path.join(output, 'InstallerFinalizeTests.exe')
const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
const compile = await execute(compiler, ['/nologo', '/utf8output', '/codepage:65001', '/target:exe', '/platform:x64',
  '/main:InstallerFinalizeTests', `/out:${executable}`, '/reference:System.dll', '/reference:System.Core.dll',
  '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
  '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
  ...(await readdir(source)).filter(file => file.endsWith('.cs')).sort().map(file => path.join(source, file)),
  path.join(repo, 'native/application-updater/tests/InstallerFinalizeTests.cs')],
{ windowsHide: true, encoding: 'utf8', timeout: 60_000 })
if (compile.stdout) process.stdout.write(compile.stdout)
const shipping = await buildApplicationUpdater(repo)
process.stdout.write(`Compiled native matrix and shipping helper ${shipping.trust.sha256}\n`)
if (!process.argv.includes('--compile-only')) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-installer-finalize-matrix-'))
  const pids: number[] = []
  try {
    // Directory junctions do not require the symbolic-link privilege. Keep both
    // the protected target and the link inside this isolated cleanup root.
    const junctionTarget = path.join(root, 'junction-target')
    const junctionParent = path.join(root, 'ancestor-junction/resources/components')
    await mkdir(junctionTarget, { recursive: true })
    await mkdir(junctionParent, { recursive: true })
    await writeFile(path.join(junctionTarget, 'MANUAL.html'), 'independent harmless migration test content', 'utf8')
    await symlink(junctionTarget, path.join(junctionParent, 'pandoc'), 'junction')
    const running = execute(executable, [root], { windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
    if (running.child.pid) pids.push(running.child.pid)
    const result = await running
    process.stdout.write(result.stdout)
  } finally {
    await observeNativeTestExit(root, executable, pids)
    assertTestCleanupRoot(root, os.tmpdir(), 'arkdown-installer-finalize-matrix-')
    await rm(root, { recursive: true, force: true })
  }
  // Separate shipping Main behavior from direct primitive tests; also serialized.
  const result = await execute(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    path.join(repo, 'native/application-updater/tests/installer-finalize-entry-test.ts'),
    path.join(repo, '.native-cache/application-updater/Arkdown.Update.exe')],
  { windowsHide: true, encoding: 'utf8', timeout: 45_000 })
  process.stdout.write(result.stdout)
}
