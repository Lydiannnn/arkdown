import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { registerHooks } from 'node:module'
import { once } from 'node:events'
import { promisify } from 'node:util'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const output = path.join(root, '.native-cache/window-hit-native')
await mkdir(output, { recursive: true })
const source = await readFile(path.join(root, 'scripts/windows-window-hit-test.ps1'), 'utf8')
const embedded = /Add-Type @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1]
if (!embedded) throw new Error('Native policy missing')
const policy = path.join(output, 'Policy.cs')
await writeFile(policy, embedded, 'utf8')
const executable = path.join(output, 'WindowHitFixture.exe')
await promisify(execFile)(path.join(process.env.SystemRoot ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
  '/nologo', '/utf8output', '/codepage:65001', '/target:exe', `/out:${executable}`,
  '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll',
  policy, path.join(root, 'tests/e2e/fixtures/window-hit-test-native.cs'),
], { windowsHide: true, encoding: 'utf8', timeout: 30_000 })
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) } catch (error) {
    if (specifier.startsWith('.') && !path.extname(specifier)) return nextResolve(`${specifier}.ts`, context)
    throw error
  }
} })
const { createWindowHitTestService } = await import(pathToFileURL(path.join(root, 'src/main/screenshot-translation/window-hit-test.ts')).href)
const bridge = createWindowHitTestService({ scriptPath: path.join(root, 'scripts/windows-window-hit-test.ps1'), timeoutMs: 10_000 })
const child = spawn(executable, [], { windowsHide: true, shell: false, stdio: 'pipe' })
const exited = once(child, 'exit')
const lines = createInterface({ input: child.stdout })
const queued: any[] = []
let receiver: ((value: any) => void) | undefined
lines.on('line', line => { const value = JSON.parse(line); if (receiver) { const next = receiver; receiver = undefined; next(value) } else queued.push(value) })
const next = () => queued.length ? Promise.resolve(queued.shift()) : new Promise<any>((resolve, reject) => {
  const timeout = setTimeout(() => { receiver = undefined; reject(new Error('Fixture timeout')) }, 10_000)
  receiver = value => { clearTimeout(timeout); resolve(value) }
})
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const command = async (value: string) => { child.stdin.write(`${value}\n`); const reply = await next(); await delay(150); return reply }
const center = (window: any) => ({ x: window.boundsPx.x + Math.floor(window.boundsPx.width / 2), y: window.boundsPx.y + Math.floor(window.boundsPx.height / 2) })
let checks = 0
const expectHit = async (window: any, exclusions: string[] = []) => {
  const hit = await bridge.hitTest(center(window), new Set(exclusions))
  assert.equal(hit?.hwnd, window.hwnd)
  assert.deepEqual(hit.boundsPx, window.boundsPx)
  assert.match(hit.processCreationIdentity, /^[1-9][0-9]+$/u)
  checks++
}
try {
  let state = await next(); await delay(200)
  await expectHit(state.first); await expectHit(state.second)
  state = await command('overlay')
  await expectHit(state.overlay)
  await expectHit(state.first, [state.overlay.hwnd])
  for (const mode of ['transparent', 'tool', 'noactivate', 'passthrough']) {
    state = await command(mode); await expectHit(state.first)
  }
  state = await command('layered'); await expectHit(state.overlay)
  state = await command('move'); await expectHit(state.first)
  state = await command('maximize'); await expectHit(state.first)
  state = await command('restore'); await expectHit(state.first)
  const before = state.first
  await command('minimize')
  const hidden = await bridge.hitTest(center(before), new Set())
  assert.notEqual(hidden?.hwnd, before.hwnd); checks++
  state = await command('restore'); await expectHit(state.first)
  process.stdout.write(`Native synthetic window checks passed: ${checks}\n`)
} finally {
  child.stdin.end('close\n')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture did not close normally')), 10_000) })])
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) { child.kill(); await exited }
    try { await bridge.dispose() } finally { lines.close(); await delay(1200) }
  }
}
