import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** Resolve the npm package's native binary, following its installed bin/codex.js layout. */
export function codexNativeExecutable(candidates: readonly string[], arch = process.arch): string | undefined {
  const direct = candidates.find(candidate => path.isAbsolute(candidate) && path.extname(candidate).toLowerCase() === '.exe' && existsSync(candidate))
  if (direct) return direct
  const target = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : arch === 'x64' ? 'x86_64-pc-windows-msvc' : undefined
  if (!target) return undefined
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    const lexical = path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex')
    if (!existsSync(path.join(lexical, 'package.json'))) continue
    const root = realpathSync(lexical)
    let vendor = path.join(root, 'vendor')
    try {
      const require = createRequire(path.join(root, 'package.json'))
      vendor = path.join(path.dirname(require.resolve(`@openai/codex-win32-${arch}/package.json`)), 'vendor')
    } catch { /* Older packages ship vendor inside the main package. */ }
    for (const directory of ['bin', 'codex']) {
      const binary = path.join(vendor, target, directory, 'codex.exe')
      if (existsSync(binary)) return binary
    }
  }
  return undefined
}

export async function discoverCodexCliExecutables(timeoutMs = 2_000): Promise<readonly string[]> {
  const candidates = await new Promise<string[]>(resolve => execFile('where.exe', ['codex'], {
    encoding: 'utf8', maxBuffer: 4 * 1024, timeout: timeoutMs, windowsHide: true,
  }, (_error, stdout) => resolve((stdout ?? '').split(/\r?\n/u).map(value => value.trim()).filter(Boolean))))
  const roaming = process.env.APPDATA
  if (roaming && path.isAbsolute(roaming)) {
    const wrapper = path.join(roaming, 'npm', 'codex.cmd')
    if (existsSync(wrapper) && !candidates.includes(wrapper)) candidates.push(wrapper)
  }
  const binary = codexNativeExecutable(candidates)
  return binary ? [binary, ...candidates.filter(candidate => candidate !== binary)] : candidates
}
