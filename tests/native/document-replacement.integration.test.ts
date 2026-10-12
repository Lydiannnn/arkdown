// @vitest-environment node
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildWorkspaceCommitHelper } from '../../scripts/build-workspace-commit-helper'
import { DocumentService } from '../../src/main/documents/document-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { WindowsWorkspaceCommitProcessAdapter, type WorkspaceCommitChildProcess } from '../../src/main/workspace/windows-workspace-commit-process'

const roots: string[] = []
let helperPath: string
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function identity(file: string) {
  const info = await stat(file, { bigint: true })
  return `${info.dev.toString(16)}.${info.ino.toString(16)}`
}
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'arkdown-document-replace-')))
  roots.push(root)
  const destinationPath = path.join(root, '桌面 文档.md')
  const temporaryPath = path.join(root, '.桌面 文档.md.123.test.tmp')
  const before = Buffer.from('\uFEFF# 原文\r\n- [ ] 保留格式\r\n')
  const after = Buffer.from('\uFEFF# 修改\r\n- [x] 保留格式\r\n')
  await writeFile(destinationPath, before)
  await writeFile(temporaryPath, after)
  const request = {
    destinationPath, temporaryPath,
    destinationIdentity: await identity(destinationPath),
    temporaryIdentity: await identity(temporaryPath),
    expectedRevision: hash(before), replacementRevision: hash(after),
  }
  return { root, before, after, request }
}
async function replace(request: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
  const requestId = randomUUID()
  const bytes = Buffer.from(JSON.stringify({ protocolVersion: 1, requestId, command: 'replace-document', request }))
  const header = Buffer.alloc(4)
  header.writeUInt32LE(bytes.length)
  const child = spawn(helperPath, ['--stdio-json-v1'], {
    shell: false, windowsHide: true, stdio: 'pipe', env: { ...process.env, ...env },
  })
  const output: Buffer[] = []
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)))
  child.stdin.end(Buffer.concat([header, bytes]))
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  expect(code).toBe(0)
  const result = Buffer.concat(output)
  expect(result.readUInt32LE(0)).toBe(result.length - 4)
  return JSON.parse(result.subarray(4).toString('utf8')) as { status: string; reason?: string }
}
beforeAll(async () => {
  if (process.platform !== 'win32') return
  helperPath = (await buildWorkspaceCommitHelper({ repoRoot: process.cwd(), arch: process.arch === 'arm64' ? 'arm64' : 'x64', testHooks: true })).executablePath
}, 120_000)
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

describe.skipIf(process.platform !== 'win32')('Windows ordinary document replacement', () => {
  it.each(['transient', 'permanent', 'document-changed'] as const)(
    'handles a real %s executable lock before releasing any save request', async (kind) => {
      const { root, request, before, after } = await fixture()
      const helperRoot = path.join(root, 'helper')
      await mkdir(helperRoot)
      const helper = path.join(helperRoot, path.basename(helperPath))
      await copyFile(helperPath, helper)
      await copyFile(path.join(path.dirname(helperPath), 'manifest.json'), path.join(helperRoot, 'manifest.json'))
      const helperBytes = await readFile(helper)
      // A writable image handle permits the adapter's read/hash checks but makes
      // Windows reject CreateProcess with a real sharing violation (spawn EBUSY).
      // Only this disposable copy is opened; its contents are never modified.
      const imageHandle = await open(helper, 'r+')
      const errors: string[] = []
      let attempts = 0
      let launched = 0
      let release: Promise<void> | undefined
      const external = Buffer.from('# External edit during the launch wait\n')
      const adapter = new WindowsWorkspaceCommitProcessAdapter({
        developmentHelperPath: helper,
        processFactory: (executable, args, options) => {
          attempts += 1
          try {
            const child = spawn(executable, [...args], options)
            launched += 1
            return child as WorkspaceCommitChildProcess
          } catch (error) {
            errors.push((error as NodeJS.ErrnoException).code ?? 'missing')
            if (!release && kind !== 'permanent') {
              release = new Promise<void>((resolve, reject) => setTimeout(() => {
                const edit = kind === 'document-changed' ? writeFile(request.destinationPath, external) : Promise.resolve()
                edit.then(() => imageHandle.close()).then(resolve, reject)
              }, 50))
            }
            throw error
          }
        },
      })
      try {
        if (kind === 'transient') {
          await adapter.replaceDocumentFile(request)
          expect(await readFile(request.destinationPath)).toEqual(after)
          expect(await readdir(root)).not.toContain(path.basename(request.temporaryPath))
          expect(launched).toBe(1)
        } else {
          await expect(adapter.replaceDocumentFile(request)).rejects.toThrow(
            kind === 'permanent' ? 'Document replacement rejected: unsupported' : /changed|修改|冲突/i,
          )
          expect(await readFile(request.destinationPath)).toEqual(kind === 'permanent' ? before : external)
          expect(await readFile(request.temporaryPath)).toEqual(after)
          expect(launched).toBe(kind === 'permanent' ? 0 : 1)
        }
        expect(attempts).toBeGreaterThanOrEqual(2)
        expect(attempts).toBeLessThanOrEqual(4)
        if (kind === 'permanent') expect(attempts).toBe(4)
        expect(errors.length).toBeGreaterThan(0)
        expect(errors.every(code => code === 'EBUSY')).toBe(true)
      } finally {
        if (release) await release
        await imageHandle.close()
      }
      expect(await readFile(helper)).toEqual(helperBytes)
    },
  )
  it('preserves creation time and alternate streams while publishing the staged identity and exact bytes', async () => {
    const { root, request, after } = await fixture()
    await writeFile(`${request.destinationPath}:arkdown-test-metadata`, 'keep metadata')
    const original = await stat(request.destinationPath, { bigint: true })
    expect(await replace(request)).toMatchObject({ status: 'committed' })
    expect(await readFile(request.destinationPath)).toEqual(after)
    expect(await identity(request.destinationPath)).toBe(request.temporaryIdentity)
    expect((await stat(request.destinationPath, { bigint: true })).birthtimeNs).toBe(original.birthtimeNs)
    expect(await readFile(`${request.destinationPath}:arkdown-test-metadata`, 'utf8')).toBe('keep metadata')
    expect(await readdir(root)).toEqual(['桌面 文档.md'])
  })
  it.each(['destination', 'temporary'] as const)('rejects changed %s bytes before replacing anything', async (kind) => {
    const { request, before, after } = await fixture()
    const changed = Buffer.from('changed externally')
    await writeFile(kind === 'destination' ? request.destinationPath : request.temporaryPath, changed)
    expect(await replace(request)).toMatchObject({ status: 'rejected', reason: 'source-changed' })
    expect(await readFile(request.destinationPath)).toEqual(kind === 'destination' ? changed : before)
    expect(await readFile(request.temporaryPath)).toEqual(kind === 'temporary' ? changed : after)
  })
  it('leaves a read-only original and the staged bytes intact on failure', async () => {
    const { request, before, after } = await fixture()
    await chmod(request.destinationPath, 0o444)
    try {
      expect(await replace(request)).toMatchObject({ status: 'rejected' })
      expect(await readFile(request.destinationPath)).toEqual(before)
      expect(await readFile(request.temporaryPath)).toEqual(after)
    } finally { await chmod(request.destinationPath, 0o666) }
  })
  it('restores the original if replacement fails after moving it to the backup', async () => {
    const { root, request, before, after } = await fixture()
    expect(await replace(request, { ARKDOWN_DOCUMENT_REPLACE_TEST_FAULT: 'after-backup' })).toMatchObject({ status: 'rejected' })
    expect(await readFile(request.destinationPath)).toEqual(before)
    expect(await identity(request.destinationPath)).toBe(request.destinationIdentity)
    expect(await readFile(request.temporaryPath)).toEqual(after)
    expect((await readdir(root)).sort()).toEqual([path.basename(request.temporaryPath), path.basename(request.destinationPath)].sort())
  })
  it('retains the old bytes when a failure is reported after publication', async () => {
    const { root, request, before, after } = await fixture()
    expect(await replace(request, { ARKDOWN_DOCUMENT_REPLACE_TEST_FAULT: 'after-replace' })).toMatchObject({ status: 'unknown' })
    expect(await readFile(request.destinationPath)).toEqual(after)
    const backup = (await readdir(root)).find((name) => name.startsWith('.arkdown-save-') && name.endsWith('.bak'))
    expect(backup).toBeDefined()
    expect(await readFile(path.join(root, backup!))).toEqual(before)
  })
  it('does not impose the AI editing size limit on an ordinary document', async () => {
    const { request } = await fixture()
    const bytes = Buffer.alloc(25 * 1024 * 1024, 'a')
    await writeFile(request.temporaryPath, bytes)
    expect(await replace({ ...request, replacementRevision: hash(bytes) })).toMatchObject({ status: 'committed' })
    expect((await readFile(request.destinationPath)).equals(bytes)).toBe(true)
  })
  it('supports canonical paths longer than MAX_PATH', async () => {
    const { root, request, after } = await fixture()
    const directory = path.join(root, 'a'.repeat(100), 'b'.repeat(100))
    await mkdir(directory, { recursive: true })
    const destinationPath = path.join(directory, path.basename(request.destinationPath))
    const temporaryPath = path.join(directory, path.basename(request.temporaryPath))
    await rename(request.destinationPath, destinationPath)
    await rename(request.temporaryPath, temporaryPath)
    expect(destinationPath.length).toBeGreaterThan(260)
    expect(await replace({ ...request, destinationPath, temporaryPath })).toMatchObject({ status: 'committed' })
    expect(await readFile(destinationPath)).toEqual(after)
  })
  it('does not rename over the original when the trusted helper is unavailable', async () => {
    const { root, request, before } = await fixture()
    await rm(request.temporaryPath)
    const adapter = new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: path.join(root, 'missing.exe') })
    const workspace = new WorkspaceService()
    await workspace.setRoot(root)
    const service = new DocumentService(workspace, undefined, { replaceFile: adapter.replaceDocumentFile.bind(adapter) })
    const relativePath = path.basename(request.destinationPath)
    const document = await service.read(relativePath)
    await expect(service.save({ ...document, markdown: 'new content', expectedRevision: document.revision })).rejects.toThrow('Document replacement rejected')
    expect(await readFile(request.destinationPath)).toEqual(before)
    expect(await readdir(root)).toEqual([relativePath])
  })
  it('publishes repeated real editor saves through the trusted adapter with the correct ownership handoff', async () => {
    const { root, request } = await fixture()
    await rm(request.temporaryPath)
    const adapter = new WindowsWorkspaceCommitProcessAdapter({ developmentHelperPath: helperPath })
    const workspace = new WorkspaceService()
    await workspace.setRoot(root)
    const service = new DocumentService(workspace, undefined, { replaceFile: adapter.replaceDocumentFile.bind(adapter) })
    const relativePath = path.basename(request.destinationPath)
    for (let index = 0; index < 5; index += 1) {
      const opened = await service.readForMain(relativePath)
      let successor = ''
      const saved = await service.saveForMain({
        relativePath, markdown: `# 保存 ${index}\n- [x] 保留格式\n`,
        expectedRevision: opened.document.revision, encoding: opened.document.encoding, newline: opened.document.newline,
      }, async (published) => {
        expect(published.identity).toBe(successor)
        expect(await identity(request.destinationPath)).toBe(successor)
      }, async (prepared) => {
        expect(prepared.sourceIdentity).toBe(opened.identity)
        successor = prepared.successorIdentity
      })
      expect(saved.identity).toBe(successor)
      expect(await readFile(request.destinationPath)).toEqual(Buffer.from(`\uFEFF# 保存 ${index}\r\n- [x] 保留格式\r\n`))
      expect(await readdir(root)).toEqual([relativePath])
    }
  })
})
