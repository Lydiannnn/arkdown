import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceAiCommitRequest } from '../../src/main/workspace/workspace-ai-file-service'
import {
  WindowsWorkspaceCommitProcessAdapter,
  resolveWorkspaceCommitHelperPath,
  type WorkspaceCommitChildProcess,
  type WorkspaceCommitProcessFactory,
} from '../../src/main/workspace/windows-workspace-commit-process'

const roots: string[] = []
const requestId = '11111111-1111-4111-8111-111111111111'

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fakePe(machine: number): Buffer {
  const bytes = Buffer.alloc(512)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.write('PE\0\0', 0x80, 'binary')
  bytes.writeUInt16LE(machine, 0x84)
  return bytes
}

async function helperFile(options: {
  readonly mutateBytesAfterManifest?: boolean
  readonly manifestExtra?: boolean
  readonly oversizedManifest?: boolean
  readonly wrongArch?: boolean
} = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-commit-process-'))
  roots.push(root)
  const helper = path.join(root, 'arkdown-workspace-commit.exe')
  const runtimeArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const manifestArch = options.wrongArch ? (runtimeArch === 'x64' ? 'arm64' : 'x64') : runtimeArch
  const machine = manifestArch === 'x64' ? 0x8664 : 0xaa64
  const bytes = fakePe(machine)
  await writeFile(helper, bytes)
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    protocolVersion: 1,
    arch: manifestArch,
    fileName: 'arkdown-workspace-commit.exe',
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    peMachine: machine,
    ...(options.manifestExtra ? { extra: true } : {}),
  }) + (options.oversizedManifest ? ' '.repeat(5 * 1024) : ''))
  if (options.mutateBytesAfterManifest) await writeFile(helper, Buffer.concat([bytes, Buffer.from('tampered')]))
  return helper
}

async function packagedTrust(helperPath: string) {
  return JSON.parse(await readFile(path.join(path.dirname(helperPath), 'manifest.json'), 'utf8'))
}

function editRequest(bytes = Buffer.from('# edited')): Extract<WorkspaceAiCommitRequest, { kind: 'edit' }> {
  return {
    kind: 'edit',
    root: {
      rootFinalPath: 'C:\\workspace',
      activationEpoch: 9,
      rootVolumeSerial: 'abcd1234',
      rootFileId: '100',
    },
    source: {
      absolutePath: 'C:\\workspace\\notes\\a.md',
      relativePath: 'notes/a.md',
      fileId: 'abcd1234.200',
      size: 3,
      mtimeMs: 123,
      ctimeNs: '456000000',
      revision: 'a'.repeat(64),
    },
    parents: [{
      absolutePath: 'C:\\workspace\\notes',
      relativePath: 'notes',
      fileId: 'abcd1234.150',
    }],
    bytes,
  }
}

function recycleRequest(): Extract<WorkspaceAiCommitRequest, { kind: 'recycle' }> {
  const edit = editRequest()
  return {
    kind: 'recycle',
    root: edit.root,
    source: edit.source,
    parents: edit.parents,
  }
}

class CapturingStdin extends Writable {
  readonly chunks: Buffer[] = []

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }
}

class FakeChild extends EventEmitter implements WorkspaceCommitChildProcess {
  readonly stdin = new CapturingStdin()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => true)
}

function framed(payload: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(bytes.byteLength)
  return Buffer.concat([header, bytes])
}

function committedResponse(id = requestId): Buffer {
  return framed(`{"protocolVersion":1,"requestId":"${id}","status":"committed"}`)
}

function spawnBusyError(): Error {
  return Object.assign(new Error('spawn EBUSY'), { code: 'EBUSY', errno: -4082, syscall: 'spawn' })
}

function attemptSignal() {
  let reached!: () => void
  const pending = new Promise<void>((resolve) => { reached = resolve })
  return { pending, reached }
}

function respondingFactory(
  response: Buffer,
  options: { exitCode?: number; stderr?: Buffer; afterSpawn?: (child: FakeChild) => void } = {},
): { child: FakeChild; factory: WorkspaceCommitProcessFactory } {
  const child = new FakeChild()
  const factory = vi.fn(() => {
    queueMicrotask(() => {
      child.emit('spawn')
      child.stdin.once('finish', () => {
        options.afterSpawn?.(child)
        if (options.stderr) child.stderr.end(options.stderr)
        else child.stderr.end()
        child.stdout.end(response)
        child.emit('close', options.exitCode ?? 0, null)
      })
    })
    return child
  })
  return { child, factory }
}

describe('Windows workspace commit helper process boundary', () => {
  it('retries only unstarted busy launches after 100, 200 and 400 ms and sends one unchanged frame', async () => {
    const helperPath = await helperFile()
    const { child, factory: successfulFactory } = respondingFactory(committedResponse())
    const signals = Array.from({ length: 4 }, attemptSignal)
    let attempts = 0
    const factory = vi.fn<WorkspaceCommitProcessFactory>((...args) => {
      signals[attempts++].reached()
      if (attempts < 4) throw spawnBusyError()
      return successfulFactory(...args)
    })
    const nextRequestId = vi.fn(() => requestId)
    vi.useFakeTimers()
    const request = editRequest()
    const pending = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath, processFactory: factory, requestId: nextRequestId,
    }).commit(request)

    await signals[0].pending
    // Queued input must remain the initial snapshot throughout launch retries.
    request.bytes.fill(0)
    for (const [index, delay] of [100, 200, 400].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(factory).toHaveBeenCalledTimes(index + 1)
      expect(child.stdin.chunks).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      await Promise.race([signals[index + 1].pending, pending])
      expect(factory).toHaveBeenCalledTimes(index + 2)
    }
    await expect(pending).resolves.toEqual({ status: 'committed' })
    expect(nextRequestId).toHaveBeenCalledTimes(1)
    expect(child.stdin.chunks).toHaveLength(1)
    const input = Buffer.concat(child.stdin.chunks)
    expect(input.readUInt32LE(0)).toBe(input.byteLength - 4)
    expect(JSON.parse(input.subarray(4).toString())).toMatchObject({
      requestId, command: 'commit', request: { contentBase64: 'IyBlZGl0ZWQ=' },
    })
  })

  it('fails closed after four busy launches without changing the pending document bytes', async () => {
    const helperPath = await helperFile()
    const destinationPath = path.join(path.dirname(helperPath), 'note.md')
    const temporaryPath = path.join(path.dirname(helperPath), '.note.md.pending.tmp')
    await writeFile(destinationPath, 'original')
    await writeFile(temporaryPath, 'replacement')
    const signals = Array.from({ length: 4 }, attemptSignal)
    let attempts = 0
    const factory = vi.fn(() => {
      signals[attempts++].reached()
      throw spawnBusyError()
    })
    vi.useFakeTimers()
    const pending = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath, processFactory: factory, requestId: () => requestId,
    }).replaceDocumentFile({
      destinationPath, temporaryPath, destinationIdentity: '1.2', temporaryIdentity: '1.3',
      expectedRevision: 'a'.repeat(64), replacementRevision: 'b'.repeat(64),
    })
    const outcome = pending.then(() => undefined, (error: unknown) => error)
    await signals[0].pending
    for (const [index, delay] of [100, 200, 400].entries()) {
      await vi.advanceTimersByTimeAsync(delay)
      await Promise.race([signals[index + 1].pending, outcome])
      expect(factory).toHaveBeenCalledTimes(index + 2)
    }
    expect(await outcome).toEqual(new Error('Document replacement rejected: unsupported'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(factory).toHaveBeenCalledTimes(4)
    expect(await readFile(destinationPath, 'utf8')).toBe('original')
    expect(await readFile(temporaryPath, 'utf8')).toBe('replacement')
  })

  it('rechecks anchored helper trust after a busy delay before attempting another launch', async () => {
    const packageRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-packaged-busy-'))
    roots.push(packageRoot)
    const original = await helperFile()
    const trust = await packagedTrust(original)
    const helperRoot = path.join(packageRoot, 'native', 'workspace-commit', trust.arch)
    await mkdir(helperRoot, { recursive: true })
    const helperPath = path.join(helperRoot, 'arkdown-workspace-commit.exe')
    await writeFile(helperPath, await readFile(original))
    await writeFile(path.join(helperRoot, 'manifest.json'), JSON.stringify(trust))
    vi.stubGlobal('__ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__', trust)
    const signal = attemptSignal()
    const factory = vi.fn(() => { signal.reached(); throw spawnBusyError() })
    vi.useFakeTimers()
    const pending = new WindowsWorkspaceCommitProcessAdapter({
      location: { isPackaged: true, resourcesPath: packageRoot, appPath: 'C:\\ignored', arch: trust.arch },
      processFactory: factory, requestId: () => requestId,
    }).commit(editRequest())
    await signal.pending
    const replacement = Buffer.concat([fakePe(trust.peMachine), Buffer.from('changed while busy')])
    await writeFile(helperPath, replacement)
    await writeFile(path.join(helperRoot, 'manifest.json'), JSON.stringify({
      ...trust, bytes: replacement.byteLength, sha256: createHash('sha256').update(replacement).digest('hex'),
    }))
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toEqual({ status: 'rejected', reason: 'unsupported' })
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it.each([
    { code: 'EACCES', syscall: 'spawn' },
    { code: 'ENOENT', syscall: 'spawn' },
    { code: 'EBUSY', syscall: 'open' },
    { code: 'EBUSY' },
  ])('does not retry a synchronous launch error outside spawn EBUSY: %j', async (details) => {
    const helperPath = await helperFile()
    const factory = vi.fn(() => { throw Object.assign(new Error('launch failed'), details) })
    vi.useFakeTimers()
    await expect(new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath, processFactory: factory, requestId: () => requestId,
    }).commit(editRequest())).resolves.toEqual({ status: 'rejected', reason: 'unsupported' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('never retries an emitted busy error after the child is returned (spawned: %s)', async (spawned) => {
    const helperPath = await helperFile()
    const child = new FakeChild()
    const factory = vi.fn(() => {
      queueMicrotask(() => {
        if (spawned) child.emit('spawn')
        child.emit('error', spawnBusyError())
        child.emit('close', 1, null)
      })
      return child
    })
    vi.useFakeTimers()
    await expect(new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath, processFactory: factory, requestId: () => requestId,
    }).commit(editRequest())).resolves.toEqual(spawned
      ? { status: 'unknown', reason: 'helper_crash' }
      : { status: 'rejected', reason: 'unsupported' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(child.stdin.chunks).toHaveLength(0)
  })

  it.each([
    { status: 'rejected', reason: 'unsupported' },
    { status: 'unknown', reason: 'commit_verification_failed' },
  ])('does not relaunch after a native helper outcome: %j', async (outcome) => {
    const helperPath = await helperFile()
    const { child, factory } = respondingFactory(framed(JSON.stringify({ protocolVersion: 1, requestId, ...outcome })))
    vi.useFakeTimers()
    await expect(new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath, processFactory: factory, requestId: () => requestId,
    }).commit(editRequest())).resolves.toEqual(outcome)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(child.stdin.chunks).toHaveLength(1)
  })

  it('sends one bounded frame over stdin with no document data or paths in process arguments', async () => {
    const helperPath = await helperFile()
    const { child, factory } = respondingFactory(committedResponse())
    const adapter = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath,
      processFactory: factory,
      requestId: () => requestId,
    })

    await expect(adapter.commit(editRequest())).resolves.toEqual({ status: 'committed' })

    expect(factory).toHaveBeenCalledWith(helperPath, ['--stdio-json-v1'], expect.objectContaining({
      shell: false,
      windowsHide: true,
      cwd: path.dirname(helperPath),
      stdio: ['pipe', 'pipe', 'pipe'],
    }))
    const commandText = JSON.stringify((factory as ReturnType<typeof vi.fn>).mock.calls[0])
    expect(commandText).not.toContain('# edited')
    expect(commandText).not.toContain('notes/a.md')
    const input = Buffer.concat(child.stdin.chunks)
    expect(input.readUInt32LE(0)).toBe(input.byteLength - 4)
    expect(JSON.parse(input.subarray(4).toString('utf8'))).toEqual({
      protocolVersion: 1,
      requestId,
      command: 'commit',
      request: {
        kind: 'edit',
        root: editRequest().root,
        source: editRequest().source,
        parents: editRequest().parents,
        contentBase64: Buffer.from('# edited').toString('base64'),
      },
    })
  })

  it('fails closed before spawn when the controlled helper artifact is missing', async () => {
    const factory = vi.fn() as unknown as WorkspaceCommitProcessFactory
    const adapter = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: path.join(tmpdir(), 'missing-arkdown-workspace-commit.exe'),
      processFactory: factory,
      requestId: () => requestId,
    })

    await expect(adapter.commit(editRequest())).resolves.toEqual({
      status: 'rejected', reason: 'unsupported',
    })
    expect(factory).not.toHaveBeenCalled()
  })

  it.each([
    ['tampered helper hash/size', { mutateBytesAfterManifest: true }],
    ['wrong helper architecture', { wrongArch: true }],
    ['extra manifest field', { manifestExtra: true }],
    ['oversized manifest', { oversizedManifest: true }],
  ] as const)('fails closed before spawn for %s', async (_label, options) => {
    const helperPath = await helperFile(options)
    const factory = vi.fn() as unknown as WorkspaceCommitProcessFactory
    const adapter = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath,
      processFactory: factory,
      requestId: () => requestId,
    })

    await expect(adapter.commit(editRequest())).resolves.toEqual({ status: 'rejected', reason: 'unsupported' })
    expect(factory).not.toHaveBeenCalled()
  })

  it('anchors a packaged helper to the main-bundle trust record instead of a replaceable adjacent manifest', async () => {
    const packageRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-packaged-helper-'))
    roots.push(packageRoot)
    const helperRoot = path.join(packageRoot, 'native', 'workspace-commit', process.arch === 'arm64' ? 'arm64' : 'x64')
    await mkdir(helperRoot, { recursive: true })
    const original = await helperFile()
    const trust = await packagedTrust(original)
    const helperPath = path.join(helperRoot, 'arkdown-workspace-commit.exe')
    const replacement = Buffer.concat([fakePe(trust.peMachine), Buffer.from('self-consistent replacement')])
    await writeFile(helperPath, replacement)
    await writeFile(path.join(helperRoot, 'manifest.json'), JSON.stringify({
      ...trust,
      bytes: replacement.byteLength,
      sha256: createHash('sha256').update(replacement).digest('hex'),
    }))
    const factory = vi.fn() as unknown as WorkspaceCommitProcessFactory
    vi.stubGlobal('__ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__', trust)

    await expect(new WindowsWorkspaceCommitProcessAdapter({
      location: {
        isPackaged: true,
        resourcesPath: packageRoot,
        appPath: 'C:\\ignored',
        arch: trust.arch,
      },
      processFactory: factory,
      requestId: () => requestId,
    }).commit(editRequest())).resolves.toEqual({ status: 'rejected', reason: 'unsupported' })
    expect(factory).not.toHaveBeenCalled()
  })

  it.each([
    ['a direct development helper path', (helperPath: string, trust: Awaited<ReturnType<typeof packagedTrust>>) => ({
      developmentHelperPath: helperPath,
      processFactory: vi.fn() as unknown as WorkspaceCommitProcessFactory,
      requestId: () => requestId,
      trust,
    })],
  ] as const)('rejects %s when compiled packaged trust exists', async (_label, makeOptions) => {
    const helperPath = await helperFile()
    const trust = await packagedTrust(helperPath)
    const options = makeOptions(helperPath, trust)
    vi.stubGlobal('__ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__', options.trust)
    const { trust: _trust, ...adapterOptions } = options

    await expect(new WindowsWorkspaceCommitProcessAdapter(adapterOptions).commit(editRequest()))
      .resolves.toEqual({ status: 'rejected', reason: 'unsupported' })
    expect(adapterOptions.processFactory).not.toHaveBeenCalled()
  })

  it('rejects a valid non-packaged resolver when compiled packaged trust exists', async () => {
    const original = await helperFile()
    const trust = await packagedTrust(original)
    const appPath = await mkdtemp(path.join(tmpdir(), 'arkdown-valid-dev-location-'))
    roots.push(appPath)
    const helperRoot = path.join(appPath, '.components', 'workspace-commit', trust.arch)
    await mkdir(helperRoot, { recursive: true })
    await writeFile(path.join(helperRoot, 'arkdown-workspace-commit.exe'), await readFile(original))
    await writeFile(path.join(helperRoot, 'manifest.json'), JSON.stringify(trust))
    const factory = vi.fn() as unknown as WorkspaceCommitProcessFactory
    vi.stubGlobal('__ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__', trust)

    await expect(new WindowsWorkspaceCommitProcessAdapter({
      location: {
        isPackaged: false,
        resourcesPath: 'C:\\ignored',
        appPath,
        arch: trust.arch,
      },
      processFactory: factory,
      requestId: () => requestId,
    }).commit(editRequest())).resolves.toEqual({ status: 'rejected', reason: 'unsupported' })
    expect(factory).not.toHaveBeenCalled()
  })

  it('fails closed instead of downgrading when a compiled trust marker is malformed', async () => {
    const helperPath = await helperFile()
    const factory = vi.fn() as unknown as WorkspaceCommitProcessFactory
    vi.stubGlobal('__ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__', { malformed: true })

    await expect(new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath,
      processFactory: factory,
      requestId: () => requestId,
    }).commit(editRequest())).resolves.toEqual({ status: 'rejected', reason: 'unsupported' })
    expect(factory).not.toHaveBeenCalled()
  })

  it('rejects a packaged helper whose lexical trusted-root descendant escapes through a junction', async ({ skip }) => {
    const packageRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-packaged-root-'))
    const outside = await mkdtemp(path.join(tmpdir(), 'arkdown-packaged-outside-'))
    roots.push(packageRoot, outside)
    const original = await helperFile()
    const trust = await packagedTrust(original)
    const outsideRoot = path.join(outside, 'workspace-commit', trust.arch)
    await mkdir(outsideRoot, { recursive: true })
    await writeFile(path.join(outsideRoot, 'arkdown-workspace-commit.exe'), await readFile(original))
    await writeFile(path.join(outsideRoot, 'manifest.json'), JSON.stringify(trust))
    try {
      await symlink(outside, path.join(packageRoot, 'native'), 'junction')
    } catch {
      skip()
      return
    }
    const factory = vi.fn() as unknown as WorkspaceCommitProcessFactory
    vi.stubGlobal('__ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__', trust)

    await expect(new WindowsWorkspaceCommitProcessAdapter({
      location: {
        isPackaged: true,
        resourcesPath: packageRoot,
        appPath: 'C:\\ignored',
        arch: trust.arch,
      },
      processFactory: factory,
      requestId: () => requestId,
    }).commit(editRequest())).resolves.toEqual({ status: 'rejected', reason: 'unsupported' })
    expect(factory).not.toHaveBeenCalled()
  })

  it('reverifies the packaged artifact after spawn and before releasing the mutation request', async () => {
    const packageRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-packaged-spawn-barrier-'))
    roots.push(packageRoot)
    const original = await helperFile()
    const trust = await packagedTrust(original)
    const helperRoot = path.join(packageRoot, 'native', 'workspace-commit', trust.arch)
    await mkdir(helperRoot, { recursive: true })
    const helperPath = path.join(helperRoot, 'arkdown-workspace-commit.exe')
    await writeFile(helperPath, await readFile(original))
    await writeFile(path.join(helperRoot, 'manifest.json'), JSON.stringify(trust))
    vi.stubGlobal('__ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__', trust)
    const child = new FakeChild()
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'))
      return true
    })
    const replacement = Buffer.concat([fakePe(trust.peMachine), Buffer.from('spawn-boundary replacement')])
    const factory = vi.fn(() => {
      writeFileSync(helperPath, replacement)
      writeFileSync(path.join(helperRoot, 'manifest.json'), JSON.stringify({
        ...trust,
        bytes: replacement.byteLength,
        sha256: createHash('sha256').update(replacement).digest('hex'),
      }))
      queueMicrotask(() => child.emit('spawn'))
      return child
    })

    await expect(new WindowsWorkspaceCommitProcessAdapter({
      location: {
        isPackaged: true,
        resourcesPath: packageRoot,
        appPath: 'C:\\ignored',
        arch: trust.arch,
      },
      processFactory: factory,
      requestId: () => requestId,
    }).commit(editRequest())).resolves.toEqual({ status: 'rejected', reason: 'unsupported' })
    expect(child.stdin.chunks).toHaveLength(0)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it.each([
    ['duplicate response key', framed(`{"protocolVersion":1,"requestId":"${requestId}","status":"unknown","status":"committed","reason":"helper_crash"}`)],
    ['request id mismatch', committedResponse('22222222-2222-4222-8222-222222222222')],
    ['extra response field', framed(`{"protocolVersion":1,"requestId":"${requestId}","status":"committed","extra":true}`)],
    ['invalid utf8', framed(Buffer.from([0xc3, 0x28]))],
    ['truncated frame', Buffer.from([20, 0, 0, 0, 123])],
    ['trailing bytes', Buffer.concat([committedResponse(), Buffer.from('x')])],
  ])('maps a started helper with %s to unknown', async (_label, response) => {
    const helperPath = await helperFile()
    const { factory } = respondingFactory(response)
    const adapter = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath,
      processFactory: factory,
      requestId: () => requestId,
    })

    await expect(adapter.commit(editRequest())).resolves.toEqual({
      status: 'unknown', reason: 'malformed_response',
    })
  })

  it('never accepts committed from a helper for recycle', async () => {
    const helperPath = await helperFile()
    const { factory } = respondingFactory(committedResponse())
    const adapter = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath,
      processFactory: factory,
      requestId: () => requestId,
    })

    await expect(adapter.commit(recycleRequest())).resolves.toEqual({
      status: 'unknown', reason: 'shell_result_unverifiable',
    })
  })

  it('caps helper output and classifies overflow as unknown', async () => {
    const helperPath = await helperFile()
    const oversized = Buffer.alloc(16 * 1024 + 5, 0x61)
    const { factory } = respondingFactory(oversized)
    const adapter = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath,
      processFactory: factory,
      requestId: () => requestId,
    })

    await expect(adapter.commit(editRequest())).resolves.toEqual({
      status: 'unknown', reason: 'output_limit',
    })
  })

  it('kills a timed-out started helper and never reports a rejection', async () => {
    const helperPath = await helperFile()
    vi.useFakeTimers()
    const child = new FakeChild()
    const factory = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    const adapter = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath,
      processFactory: factory,
      requestId: () => requestId,
      timeoutMs: 50,
    })

    const pending = adapter.commit(editRequest())
    let resolved = false
    void pending.then(() => { resolved = true })
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(51)
    await Promise.resolve()
    expect(resolved).toBe(false)
    child.emit('close', null, 'SIGTERM')

    await expect(pending).resolves.toEqual({ status: 'unknown', reason: 'timeout' })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('keeps timeout pending until close even when kill reports failure', async () => {
    const helperPath = await helperFile()
    vi.useFakeTimers()
    const child = new FakeChild()
    child.kill.mockReturnValue(false)
    const factory = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    const pending = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath, processFactory: factory, requestId: () => requestId, timeoutMs: 50,
    }).commit(editRequest())
    let resolved = false
    void pending.then(() => { resolved = true })
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(51)
    await Promise.resolve()
    expect(resolved).toBe(false)
    child.emit('close', 1, null)
    await expect(pending).resolves.toEqual({ status: 'unknown', reason: 'timeout' })
  })

  it('distinguishes a pre-spawn launch failure from a post-spawn crash', async () => {
    const helperPath = await helperFile()
    const before = new FakeChild()
    const beforeFactory = vi.fn(() => {
      queueMicrotask(() => before.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })))
      return before
    })
    const after = new FakeChild()
    const afterFactory = vi.fn(() => {
      queueMicrotask(() => {
        after.emit('spawn')
        after.emit('error', new Error('crash'))
        after.emit('close', 1, null)
      })
      return after
    })

    await expect(new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath, processFactory: beforeFactory, requestId: () => requestId,
    }).commit(editRequest())).resolves.toEqual({ status: 'rejected', reason: 'unsupported' })
    await expect(new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath, processFactory: afterFactory, requestId: () => requestId,
    }).commit(editRequest())).resolves.toEqual({ status: 'unknown', reason: 'helper_crash' })
  })

  it('keeps a post-spawn error pending until the child really closes', async () => {
    const helperPath = await helperFile()
    const child = new FakeChild()
    const factory = vi.fn(() => {
      queueMicrotask(() => {
        child.emit('spawn')
        child.emit('error', new Error('post-spawn error'))
      })
      return child
    })
    const pending = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath, processFactory: factory, requestId: () => requestId,
    }).commit(editRequest())
    let resolved = false
    void pending.then(() => { resolved = true })
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'))
    await Promise.resolve()
    expect(resolved).toBe(false)
    child.emit('close', 1, null)
    await expect(pending).resolves.toEqual({ status: 'unknown', reason: 'helper_crash' })
  })

  it.each(['stdout', 'stderr'] as const)('keeps a %s stream error close-gated and terminal unknown', async (stream) => {
    const helperPath = await helperFile()
    const child = new FakeChild()
    const factory = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    const pending = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath,
      processFactory: factory,
      requestId: () => requestId,
    }).commit(editRequest())
    let resolved = false
    void pending.then(() => { resolved = true })
    await vi.waitFor(() => expect(child.stdin.chunks.length).toBeGreaterThan(0))

    child[stream].emit('error', new Error(`${stream} failed`))

    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGKILL'))
    await Promise.resolve()
    expect(resolved).toBe(false)
    child.emit('close', 1, null)
    await expect(pending).resolves.toEqual({ status: 'unknown', reason: 'helper_crash' })
  })

  it('requires a clean zero exit even if stdout looks committed', async () => {
    const helperPath = await helperFile()
    const { factory } = respondingFactory(committedResponse(), { exitCode: 3 })
    const adapter = new WindowsWorkspaceCommitProcessAdapter({
      developmentHelperPath: helperPath, processFactory: factory, requestId: () => requestId,
    })

    await expect(adapter.commit(editRequest())).resolves.toEqual({
      status: 'unknown', reason: 'helper_crash',
    })
  })

  it('resolves only the controlled packaged and development artifact locations', () => {
    expect(resolveWorkspaceCommitHelperPath({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\Arkdown\\resources',
      appPath: 'C:\\source\\Arkdown',
      arch: 'x64',
    })).toBe(path.resolve('C:\\Program Files\\Arkdown\\resources', 'native', 'workspace-commit', 'x64', 'arkdown-workspace-commit.exe'))
    expect(resolveWorkspaceCommitHelperPath({
      isPackaged: false,
      resourcesPath: 'C:\\ignored',
      appPath: 'C:\\source\\Arkdown',
      arch: 'arm64',
    })).toBe(path.resolve('C:\\source\\Arkdown', '.components', 'workspace-commit', 'arm64', 'arkdown-workspace-commit.exe'))
    expect(() => resolveWorkspaceCommitHelperPath({
      isPackaged: false,
      resourcesPath: 'C:\\ignored',
      appPath: 'C:\\source\\Arkdown',
      arch: 'ia32' as never,
    })).toThrow('Unsupported workspace commit helper architecture')
  })
})

describe('safe recycle rejection receipt', () => {
  it.each(['recycle', 'edit', 'create', 'rename'] as const)('accepts recycle-unavailable only for %s as appropriate', async kind => {
    const helperPath = await helperFile()
    const { factory } = respondingFactory(framed(`{"protocolVersion":1,"requestId":"${requestId}","status":"rejected","reason":"recycle-unavailable"}`))
    const edit = editRequest()
    const destination = { absolutePath: 'C:\\workspace\\notes\\b.md', relativePath: 'notes/b.md' }
    const request: WorkspaceAiCommitRequest = kind === 'recycle' ? recycleRequest()
      : kind === 'edit' ? edit : kind === 'rename' ? { ...recycleRequest(), kind, destination }
        : { kind, root: edit.root, parents: edit.parents, destination, bytes: edit.bytes }
    const adapter = new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: helperPath, processFactory: factory, requestId: () => requestId })
    await expect(adapter.commit(request)).resolves.toEqual(kind === 'recycle'
      ? { status: 'rejected', reason: 'recycle-unavailable' }
      : { status: 'unknown', reason: 'malformed_response' })
  })
  it.each([
    '"rejected","reason":"recycle-unavailable","extra":true',
    '"rejected","reason":"recycle-unavailable","reason":"unsupported"',
    '"unknown","reason":"recycle-unavailable"',
    '"rejected","reason":"recycle_unavailable"',
  ])('does not derive safe rejection from malformed receipt %s', async suffix => {
    const helperPath = await helperFile()
    const { factory } = respondingFactory(framed(`{"protocolVersion":1,"requestId":"${requestId}","status":${suffix}}`))
    const adapter = new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: helperPath, processFactory: factory, requestId: () => requestId })
    await expect(adapter.commit(recycleRequest())).resolves.toEqual({ status: 'unknown', reason: 'malformed_response' })
  })
})
