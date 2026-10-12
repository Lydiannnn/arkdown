import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import * as tar from 'tar'
import type { ComponentBuildOptions, ComponentBuildResult } from '../../scripts/build-markitdown-component'
import {
  canonicalJsonBytes,
  publicManifest,
} from '../../scripts/build-markitdown-component'
import {
  assertMatchingBuildResults,
  assertSafeArchiveEntries,
  buildComponentTwice,
  createCrLfSourceVariant,
  inspectBuiltComponent,
  readVerifiedArchive,
  runReportedVerification,
  verifyMarkItDownRelease,
  verifyInternalManifest,
} from '../../scripts/verify-markitdown-component'

const temporaryRoots: string[] = []
const SHA256 = 'a'.repeat(64)
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

function buildResult(root: string, sha256 = SHA256): ComponentBuildResult {
  return {
    archivePath: path.join(root, 'component.tar.gz'),
    manifestPath: path.join(root, 'manifest.json'),
    version: '0.1.7-py3.12.10',
    bytes: 123,
    sha256,
  }
}

describe('MarkItDown full component verification seams', () => {
  it('loads as a direct Node entry point before validating command arguments', async () => {
    await expect(execFileAsync('node', [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      path.resolve('scripts', 'verify-markitdown-component.ts'),
      '--unsupported-option',
    ], {
      encoding: 'utf8',
      windowsHide: true,
    })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('Usage: npm run verify:markitdown'),
    })
  })

  it('runs two isolated builds with one cache and rejects any output mismatch', async () => {
    const root = await temporaryRoot('arkdown-markitdown-twice-')
    const cacheRoot = path.join(root, 'cache')
    const runsRoot = path.join(root, 'runs')
    const repoRoots = [path.join(root, 'lf-repo'), path.join(root, 'crlf-repo')] as const
    const calls: ComponentBuildOptions[] = []
    const archiveBytes = Buffer.from('locked archive bytes', 'utf8')
    const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex')
    const build = async (options: ComponentBuildOptions): Promise<ComponentBuildResult> => {
      calls.push(options)
      await mkdir(options.componentsRoot!, { recursive: true })
      const result = {
        ...buildResult(options.componentsRoot!, archiveSha256),
        bytes: archiveBytes.length,
      }
      await writeFile(result.archivePath, archiveBytes)
      return result
    }

    const result = await buildComponentTwice({
      repoRoots,
      cacheRoot,
      runsRoot,
      allowDownload: false,
      build,
    })

    expect(result).toEqual({
      first: { ...buildResult(path.join(runsRoot, 'first'), archiveSha256), bytes: archiveBytes.length },
      second: { ...buildResult(path.join(runsRoot, 'second'), archiveSha256), bytes: archiveBytes.length },
    })
    expect(calls).toEqual([
      { repoRoot: repoRoots[0], componentsRoot: path.join(runsRoot, 'first'), cacheRoot, allowDownload: false },
      { repoRoot: repoRoots[1], componentsRoot: path.join(runsRoot, 'second'), cacheRoot, allowDownload: false },
    ])

    let invocation = 0
    await expect(buildComponentTwice({
      repoRoots,
      cacheRoot,
      runsRoot,
      allowDownload: false,
      build: async (options) => {
        await mkdir(options.componentsRoot!, { recursive: true })
        const bytes = Buffer.from(invocation++ === 0 ? 'first archive' : 'other archive', 'utf8')
        const result = {
          ...buildResult(options.componentsRoot!, createHash('sha256').update(bytes).digest('hex')),
          bytes: bytes.length,
        }
        await writeFile(result.archivePath, bytes)
        return result
      },
    })).rejects.toThrow('not reproducible')
  })

  it('verifies each archive on disk before trusting matching self-reported build identities', async () => {
    const root = await temporaryRoot('arkdown-markitdown-build-evidence-')
    const reportedBytes = Buffer.from('locked bytes!', 'utf8')
    const tamperedBytes = Buffer.from('tamper bytes!', 'utf8')
    const reportedSha256 = createHash('sha256').update(reportedBytes).digest('hex')
    let invocation = 0

    await expect(buildComponentTwice({
      repoRoots: [path.join(root, 'lf-repo'), path.join(root, 'crlf-repo')],
      cacheRoot: path.join(root, 'cache'),
      runsRoot: path.join(root, 'runs'),
      allowDownload: false,
      build: async (options) => {
        await mkdir(options.componentsRoot!, { recursive: true })
        const result = {
          ...buildResult(options.componentsRoot!, reportedSha256),
          bytes: reportedBytes.length,
        }
        await writeFile(result.archivePath, invocation++ === 0 ? tamperedBytes : reportedBytes)
        return result
      },
    })).rejects.toThrow('SHA-256')
  })

  it('compares the complete public build identity rather than only paths', () => {
    const first = buildResult('first')
    expect(() => assertMatchingBuildResults(first, buildResult('second'))).not.toThrow()
    expect(() => assertMatchingBuildResults(first, { ...buildResult('second'), bytes: 124 })).toThrow('not reproducible')
    expect(() => assertMatchingBuildResults(first, { ...buildResult('second'), version: '0.1.7-py3.12.10', sha256: 'b'.repeat(64) }))
      .toThrow('not reproducible')
  })

  it('uses one verified immutable archive byte snapshot for preflight and extraction', async () => {
    const root = await temporaryRoot('arkdown-markitdown-snapshot-')
    const archivePath = path.join(root, 'component.tar.gz')
    const bytes = Buffer.from('verified archive bytes', 'utf8')
    await writeFile(archivePath, bytes)
    const result = {
      ...buildResult(root, createHash('sha256').update(bytes).digest('hex')),
      archivePath,
      bytes: bytes.length,
    }

    const snapshot = await readVerifiedArchive(result)
    await writeFile(archivePath, Buffer.from('replaced after snapshot', 'utf8'))
    expect(snapshot).toEqual(bytes)
  })

  it('rejects unsafe tar entry types, aliases, duplicates, and file-tree conflicts before extraction', () => {
    expect(() => assertSafeArchiveEntries([
      { path: 'python.exe', type: 'File' },
      { path: 'Lib/site-packages/safe_pkg/__init__.py', type: 'File' },
      { path: 'component-manifest.json', type: 'File' },
    ])).not.toThrow()

    for (const entries of [
      [{ path: '../escape.py', type: 'File' }],
      [{ path: 'Lib\\site-packages\\alias.py', type: 'File' }],
      [{ path: 'python.exe', type: 'SymbolicLink' }],
      [{ path: 'python.exe', type: 'File' }, { path: 'python.exe', type: 'File' }],
      [{ path: 'Lib/site-packages/Name.py', type: 'File' }, { path: 'lib/site-packages/name.py', type: 'File' }],
      [{ path: 'Lib/site-packages/name.py', type: 'File' }, { path: 'Lib/site-packages/name.py.', type: 'File' }],
      [{ path: 'Lib/site-packages/pkg', type: 'File' }, { path: 'Lib/site-packages/pkg/module.py', type: 'File' }],
    ]) {
      expect(() => assertSafeArchiveEntries(entries)).toThrow('archive')
    }
  })

  it('rejects every trailing-dot or trailing-space archive segment without requiring an alias collision', () => {
    for (const entryPath of [
      'Lib/site-packages/safe_pkg./module.py',
      'Lib/site-packages/safe_pkg /module.py',
      'Lib/site-packages/safe_pkg/module.py.',
      'Lib/site-packages/safe_pkg/module.py ',
    ]) {
      expect(() => assertSafeArchiveEntries([{ path: entryPath, type: 'File' }])).toThrow('archive')
    }
  })

  it('rejects Windows DOS device basenames with extensions and case variants', () => {
    for (const entryPath of [
      'Lib/site-packages/CON/module.py',
      'Lib/site-packages/safe_pkg/con.py',
      'Lib/site-packages/safe_pkg/PrN.txt',
      'Lib/site-packages/safe_pkg/AUX',
      'Lib/site-packages/safe_pkg/nul.JSON',
      'Lib/site-packages/safe_pkg/COM1.dll',
      'Lib/site-packages/safe_pkg/com9.data',
      'Lib/site-packages/safe_pkg/LPT1',
      'Lib/site-packages/safe_pkg/lpt9.py',
    ]) {
      expect(() => assertSafeArchiveEntries([{ path: entryPath, type: 'File' }])).toThrow('archive')
    }

    expect(() => assertSafeArchiveEntries([
      { path: 'Lib/site-packages/safe_pkg/console.py', type: 'File' },
      { path: 'Lib/site-packages/safe_pkg/auxiliary.py', type: 'File' },
      { path: 'Lib/site-packages/safe_pkg/com10.dll', type: 'File' },
      { path: 'Lib/site-packages/safe_pkg/lpt10.py', type: 'File' },
    ])).not.toThrow()
  })

  it('verifies internal manifest paths, sizes, hashes, and exact payload membership', async () => {
    const root = await temporaryRoot('arkdown-markitdown-manifest-')
    const payload = Buffer.from('safe\n', 'utf8')
    const payloadHash = createHash('sha256').update(payload).digest('hex')
    await writeFile(path.join(root, 'arkdown_markitdown.py'), payload)
    await writeFile(path.join(root, 'component-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      version: '0.1.7-py3.12.10',
      pythonVersion: '3.12.10',
      platform: 'win-x64',
      lockSha256: SHA256,
      files: [{ path: 'arkdown_markitdown.py', bytes: payload.length, sha256: payloadHash }],
    }))

    await expect(verifyInternalManifest(root, SHA256)).resolves.toEqual({ files: 1 })
    await writeFile(path.join(root, 'THIRD_PARTY_LICENSES.txt'), 'unexpected\n')
    await expect(verifyInternalManifest(root, SHA256)).rejects.toThrow('manifest')
  })

  it('reopens a real archive and reconciles manifests, distributions, licenses, and smoke results', async () => {
    const root = await temporaryRoot('arkdown-markitdown-inspect-')
    const repoRoot = path.join(root, 'repo')
    const stageRoot = path.join(root, 'stage')
    const outputRoot = path.join(root, 'output')
    const extractionRoot = path.join(root, 'extracted')
    const sitePackages = path.join(stageRoot, 'Lib', 'site-packages')
    const distInfo = path.join(sitePackages, 'markitdown-0.1.7.dist-info')
    await mkdir(path.join(repoRoot, 'scripts', 'markitdown'), { recursive: true })
    await mkdir(distInfo, { recursive: true })
    await mkdir(outputRoot)
    const lock = {
      schemaVersion: 1,
      componentVersion: '0.1.7',
      pythonVersion: '3.12.10',
      platform: 'win-x64',
      python: {
        filename: 'python.zip',
        url: 'https://www.python.org/python.zip',
        bytes: 1,
        sha256: SHA256,
      },
      pipBootstrap: {
        filename: 'get-pip.py',
        url: 'https://bootstrap.pypa.io/get-pip.py',
        bytes: 1,
        sha256: SHA256,
      },
      pipWheel: {
        filename: 'pip.whl',
        url: 'https://files.pythonhosted.org/pip.whl',
        bytes: 1,
        sha256: SHA256,
      },
      wheels: [{
        name: 'markitdown',
        version: '0.1.7',
        filename: 'markitdown.whl',
        url: 'https://files.pythonhosted.org/markitdown.whl',
        bytes: 1,
        sha256: SHA256,
      }],
    }
    await writeFile(
      path.join(repoRoot, 'scripts', 'markitdown', 'component-lock.json'),
      JSON.stringify(lock),
    )
    const payloads = new Map<string, Buffer>([
      ['python.exe', Buffer.from('embedded python', 'utf8')],
      ['LICENSE.txt', Buffer.from('Python license\n', 'utf8')],
      ['arkdown_markitdown.py', Buffer.from('print("safe")\n', 'utf8')],
      ['Lib/site-packages/markitdown-0.1.7.dist-info/METADATA', Buffer.from('Name: markitdown\nVersion: 0.1.7\nLicense: MIT\n', 'utf8')],
      ['THIRD_PARTY_LICENSES.txt', Buffer.from([
        'Arkdown MarkItDown component third-party license inventory',
        'Component: 0.1.7-py3.12.10',
        `Python: 3.12.10 (${lock.python.url}; SHA-256 ${lock.python.sha256})`,
        '',
        '=== markitdown 0.1.7 ===',
        `Source: ${lock.wheels[0]!.url}`,
        `SHA-256: ${lock.wheels[0]!.sha256}`,
        'License-Expression: Not declared',
        'License: MIT',
        '',
      ].join('\n'), 'utf8')],
    ])
    for (const [relative, bytes] of payloads) {
      const absolute = path.join(stageRoot, ...relative.split('/'))
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, bytes)
    }
    const lockSha256 = createHash('sha256').update(canonicalJsonBytes(lock)).digest('hex')
    const manifestFiles = [...payloads.entries()].map(([entryPath, bytes]) => ({
      path: entryPath,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    await writeFile(path.join(stageRoot, 'component-manifest.json'), JSON.stringify({
      schemaVersion: 1,
      version: '0.1.7-py3.12.10',
      pythonVersion: '3.12.10',
      platform: 'win-x64',
      lockSha256,
      files: manifestFiles,
    }))

    const archivePath = path.join(outputRoot, 'arkdown-markitdown-0.1.7-py3.12.10-win-x64.tar.gz')
    const archiveEntries = [...payloads.keys(), 'component-manifest.json'].sort()
    await tar.create({
      cwd: stageRoot,
      file: archivePath,
      gzip: { level: 9 },
      mtime: new Date(0),
      noDirRecurse: true,
      portable: true,
    }, archiveEntries)
    const archiveBytes = await readFile(archivePath)
    const result: ComponentBuildResult = {
      archivePath,
      manifestPath: path.join(outputRoot, 'manifest.json'),
      version: '0.1.7-py3.12.10',
      bytes: (await stat(archivePath)).size,
      sha256: createHash('sha256').update(archiveBytes).digest('hex'),
    }
    await writeFile(result.manifestPath, `${JSON.stringify(publicManifest(result))}\n`)

    const audit = await inspectBuiltComponent(result, {
      repoRoot,
      extractionRoot,
      smoke: async () => [
        { format: 'pdf', chars: 1 },
        { format: 'pptx', chars: 2 },
        { format: 'xlsx', chars: 3 },
        { format: 'epub', chars: 4 },
      ],
    })
    expect(audit).toEqual({
      archiveEntries: 6,
      manifestFiles: 5,
      distributions: 1,
      licenseSections: 1,
      smokeConversions: 4,
    })
  })

  it('materializes an equivalent CRLF component-source checkout for the second full build', async () => {
    const root = await temporaryRoot('arkdown-markitdown-eol-variant-')
    const repoRoot = path.join(root, 'repo')
    const variantRoot = path.join(root, 'variant')
    const sourceRoot = path.join(repoRoot, 'scripts', 'markitdown')
    await mkdir(sourceRoot, { recursive: true })
    const files = new Map([
      ['component-lock.json', '{\n  "schemaVersion": 1\n}\n'],
      ['arkdown_markitdown.py', 'print("safe")\n'],
      ['create_epub_fixture.py', 'print("fixture")\n'],
      ['requirements.in', 'markitdown==0.1.7\n'],
    ])
    for (const [name, content] of files) await writeFile(path.join(sourceRoot, name), content)

    await createCrLfSourceVariant(repoRoot, variantRoot)

    for (const [name, content] of files) {
      const variant = await readFile(path.join(variantRoot, 'scripts', 'markitdown', name), 'utf8')
      expect(variant).toBe(content.replaceAll('\n', '\r\n'))
      expect(variant).not.toMatch(/(?<!\r)\n/u)
    }
  })

  it('writes a new concise report for both successful and failed release verification', async () => {
    const root = await temporaryRoot('arkdown-markitdown-report-')
    const success = await runReportedVerification(root, false, async () => ({ evidence: 'verified' }))
    expect(success.report).toEqual({
      schemaVersion: 1,
      createdAt: expect.any(String),
      ok: true,
      allowDownload: false,
      result: { evidence: 'verified' },
    })
    expect(JSON.parse(await readFile(success.reportPath, 'utf8'))).toEqual(success.report)

    const failure = await runReportedVerification(root, true, async () => {
      throw new Error('deliberate verification failure')
    })
    expect(failure.report).toEqual({
      schemaVersion: 1,
      createdAt: expect.any(String),
      ok: false,
      allowDownload: true,
      error: 'deliberate verification failure',
    })
    expect(failure.reportPath).not.toBe(success.reportPath)
    expect(JSON.parse(await readFile(failure.reportPath, 'utf8'))).toEqual(failure.report)
  })

  it('orchestrates the CRLF build variant and audits the matching final archive', async () => {
    const root = await temporaryRoot('arkdown-markitdown-release-')
    const repoRoot = path.join(root, 'repo')
    const componentsRoot = path.join(root, 'components')
    const first = buildResult(path.join(componentsRoot, 'verification', 'current', 'runs', 'first'))
    const second = buildResult(path.join(componentsRoot, 'verification', 'current', 'runs', 'second'))
    const audit = {
      archiveEntries: 4498,
      manifestFiles: 4497,
      distributions: 41,
      licenseSections: 41,
      smokeConversions: 4,
    }
    const events: string[] = []

    const result = await verifyMarkItDownRelease({ repoRoot, componentsRoot, allowDownload: false }, {
      createVariant: async (source, destination) => {
        events.push(`variant:${source}:${destination}`)
      },
      buildTwice: async (options) => {
        events.push(`build:${options.cacheRoot}:${options.allowDownload}`)
        return { first, second }
      },
      inspect: async (build, options) => {
        events.push(`inspect:${build.archivePath}:${options.repoRoot}:${options.extractionRoot}`)
        return audit
      },
    })

    expect(result).toEqual({
      version: second.version,
      archiveName: path.basename(second.archivePath),
      bytes: second.bytes,
      sha256: second.sha256,
      builds: [
        { sourceEol: 'lf', bytes: first.bytes, sha256: first.sha256 },
        { sourceEol: 'crlf', bytes: second.bytes, sha256: second.sha256 },
      ],
      audit,
    })
    expect(events).toEqual([
      `variant:${repoRoot}:${path.join(componentsRoot, 'verification', 'current', 'crlf-source')}`,
      `build:${path.join(componentsRoot, 'cache')}:false`,
      `inspect:${second.archivePath}:${repoRoot}:${path.join(componentsRoot, 'verification', 'current', 'extracted')}`,
    ])
  })
})
