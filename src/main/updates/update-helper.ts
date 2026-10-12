import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { ensureUpdateDirectory, openUpdateFile } from './update-cache'
import type { UpdateArtifact } from './update-protocol'
import type { UpdateHandoff } from './update-install-coordinator'
import { UpdatePackageInvalidError } from './update-errors'
import { pinTrustedUpdateExecutable } from './update-executable'
import { parentPinDiagnostic, parseUpdateDiagnostic, type UpdateDiagnostic } from './update-diagnostic'
import type { UpdateDiagnosticContext, UpdateDiagnosticLog } from './update-diagnostic-log'

declare const __ARKDOWN_APPLICATION_UPDATER_TRUST__: unknown
export interface ApplicationUpdaterTrust { bytes: number; sha256: string }
export interface NativeUpdateHandoff extends UpdateHandoff { notesRunning(): Promise<boolean>; waitNotesStopped(): Promise<void> }
export function parseApplicationUpdaterTrust(value: unknown): ApplicationUpdaterTrust {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'bytes,sha256') throw new Error('更新助手未包含可信校验信息，请使用完整发布包。')
  const record = value as ApplicationUpdaterTrust
  if (!Number.isSafeInteger(record.bytes) || record.bytes <= 0 || record.bytes > 2 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('更新助手校验信息无效。')
  return record
}
export function compiledUpdaterTrust(): ApplicationUpdaterTrust {
  return parseApplicationUpdaterTrust(typeof __ARKDOWN_APPLICATION_UPDATER_TRUST__ === 'undefined' ? undefined : __ARKDOWN_APPLICATION_UPDATER_TRUST__)
}
export async function copyTrustedUpdater(source: string, destination: string, trust: ApplicationUpdaterTrust): Promise<void> {
  const file = await openUpdateFile(source)
  try {
    if ((await file.stat()).size !== trust.bytes) throw new Error('更新助手校验失败，请重新下载完整发布包。')
    const bytes = await file.readFile()
    if (bytes.length !== trust.bytes || createHash('sha256').update(bytes).digest('hex') !== trust.sha256) throw new Error('更新助手校验失败，请重新下载完整发布包。')
    const target = await open(destination, 'wx')
    try { await target.writeFile(bytes); await target.sync() } finally { await target.close() }
  } finally { await file.close() }
}

export class UpdateHelperConnection {
  private readonly exited: Promise<void>
  private tail = ''
  private ended = false
  private fatal: Error | undefined
  private waiters = new Map<string, { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private received = new Set<string>()
  private notes = false
  private recordedDiagnostic = false
  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly token: string,
    private readonly onDiagnostic?: (diagnostic: UpdateDiagnostic) => void) {
    this.exited = new Promise(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()) })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.tail += chunk
      if (this.tail.length > 16384) { this.fail(new Error('更新助手响应过大。')); return }
      let newline: number
      while ((newline = this.tail.indexOf('\n')) >= 0) {
        const line = this.tail.slice(0, newline); this.tail = this.tail.slice(newline + 1)
        try {
          const value = JSON.parse(line.replace(/^\uFEFF/, ''))
          if (value.type === 'error') {
            this.recordDiagnostic(value.diagnostic)
            this.fail(new Error(typeof value.message === 'string' ? value.message : '更新助手未能完成交接。'))
          }
          else if (['ready', 'committed', 'revoked', 'done', 'notes', 'notes-stopped'].includes(value.type)) {
            if (value.type === 'notes') { if (typeof value.running !== 'boolean') throw new Error('Invalid process inventory'); this.notes = value.running }
            this.received.add(value.type); const waiter = this.waiters.get(value.type)
            if (waiter) { clearTimeout(waiter.timer); this.waiters.delete(value.type); waiter.resolve() }
          }
        } catch { this.fail(new Error('更新助手返回了无效响应。')) }
      }
    })
    child.stderr.resume() // Native details never enter the renderer or telemetry.
    child.stdin.on('error', () => this.fail(new Error('无法向更新助手发送交接请求。')))
    child.on('error', () => this.fail(new Error('无法启动更新助手，请检查程序文件及安全软件。')))
    child.on('exit', () => { this.ended = true; this.fail(new Error('更新助手已退出，安装未继续。')) })
  }
  private recordDiagnostic(value: unknown): void {
    if (this.recordedDiagnostic || this.received.has('ready') || !this.onDiagnostic) return
    try {
      const diagnostic = parseUpdateDiagnostic(value)
      if (diagnostic) { this.recordedDiagnostic = true; this.onDiagnostic(diagnostic) }
    } catch { /* Failure diagnostics have no protocol or lifecycle authority. */ }
  }
  send(value: unknown): void { if (this.ended) throw new Error('更新助手已退出。'); this.child.stdin.write(JSON.stringify(value) + '\n') }
  wait(type: string, timeout: number): Promise<void> {
    if (this.received.has(type)) return Promise.resolve()
    if (this.fatal) return Promise.reject(this.fatal)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(type); reject(new Error('更新助手未及时确认，请保留 Arkdown 窗口并重试。')) }, timeout)
      this.waiters.set(type, { resolve, reject, timer })
    })
  }
  private fail(error: Error): void { this.fatal = error; for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(error) } this.waiters.clear() }
  handoff(): NativeUpdateHandoff {
    return {
      exited: this.exited,
      commit: async input => { this.send({ type: 'commit', token: this.token, ...input }); await this.wait('committed', 15_000); this.child.unref() },
      revoke: async message => {
        if (this.ended) return // No surviving helper can mutate files after the parent exits.
        this.fatal = undefined; this.send({ type: 'revoke', token: this.token, message }); await this.wait('revoked', 15_000)
      },
      notesRunning: async () => { this.received.delete('notes'); this.send({ type: 'notes-state', token: this.token }); await this.wait('notes', 15_000); return this.notes },
      waitNotesStopped: async () => { this.received.delete('notes-stopped'); this.send({ type: 'wait-notes-exit', token: this.token }); await this.wait('notes-stopped', 35_000) },
    }
  }
}

function pinHelper(executable: string, resourcesPath: string, trust: ApplicationUpdaterTrust,
  failure: (error: unknown) => void): ReturnType<typeof pinTrustedUpdateExecutable> {
  try { return pinTrustedUpdateExecutable(executable, resourcesPath, trust) }
  catch (error) {
    try { failure(error) } catch { /* A diagnostic failure cannot replace the original pin exception. */ }
    throw error
  }
}
function recordPinFailure(log: UpdateDiagnosticLog | undefined, error: unknown, session: string, target: string,
  packageFile: string, context: UpdateDiagnosticContext): void {
  if (!log) return
  const diagnostic = parentPinDiagnostic(error, { session, target, package: packageFile, stage: path.join(session, 'stage') })
  if (diagnostic) log.record(diagnostic, context)
}

export async function prepareUpdateHelper(options: { resourcesPath: string; executablePath: string; version: string; artifact: UpdateArtifact; verifiedFile: string; trust?: ApplicationUpdaterTrust; diagnostics?: UpdateDiagnosticLog }): Promise<NativeUpdateHandoff> {
  const target = path.dirname(options.executablePath), session = path.join(path.dirname(target), '.ArkdownUpdate-' + randomUUID().replaceAll('-', ''))
  await ensureUpdateDirectory(session)
  const executable = path.join(session, 'Arkdown.Update.exe'), trust = options.trust ?? compiledUpdaterTrust()
  await copyTrustedUpdater(path.join(options.resourcesPath, 'application-updater/Arkdown.Update.exe'), executable, trust)
  const packageFile = path.join(session, options.artifact.kind === 'installer' ? 'update.exe' : 'update.zip')
  const source = await openUpdateFile(options.verifiedFile), output = await open(packageFile, 'wx')
  try {
    if ((await source.stat()).size !== options.artifact.bytes) throw new UpdatePackageInvalidError()
    let bytes = 0; const hash = createHash('sha256')
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      bytes += chunk.length; if (bytes > options.artifact.bytes) throw new UpdatePackageInvalidError()
      hash.update(chunk); await output.writeFile(chunk)
    }
    if (bytes !== options.artifact.bytes || hash.digest('hex') !== options.artifact.sha256) throw new UpdatePackageInvalidError()
    await output.sync()
  } finally { await source.close(); await output.close() }
  const token = randomBytes(32).toString('hex')
  // Windows otherwise terminates this child with the parent's libuv job.
  // Pipes still require the explicit commit/revoke protocol before any replacement.
  const lease = pinHelper(executable, options.resourcesPath, trust, error => recordPinFailure(options.diagnostics, error, session,
    target, packageFile, { version: options.version, edition: options.artifact.edition, kind: options.artifact.kind,
      helperSha256: trust.sha256, helperStarted: false, helperPid: null }))
  try {
    const child = spawn(executable, ['--stdio'], { detached: true, shell: false, windowsHide: true, stdio: 'pipe', cwd: session })
    const connection = new UpdateHelperConnection(child, token, diagnostic => options.diagnostics?.record(diagnostic, {
      version: options.version, edition: options.artifact.edition, kind: options.artifact.kind,
      helperSha256: trust.sha256, helperStarted: true, helperPid: child.pid ?? null }))
    connection.send({ protocolVersion: 1, parentPid: process.pid, token, target, session, package: packageFile,
      bytes: options.artifact.bytes, sha256: options.artifact.sha256, oldVersion: options.version, version: options.artifact.version, edition: options.artifact.edition, kind: options.artifact.kind })
    try { await connection.wait('ready', 20 * 60_000) } catch (error) { await connection.handoff().revoke().catch(() => {}); throw error }
    return connection.handoff()
  } finally { lease.close() }
}
export async function prepareRecoveryHelper(options: { resourcesPath: string; executablePath: string; version: string; session: string; diagnostics?: UpdateDiagnosticLog }): Promise<{ helper: NativeUpdateHandoff; documents: string[]; restoreArknote: boolean }> {
  const target = path.dirname(options.executablePath), session = path.resolve(options.session)
  if (path.dirname(session).toLowerCase() !== path.dirname(target).toLowerCase() || !/^\.ArkdownUpdate-[a-f0-9]{32}$/.test(path.basename(session))) throw new Error('更新恢复目录无效。')
  async function record(name: string, max: number): Promise<Record<string, unknown>> {
    const file = await openUpdateFile(path.join(session, name))
    try { if ((await file.stat()).size > max) throw new Error('更新恢复记录过大。'); return JSON.parse((await file.readFile('utf8')).replace(/^\uFEFF/, '')) } finally { await file.close() }
  }
  const request = await record('request.json', 16384), journal = await record('journal.json', 32 * 1024 * 1024)
  const originalCommit = await record('commit.json', 131072)
  const recoveryVersion = journal.state === 'complete' ? journal.newVersion : journal.oldVersion
  if (journal.schemaVersion !== 1 || journal.target !== target || request.target !== target || request.kind !== 'portable'
    || !['complete', 'rolled-back', 'replacing', 'applied'].includes(String(journal.state))
    || typeof recoveryVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(recoveryVersion)
    || !Array.isArray(originalCommit.documents) || originalCommit.documents.length > 128
    || !originalCommit.documents.every(p => typeof p === 'string' && path.isAbsolute(p) && p.length <= 32760)) throw new Error('更新恢复记录校验失败，请使用官方安装包修复程序。')
  const executable = path.join(session, 'Arkdown.Recover-' + randomUUID() + '.exe')
  const trust = compiledUpdaterTrust()
  await copyTrustedUpdater(path.join(options.resourcesPath, 'application-updater/Arkdown.Update.exe'), executable, trust)
  const lease = pinHelper(executable, options.resourcesPath, trust, error => recordPinFailure(options.diagnostics, error, session,
    target, path.join(session, 'update.zip'), { version: options.version,
      edition: request.edition === 'Full' || request.edition === 'Lite' ? request.edition : null, kind: 'portable',
      helperSha256: trust.sha256, helperStarted: false, helperPid: null }))
  try {
    const token = randomBytes(32).toString('hex'), child = spawn(executable, ['--stdio'], { detached: true, shell: false, windowsHide: true, stdio: 'pipe', cwd: session })
    const connection = new UpdateHelperConnection(child, token, diagnostic => options.diagnostics?.record(diagnostic, {
      version: options.version, edition: request.edition === 'Full' || request.edition === 'Lite' ? request.edition : null, kind: 'portable',
      helperSha256: trust.sha256, helperStarted: true, helperPid: child.pid ?? null }))
    connection.send({ ...request, parentPid: process.pid, token, oldVersion: options.version, version: recoveryVersion, recover: true })
    try { await connection.wait('ready', 60_000) } catch (error) { await connection.handoff().revoke().catch(() => {}); throw error }
    return { helper: connection.handoff(), documents: originalCommit.documents as string[], restoreArknote: originalCommit.restoreArknote === true }
  } finally { lease.close() }
}
