import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPackageProvenanceMatchesCleanSource,
  auditPackageProvenance,
  captureCleanPackageSource,
  PACKAGE_PROVENANCE_FILENAME,
  readPackageProvenance,
  writePackageProvenance,
} from '../../scripts/package-provenance'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root, encoding: 'utf8' })
  return stdout.trim()
}

async function committedSource(): Promise<string> {
  const root = await temporaryRoot('arkdown-provenance-source-')
  await git(root, 'init')
  await git(root, 'config', 'user.email', 'tests@arkdown.invalid')
  await git(root, 'config', 'user.name', 'Arkdown tests')
  await writeFile(path.join(root, 'tracked.txt'), 'tracked\n', 'utf8')
  await git(root, 'add', 'tracked.txt')
  await git(root, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
  return root
}

async function packageRoot(appAsar = Buffer.from('app-asar')): Promise<string> {
  const root = await temporaryRoot('arkdown-provenance-package-')
  await mkdir(path.join(root, 'resources'), { recursive: true })
  await writeFile(path.join(root, 'resources', 'app.asar'), appAsar)
  return root
}

describe('package provenance', () => {
  it('captures only a clean tracked HEAD and its deterministic tree identity', async () => {
    const root = await committedSource()

    await expect(captureCleanPackageSource(root)).resolves.toEqual({
      commit: await git(root, 'rev-parse', 'HEAD'),
      tree: await git(root, 'rev-parse', 'HEAD^{tree}'),
    })

    await writeFile(path.join(root, 'tracked.txt'), 'dirty\n', 'utf8')
    await expect(captureCleanPackageSource(root)).rejects.toThrow('clean Git HEAD')
    await git(root, 'checkout', '--', 'tracked.txt')
    await writeFile(path.join(root, 'untracked.txt'), 'untracked\n', 'utf8')
    await expect(captureCleanPackageSource(root)).rejects.toThrow('clean Git HEAD')
  })

  it('writes a strict bounded record bound to the packaged app.asar and current clean source', async () => {
    const sourceRoot = await committedSource()
    const outputRoot = await packageRoot()
    const source = await captureCleanPackageSource(sourceRoot)

    await writePackageProvenance([outputRoot], source)

    const record = await readPackageProvenance(outputRoot)
    expect(record).toEqual({
      schemaVersion: 1,
      commit: source.commit,
      tree: source.tree,
      appAsarSha256: createHash('sha256').update('app-asar').digest('hex'),
    })
    await expect(assertPackageProvenanceMatchesCleanSource(outputRoot, sourceRoot)).resolves.toEqual(record)
    expect((await readFile(path.join(outputRoot, 'resources', PACKAGE_PROVENANCE_FILENAME), 'utf8')).length)
      .toBeLessThan(256)
  })

  it('rejects stale source identity, modified app.asar, extra schema fields, casing, and non-files', async () => {
    const sourceRoot = await committedSource()
    const outputRoot = await packageRoot()
    const source = await captureCleanPackageSource(sourceRoot)
    await writePackageProvenance([outputRoot], source)

    await writeFile(path.join(sourceRoot, 'tracked.txt'), 'next commit\n', 'utf8')
    await git(sourceRoot, 'add', 'tracked.txt')
    await git(sourceRoot, '-c', 'commit.gpgsign=false', 'commit', '-m', 'next fixture')
    await expect(assertPackageProvenanceMatchesCleanSource(outputRoot, sourceRoot))
      .rejects.toThrow('current clean Git HEAD')

    await writeFile(path.join(outputRoot, 'resources', 'app.asar'), 'changed', 'utf8')
    await expect(assertPackageProvenanceMatchesCleanSource(outputRoot, sourceRoot))
      .rejects.toThrow('provenance')

    const provenancePath = path.join(outputRoot, 'resources', PACKAGE_PROVENANCE_FILENAME)
    await writeFile(provenancePath, JSON.stringify({
      schemaVersion: 1,
      commit: source.commit,
      tree: source.tree,
      appAsarSha256: '0'.repeat(64),
      extra: true,
    }), 'utf8')
    await expect(readPackageProvenance(outputRoot)).rejects.toThrow('schema')

    await rm(provenancePath)
    await writeFile(path.join(outputRoot, 'resources', 'PACKAGE-PROVENANCE.JSON'), '{}', 'utf8')
    await expect(auditPackageProvenance(outputRoot)).resolves.toEqual(expect.arrayContaining([
      'missing package provenance',
      path.join('unexpected package provenance', 'PACKAGE-PROVENANCE.JSON'),
    ]))

    await rm(path.join(outputRoot, 'resources', 'PACKAGE-PROVENANCE.JSON'))
    await mkdir(provenancePath)
    await expect(auditPackageProvenance(outputRoot)).resolves.toContain('invalid package provenance file')
  })
})
