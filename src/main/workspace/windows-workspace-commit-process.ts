import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { DocumentConflictError } from '../documents/document-service'
import type { DocumentReplacementRequest } from '../documents/document-replacement'
import type {
  WindowsWorkspaceCommitAdapter,
  WorkspaceAiCommitOutcome,
  WorkspaceAiCommitRequest,
} from './workspace-ai-file-service'

const PROTOCOL_VERSION = 1
const MAX_REQUEST_FRAME_BYTES = 32 * 1024 * 1024
const MAX_RESPONSE_BYTES = 16 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const DOCUMENT_TIMEOUT_MS = 120_000
const SPAWN_BUSY_RETRY_DELAYS_MS = [100, 200, 400] as const
const MAX_HELPER_BYTES = 2 * 1024 * 1024
const MAX_MANIFEST_BYTES = 4 * 1024
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u

declare const __ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__: unknown

const REJECTED_REASONS = [
  'root-changed',
  'parent-changed',
  'source-changed',
  'destination-exists',
  'unsupported',
] as const

const HELPER_UNKNOWN_REASONS = [
  'cleanup_ambiguous',
  'commit_verification_failed',
  'pipe_failure',
  'post_commit_verification_failed',
  'quarantine_retained',
  'shell_result_unverifiable',
] as const

export interface WorkspaceCommitChildProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly kill: (signal?: NodeJS.Signals | number) => boolean
  once(event: 'spawn', listener: () => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
}

export interface WorkspaceCommitSpawnOptions {
  readonly shell: false
  readonly windowsHide: true
  readonly cwd: string
  readonly stdio: ['pipe', 'pipe', 'pipe']
  readonly env: NodeJS.ProcessEnv
}

export type WorkspaceCommitProcessFactory = (
  executable: string,
  args: readonly string[],
  options: WorkspaceCommitSpawnOptions,
) => WorkspaceCommitChildProcess

export interface WorkspaceCommitHelperLocation {
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly appPath: string
  readonly arch: 'x64' | 'arm64'
}

export interface WorkspaceCommitHelperTrust {
  readonly schemaVersion: 1
  readonly protocolVersion: 1
  readonly arch: 'x64' | 'arm64'
  readonly fileName: 'arkdown-workspace-commit.exe'
  readonly bytes: number
  readonly sha256: string
  readonly peMachine: 0x8664 | 0xaa64
}

export interface WindowsWorkspaceCommitProcessOptions {
  /** A direct helper path is an explicit development/test downgrade. Packaged code must use location. */
  readonly developmentHelperPath?: string
  readonly location?: WorkspaceCommitHelperLocation
  readonly processFactory?: WorkspaceCommitProcessFactory
  readonly requestId?: () => string
  readonly timeoutMs?: number
}

function defaultProcessFactory(
  executable: string,
  args: readonly string[],
  options: WorkspaceCommitSpawnOptions,
): WorkspaceCommitChildProcess {
  return spawn(executable, [...args], options) as WorkspaceCommitChildProcess
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const) {
    const value = process.env[name]
    if (value) environment[name] = value
  }
  return environment
}

function peMachine(bytes: Buffer): number | undefined {
  if (bytes.byteLength < 0x40 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') return undefined
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset < 0x40 || peOffset + 6 > bytes.byteLength
    || bytes.subarray(peOffset, peOffset + 4).toString('binary') !== 'PE\0\0') return undefined
  return bytes.readUInt16LE(peOffset + 4)
}

function exactTrust(value: unknown): WorkspaceCommitHelperTrust | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined
  const record = value as Record<string, unknown>
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([
    'arch', 'bytes', 'fileName', 'peMachine', 'protocolVersion', 'schemaVersion', 'sha256',
  ])) return undefined
  const expectedMachine = record.arch === 'x64' ? 0x8664 : record.arch === 'arm64' ? 0xaa64 : undefined
  if (!expectedMachine || record.schemaVersion !== 1 || record.protocolVersion !== PROTOCOL_VERSION
    || record.fileName !== 'arkdown-workspace-commit.exe'
    || !Number.isSafeInteger(record.bytes) || (record.bytes as number) <= 0 || (record.bytes as number) > MAX_HELPER_BYTES
    || typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)
    || record.peMachine !== expectedMachine) return undefined
  return record as unknown as WorkspaceCommitHelperTrust
}

function compiledPackagedTrustState(): {
  readonly present: boolean
  readonly trust?: WorkspaceCommitHelperTrust
} {
  try {
    if (typeof __ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__ === 'undefined'
      || __ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__ === null) return { present: false }
    return {
      present: true,
      trust: exactTrust(__ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__),
    }
  } catch {
    return { present: true }
  }
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function rejectReparseDescendants(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return false
  let current = root
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component)
    const metadata = await lstat(current)
    if (metadata.isSymbolicLink()) return false
  }
  return true
}

async function verifyHelperArtifact(
  helperPath: string,
  trustedRoot: string,
  anchoredTrust?: WorkspaceCommitHelperTrust,
): Promise<string | undefined> {
  if (!path.isAbsolute(helperPath)
    || path.basename(helperPath) !== 'arkdown-workspace-commit.exe') return undefined
  try {
    const lexicalRoot = path.resolve(trustedRoot)
    const lexicalHelper = path.resolve(helperPath)
    const manifestPath = path.join(path.dirname(lexicalHelper), 'manifest.json')
    if (!contained(lexicalRoot, lexicalHelper) || !contained(lexicalRoot, manifestPath)
      || !await rejectReparseDescendants(lexicalRoot, lexicalHelper)
      || !await rejectReparseDescendants(lexicalRoot, manifestPath)) return undefined
    const metadata = await lstat(helperPath)
    const manifestMetadata = await lstat(manifestPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size <= 0 || metadata.size > MAX_HELPER_BYTES
      || !manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()
      || manifestMetadata.size <= 0 || manifestMetadata.size > MAX_MANIFEST_BYTES) return undefined
    const [canonical, canonicalManifest, bytes, manifestBytes] = await Promise.all([
      realpath(helperPath),
      realpath(manifestPath),
      readFile(helperPath),
      readFile(manifestPath),
    ])
    const canonicalRoot = await realpath(lexicalRoot)
    if (!contained(canonicalRoot, canonical) || !contained(canonicalRoot, canonicalManifest)
      || path.basename(canonical) !== 'arkdown-workspace-commit.exe'
      || path.basename(canonicalManifest) !== 'manifest.json'
      || path.dirname(canonical) !== path.dirname(canonicalManifest)) return undefined
    const manifest = exactTrust(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)))
    if (!manifest) return undefined
    const runtimeArch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : undefined
    const expectedMachine = runtimeArch === 'x64' ? 0x8664 : runtimeArch === 'arm64' ? 0xaa64 : undefined
    if (!runtimeArch || manifest.arch !== runtimeArch
      || manifest.bytes !== bytes.byteLength || manifest.bytes !== metadata.size
      || manifest.peMachine !== expectedMachine || peMachine(bytes) !== expectedMachine
      || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) return undefined
    if (anchoredTrust && JSON.stringify(manifest) !== JSON.stringify(anchoredTrust)) return undefined
    return canonical
  } catch {
    return undefined
  }
}

export function resolveWorkspaceCommitHelperPath(location: WorkspaceCommitHelperLocation): string {
  if (location.arch !== 'x64' && location.arch !== 'arm64') {
    throw new Error('Unsupported workspace commit helper architecture')
  }
  const trustedRoot = location.isPackaged
    ? path.resolve(location.resourcesPath)
    : path.resolve(location.appPath, '.components')
  const relative = location.isPackaged
    ? path.join('native', 'workspace-commit', location.arch, 'arkdown-workspace-commit.exe')
    : path.join('workspace-commit', location.arch, 'arkdown-workspace-commit.exe')
  const resolved = path.resolve(trustedRoot, relative)
  const containment = path.relative(trustedRoot, resolved)
  if (!containment || containment.startsWith('..') || path.isAbsolute(containment)) {
    throw new Error('Invalid workspace commit helper location')
  }
  return resolved
}

function requestPayload(request: WorkspaceAiCommitRequest): Record<string, unknown> {
  const common = {
    kind: request.kind,
    root: request.root,
    parents: request.parents,
  }
  switch (request.kind) {
    case 'edit':
      return {
        ...common,
        source: request.source,
        contentBase64: request.bytes.toString('base64'),
      }
    case 'create':
      return {
        ...common,
        destination: request.destination,
        contentBase64: request.bytes.toString('base64'),
      }
    case 'rename':
      return { ...common, source: request.source, destination: request.destination }
    case 'recycle':
      return { ...common, source: request.source }
  }
}

function frameRequest(request: Record<string, unknown> | DocumentReplacementRequest, requestId: string, command: string): Buffer | undefined {
  const json = JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    command,
    request,
  })
  const payload = Buffer.from(json, 'utf8')
  if (payload.byteLength > MAX_REQUEST_FRAME_BYTES) return undefined
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE(payload.byteLength)
  return Buffer.concat([header, payload])
}

function parseExactHelperResponse(
  frame: Buffer,
  requestId: string,
  requestKind: WorkspaceAiCommitRequest['kind'],
): WorkspaceAiCommitOutcome | undefined {
  if (frame.byteLength < 4 || frame.byteLength > MAX_RESPONSE_BYTES) return undefined
  const declared = frame.readUInt32LE(0)
  if (declared !== frame.byteLength - 4 || declared === 0) return undefined
  let payload: string
  try {
    payload = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4))
  } catch {
    return undefined
  }
  const prefix = `{"protocolVersion":1,"requestId":"${requestId}","status":"`
  if (payload === `${prefix}committed"}`) {
    return requestKind === 'recycle'
      ? Object.freeze({ status: 'unknown', reason: 'shell_result_unverifiable' })
      : Object.freeze({ status: 'committed' })
  }
  if (requestKind === 'recycle' && payload === `${prefix}rejected","reason":"recycle-unavailable"}`) {
    return Object.freeze({ status: 'rejected', reason: 'recycle-unavailable' })
  }
  for (const reason of REJECTED_REASONS) {
    if (payload === `${prefix}rejected","reason":"${reason}"}`) {
      return Object.freeze({ status: 'rejected', reason })
    }
  }
  for (const reason of HELPER_UNKNOWN_REASONS) {
    if (payload === `${prefix}unknown","reason":"${reason}"}`) {
      return Object.freeze({ status: 'unknown', reason })
    }
  }
  return undefined
}

function generatedUnknown(reason: 'helper_crash' | 'malformed_response' | 'output_limit' | 'timeout'): WorkspaceAiCommitOutcome {
  return Object.freeze({ status: 'unknown', reason })
}

export class WindowsWorkspaceCommitProcessAdapter implements WindowsWorkspaceCommitAdapter {
  private readonly processFactory: WorkspaceCommitProcessFactory
  private readonly nextRequestId: () => string
  private readonly timeoutMs: number

  constructor(private readonly options: WindowsWorkspaceCommitProcessOptions) {
    this.processFactory = options.processFactory ?? defaultProcessFactory
    this.nextRequestId = options.requestId ?? randomUUID
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new Error('Invalid workspace commit helper timeout')
    }
    if ((options.location === undefined) === (options.developmentHelperPath === undefined)) {
      throw new Error('Exactly one workspace commit helper location is required')
    }
  }

  async commit(request: WorkspaceAiCommitRequest): Promise<WorkspaceAiCommitOutcome> {
    return this.execute(requestPayload(request), 'commit', request.kind)
  }

  async replaceDocumentFile(request: DocumentReplacementRequest): Promise<void> {
    const outcome = await this.execute(request, 'replace-document', 'edit')
    if (outcome.status === 'committed') return
    if (outcome.status === 'rejected' && outcome.reason === 'source-changed') throw new DocumentConflictError()
    // Never fall back to rename or in-place writing after a failed/uncertain replacement.
    throw new Error(`Document replacement ${outcome.status}: ${outcome.reason}`)
  }

  private async execute(
    request: Record<string, unknown> | DocumentReplacementRequest,
    command: 'commit' | 'replace-document',
    requestKind: WorkspaceAiCommitRequest['kind'],
  ): Promise<WorkspaceAiCommitOutcome> {
    let requestedPath: string | undefined
    let trustedRoot: string | undefined
    let anchoredTrust: WorkspaceCommitHelperTrust | undefined
    const bundledTrustState = compiledPackagedTrustState()
    const bundledTrust = bundledTrustState.trust
    // Once the main bundle contains packaged trust, every development resolver
    // is a forbidden downgrade even if a caller can construct these options.
    if (bundledTrustState.present && (!this.options.location || !this.options.location.isPackaged)) {
      return { status: 'rejected', reason: 'unsupported' }
    }
    if (this.options.location) {
      requestedPath = resolveWorkspaceCommitHelperPath(this.options.location)
      trustedRoot = this.options.location.isPackaged
        ? path.resolve(this.options.location.resourcesPath)
        : path.resolve(this.options.location.appPath, '.components')
      anchoredTrust = this.options.location.isPackaged ? bundledTrust : undefined
      if (this.options.location.isPackaged && (!anchoredTrust || anchoredTrust.arch !== this.options.location.arch)) {
        return { status: 'rejected', reason: 'unsupported' }
      }
    } else if (this.options.developmentHelperPath) {
      requestedPath = path.resolve(this.options.developmentHelperPath)
      trustedRoot = path.dirname(requestedPath)
    }
    if (!requestedPath || !trustedRoot) return { status: 'rejected', reason: 'unsupported' }
    const helperPath = await verifyHelperArtifact(requestedPath, trustedRoot, anchoredTrust)
    if (!helperPath) return { status: 'rejected', reason: 'unsupported' }
    const requestId = this.nextRequestId()
    if (!REQUEST_ID.test(requestId)) return { status: 'rejected', reason: 'unsupported' }
    const input = frameRequest(request, requestId, command)
    if (!input) return { status: 'rejected', reason: 'unsupported' }

    let child: WorkspaceCommitChildProcess
    for (let attempt = 0; ; attempt++) {
      try {
        child = this.processFactory(helperPath, ['--stdio-json-v1'], {
          shell: false,
          windowsHide: true,
          cwd: path.dirname(helperPath),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: minimalEnvironment(),
        })
        break
      } catch (error) {
        const delay = SPAWN_BUSY_RETRY_DELAYS_MS[attempt]
        if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EBUSY'
          || (error as NodeJS.ErrnoException).syscall !== 'spawn' || delay === undefined) {
          return { status: 'rejected', reason: 'unsupported' }
        }
        // A synchronous spawn EBUSY leaves no child and sends no request. Retry
        // only this launch boundary; a returned child keeps the existing lifecycle.
        await new Promise<void>((resolve) => setTimeout(resolve, delay))
        if (await verifyHelperArtifact(requestedPath, trustedRoot, anchoredTrust) !== helperPath) {
          return { status: 'rejected', reason: 'unsupported' }
        }
      }
    }

    return await new Promise<WorkspaceAiCommitOutcome>((resolve) => {
      let started = false
      let settled = false
      let pendingTerminal: WorkspaceAiCommitOutcome | undefined
      let requestReleased = false
      let overflow = false
      const stdout: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      const settle = (outcome: WorkspaceAiCommitOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
      }
      const requestTermination = (outcome: WorkspaceAiCommitOutcome) => {
        if (pendingTerminal) return
        pendingTerminal = outcome
        try { child.kill('SIGKILL') } catch { /* close remains the only lease-release boundary */ }
      }
      const timeoutMs = command === 'replace-document' ? this.options.timeoutMs ?? DOCUMENT_TIMEOUT_MS : this.timeoutMs
      const timer = setTimeout(() => requestTermination(generatedUnknown('timeout')), timeoutMs)

      child.once('spawn', () => {
        started = true
        // This recheck narrows ordinary replacement, but pure Node cannot bind
        // these bytes to the image already mapped by the child process. The
        // packaged path therefore also relies on the installation/resources ACL.
        void verifyHelperArtifact(requestedPath, trustedRoot, anchoredTrust).then((reverified) => {
          if (settled || pendingTerminal) return
          if (reverified !== helperPath) {
            requestTermination({ status: 'rejected', reason: 'unsupported' })
            return
          }
          requestReleased = true
          child.stdin.end(input)
        }, () => requestTermination({ status: 'rejected', reason: 'unsupported' }))
      })
      child.once('error', () => {
        if (started) requestTermination(generatedUnknown('helper_crash'))
        else settle({ status: 'rejected', reason: 'unsupported' })
      })
      child.stdout.on('data', (chunk: Buffer | string) => {
        const bytes = Buffer.from(chunk)
        stdoutBytes += bytes.byteLength
        if (stdoutBytes > MAX_RESPONSE_BYTES) {
          overflow = true
          requestTermination(generatedUnknown('output_limit'))
          return
        }
        stdout.push(bytes)
      })
      child.stdout.on('error', () => {
        requestTermination(generatedUnknown('helper_crash'))
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > MAX_RESPONSE_BYTES) {
          overflow = true
          requestTermination(generatedUnknown('output_limit'))
        }
      })
      child.stderr.on('error', () => {
        requestTermination(generatedUnknown('helper_crash'))
      })
      child.stdin.on('error', () => {
        if (started) requestTermination(generatedUnknown('helper_crash'))
      })
      child.once('close', (code) => {
        if (settled) return
        if (pendingTerminal) return settle(pendingTerminal)
        if (!requestReleased) return settle({ status: 'rejected', reason: 'unsupported' })
        if (overflow) return settle(generatedUnknown('output_limit'))
        if (!started) return settle({ status: 'rejected', reason: 'unsupported' })
        if (code !== 0) return settle(generatedUnknown('helper_crash'))
        const parsed = parseExactHelperResponse(Buffer.concat(stdout), requestId, requestKind)
        settle(parsed ?? generatedUnknown('malformed_response'))
      })
    })
  }
}
