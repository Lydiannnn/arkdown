import { execFile } from 'node:child_process'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)
/** Observe the exact helper/fixture and its descendants; never kill processes. */
export async function observeNativeTestExit(root: string, executable: string, pids: number[]): Promise<void> {
  const known = new Set(pids)
  let quietSince = 0
  const deadline = Date.now() + 20_000
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$all = @(Get-CimInstance Win32_Process -ErrorAction Stop)',
    '$known = [System.Collections.Generic.HashSet[int]]::new()',
    '$env:ARKDOWN_TEST_PIDS.Split(\',\') | Where-Object { $_ } | ForEach-Object { [void]$known.Add([int]$_) }',
    '$found = [System.Collections.Generic.HashSet[int]]::new()',
    'do { $changed = $false; foreach ($item in $all) {',
    '  $belongs = $item.ExecutablePath -and (($item.ExecutablePath -ieq $env:ARKDOWN_TEST_HELPER) -or $item.ExecutablePath.StartsWith($env:ARKDOWN_TEST_ROOT + \'\\\', [System.StringComparison]::OrdinalIgnoreCase))',
    '  if ($belongs -or $known.Contains([int]$item.ProcessId) -or $known.Contains([int]$item.ParentProcessId)) {',
    '    [void]$found.Add([int]$item.ProcessId); if ($known.Add([int]$item.ProcessId)) { $changed = $true }',
    '  }',
    '} } while ($changed)',
    'ConvertTo-Json -InputObject @($found) -Compress',
  ].join('\n')
  while (Date.now() < deadline) {
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, ARKDOWN_TEST_ROOT: path.resolve(root), ARKDOWN_TEST_HELPER: path.resolve(executable), ARKDOWN_TEST_PIDS: [...known].join(',') },
    })
    const active: number[] = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())
    for (const pid of active) known.add(pid)
    if (active.length) quietSince = 0
    else if (!quietSince) quietSince = Date.now()
    else if (Date.now() - quietSince >= 1200) {
      process.stdout.write(`PASS native process tree absent for ${Date.now() - quietSince}ms before fixture cleanup\n`)
      return
    }
    await delay(200)
  }
  throw new Error('Native test processes did not reach a verified 1200ms quiet period; fixture retained')
}

export function assertTestCleanupRoot(root: string, temporaryRoot: string, prefix: string): void {
  const relative = path.relative(path.resolve(temporaryRoot), path.resolve(root))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith(prefix)) {
    throw new Error('Refusing cleanup outside the generated native-test fixture')
  }
}
