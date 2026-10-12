// Run serially with other native updater tests. This does not build or run Inno Setup.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { assertTestCleanupRoot, observeNativeTestExit } from './native-test-processes.ts'

const helperArgument = process.argv[2]
if (!helperArgument || process.platform !== 'win32') throw new Error('Pass the Windows shipping Arkdown.Update.exe path')
const helper = path.resolve(helperArgument)
const execute = promisify(execFile)
const pids: number[] = []
const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-installer-finalize-entry-'))
const target = path.join(root, 'app')
await mkdir(target)
const sentinel = path.join(target, 'personal.md')
await writeFile(sentinel, 'preserve user document', 'utf8')
try {
  const running = execute(helper, ['--installer-finalize', 'prepare', target,
    'a'.repeat(64), '1.0.4', 'Full', '-'], { windowsHide: true, encoding: 'utf8', timeout: 10_000 })
  if (running.child.pid) pids.push(running.child.pid)
  const result = await running
  const guardBytes = await readFile(path.join(target, '.arkdown-installer-update.ini')).catch(() => Buffer.alloc(0))
  const guard = guardBytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
    ? guardBytes.subarray(2).toString('utf16le') : guardBytes.toString('utf8').replace(/^\uFEFF/, '')
  // The old CLI reports an unsupported command and exits without this protective
  // state. The RED is this missing behavior, not a missing C# type/compile error.
  assert.match(guard, /InstallerFinalize=1/, 'prepare must persist the installation-finalization guard')
  assert.match(guard, /Schema=1/)
  assert.ok(guard.includes('Target=' + target), 'guard must identify the exact installation')
  assert.equal(result.stdout, '', 'the restricted entry must not enter the GUI/stdio update protocol')
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve user document')
  process.stdout.write('PASS shipping installer-finalize entry prepares a guard without modifying user data\n')
} finally {
  await observeNativeTestExit(root, helper, pids)
  assertTestCleanupRoot(root, os.tmpdir(), 'arkdown-installer-finalize-entry-')
  await rm(root, { recursive: true, force: true })
}
