import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'

export function updateLaunchPipe(target: string): string {
  const identity = path.win32.resolve(target).replace(/[\\/]+$/, '').toLowerCase()
  return '\\\\.\\pipe\\arkdown-update-' + createHash('sha256').update(identity, 'utf8').digest('hex')
}
/** The external helper owns this lease until all replacements and restarts end. */
export async function notifyUpdateLaunchBlocked(target: string, mode: 'arkdown' | 'arknote'): Promise<void> {
  await queryUpdateLaunchGate(target, [], mode, updateLaunchPipe(target), 3_000, true)
}
export function queryUpdateLaunchGate(target: string, argv: string[], mode: 'arkdown' | 'arknote', pipe = updateLaunchPipe(target), timeout = 3_000, notifyBusy = false): Promise<'absent' | 'allowed' | 'blocked'> {
  return new Promise((resolve, reject) => {
    let connected = false, settled = false, text = ''
    const socket = net.connect(pipe)
    const finish = (result?: 'absent' | 'allowed' | 'blocked') => {
      if (settled) return; settled = true; socket.destroy()
      if (result) resolve(result); else reject(new Error('更新助手暂未响应，请等待更新结束后再打开程序。'))
    }
    socket.setTimeout(timeout, () => finish())
    socket.on('error', error => finish(!connected && ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'absent' : undefined))
    socket.on('connect', () => {
      connected = true
      const args = (prefix: string) => argv.filter(value => value.startsWith(prefix))
      const sessions = args('--arkdown-update-session='), tokens = args('--arkdown-update-token=')
      socket.write(JSON.stringify({ protocolVersion: 1, mode, pid: process.pid, notifyBusy,
        session: sessions.length === 1 ? sessions[0].slice('--arkdown-update-session='.length) : '',
        token: tokens.length === 1 ? tokens[0].slice('--arkdown-update-token='.length) : '' }) + '\n')
    })
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      text += chunk; if (text.length > 1024) { finish(); return }
      if (!text.includes('\n')) return
      try { const result = JSON.parse(text); finish(result.allowed === true ? 'allowed' : result.allowed === false ? 'blocked' : undefined) } catch { finish() }
    })
    socket.on('end', () => finish())
  })
}
