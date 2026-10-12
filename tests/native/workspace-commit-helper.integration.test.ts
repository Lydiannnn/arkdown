import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildWorkspaceCommitHelper } from '../../scripts/build-workspace-commit-helper'
import type { WorkspaceAiCommitRequest } from '../../src/main/workspace/workspace-ai-file-service'
import { WindowsWorkspaceCommitProcessAdapter } from '../../src/main/workspace/windows-workspace-commit-process'

const roots: string[] = []
let helperPath: string

function fileId(metadata: BigIntStats): string {
  return `${metadata.dev.toString(16)}.${metadata.ino.toString(16)}`
}

function revision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function rootFixture(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'arkdown-native-workspace-')))
  roots.push(root)
  await mkdir(path.join(root, 'notes'))
  return root
}

async function rootIdentity(root: string) {
  const metadata = await stat(root, { bigint: true })
  return {
    rootFinalPath: root,
    activationEpoch: 1,
    rootVolumeSerial: metadata.dev.toString(16),
    rootFileId: metadata.ino.toString(16),
  }
}

async function windowsFileAttributes(filePath: string, hidden = false): Promise<number> {
  const script = "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $taskInput = [Console]::In.ReadToEnd() | ConvertFrom-Json; $taskAttributes = [System.IO.File]::GetAttributes($taskInput.path); if ($taskInput.hidden) { [System.IO.File]::SetAttributes($taskInput.path, ($taskAttributes -bor [System.IO.FileAttributes]::Hidden)) }; [Console]::Out.Write([int][System.IO.File]::GetAttributes($taskInput.path))"
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
  child.stdin.end(Buffer.from(JSON.stringify({ path: filePath, hidden }), 'utf8'))
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve)
  })
  if (code !== 0) throw new Error(`Windows attribute query failed: ${Buffer.concat(stderr).toString('utf8')}`)
  const attributes = Number(Buffer.concat(stdout).toString('utf8'))
  if (!Number.isSafeInteger(attributes) || attributes < 0) throw new Error('Invalid Windows attributes')
  return attributes
}

async function directoryIdentity(root: string, relativePath: string) {
  const absolutePath = relativePath ? path.join(root, ...relativePath.split('/')) : root
  const metadata = await stat(absolutePath, { bigint: true })
  return { absolutePath, relativePath, fileId: fileId(metadata) }
}

async function sourceIdentity(root: string, relativePath: string) {
  const absolutePath = path.join(root, ...relativePath.split('/'))
  const [metadata, bytes] = await Promise.all([
    stat(absolutePath, { bigint: true }),
    readFile(absolutePath),
  ])
  return {
    absolutePath,
    relativePath,
    fileId: fileId(metadata),
    size: Number(metadata.size),
    mtimeMs: Math.trunc(Number(metadata.mtimeNs / 1_000_000n)),
    ctimeNs: String(metadata.ctimeNs),
    revision: revision(bytes),
  }
}

async function rawHelper(frame: Buffer): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  const child = spawn(helperPath, ['--stdio-json-v1'], {
    shell: false,
    windowsHide: true,
    cwd: path.dirname(helperPath),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  child.stdin.end(frame)
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
}

async function attemptMountPointReparse(
  directory: string,
  externalTarget: string,
): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  const child = spawn(helperPath, ['--test-set-mount-point-v1', directory, externalTarget], {
    shell: false,
    windowsHide: true,
    cwd: path.dirname(helperPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
}

async function barrierHelper(
  request: WorkspaceAiCommitRequest,
  barrier: string,
  environmentName = 'ARKDOWN_WORKSPACE_COMMIT_TEST_BARRIER',
): Promise<{
  readonly ready: Promise<void>
  readonly kill: () => boolean
  readonly release: () => Promise<void>
  readonly result: Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>
}> {
  await mkdir(barrier)
  const child = spawn(helperPath, ['--stdio-json-v1'], {
    shell: false,
    windowsHide: true,
    cwd: path.dirname(helperPath),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, [environmentName]: barrier },
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  child.stdin.end(framed(JSON.stringify(wireRequest(request, randomUUID()))))
  const result = new Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }))
  })
  const ready = (async () => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (await lstat(path.join(barrier, 'ready')).then(() => true, () => false)) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    child.kill('SIGKILL')
    throw new Error('native helper test barrier was not reached')
  })()
  return {
    ready,
    kill: () => child.kill('SIGKILL'),
    release: async () => { await writeFile(path.join(barrier, 'continue'), '') },
    result,
  }
}

function framed(value: Buffer | string): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.byteLength)
  return Buffer.concat([header, body])
}

function parseResponse(frame: Buffer): unknown {
  expect(frame.byteLength).toBeGreaterThan(4)
  expect(frame.readUInt32LE(0)).toBe(frame.byteLength - 4)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4)))
}

function wireRequest(request: WorkspaceAiCommitRequest, requestId: string): Record<string, unknown> {
  const common = { kind: request.kind, root: request.root, parents: request.parents }
  const body = request.kind === 'create'
    ? { ...common, destination: request.destination, contentBase64: request.bytes.toString('base64') }
    : request.kind === 'edit'
      ? { ...common, source: request.source, contentBase64: request.bytes.toString('base64') }
      : request.kind === 'rename'
        ? { ...common, source: request.source, destination: request.destination }
        : { ...common, source: request.source }
  return { protocolVersion: 1, requestId, command: 'commit', request: body }
}

beforeAll(async () => {
  if (process.platform !== 'win32') throw new Error('Windows native helper tests require Windows')
  helperPath = (await buildWorkspaceCommitHelper({
    repoRoot: path.resolve('.'), arch: process.arch === 'arm64' ? 'arm64' : 'x64', testHooks: true,
  })).executablePath
}, 120_000)

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('native workspace commit helper on NTFS', () => {
  it('rejects invalid UTF-8, duplicate keys, unknown fields, oversized frames, and escaped NULs', async () => {
    const id = randomUUID()
    const malformed = [
      framed(Buffer.from([0xc3, 0x28])),
      framed(`{"protocolVersion":1,"protocolVersion":1,"requestId":"${id}","command":"commit","request":{}}`),
      Buffer.from([1, 0, 0, 2]),
    ]
    for (const value of malformed) {
      const result = await rawHelper(value)
      expect(result.code).not.toBe(0)
      expect(result.stdout.byteLength).toBe(0)
      expect(result.stderr.byteLength).toBeLessThanOrEqual(16 * 1024)
    }

    const extra = await rawHelper(framed(
      `{"protocolVersion":1,"requestId":"${id}","command":"commit","request":{},"extra":true}`,
    ))
    expect(parseResponse(extra.stdout)).toEqual({
      protocolVersion: 1, requestId: id, status: 'rejected', reason: 'unsupported',
    })

    const root = await rootFixture()
    const request = {
      protocolVersion: 1,
      requestId: id,
      command: 'commit',
      request: {
        kind: 'create',
        root: await rootIdentity(root),
        parents: [await directoryIdentity(root, 'notes')],
        destination: { absolutePath: path.join(root, 'notes', 'bad.md'), relativePath: 'notes/bad\u0000.md' },
        contentBase64: 'eA==',
      },
    }
    const nul = await rawHelper(framed(JSON.stringify(request)))
    expect(nul.code).not.toBe(0)
    expect(nul.stdout.byteLength).toBe(0)
    await expect(lstat(path.join(root, 'notes', 'bad.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['traversal', '../outside.md'],
    ['UNC', '//server/share.md'],
    ['device', '//?/C:/device.md'],
    ['ADS', 'notes/a.md:stream'],
    ['backslash alias', 'notes\\a.md'],
  ])('rejects %s paths before mutation', async (_label, relativePath) => {
    const root = await rootFixture()
    const destination = path.join(root, 'notes', 'should-not-exist.md')
    const request: WorkspaceAiCommitRequest = {
      kind: 'create',
      root: await rootIdentity(root),
      parents: [await directoryIdentity(root, 'notes')],
      destination: { absolutePath: destination, relativePath },
      bytes: Buffer.from('unsafe'),
    }
    const outcome = await new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: helperPath }).commit(request)

    expect(outcome).toEqual({ status: 'rejected', reason: 'unsupported' })
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    'notes/CONIN$.md',
    'notes/CONOUT$.txt',
    'notes/COM¹.md',
    'notes/COM².md',
    'notes/COM³.md',
    'notes/LPT¹.txt',
    'notes/LPT².txt',
    'notes/LPT³.txt',
  ])('rejects the Windows reserved name %s in the raw protocol', async (relativePath) => {
    const root = await rootFixture()
    const request: WorkspaceAiCommitRequest = {
      kind: 'create',
      root: await rootIdentity(root),
      parents: [await directoryIdentity(root, 'notes')],
      destination: {
        absolutePath: path.join(root, ...relativePath.split('/')),
        relativePath,
      },
      bytes: Buffer.from('reserved name must be rejected'),
    }
    const id = randomUUID()

    const result = await rawHelper(framed(JSON.stringify(wireRequest(request, id))))

    expect(parseResponse(result.stdout)).toEqual({
      protocolVersion: 1,
      requestId: id,
      status: 'rejected',
      reason: 'unsupported',
    })
    expect(await readdir(path.join(root, 'notes'))).toEqual([])
  })

  it('creates with CREATE_NEW semantics, flushes bytes, and never replaces a destination', async () => {
    const root = await rootFixture()
    const adapter = new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: helperPath })
    const destination = path.join(root, 'notes', 'new.md')
    const base = {
      kind: 'create' as const,
      root: await rootIdentity(root),
      destination: { absolutePath: destination, relativePath: 'notes/new.md' },
      parents: [await directoryIdentity(root, 'notes')],
      bytes: Buffer.from('created'),
    }

    const directId = randomUUID()
    const direct = await rawHelper(framed(JSON.stringify(wireRequest(base, directId))))
    expect({ response: parseResponse(direct.stdout), diagnostic: direct.stderr.toString('utf8') }).toEqual({
      response: { protocolVersion: 1, requestId: directId, status: 'committed' },
      diagnostic: '',
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe('created')
    await expect(adapter.commit({ ...base, bytes: Buffer.from('overwrite') })).resolves.toEqual({
      status: 'rejected', reason: 'destination-exists',
    })
    await expect(readFile(destination, 'utf8')).resolves.toBe('created')
  })

  it.each(['', 'created'])('publishes a visible document for create content %j and keeps it visible through edit and rename', async content => {
    const root = await rootFixture()
    const adapter = new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: helperPath })
    const destination = path.join(root, 'notes', 'visible.md')
    await expect(adapter.commit({ kind: 'create', root: await rootIdentity(root),
      destination: { absolutePath: destination, relativePath: 'notes/visible.md' },
      parents: [await directoryIdentity(root, 'notes')], bytes: Buffer.from(content),
    })).resolves.toEqual({ status: 'committed' })
    expect((await windowsFileAttributes(destination)) & 2).toBe(0)
    expect((await windowsFileAttributes(destination)) & 32).toBe(32)
    await expect(readFile(destination, 'utf8')).resolves.toBe(content)
    await expect(adapter.commit({ kind: 'edit', root: await rootIdentity(root),
      source: await sourceIdentity(root, 'notes/visible.md'),
      parents: [await directoryIdentity(root, 'notes')], bytes: Buffer.from('updated'),
    })).resolves.toEqual({ status: 'committed' })
    const renamed = path.join(root, 'notes', 'renamed.md')
    await expect(adapter.commit({ kind: 'rename', root: await rootIdentity(root),
      source: await sourceIdentity(root, 'notes/visible.md'),
      destination: { absolutePath: renamed, relativePath: 'notes/renamed.md' },
      parents: [await directoryIdentity(root, 'notes')],
    })).resolves.toEqual({ status: 'committed' })
    expect((await windowsFileAttributes(renamed)) & 2).toBe(0)
    await expect(readFile(renamed, 'utf8')).resolves.toBe('updated')
  })

  it('preserves existing Hidden attributes through edit and rename', async () => {
    const root = await rootFixture()
    const sourcePath = path.join(root, 'notes', 'hidden.md')
    await writeFile(sourcePath, 'before')
    const originalAttributes = await windowsFileAttributes(sourcePath, true)
    expect(originalAttributes & 2).toBe(2)
    const adapter = new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: helperPath })
    await expect(adapter.commit({ kind: 'edit', root: await rootIdentity(root),
      source: await sourceIdentity(root, 'notes/hidden.md'),
      parents: [await directoryIdentity(root, 'notes')], bytes: Buffer.from('after'),
    })).resolves.toEqual({ status: 'committed' })
    expect(await windowsFileAttributes(sourcePath)).toBe(originalAttributes)
    const renamed = path.join(root, 'notes', 'still-hidden.md')
    await expect(adapter.commit({ kind: 'rename', root: await rootIdentity(root),
      source: await sourceIdentity(root, 'notes/hidden.md'),
      destination: { absolutePath: renamed, relativePath: 'notes/still-hidden.md' },
      parents: [await directoryIdentity(root, 'notes')],
    })).resolves.toEqual({ status: 'committed' })
    expect(await windowsFileAttributes(renamed)).toBe(originalAttributes)
    await expect(readFile(renamed, 'utf8')).resolves.toBe('after')
  })

  it('edits the verified opened source identity and rejects stale identity/content', async () => {
    const root = await rootFixture()
    const sourcePath = path.join(root, 'notes', 'a.md')
    await writeFile(sourcePath, 'before')
    const source = await sourceIdentity(root, 'notes/a.md')
    const request: WorkspaceAiCommitRequest = {
      kind: 'edit',
      root: await rootIdentity(root),
      source,
      parents: [await directoryIdentity(root, 'notes')],
      bytes: Buffer.from('after'),
    }
    const adapter = new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: helperPath })

    await expect(adapter.commit(request)).resolves.toEqual({ status: 'committed' })
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('after')
    await expect(adapter.commit(request)).resolves.toEqual({ status: 'rejected', reason: 'source-changed' })
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('after')
  })

  it('rechecks every held intermediate ancestor after a post-open identity-pin race', async () => {
    const root = await rootFixture()
    await mkdir(path.join(root, 'nested', 'middle', 'direct'), { recursive: true })
    const sourcePath = path.join(root, 'nested', 'middle', 'direct', 'a.md')
    await writeFile(sourcePath, 'before')
    const request: WorkspaceAiCommitRequest = {
      kind: 'edit',
      root: await rootIdentity(root),
      source: await sourceIdentity(root, 'nested/middle/direct/a.md'),
      parents: [await directoryIdentity(root, 'nested/middle/direct')],
      bytes: Buffer.from('must not be written'),
    }
    const helper = await barrierHelper(
      request,
      path.join(root, 'intermediate-race-barrier'),
      'ARKDOWN_WORKSPACE_COMMIT_TEST_INTERMEDIATE_PIN_BARRIER',
    )
    await helper.ready
    await helper.release()
    const response = parseResponse((await helper.result).stdout)

    expect(response).toMatchObject({ status: 'rejected', reason: 'parent-changed' })
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('before')
  })

  it('post-checks the full held context before reporting an edit committed', async () => {
    const root = await rootFixture()
    await mkdir(path.join(root, 'nested', 'middle', 'direct'), { recursive: true })
    const sourcePath = path.join(root, 'nested', 'middle', 'direct', 'a.md')
    await writeFile(sourcePath, 'before')
    const request: WorkspaceAiCommitRequest = {
      kind: 'edit',
      root: await rootIdentity(root),
      source: await sourceIdentity(root, 'nested/middle/direct/a.md'),
      parents: [await directoryIdentity(root, 'nested/middle/direct')],
      bytes: Buffer.from('after'),
    }
    const helper = await barrierHelper(
      request,
      path.join(root, 'edit-post-context-barrier'),
      'ARKDOWN_WORKSPACE_COMMIT_TEST_EDIT_POSTWRITE_BARRIER',
    )
    await helper.ready
    await helper.release()
    const response = parseResponse((await helper.result).stdout)

    expect(response).toMatchObject({ status: 'unknown', reason: 'post_commit_verification_failed' })
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('after')
  })

  it('rejects a real NTFS hardlink into the workspace and leaves the external identity unchanged', async () => {
    const root = await rootFixture()
    const outsideRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'arkdown-hardlink-outside-')))
    roots.push(outsideRoot)
    const external = path.join(outsideRoot, 'external.md')
    const inside = path.join(root, 'notes', 'linked.md')
    await writeFile(external, 'external must remain unchanged')
    try {
      await link(external, inside)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') return
      throw error
    }
    const request: WorkspaceAiCommitRequest = {
      kind: 'edit',
      root: await rootIdentity(root),
      source: await sourceIdentity(root, 'notes/linked.md'),
      parents: [await directoryIdentity(root, 'notes')],
      bytes: Buffer.from('attacker-controlled edit'),
    }

    await expect(new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: helperPath }).commit(request))
      .resolves.toEqual({ status: 'rejected', reason: 'source-changed' })
    await expect(readFile(external, 'utf8')).resolves.toBe('external must remain unchanged')
    await expect(readFile(inside, 'utf8')).resolves.toBe('external must remain unchanged')
  })

  it('holds a no-writer/no-delete stage handle through create commit', async () => {
    const root = await rootFixture()
    const destination = path.join(root, 'notes', 'new.md')
    const request: WorkspaceAiCommitRequest = {
      kind: 'create',
      root: await rootIdentity(root),
      destination: { absolutePath: destination, relativePath: 'notes/new.md' },
      parents: [await directoryIdentity(root, 'notes')],
      bytes: Buffer.from('trusted stage content'),
    }
    const helper = await barrierHelper(
      request,
      path.join(root, 'stage-barrier'),
      'ARKDOWN_WORKSPACE_COMMIT_TEST_STAGE_BARRIER',
    )
    await helper.ready
    const entries = await readdir(path.join(root, 'notes'))
    const stageName = entries.find((name) => name.startsWith('.arkdown-ai-stage-'))
    expect(stageName).toBeDefined()
    const writerAttempt = await writeFile(path.join(root, 'notes', stageName!), 'concurrent writer')
      .then(() => 'written', (error: NodeJS.ErrnoException) => error.code)
    expect(['EBUSY', 'EACCES', 'EPERM']).toContain(writerAttempt)
    await helper.release()
    expect(parseResponse((await helper.result).stdout)).toMatchObject({ status: 'committed' })
    await expect(readFile(destination, 'utf8')).resolves.toBe('trusted stage content')
  })

  it('renames the verified source handle with no-replace semantics', async () => {
    const root = await rootFixture()
    const sourcePath = path.join(root, 'notes', 'a.md')
    const destinationPath = path.join(root, 'notes', 'b.md')
    await writeFile(sourcePath, 'source')
    const request: WorkspaceAiCommitRequest = {
      kind: 'rename',
      root: await rootIdentity(root),
      source: await sourceIdentity(root, 'notes/a.md'),
      destination: { absolutePath: destinationPath, relativePath: 'notes/b.md' },
      parents: [await directoryIdentity(root, 'notes')],
    }
    const adapter = new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: helperPath })

    await expect(adapter.commit(request)).resolves.toEqual({ status: 'committed' })
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('source')

    await writeFile(sourcePath, 'second')
    await expect(adapter.commit({ ...request, source: await sourceIdentity(root, 'notes/a.md') }))
      .resolves.toEqual({ status: 'rejected', reason: 'destination-exists' })
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('second')
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('source')
  })

  it('rejects a reparse parent without writing through it', async ({ skip }) => {
    const root = await rootFixture()
    const outside = await rootFixture()
    try {
      await symlink(outside, path.join(root, 'escape'), 'junction')
    } catch {
      skip()
      return
    }
    const request: WorkspaceAiCommitRequest = {
      kind: 'create',
      root: await rootIdentity(root),
      destination: { absolutePath: path.join(root, 'escape', 'new.md'), relativePath: 'escape/new.md' },
      parents: [{
        absolutePath: path.join(root, 'escape'),
        relativePath: 'escape',
        fileId: fileId(await stat(path.join(root, 'escape'), { bigint: true })),
      }],
      bytes: Buffer.from('must not escape'),
    }

    await expect(new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: helperPath }).commit(request))
      .resolves.toEqual({ status: 'rejected', reason: 'parent-changed' })
    await expect(lstat(path.join(outside, 'new.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deterministically blocks a parent replacement while identity handles are open', async () => {
    const root = await rootFixture()
    const destination = path.join(root, 'notes', 'new.md')
    const request: WorkspaceAiCommitRequest = {
      kind: 'create',
      root: await rootIdentity(root),
      destination: { absolutePath: destination, relativePath: 'notes/new.md' },
      parents: [await directoryIdentity(root, 'notes')],
      bytes: Buffer.from('must not enter replacement'),
    }
    const barrier = path.join(root, 'barrier')
    const helper = await barrierHelper(request, barrier)
    await helper.ready
    const replacementAttempt = await rename(path.join(root, 'notes'), path.join(root, 'held-notes'))
      .then(() => 'renamed', (error: NodeJS.ErrnoException) => error.code)
    expect(['EBUSY', 'EACCES', 'EPERM']).toContain(replacementAttempt)
    await helper.release()
    const response = parseResponse((await helper.result).stdout) as { status: string; reason?: string }

    expect(response).toMatchObject({ status: 'committed' })
    await expect(readFile(destination, 'utf8')).resolves.toBe('must not enter replacement')
  })

  it('detects a real FSCTL_SET_REPARSE_POINT change while parent handles are held', async () => {
    const root = await rootFixture()
    const external = await rootFixture()
    const destination = path.join(root, 'notes', 'new.md')
    const request: WorkspaceAiCommitRequest = {
      kind: 'create',
      root: await rootIdentity(root),
      destination: { absolutePath: destination, relativePath: 'notes/new.md' },
      parents: [await directoryIdentity(root, 'notes')],
      bytes: Buffer.from('must remain inside the workspace'),
    }
    const helper = await barrierHelper(request, path.join(root, 'reparse-barrier'))
    await helper.ready

    const attacker = await attemptMountPointReparse(path.join(root, 'notes'), external)
    expect([0, 73]).toContain(attacker.code)
    expect(attacker.stdout.byteLength).toBe(0)
    expect(attacker.stderr.byteLength).toBe(0)
    await helper.release()
    const response = parseResponse((await helper.result).stdout)
    if (attacker.code === 0) expect(response).toMatchObject({ status: 'rejected', reason: 'parent-changed' })
    else expect(response).toMatchObject({ status: 'committed' })
    await expect(lstat(path.join(external, 'new.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (attacker.code === 0) await rm(path.join(root, 'notes'), { force: true })
    else await expect(readFile(destination, 'utf8')).resolves.toBe('must remain inside the workspace')
  })

  it('keeps a check-to-syscall FSCTL reparse race handle-relative and out of the external target', async () => {
    const root = await rootFixture()
    const external = await rootFixture()
    const request: WorkspaceAiCommitRequest = {
      kind: 'create',
      root: await rootIdentity(root),
      destination: { absolutePath: path.join(root, 'notes', 'new.md'), relativePath: 'notes/new.md' },
      parents: [await directoryIdentity(root, 'notes')],
      bytes: Buffer.from('must never escape'),
    }
    const helper = await barrierHelper(
      request,
      path.join(root, 'namespace-barrier'),
      'ARKDOWN_WORKSPACE_COMMIT_TEST_NAMESPACE_BARRIER',
    )
    await helper.ready
    const attacker = await attemptMountPointReparse(path.join(root, 'notes'), external)
    expect([0, 73]).toContain(attacker.code)
    await helper.release()
    const response = parseResponse((await helper.result).stdout)

    if (attacker.code === 0) expect(response).not.toMatchObject({ status: 'committed' })
    else expect(response).toMatchObject({ status: 'committed' })
    await expect(lstat(path.join(external, 'new.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (attacker.code === 0) await rm(path.join(root, 'notes'), { force: true })
  })

  it('deterministically pins the root and blocks source replacement after identity handles are opened', async () => {
    const root = await rootFixture()
    const destination = path.join(root, 'notes', 'new.md')
    const createRequest: WorkspaceAiCommitRequest = {
      kind: 'create',
      root: await rootIdentity(root),
      destination: { absolutePath: destination, relativePath: 'notes/new.md' },
      parents: [await directoryIdentity(root, 'notes')],
      bytes: Buffer.from('must not enter replacement root'),
    }
    const barrierParent = await realpath(await mkdtemp(path.join(tmpdir(), 'arkdown-native-barrier-')))
    roots.push(barrierParent)
    const rootHelper = await barrierHelper(createRequest, path.join(barrierParent, 'root'))
    await rootHelper.ready
    const movedRoot = `${root}-held`
    roots.push(movedRoot)
    const rootReplacement = await rename(root, movedRoot)
      .then(() => 'renamed', (error: NodeJS.ErrnoException) => error.code)
    expect(['EBUSY', 'EACCES', 'EPERM']).toContain(rootReplacement)
    await rootHelper.release()
    expect(parseResponse((await rootHelper.result).stdout)).toMatchObject({ status: 'committed' })
    await expect(readFile(destination, 'utf8')).resolves.toBe('must not enter replacement root')

    const sourcePath = path.join(root, 'notes', 'a.md')
    const renamedPath = path.join(root, 'notes', 'b.md')
    await writeFile(sourcePath, 'original')
    const renameRequest: WorkspaceAiCommitRequest = {
      kind: 'rename',
      root: await rootIdentity(root),
      source: await sourceIdentity(root, 'notes/a.md'),
      destination: { absolutePath: renamedPath, relativePath: 'notes/b.md' },
      parents: [await directoryIdentity(root, 'notes')],
    }
    const sourceHelper = await barrierHelper(renameRequest, path.join(barrierParent, 'source'))
    await sourceHelper.ready
    const sourceReplacement = await rename(sourcePath, path.join(root, 'notes', 'attacker-held.md'))
      .then(() => 'renamed', (error: NodeJS.ErrnoException) => error.code)
    expect(['EBUSY', 'EACCES', 'EPERM']).toContain(sourceReplacement)
    await sourceHelper.release()
    expect(parseResponse((await sourceHelper.result).stdout)).toMatchObject({ status: 'committed' })
    await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(renamedPath, 'utf8')).resolves.toBe('original')
  })

  it('deterministically preserves a destination created after verification', async () => {
    const root = await rootFixture()
    const destination = path.join(root, 'notes', 'new.md')
    const request: WorkspaceAiCommitRequest = {
      kind: 'create',
      root: await rootIdentity(root),
      destination: { absolutePath: destination, relativePath: 'notes/new.md' },
      parents: [await directoryIdentity(root, 'notes')],
      bytes: Buffer.from('helper content'),
    }
    const helper = await barrierHelper(request, path.join(root, 'barrier'))
    await helper.ready
    await writeFile(destination, 'attacker content')
    await helper.release()
    expect(parseResponse((await helper.result).stdout)).toMatchObject({ status: 'rejected', reason: 'destination-exists' })
    await expect(readFile(destination, 'utf8')).resolves.toBe('attacker content')
  })

  it('leaves no side effect when the real helper is force-killed at the pre-commit barrier', async () => {
    const root = await rootFixture()
    const destination = path.join(root, 'notes', 'killed.md')
    const request: WorkspaceAiCommitRequest = {
      kind: 'create',
      root: await rootIdentity(root),
      destination: { absolutePath: destination, relativePath: 'notes/killed.md' },
      parents: [await directoryIdentity(root, 'notes')],
      bytes: Buffer.from('must never commit'),
    }
    const helper = await barrierHelper(request, path.join(root, 'kill-barrier'))
    await helper.ready
    expect(helper.kill()).toBe(true)
    const result = await helper.result
    expect(result.code).toBeNull()
    expect(result.stdout.byteLength).toBe(0)
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not publish a staged create when the real helper is force-killed after flush', async () => {
    const root = await rootFixture()
    const destination = path.join(root, 'notes', 'killed-stage.md')
    const request: WorkspaceAiCommitRequest = {
      kind: 'create',
      root: await rootIdentity(root),
      destination: { absolutePath: destination, relativePath: 'notes/killed-stage.md' },
      parents: [await directoryIdentity(root, 'notes')],
      bytes: Buffer.from('flushed but unpublished'),
    }
    const helper = await barrierHelper(
      request,
      path.join(root, 'kill-stage-barrier'),
      'ARKDOWN_WORKSPACE_COMMIT_TEST_STAGE_BARRIER',
    )
    await helper.ready
    expect(helper.kill()).toBe(true)
    expect((await helper.result).code).toBeNull()
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(path.join(root, 'notes'))).some((name) => name.startsWith('.arkdown-ai-stage-')))
      .toBe(true)
  })

  it.each(['notes', 'nested/$Recycle.Bin/notes'])('rejects recycle without moving the original in %s', async (directory) => {
    const root = await rootFixture()
    await mkdir(path.join(root, ...directory.split('/')), { recursive: true })
    const relative = directory + '/delete.md'
    const sourcePath = path.join(root, ...relative.split('/'))
    await writeFile(sourcePath, 'exact source stays in its original location')
    const source = await sourceIdentity(root, relative)
    const attributes = await windowsFileAttributes(sourcePath)
    const request: WorkspaceAiCommitRequest = {
      kind: 'recycle', root: await rootIdentity(root), source,
      parents: [await directoryIdentity(root, directory)],
    }
    const result = await rawHelper(framed(JSON.stringify(wireRequest(request, randomUUID()))))
    expect(result.code).toBe(0)
    expect(parseResponse(result.stdout)).toMatchObject({ status: 'rejected', reason: 'recycle-unavailable' })
    expect(await sourceIdentity(root, relative)).toEqual(source)
    expect(await windowsFileAttributes(sourcePath)).toBe(attributes)
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('exact source stays in its original location')
    await expect(lstat(path.join(root, '.arkdown-ai-quarantine'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('pins recycle source and root until the no-mutation rejection', async () => {
    const root = await rootFixture()
    const sourcePath = path.join(root, 'notes', 'delete.md')
    await writeFile(sourcePath, 'pinned original')
    const source = await sourceIdentity(root, 'notes/delete.md')
    const request: WorkspaceAiCommitRequest = {
      kind: 'recycle', root: await rootIdentity(root), source,
      parents: [await directoryIdentity(root, 'notes')],
    }
    const helper = await barrierHelper(request, path.join(root, 'recycle-barrier'))
    await helper.ready
    try {
      const substitution = await rename(sourcePath, path.join(root, 'notes', 'attacker-held.md'))
        .then(() => 'renamed', (error: NodeJS.ErrnoException) => error.code)
      expect(['EBUSY', 'EACCES', 'EPERM']).toContain(substitution)
      const movedRoot = await rename(root, root + '-moved')
        .then(() => 'renamed', (error: NodeJS.ErrnoException) => error.code)
      expect(['EBUSY', 'EACCES', 'EPERM']).toContain(movedRoot)
    } finally { await helper.release() }
    expect(parseResponse((await helper.result).stdout)).toMatchObject({ status: 'rejected', reason: 'recycle-unavailable' })
    expect(await sourceIdentity(root, 'notes/delete.md')).toEqual(source)
    await expect(lstat(path.join(root, '.arkdown-ai-quarantine'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves the original recoverable in place when a recycle helper is killed before rejection', async () => {
    const root = await rootFixture()
    const sourcePath = path.join(root, 'notes', 'killed-delete.md')
    await writeFile(sourcePath, 'recover exact identity')
    const source = await sourceIdentity(root, 'notes/killed-delete.md')
    const request: WorkspaceAiCommitRequest = {
      kind: 'recycle', root: await rootIdentity(root), source,
      parents: [await directoryIdentity(root, 'notes')],
    }
    const helper = await barrierHelper(request, path.join(root, 'kill-recycle-barrier'))
    await helper.ready
    expect(helper.kill()).toBe(true)
    expect((await helper.result).code).toBeNull()
    expect(await sourceIdentity(root, 'notes/killed-delete.md')).toEqual(source)
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('recover exact identity')
    await expect(lstat(path.join(root, '.arkdown-ai-quarantine'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['source', 'root'] as const)('retains recycle %s identity guards before the unavailable result', async (changed) => {
    const root = await rootFixture()
    const sourcePath = path.join(root, 'notes', 'delete.md')
    await writeFile(sourcePath, 'original')
    const source = await sourceIdentity(root, 'notes/delete.md')
    const rootState = await rootIdentity(root)
    const request: WorkspaceAiCommitRequest = {
      kind: 'recycle',
      root: changed === 'root' ? { ...rootState, rootFileId: '0' } : rootState,
      source: changed === 'source' ? { ...source, revision: '0'.repeat(64) } : source,
      parents: [await directoryIdentity(root, 'notes')],
    }
    const result = await rawHelper(framed(JSON.stringify(wireRequest(request, randomUUID()))))
    expect(parseResponse(result.stdout)).toMatchObject({ status: 'rejected', reason: changed + '-changed' })
    expect(await sourceIdentity(root, 'notes/delete.md')).toEqual(source)
    await expect(lstat(path.join(root, '.arkdown-ai-quarantine'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not alter existing recovery items when another recycle is rejected', async () => {
    const root = await rootFixture()
    const retained = path.join(root, '.arkdown-ai-quarantine', 'txn-existing-fixture')
    await mkdir(retained, { recursive: true })
    const marker = Buffer.from('{"stage":"handoff-unknown","fixture":true}')
    const retainedBytes = Buffer.from('previous retained fixture')
    await writeFile(path.join(retained, 'recovery.json'), marker)
    await writeFile(path.join(retained, 'item'), retainedBytes)
    await writeFile(path.join(root, 'notes', 'delete.md'), 'new original')
    const source = await sourceIdentity(root, 'notes/delete.md')
    const retainedBefore = await stat(path.join(retained, 'item'), { bigint: true })
    const request: WorkspaceAiCommitRequest = {
      kind: 'recycle', root: await rootIdentity(root), source,
      parents: [await directoryIdentity(root, 'notes')],
    }
    const result = await rawHelper(framed(JSON.stringify(wireRequest(request, randomUUID()))))
    expect(parseResponse(result.stdout)).toMatchObject({ status: 'rejected', reason: 'recycle-unavailable' })
    expect(await sourceIdentity(root, 'notes/delete.md')).toEqual(source)
    expect(await readdir(path.dirname(retained))).toEqual(['txn-existing-fixture'])
    expect(await readFile(path.join(retained, 'recovery.json'))).toEqual(marker)
    expect(await readFile(path.join(retained, 'item'))).toEqual(retainedBytes)
    expect(fileId(await stat(path.join(retained, 'item'), { bigint: true }))).toBe(fileId(retainedBefore))
  })
})
