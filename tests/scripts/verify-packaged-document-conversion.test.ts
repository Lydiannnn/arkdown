import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import * as tar from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTrackedSpawn,
  renderPackagedDocumentConversionMarkdown,
  verifyPackagedDocumentConversion,
} from '../../scripts/verify-packaged-document-conversion'
import type { MarkItDownSpawnedChild, MarkItDownSpawn } from '../../src/main/document-conversion/markitdown-runner'
import type { DocumentConversionComponentDescriptor } from '../../src/shared/document-conversion'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const FIXTURE_SECRET = 'EXTRACTED_FIXTURE_SECRET_MUST_NOT_LEAK'

const AUTHORIZED_SAMPLES = [
  ['pdf-1', 'pdf', '爱员工offer letter-杨鹏飞.pdf'],
  ['pdf-2', 'pdf', '个人简历(1).pdf'],
  ['pdf-3', 'pdf', 'assets/weekly_report_2026_0706_0710.pdf'],
  ['pptx-1', 'pptx', '车管家咨询服务讨论案.pptx'],
  ['pptx-2', 'pptx', 'DirectX_11_Technology_Update_US.pptx'],
  ['xlsx-1', 'xlsx', '模板规则速查表.xlsx'],
  ['xlsx-large', 'xlsx', '吉香居资料.xlsx'],
] as const

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true })
  }))
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function createPackagedComponentFixture(packageRoot: string): Promise<DocumentConversionComponentDescriptor> {
  const tree = await temporaryRoot('arkdown-packaged-verifier-tree-')
  const files = {
    'arkdown_markitdown.py': 'print("fixture")\n',
    'Lib/site-packages/markitdown.py': 'VERSION = "9.8.7"\n',
    'python.exe': 'not-a-real-executable',
  } as const
  for (const [relative, contents] of Object.entries(files)) {
    const destination = path.join(tree, ...relative.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, contents, 'utf8')
  }
  const componentManifest = {
    schemaVersion: 1,
    version: '9.8.7',
    pythonVersion: '3.12.10',
    platform: 'win-x64',
    lockSha256: 'a'.repeat(64),
    files: Object.entries(files)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([relative, contents]) => ({
        path: relative,
        bytes: Buffer.byteLength(contents),
        sha256: sha256(Buffer.from(contents)),
      })),
  }
  await writeFile(path.join(tree, 'component-manifest.json'), `${JSON.stringify(componentManifest)}\n`)

  const archiveName = 'fixture-document-converter.tar.gz'
  const resources = path.join(packageRoot, 'resources', 'document-conversion')
  await mkdir(resources, { recursive: true })
  const archivePath = path.join(resources, archiveName)
  await tar.c({
    cwd: tree,
    file: archivePath,
    gzip: true,
    portable: true,
  }, (await readdir(tree)).sort())
  const archive = await readFile(archivePath)
  const descriptor: DocumentConversionComponentDescriptor = {
    source: 'packaged',
    version: '9.8.7',
    archiveName,
    bytes: archive.byteLength,
    sha256: sha256(archive),
    url: null,
  }
  await writeFile(path.join(resources, 'manifest.json'), `${JSON.stringify({
    version: descriptor.version,
    archiveName: descriptor.archiveName,
    bytes: descriptor.bytes,
    sha256: descriptor.sha256,
  })}\n`)
  return descriptor
}

async function createAuthorizedSamples(sampleRoot: string): Promise<void> {
  for (const [id, _format, relative] of AUTHORIZED_SAMPLES) {
    const destination = path.join(sampleRoot, ...relative.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, `source-${id}`, 'utf8')
  }
  await writeFile(path.join(sampleRoot, 'not-authorized.pdf'), 'must-not-be-discovered', 'utf8')
}

async function createRawResolverFixture(
  escapeKind: 'traversal' | 'absolute' | 'file-url' | 'junction-shadow',
): Promise<{ root: string; script: string }> {
  const root = await temporaryRoot('arkdown-packaged-verifier-resolver-')
  const script = path.join(root, 'scripts', 'verify-packaged-document-conversion.ts')
  const outside = path.join(root, 'outside.ts')
  await mkdir(path.dirname(script), { recursive: true })
  await copyFile(path.resolve('scripts', 'verify-packaged-document-conversion.ts'), script)
  await writeFile(outside, 'export const escaped = true\n', 'utf8')
  const escapeSpecifier = escapeKind === 'traversal'
    ? '../../../outside'
    : escapeKind === 'absolute'
      ? outside
      : escapeKind === 'file-url' ? pathToFileURL(outside).href : './escape-target'
  const modules: Record<string, string> = {
    'src/main/document-conversion/component-artifact-source.ts': [
      `import ${JSON.stringify(escapeSpecifier)}`,
      'export class PackagedArtifactSource {}',
    ].join('\n'),
    'src/main/document-conversion/component-manager.ts': 'export function createDocumentConversionComponentManager() {}\n',
    'src/main/document-conversion/markitdown-runner.ts': 'export function createMarkItDownRunner() {}\n',
    'src/main/document-conversion/document-conversion-service.ts': 'export class DocumentConversionService {}\n',
    'src/main/document-conversion/document-conversion-lifecycle.ts': 'export function createDocumentConversionRuntimeLifecycle() {}\n',
    'src/shared/document-conversion-component-manifest.ts': 'export const DOCUMENT_CONVERSION_COMPONENT_MANIFEST = {}\n',
    'src/shared/document-conversion.ts': 'export function documentConversionTimeoutMs() { return 1 }\n',
  }
  if (escapeKind === 'junction-shadow') {
    modules['src/main/document-conversion/escape-target.ts'] = 'export const safeShadow = true\n'
  }
  for (const [relativePath, source] of Object.entries(modules)) {
    const destination = path.join(root, ...relativePath.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, source, 'utf8')
  }
  if (escapeKind === 'junction-shadow') {
    const outsideDirectory = path.join(root, 'outside-target')
    await mkdir(outsideDirectory)
    await writeFile(path.join(outsideDirectory, 'index.ts'), 'export const escaped = true\n', 'utf8')
    await symlink(
      outsideDirectory,
      path.join(root, 'src', 'main', 'document-conversion', 'escape-target'),
      'junction',
    )
  }
  return { root, script }
}

class FakeChild extends EventEmitter implements MarkItDownSpawnedChild {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit('close', null, 'SIGTERM'))
    return true
  })
}

class ManualTrackedChild extends EventEmitter implements MarkItDownSpawnedChild {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid: number | undefined
  readonly kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>

  constructor(options: {
    pid?: number
    kill?: (signal?: NodeJS.Signals) => boolean
  } = {}) {
    super()
    this.pid = options.pid
    this.kill = vi.fn(options.kill ?? (() => true))
  }
}

function startTrackedConversion(
  tracker: ReturnType<typeof createTrackedSpawn>,
  inputPath: string,
): MarkItDownSpawnedChild {
  return tracker.spawn('python', ['--input', inputPath], {
    cwd: process.cwd(),
    windowsHide: true,
    shell: false,
    env: {
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  })
}

function controlledSpawn(): { spawn: MarkItDownSpawn; convertedInputs: string[] } {
  const convertedInputs: string[] = []
  const spawn: MarkItDownSpawn = (_command, args) => {
    const child = new FakeChild()
    const inputFlag = args.indexOf('--input')
    if (inputFlag === -1) {
      const epubDestination = args.at(-1)!
      queueMicrotask(() => {
        void writeFile(epubDestination, 'deterministic-epub', 'utf8')
          .then(() => child.emit('close', 0, null))
      })
      return child
    }

    const input = args[inputFlag + 1]!
    convertedInputs.push(input)
    if (path.basename(input) === 'cancellation.xlsx') return child
    const output = args[args.indexOf('--output') + 1]!
    const status = args[args.indexOf('--status') + 1]!
    const markdown = `# ${FIXTURE_SECRET}\n\n- item\n\n| a | b |\n| - | - |\n| 1 | 2 |\n`
    queueMicrotask(() => {
      void Promise.all([
        writeFile(output, markdown, 'utf8'),
        writeFile(status, JSON.stringify({ ok: true, chars: [...markdown].length }), 'utf8'),
      ]).then(() => child.emit('close', 0, null))
    })
    return child
  }
  return { spawn, convertedInputs }
}

describe('packaged document conversion verifier', () => {
  it.each(['packaged', 'COS'] as const)('runs the real %s source, manager, runner, service, and lifecycle without leaking document data', async source => {
    const packageRoot = await temporaryRoot('arkdown-packaged-verifier-package-')
    const sampleRoot = await temporaryRoot('arkdown-packaged-verifier-samples-')
    const tempParent = await temporaryRoot('arkdown-packaged-verifier-parent-')
    let descriptor = await createPackagedComponentFixture(packageRoot)
    if (source === 'COS') {
      const archive = await readFile(path.join(packageRoot, 'resources/document-conversion', descriptor.archiveName))
      const base = 'https://arkdown-downloads-1257382433.cos.ap-guangzhou.myqcloud.com/components/markitdown-0.1.7-py3.12.10/'
      descriptor = { ...descriptor, source: 'https', url: `${base}${descriptor.archiveName}` }
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        expect(init.redirect).toBe('manual')
        if (url === `${base}manifest.json`) return new Response(JSON.stringify(descriptor))
        if (url === descriptor.url) return new Response(archive, { headers: { 'content-length': String(archive.length) } })
        throw new Error('Unexpected component verification URL')
      })
    }
    await createAuthorizedSamples(sampleRoot)
    const fake = controlledSpawn()

    const report = await verifyPackagedDocumentConversion({
      descriptor,
      packageRoot,
      repositoryRoot: path.resolve('.'),
      sampleRoot,
      spawn: fake.spawn,
      tempParent,
    })

    expect(report.schemaVersion).toBe(1)
    expect(report.component).toEqual({
      initialStatus: 'absent',
      installedStatus: 'installed',
      removedStatus: 'absent',
      reinstalledStatus: 'installed',
      version: '9.8.7',
    })
    expect(report.samples.map(({ id, format }) => [id, format])).toEqual([
      ['pdf-1', 'pdf'],
      ['pdf-2', 'pdf'],
      ['pdf-3', 'pdf'],
      ['pptx-1', 'pptx'],
      ['pptx-2', 'pptx'],
      ['xlsx-1', 'xlsx'],
      ['xlsx-large', 'xlsx'],
      ['epub-1', 'epub'],
    ])
    for (const sample of report.samples) {
      expect(sample.cacheReused).toBe(true)
      expect(sample.coldSpawnCount).toBe(1)
      expect(sample.warmSpawnCount).toBe(0)
      expect(sample.sourceBefore).toEqual(sample.sourceAfter)
      expect(sample.structure).toEqual({
        bytes: expect.any(Number),
        characters: expect.any(Number),
        headings: 1,
        listItems: 1,
        tableRows: 3,
        replacementCharacters: 0,
      })
      expect(sample.outputSha256).toMatch(/^[0-9a-f]{64}$/u)
      expect(sample.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
    }
    expect(report.sourceModification).toMatchObject({
      id: 'modified-copy',
      invalidated: true,
      spawnCount: 2,
    })
    expect(report.cancellation).toEqual({
      id: 'xlsx-large-cancel-copy',
      cancelled: true,
      childKilled: true,
      taskDirectoriesRemaining: 0,
    })
    expect(report.removal).toEqual({
      activeRemaining: false,
      backupEntriesRemaining: 0,
      stagingEntriesRemaining: 0,
    })
    expect(report.shutdown).toEqual({
      drained: true,
      childKilled: true,
      leaseReleased: true,
      taskDirectoriesRemaining: 0,
    })
    expect(report.timeoutBoundsMs).toEqual({ pdf: 120_000, pptx: 120_000, xlsx: 300_000, epub: 120_000 })
    expect(report.cleanup).toEqual({ pythonChildrenRemaining: 0, harnessRootsRemaining: 0 })

    const serialized = JSON.stringify(report)
    const markdown = renderPackagedDocumentConversionMarkdown(report)
    for (const forbidden of [
      FIXTURE_SECRET,
      packageRoot,
      sampleRoot,
      tempParent,
      '爱员工offer letter-杨鹏飞.pdf',
      '吉香居资料.xlsx',
      'not-authorized.pdf',
    ]) {
      expect(serialized).not.toContain(forbidden)
      expect(markdown).not.toContain(forbidden)
    }
    expect(fake.convertedInputs.some((input) => input.endsWith('not-authorized.pdf'))).toBe(false)
  }, 30_000)

  it('loads the production TypeScript graph from the raw Node 24 entry point', async () => {
    const result = await execFileAsync(process.execPath, [
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      'scripts/verify-packaged-document-conversion.ts',
      '--help',
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(
      'Usage: verify-packaged-document-conversion --package-root <absolute-path> --sample-root <absolute-path>\n',
    )
  })

  it.each([
    ['parent traversal', 'traversal'],
    ['absolute path', 'absolute'],
    ['file URL', 'file-url'],
    ['outside junction shadowed by an in-src .ts fallback', 'junction-shadow'],
  ] as const)('rejects a raw-Node src import escape through %s without leaking paths', async (_label, kind) => {
    const fixture = await createRawResolverFixture(kind)
    let failure: unknown
    try {
      await execFileAsync(process.execPath, [
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        fixture.script,
        '--help',
      ], {
        cwd: fixture.root,
        encoding: 'utf8',
        windowsHide: true,
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      code: 1,
      stdout: '',
      stderr: 'packaged_document_conversion_verification_failed\n',
    })
    expect(JSON.stringify(failure)).not.toContain(fixture.root)
    expect(JSON.stringify(failure)).not.toContain('outside.ts')
  })

  it('keeps an errored spawned process active until close and only confirms an observed requested signal', async () => {
    const child = new ManualTrackedChild({ pid: 101, kill: () => true })
    const tracker = createTrackedSpawn(() => child, 20)
    const inputPath = path.resolve('tracked-input.pdf')
    const wrapped = startTrackedConversion(tracker, inputPath)
    const record = await tracker.waitForConversion(inputPath, 0)

    expect(wrapped.kill('SIGTERM')).toBe(true)
    expect(record.killed).toBe(false)
    child.emit('error', new Error('error-before-close'))
    expect(tracker.activeCount()).toBe(1)
    expect(record.killed).toBe(false)

    child.emit('close', null, 'SIGTERM')
    await tracker.waitForIdle()
    expect(tracker.activeCount()).toBe(0)
    expect(record.killed).toBe(true)
  })

  it.each([
    ['returned false', (): boolean => false],
    ['threw', (): boolean => { throw new Error('kill-failed') }],
  ] as const)('does not report cleanup complete when kill %s before close', async (_label, kill) => {
    const child = new ManualTrackedChild({ pid: 102, kill })
    const tracker = createTrackedSpawn(() => child, 20)
    const inputPath = path.resolve('uncleaned-input.pdf')
    const wrapped = startTrackedConversion(tracker, inputPath)
    const record = await tracker.waitForConversion(inputPath, 0)

    expect(wrapped.kill('SIGTERM')).toBe(false)
    child.emit('error', new Error('still-not-close'))
    expect(tracker.activeCount()).toBe(1)
    await expect(tracker.waitForIdle()).rejects.toThrow('python_child_cleanup_timeout')
    expect(record.killed).toBe(false)

    child.emit('close', 1, null)
    await tracker.waitForIdle()
    expect(tracker.activeCount()).toBe(0)
    expect(record.killed).toBe(false)
  })

  it('does not mark an accepted kill as confirmed when close reports a different signal', async () => {
    const child = new ManualTrackedChild({ pid: 103, kill: () => true })
    const tracker = createTrackedSpawn(() => child, 20)
    const inputPath = path.resolve('differently-closed-input.pdf')
    const wrapped = startTrackedConversion(tracker, inputPath)
    const record = await tracker.waitForConversion(inputPath, 0)

    expect(wrapped.kill('SIGTERM')).toBe(true)
    child.emit('close', null, 'SIGKILL')
    child.emit('error', new Error('error-after-close'))
    await tracker.waitForIdle()
    expect(record.killed).toBe(false)
  })

  it('confirms an accepted kill when close races synchronously with the kill return', async () => {
    let child!: ManualTrackedChild
    child = new ManualTrackedChild({
      pid: 105,
      kill: () => {
        child.emit('close', null, 'SIGTERM')
        return true
      },
    })
    const tracker = createTrackedSpawn(() => child, 20)
    const inputPath = path.resolve('synchronously-closed-input.pdf')
    const wrapped = startTrackedConversion(tracker, inputPath)
    const record = await tracker.waitForConversion(inputPath, 0)

    expect(wrapped.kill('SIGTERM')).toBe(true)
    await tracker.waitForIdle()
    expect(record.killed).toBe(true)
  })

  it('keeps shutdown cleanup pending until an accepted kill is observed closing the child', async () => {
    const child = new ManualTrackedChild({ pid: 106, kill: () => true })
    const tracker = createTrackedSpawn(() => child, 20)
    const inputPath = path.resolve('shutdown-input.pdf')
    startTrackedConversion(tracker, inputPath)
    const record = await tracker.waitForConversion(inputPath, 0)

    tracker.killActive()
    expect(record.killed).toBe(false)
    await expect(tracker.waitForIdle()).rejects.toThrow('python_child_cleanup_timeout')
    child.emit('close', null, 'SIGTERM')
    await tracker.waitForIdle()
    expect(record.killed).toBe(true)
  })

  it('treats an error without a pid as a proven spawn failure', async () => {
    const child = new ManualTrackedChild()
    const tracker = createTrackedSpawn(() => child, 20)
    startTrackedConversion(tracker, path.resolve('spawn-failure-input.pdf'))

    child.emit('error', new Error('spawn-failed'))
    await tracker.waitForIdle()
    expect(tracker.activeCount()).toBe(0)
  })

  it('terminates a hanging EPUB fixture generator within a bounded interval and cleans its run root', async () => {
    const packageRoot = await temporaryRoot('arkdown-packaged-verifier-package-')
    const sampleRoot = await temporaryRoot('arkdown-packaged-verifier-samples-')
    const tempParent = await temporaryRoot('arkdown-packaged-verifier-parent-')
    const descriptor = await createPackagedComponentFixture(packageRoot)
    await createAuthorizedSamples(sampleRoot)
    const conversions = controlledSpawn()
    let generatorStarted!: (child: ManualTrackedChild) => void
    const generator = new Promise<ManualTrackedChild>((resolve) => { generatorStarted = resolve })
    const spawn: MarkItDownSpawn = (command, args, options) => {
      if (args.includes('--input')) return conversions.spawn(command, args, options)
      let child!: ManualTrackedChild
      child = new ManualTrackedChild({
        pid: 104,
        kill: () => {
          queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
          return true
        },
      })
      generatorStarted(child)
      return child
    }
    const verificationOptions: Parameters<typeof verifyPackagedDocumentConversion>[0] & {
      fixtureGeneratorTimeoutMs: number
      cleanupTimeoutMs: number
    } = {
      cleanupTimeoutMs: 20,
      descriptor,
      fixtureGeneratorTimeoutMs: 20,
      packageRoot,
      repositoryRoot: path.resolve('.'),
      sampleRoot,
      spawn,
      tempParent,
    }

    vi.useFakeTimers()
    try {
      const verification = verifyPackagedDocumentConversion(verificationOptions)
      const child = await generator
      await vi.advanceTimersByTimeAsync(21)
      const timeoutRequestedTermination = child.kill.mock.calls.some(([signal]) => signal === 'SIGTERM')
      if (!timeoutRequestedTermination) child.emit('close', 1, null)

      await expect(verification).rejects.toThrow('packaged_document_conversion_verification_failed')
      expect(timeoutRequestedTermination).toBe(true)
      expect(await readdir(tempParent)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans only successfully allocated verifier roots when a later temporary allocation fails', async () => {
    const packageRoot = await temporaryRoot('arkdown-packaged-verifier-package-')
    const sampleRoot = await temporaryRoot('arkdown-packaged-verifier-samples-')
    const tempParent = await temporaryRoot('arkdown-packaged-verifier-parent-')
    await createAuthorizedSamples(sampleRoot)
    const callerDirectory = path.join(tempParent, 'arkdown-packaged-doc-verifier-caller-data')
    const callerSentinel = path.join(callerDirectory, 'keep.txt')
    await mkdir(callerDirectory)
    await writeFile(callerSentinel, 'caller-owned', 'utf8')
    const verificationOptions: Parameters<typeof verifyPackagedDocumentConversion>[0] = {
      failTemporaryRootAllocationAt: 3,
      packageRoot,
      repositoryRoot: path.resolve('.'),
      sampleRoot,
      tempParent,
    }

    await expect(verifyPackagedDocumentConversion(verificationOptions))
      .rejects.toThrow('packaged_document_conversion_verification_failed')
    expect((await lstat(tempParent)).isDirectory()).toBe(true)
    expect(await readdir(tempParent)).toEqual(['arkdown-packaged-doc-verifier-caller-data'])
    expect(await readFile(callerSentinel, 'utf8')).toBe('caller-owned')
  })

  it.each([0, 5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid temporary-allocation failure index %s without allocating a run root',
    async (failTemporaryRootAllocationAt) => {
      const packageRoot = await temporaryRoot('arkdown-packaged-verifier-package-')
      const sampleRoot = await temporaryRoot('arkdown-packaged-verifier-samples-')
      const tempParent = await temporaryRoot('arkdown-packaged-verifier-parent-')
      const verificationOptions: Parameters<typeof verifyPackagedDocumentConversion>[0] = {
        failTemporaryRootAllocationAt,
        packageRoot,
        repositoryRoot: path.resolve('.'),
        sampleRoot,
        tempParent,
      }

      await expect(verifyPackagedDocumentConversion(verificationOptions))
        .rejects.toThrow('invalid_packaged_verifier_configuration')
      expect(await readdir(tempParent)).toEqual([])
    },
  )

  it.each([1, 4])(
    'accepts boundary temporary-allocation failure index %s and cleans every earlier root',
    async (failTemporaryRootAllocationAt) => {
      const packageRoot = await temporaryRoot('arkdown-packaged-verifier-package-')
      const sampleRoot = await temporaryRoot('arkdown-packaged-verifier-samples-')
      const tempParent = await temporaryRoot('arkdown-packaged-verifier-parent-')
      await createAuthorizedSamples(sampleRoot)

      await expect(verifyPackagedDocumentConversion({
        failTemporaryRootAllocationAt,
        packageRoot,
        repositoryRoot: path.resolve('.'),
        sampleRoot,
        tempParent,
      })).rejects.toThrow('packaged_document_conversion_verification_failed')
      expect(await readdir(tempParent)).toEqual([])
    },
  )

  it('does not alter the caller-owned package or sample roots when a run is copied into isolation', async () => {
    const packageRoot = await temporaryRoot('arkdown-packaged-verifier-package-')
    const sampleRoot = await temporaryRoot('arkdown-packaged-verifier-samples-')
    const tempParent = await temporaryRoot('arkdown-packaged-verifier-parent-')
    const descriptor = await createPackagedComponentFixture(packageRoot)
    await createAuthorizedSamples(sampleRoot)
    const beforeArchive = await readFile(path.join(
      packageRoot, 'resources', 'document-conversion', descriptor.archiveName,
    ))
    const beforeSamples = await Promise.all(AUTHORIZED_SAMPLES.map(async ([, , relative]) => {
      const source = path.join(sampleRoot, ...relative.split('/'))
      return [source, await lstat(source), await readFile(source)] as const
    }))
    const fake = controlledSpawn()

    await verifyPackagedDocumentConversion({
      descriptor,
      packageRoot,
      repositoryRoot: path.resolve('.'),
      sampleRoot,
      spawn: fake.spawn,
      tempParent,
    })

    expect(await readFile(path.join(
      packageRoot, 'resources', 'document-conversion', descriptor.archiveName,
    ))).toEqual(beforeArchive)
    for (const [source, before, bytes] of beforeSamples) {
      const after = await lstat(source)
      expect(await readFile(source)).toEqual(bytes)
      expect(after.size).toBe(before.size)
      expect(after.mtimeMs).toBe(before.mtimeMs)
    }
  }, 30_000)
})
