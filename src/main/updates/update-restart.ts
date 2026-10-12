import path from 'node:path'
import { lstat, open } from 'node:fs/promises'
import { openUpdateFile } from './update-cache'
import { queryUpdateLaunchGate } from './update-launch-gate'
export interface RestartContext { session: string; token: string; version: string; target: string }
async function json(file: string, max: number): Promise<Record<string, unknown>> {
  const handle = await openUpdateFile(file)
  try {
    if ((await handle.stat()).size > max) throw new Error('更新记录超出安全读取范围。')
    return JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, ''))
  } finally { await handle.close() }
}
const same = (a: unknown, b: string): boolean => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
export async function inspectUpdateStartup(input: { executablePath: string; version: string; argv: string[] }): Promise<{ restart?: RestartContext; recoverySession?: string; blockedByUpdate?: boolean }> {
  const target = path.dirname(input.executablePath), markerPath = path.join(target, '.arkdown-update-pending.json')
  const mode = path.basename(input.executablePath).toLowerCase() === 'arknote.exe' ? 'arknote' : 'arkdown'
  const admission = await queryUpdateLaunchGate(target, input.argv, mode)
  if (admission === 'blocked') return { blockedByUpdate: true }
  const installerGuard = await lstat(path.join(target, '.arkdown-installer-update.ini')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
  if (installerGuard && admission !== 'allowed') throw new Error('上一次安装尚未确认完成。请等待安装程序退出；若已中断，请重新运行官方安装包修复后再打开程序。')
  const markerInfo = await lstat(markerPath).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error })
  let recoverySession: string | undefined
  if (markerInfo) {
    const marker = await json(markerPath, 1024)
    if (marker.schemaVersion !== 1 || typeof marker.session !== 'string' || !/^\.ArkdownUpdate-[a-f0-9]{32}$/.test(marker.session)) throw new Error('检测到无法校验的更新恢复记录。请使用官方安装包修复程序，保留用户数据。')
    recoverySession = path.join(path.dirname(target), marker.session)
  }
  const sessions = input.argv.filter(s => s.startsWith('--arkdown-update-session=')), tokens = input.argv.filter(s => s.startsWith('--arkdown-update-token='))
  if (!sessions.length && !tokens.length) return recoverySession ? { recoverySession } : {}
  if (sessions.length !== 1 || tokens.length !== 1) throw new Error('更新启动参数不完整。')
  const session = sessions[0].slice('--arkdown-update-session='.length), token = tokens[0].slice('--arkdown-update-token='.length)
  if (!path.isAbsolute(session) || !same(path.dirname(session), path.dirname(target)) || !/^\.ArkdownUpdate-[a-f0-9]{32}$/.test(path.basename(session)) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('更新会话位置或凭据无效。')
  const request = await json(path.join(session, 'request.json'), 16384)
  if (request.protocolVersion !== 1 || !same(request.target, target) || !same(request.session, session) || request.token !== token || request.version !== input.version || !['portable', 'installer'].includes(String(request.kind))) throw new Error('更新启动确认与当前程序版本不匹配。')
  if (recoverySession) {
    const journal = await json(path.join(session, 'journal.json'), 32 * 1024 * 1024)
    if (!same(recoverySession, session) || journal.schemaVersion !== 1 || !same(journal.target, target) || journal.state !== 'applied' || journal.newVersion !== input.version) throw new Error('上一次更新尚未完成，需要先恢复程序文件。')
  }
  return { restart: { session, token, version: input.version, target } }
}
export async function acknowledgeUpdateRestart(context: RestartContext, mode: 'arkdown' | 'arknote', pid: number): Promise<void> {
  const target = await open(path.join(context.session, mode + '-ready.json'), 'wx')
  try { await target.writeFile(JSON.stringify({ protocolVersion: 1, token: context.token, version: context.version, mode, pid }), 'utf8'); await target.sync() }
  finally { await target.close() }
}
