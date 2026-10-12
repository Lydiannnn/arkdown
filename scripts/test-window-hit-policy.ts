import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = process.cwd()
const source = await readFile(path.join(root, 'scripts/windows-window-hit-test.ps1'), 'utf8')
const match = /Add-Type @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)
if (!match) throw new Error('Native policy block missing')
const output = path.join(root, '.native-cache/window-hit-policy')
await mkdir(output, { recursive: true })
const policy = path.join(output, 'Policy.cs')
await writeFile(policy, match[1], 'utf8')
const executable = path.join(output, 'PolicyTests.exe')
const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
const build = await execute(compiler, ['/nologo', '/utf8output', '/codepage:65001', '/target:exe', `/out:${executable}`, policy,
  path.join(root, 'tests/main/window-hit-policy-tests.cs')], { windowsHide: true, encoding: 'utf8', timeout: 60_000 })
if (build.stdout) process.stdout.write(build.stdout)
const result = await execute(executable, [], { windowsHide: true, encoding: 'utf8', timeout: 15_000 })
process.stdout.write(result.stdout)
