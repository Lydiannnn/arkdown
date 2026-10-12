import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertAllowedArtifactUrl,
  assertAllowedArchiveTree,
  canonicalJsonBytes,
  embeddedPythonEnvironment,
  fetchAllowlistedArtifact,
  normalizeInstalledCommandWrapperBytes,
  normalizeTextBytes,
  obtainLockedArtifact,
  parseComponentLock,
  publicManifest,
  reconcileLockedDistributions,
  verifyArtifact,
} from '../../scripts/build-markitdown-component'

const SHA256 = 'a'.repeat(64)
const execFileAsync = promisify(execFile)
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (true) {
    try {
      await access(filePath)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

async function createFakeMarkitdown(root: string): Promise<string> {
  const fakeRoot = path.join(root, 'fake')
  const fakePackage = path.join(fakeRoot, 'markitdown')
  const converters = path.join(fakePackage, 'converters')
  await mkdir(converters, { recursive: true })
  await writeFile(path.join(fakePackage, '__init__.py'), [
    'import json, os, time',
    'class MarkItDown:',
    '    def __init__(self, **kwargs):',
    '        self.kwargs = kwargs',
    '        self.registered = []',
    '    def register_converter(self, converter):',
    '        self.registered.append(type(converter).__name__)',
    '    def convert_local(self, source):',
    '        markdown = "# Converted\\n\\nSafe body\\n"',
    '        ready = os.environ.get("ARKDOWN_RACE_READY")',
    '        if ready:',
    '            open(ready, "w", encoding="utf-8").close()',
    '            deadline = time.monotonic() + 10',
    '            release = os.environ["ARKDOWN_RACE_RELEASE"]',
    '            while not os.path.exists(release):',
    '                if time.monotonic() >= deadline: raise TimeoutError("race release timed out")',
    '                time.sleep(0.01)',
    '            with open(source, "r", encoding="utf-8") as source_handle:',
    '                markdown = source_handle.read()',
    '        with open(os.environ["ARKDOWN_FAKE_TRACE"], "w", encoding="utf-8") as handle:',
    '            json.dump({"kwargs": self.kwargs, "registered": self.registered, "source": source}, handle)',
    '        return type("Result", (), {"markdown": markdown})()',
    '',
  ].join('\n'), 'utf8')
  await writeFile(path.join(converters, '__init__.py'), [
    'class PdfConverter: pass',
    'class PptxConverter: pass',
    'class XlsxConverter: pass',
    'class EpubConverter: pass',
    '',
  ].join('\n'), 'utf8')
  return fakeRoot
}

function cliEnvironment(fakeRoot: string, trace: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONPATH: fakeRoot,
    PYTHONDONTWRITEBYTECODE: '1',
    ARKDOWN_FAKE_TRACE: trace,
  }
}

function validLock(): unknown {
  return {
    schemaVersion: 1,
    componentVersion: '0.1.7',
    pythonVersion: '3.12.10',
    platform: 'win-x64',
    python: {
      filename: 'python-3.12.10-embed-amd64.zip',
      url: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip',
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
      filename: 'pip-26.2.1-py3-none-any.whl',
      url: 'https://files.pythonhosted.org/packages/aa/bb/pip-26.2.1-py3-none-any.whl',
      bytes: 1,
      sha256: SHA256,
    },
    wheels: [{
      name: 'markitdown',
      version: '0.1.7',
      filename: 'markitdown-0.1.7-py3-none-any.whl',
      url: 'https://files.pythonhosted.org/packages/aa/bb/markitdown-0.1.7-py3-none-any.whl',
      bytes: 1,
      sha256: SHA256,
    }],
  }
}

describe('MarkItDown component builder validation', () => {
  it('normalizes component text and lock JSON independently of checkout EOLs', () => {
    const lfSource = Buffer.from('from __future__ import annotations\n\nprint("safe")\n', 'utf8')
    const crlfSource = Buffer.from('from __future__ import annotations\r\n\r\nprint("safe")\r\n', 'utf8')
    const normalizedLf = normalizeTextBytes(lfSource)
    const normalizedCrlf = normalizeTextBytes(crlfSource)

    expect(normalizedCrlf).toEqual(normalizedLf)
    expect(normalizedLf.toString('utf8')).toBe('from __future__ import annotations\n\nprint("safe")\n')
    expect(createHash('sha256').update(normalizedCrlf).digest('hex')).toBe(
      createHash('sha256').update(normalizedLf).digest('hex'),
    )

    const lfLock = '{\n  "pythonVersion": "3.12.10",\n  "schemaVersion": 1\n}\n'
    const crlfLock = '{\r\n  "schemaVersion": 1,\r\n  "pythonVersion": "3.12.10"\r\n}\r\n'
    expect(canonicalJsonBytes(JSON.parse(crlfLock))).toEqual(canonicalJsonBytes(JSON.parse(lfLock)))
    expect(canonicalJsonBytes(JSON.parse(lfLock)).toString('utf8')).toBe(
      '{"pythonVersion":"3.12.10","schemaVersion":1}\n',
    )
  })

  it('canonicalizes pip-generated command wrapper shebangs independently of the build path', () => {
    const first = Buffer.from('#!C:\\build\\first\\python.exe\r\nprint("safe")\n', 'utf8')
    const second = Buffer.from('#!C:\\different-length\\second\\python.exe\nprint("safe")\n', 'utf8')

    expect(normalizeInstalledCommandWrapperBytes(first)).toEqual(normalizeInstalledCommandWrapperBytes(second))
    expect(normalizeInstalledCommandWrapperBytes(first).toString('utf8')).toBe('#!python.exe\nprint("safe")\n')
    expect(normalizeInstalledCommandWrapperBytes(Buffer.from('print("no shebang")\n')))
      .toEqual(Buffer.from('print("no shebang")\n'))
  })

  it('rejects incomplete and non-exact lock objects', () => {
    expect(() => parseComponentLock({ pythonVersion: '3.12.10' })).toThrow('component lock')
    expect(() => parseComponentLock({
      ...(validLock() as Record<string, unknown>),
      unexpected: true,
    })).toThrow('component lock')
    expect(() => parseComponentLock(validLock())).not.toThrow()
  })

  it('requires a separately locked pip wheel for offline bootstrap', () => {
    const { pipWheel: _pipWheel, ...withoutPipWheel } = validLock() as Record<string, unknown>
    expect(() => parseComponentLock(withoutPipWheel)).toThrow('component lock')
  })

  it('allows artifacts only from the three pinned HTTPS origins', () => {
    expect(() => assertAllowedArtifactUrl('https://www.python.org/ftp/python/a.zip')).not.toThrow()
    expect(() => assertAllowedArtifactUrl('https://bootstrap.pypa.io/get-pip.py')).not.toThrow()
    expect(() => assertAllowedArtifactUrl('https://files.pythonhosted.org/packages/a.whl')).not.toThrow()
    expect(() => assertAllowedArtifactUrl('http://www.python.org/ftp/python/a.zip')).toThrow()
    expect(() => assertAllowedArtifactUrl('https://python.org.evil.invalid/a.zip')).toThrow()
    expect(() => assertAllowedArtifactUrl('https://user@www.python.org/a.zip')).toThrow()
  })

  it('rejects an unapproved redirect target before contacting it', async () => {
    const initial = 'https://www.python.org/first'
    const requests: string[] = []
    const request: typeof fetch = async (input) => {
      const url = String(input)
      requests.push(url)
      if (url !== initial) throw new Error(`unexpected outbound request: ${url}`)
      return new Response(null, {
        status: 302,
        headers: { location: 'https://unapproved.invalid/then-back' },
      })
    }

    await expect(fetchAllowlistedArtifact(initial, request)).rejects.toThrow('allowlisted')
    expect(requests).toEqual([initial])
  })

  it('follows only bounded, valid allowlisted redirects in manual mode', async () => {
    const initial = 'https://www.python.org/first'
    const redirected = 'https://www.python.org/second'
    const requests: Array<{ url: string; redirect?: RequestRedirect }> = []
    const request: typeof fetch = async (input, init) => {
      const url = String(input)
      requests.push({ url, redirect: init?.redirect })
      if (url === initial) {
        return new Response(null, { status: 307, headers: { location: '/second' } })
      }
      return new Response('locked bytes', { status: 200 })
    }

    const response = await fetchAllowlistedArtifact(initial, request)
    expect(await response.text()).toBe('locked bytes')
    expect(requests).toEqual([
      { url: initial, redirect: 'manual' },
      { url: redirected, redirect: 'manual' },
    ])

    const redirectResponse = (location?: string): Response => new Response(null, {
      status: 302,
      headers: location === undefined ? undefined : { location },
    })
    await expect(fetchAllowlistedArtifact(initial, async () => redirectResponse())).rejects.toThrow('Location')
    await expect(fetchAllowlistedArtifact(initial, async () => redirectResponse('http://www.python.org/downgrade')))
      .rejects.toThrow('allowlisted')
    await expect(fetchAllowlistedArtifact(initial, async () => redirectResponse('http://[')))
      .rejects.toThrow('redirect Location')

    let loopRequests = 0
    await expect(fetchAllowlistedArtifact(initial, async () => {
      loopRequests += 1
      return redirectResponse(initial)
    })).rejects.toThrow('loop')
    expect(loopRequests).toBe(1)

    let hop = 0
    await expect(fetchAllowlistedArtifact(initial, async () => {
      hop += 1
      return redirectResponse(`/hop-${hop}`)
    })).rejects.toThrow('too many redirects')
    expect(hop).toBe(6)
  })

  it('rejects an artifact whose byte count or SHA-256 differs from the lock', async () => {
    const root = await temporaryRoot('arkdown-markitdown-verify-')
    const badPath = path.join(root, 'artifact.bin')
    await writeFile(badPath, 'bad!')

    await expect(verifyArtifact(badPath, { bytes: 4, sha256: '0'.repeat(64) })).rejects.toThrow('SHA-256')
    await expect(verifyArtifact(badPath, { bytes: 3, sha256: SHA256 })).rejects.toThrow('byte count')
  })

  it('uses a verified warm cache without network and fails closed offline on a cache miss', async () => {
    const root = await temporaryRoot('arkdown-markitdown-cache-')
    const bytes = Buffer.from('locked bytes', 'utf8')
    const artifact = {
      filename: 'artifact.bin',
      url: 'https://www.python.org/artifact.bin',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
    await writeFile(path.join(root, artifact.filename), bytes)
    let requests = 0
    const request: typeof fetch = async () => {
      requests += 1
      throw new Error('network must not be used')
    }

    await expect(obtainLockedArtifact(root, artifact, { allowDownload: false, request }))
      .resolves.toBe(path.join(root, artifact.filename))
    expect(requests).toBe(0)

    await rm(path.join(root, artifact.filename))
    await expect(obtainLockedArtifact(root, artifact, { allowDownload: false, request }))
      .rejects.toThrow('downloads are disabled')
    expect(requests).toBe(0)

    await expect(obtainLockedArtifact(root, artifact, {
      allowDownload: true,
      request: async () => new Response(bytes, { status: 200 }),
    })).resolves.toBe(path.join(root, artifact.filename))
    await expect(readFile(path.join(root, artifact.filename))).resolves.toEqual(bytes)
  })

  it('forces pip platformdirs to a build-local Windows folder override', () => {
    const stageRoot = path.resolve('safe-stage')
    const environment = embeddedPythonEnvironment(stageRoot, {
      WIN_PD_OVERRIDE_LOCAL_APPDATA: String.raw`C:\untrusted`,
      PYTHONUTF8: '0',
    })

    expect(environment.WIN_PD_OVERRIDE_LOCAL_APPDATA).toBe(stageRoot)
    expect(environment.PYTHONUTF8).toBe('1')
    expect(environment.PIP_NO_CACHE_DIR).toBe('1')
    expect(environment.PIP_NO_INDEX).toBe('1')
  })

  it('removes inherited Python, pip, and virtual-environment controls from the child environment', () => {
    const stageRoot = path.resolve('safe-stage')
    const hostileKeys = [
      'PIP_REQUIRE_VIRTUALENV',
      'Pip_User',
      'pip_config_file',
      'PIP_TARGET',
      'PIP_INDEX_URL',
      'PIP_EXTRA_INDEX_URL',
      'PYTHONPATH',
      'PythonHome',
      'pythonuserbase',
      'PYTHONINSPECT',
      'VIRTUAL_ENV',
      'Virtual_Env_Prompt',
      '__PYVENV_LAUNCHER__',
    ]
    const environment = embeddedPythonEnvironment(stageRoot, {
      KEEP_ME: 'required by the host',
      ...Object.fromEntries(hostileKeys.map((key) => [key, 'hostile'])),
    })

    expect(environment.KEEP_ME).toBe('required by the host')
    for (const key of hostileKeys) expect(environment).not.toHaveProperty(key)
    expect(environment).toMatchObject({
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PIP_NO_CACHE_DIR: '1',
      PIP_NO_INDEX: '1',
      WIN_PD_OVERRIDE_LOCAL_APPDATA: stageRoot,
    })
  })

  it('matches installed distributions by exact normalized METADATA name and exact version', () => {
    const lock = [{ name: 'example-package', version: '1.2.3' }]
    expect(reconcileLockedDistributions(lock, [{
      directory: 'misleading-directory-name.dist-info',
      metadata: 'Metadata-Version: 2.4\nName: Example_Package\nVersion: 1.2.3\n',
    }])).toEqual([{
      directory: 'misleading-directory-name.dist-info',
      name: 'Example_Package',
      version: '1.2.3',
      metadata: 'Metadata-Version: 2.4\nName: Example_Package\nVersion: 1.2.3\n',
    }])

    expect(() => reconcileLockedDistributions(lock, [{
      directory: 'example_package_extra-1.2.3.dist-info',
      metadata: 'Name: example-package-extra\nVersion: 1.2.3\n',
    }])).toThrow('installed distributions')
    expect(() => reconcileLockedDistributions(lock, [{
      directory: 'example_package-9.9.9.dist-info',
      metadata: 'Name: example-package\nVersion: 9.9.9\n',
    }])).toThrow('installed distributions')
    expect(() => reconcileLockedDistributions(lock, [
      { directory: 'one.dist-info', metadata: 'Name: example-package\nVersion: 1.2.3\n' },
      { directory: 'two.dist-info', metadata: 'Name: example.package\nVersion: 1.2.3\n' },
    ])).toThrow('installed distributions')
    expect(() => reconcileLockedDistributions(lock, [
      { directory: 'expected.dist-info', metadata: 'Name: example-package\nVersion: 1.2.3\n' },
      { directory: 'unexpected.dist-info', metadata: 'Name: unrelated\nVersion: 4.5.6\n' },
    ])).toThrow('installed distributions')
  })

  it('runs the CLI with only the four explicit local converters registered', async () => {
    const root = await temporaryRoot('arkdown-markitdown-cli-')
    const fakeRoot = await createFakeMarkitdown(root)
    const source = path.join(root, 'input.pdf')
    const output = path.join(root, 'output.md')
    const status = path.join(root, 'status.json')
    const trace = path.join(root, 'trace.json')
    await writeFile(source, 'fixture', 'utf8')

    await execFileAsync('python', [
      path.resolve('scripts', 'markitdown', 'arkdown_markitdown.py'),
      '--input', source,
      '--output', output,
      '--status', status,
    ], {
      cwd: root,
      env: {
        ...cliEnvironment(fakeRoot, trace),
      },
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(await readFile(output, 'utf8')).toBe('# Converted\n\nSafe body\n')
    expect(JSON.parse(await readFile(status, 'utf8'))).toEqual({ ok: true, chars: 23 })
    const conversionTrace = JSON.parse(await readFile(trace, 'utf8')) as {
      kwargs: Record<string, boolean>
      registered: string[]
      source: string
    }
    expect(conversionTrace).toMatchObject({
      kwargs: { enable_builtins: false, enable_plugins: false },
      registered: ['PdfConverter', 'PptxConverter', 'XlsxConverter', 'EpubConverter'],
    })
    expect(path.basename(conversionTrace.source)).toBe(path.basename(source))
    expect(conversionTrace.source).not.toBe(source)
    if (process.platform === 'win32') {
      expect(path.dirname(path.dirname(conversionTrace.source))).toBe(root)
    }
    await expect(access(conversionTrace.source)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts ordinary absolute local files for exactly the four approved suffixes', async () => {
    const root = await temporaryRoot('arkdown-markitdown-formats-')
    const fakeRoot = await createFakeMarkitdown(root)
    const cli = path.resolve('scripts', 'markitdown', 'arkdown_markitdown.py')

    for (const suffix of ['pdf', 'pptx', 'xlsx', 'epub']) {
      const source = path.join(root, `input.${suffix}`)
      const taskRoot = path.join(root, suffix)
      await mkdir(taskRoot)
      const output = path.join(taskRoot, 'output.md')
      const status = path.join(taskRoot, 'status.json')
      const trace = path.join(root, `${suffix}-trace.json`)
      await writeFile(source, 'fixture', 'utf8')

      await execFileAsync('python', [cli, '--input', source, '--output', output, '--status', status], {
        cwd: taskRoot,
        env: cliEnvironment(fakeRoot, trace),
        encoding: 'utf8',
        windowsHide: true,
      })

      expect(JSON.parse(await readFile(status, 'utf8'))).toEqual({ ok: true, chars: 23 })
      const conversionSource = (JSON.parse(await readFile(trace, 'utf8')) as { source: string }).source
      expect(path.basename(conversionSource)).toBe(path.basename(source))
      expect(conversionSource).not.toBe(source)
      await expect(access(conversionSource)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('accepts output only as fixed sibling files in one existing task directory', async () => {
    const root = await temporaryRoot('arkdown-markitdown-output-contract-')
    const fakeRoot = await createFakeMarkitdown(root)
    const source = path.join(root, 'input.pdf')
    const taskRoot = path.join(root, 'task')
    const otherRoot = path.join(root, 'other')
    const cli = path.resolve('scripts', 'markitdown', 'arkdown_markitdown.py')
    await writeFile(source, 'fixture', 'utf8')
    await Promise.all([mkdir(taskRoot), mkdir(otherRoot)])

    const invalidDestinations = [
      [path.join(taskRoot, 'arbitrary.md'), path.join(taskRoot, 'status.json'), taskRoot],
      [path.join(taskRoot, 'output.md'), path.join(taskRoot, 'arbitrary.json'), taskRoot],
      [path.join(taskRoot, 'output.md'), path.join(otherRoot, 'status.json'), taskRoot],
      [path.join(taskRoot, 'output.md'), path.join(taskRoot, 'status.json'), otherRoot],
    ] as const
    for (const [output, status, cwd] of invalidDestinations) {
      const trace = path.join(root, `trace-${Math.random().toString(16).slice(2)}.json`)
      await expect(execFileAsync('python', [
        cli,
        '--input', source,
        '--output', output,
        '--status', status,
      ], {
        cwd,
        env: cliEnvironment(fakeRoot, trace),
        encoding: 'utf8',
        windowsHide: true,
      })).rejects.toMatchObject({ code: 2 })
      await expect(access(trace)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(status)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('rejects a task directory reached through a symlink or Windows reparse point', async ({ skip }) => {
    const root = await temporaryRoot('arkdown-markitdown-output-reparse-')
    const fakeRoot = await createFakeMarkitdown(root)
    const source = path.join(root, 'input.pdf')
    const realTaskRoot = path.join(root, 'real-task')
    const linkedTaskRoot = path.join(root, 'linked-task')
    const trace = path.join(root, 'trace.json')
    await writeFile(source, 'fixture', 'utf8')
    await mkdir(realTaskRoot)
    try {
      await symlink(realTaskRoot, linkedTaskRoot, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES') skip()
      throw error
    }

    await expect(execFileAsync('python', [
      path.resolve('scripts', 'markitdown', 'arkdown_markitdown.py'),
      '--input', source,
      '--output', path.join(linkedTaskRoot, 'output.md'),
      '--status', path.join(linkedTaskRoot, 'status.json'),
    ], {
      cwd: linkedTaskRoot,
      env: cliEnvironment(fakeRoot, trace),
      encoding: 'utf8',
      windowsHide: true,
    })).rejects.toMatchObject({ code: 2 })
    await expect(access(trace)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(path.join(realTaskRoot, 'output.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(path.join(realTaskRoot, 'status.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a real Windows named stream whose stream name has an approved suffix', async ({ skip }) => {
    if (process.platform !== 'win32') skip()
    const root = await temporaryRoot('arkdown-markitdown-ads-')
    const fakeRoot = await createFakeMarkitdown(root)
    const carrier = path.join(root, 'carrier.bin')
    const namedStream = `${carrier}:payload.pdf`
    await writeFile(carrier, 'carrier content', 'utf8')
    try {
      await writeFile(namedStream, 'named stream content', 'utf8')
      if (await readFile(namedStream, 'utf8') !== 'named stream content') skip()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (['EINVAL', 'ENOTSUP', 'ENOSYS', 'EPERM', 'EACCES'].includes(code ?? '')) skip()
      throw error
    }
    expect(await readFile(carrier, 'utf8')).toBe('carrier content')
    expect(await readdir(root)).not.toContain(path.basename(namedStream))

    const output = path.join(root, 'output.md')
    const status = path.join(root, 'status.json')
    const trace = path.join(root, 'trace.json')
    await expect(execFileAsync('python', [
      path.resolve('scripts', 'markitdown', 'arkdown_markitdown.py'),
      '--input', namedStream,
      '--output', output,
      '--status', status,
    ], {
      cwd: root,
      env: cliEnvironment(fakeRoot, trace),
      encoding: 'utf8',
      windowsHide: true,
    })).rejects.toMatchObject({ code: 2 })
    await expect(access(status)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(output)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(trace)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts only the drive-designator colon and rejects default-stream and colon edge forms', async ({ skip }) => {
    if (process.platform !== 'win32') skip()
    const root = await temporaryRoot('arkdown-markitdown-colons-')
    const fakeRoot = await createFakeMarkitdown(root)
    const ordinary = path.join(root, 'input.pdf')
    const values = [
      ordinary,
      `${ordinary}:payload.pdf`,
      `${ordinary}:`,
      `${ordinary}::$DATA`,
      path.join(root, 'folder:name', 'input.pdf'),
      String.raw`C::\input.pdf`,
      String.raw`:C:\input.pdf`,
      String.raw`::\input.pdf`,
      String.raw`1:\input.pdf`,
      String.raw`?:\input.pdf`,
      'relative:payload.pdf',
    ]
    const inspectionCode = [
      'import json, sys',
      'from arkdown_markitdown import _validated_input_path',
      'results = {}',
      'for value in sys.argv[1:]:',
      '    try:',
      '        _validated_input_path(value)',
      '        results[value] = "accepted"',
      '    except Exception as error:',
      '        results[value] = str(error)',
      'print(json.dumps(results))',
    ].join('\n')
    const { stdout } = await execFileAsync('python', ['-c', inspectionCode, ...values], {
      cwd: path.dirname(path.resolve('scripts', 'markitdown', 'arkdown_markitdown.py')),
      env: cliEnvironment(fakeRoot, path.join(root, 'trace.json')),
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(JSON.parse(stdout)).toEqual({
      [ordinary]: 'accepted',
      ...Object.fromEntries(values.slice(1).map((value) => [value, 'invalid_input'])),
    })
  })

  it('derives the private snapshot name only from the approved suffix', async () => {
    const root = await temporaryRoot('arkdown-markitdown-snapshot-name-')
    const fakeRoot = await createFakeMarkitdown(root)
    const source = path.join(root, 'untrusted.original-name.PDF')
    const output = path.join(root, 'output.md')
    const status = path.join(root, 'status.json')
    const trace = path.join(root, 'trace.json')
    await writeFile(source, 'fixture', 'utf8')

    await execFileAsync('python', [
      path.resolve('scripts', 'markitdown', 'arkdown_markitdown.py'),
      '--input', source,
      '--output', output,
      '--status', status,
    ], {
      cwd: root,
      env: cliEnvironment(fakeRoot, trace),
      encoding: 'utf8',
      windowsHide: true,
    })

    const conversionSource = (JSON.parse(await readFile(trace, 'utf8')) as { source: string }).source
    expect(path.basename(conversionSource)).toBe('input.pdf')
    await expect(access(conversionSource)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a symlink or Windows reparse-point input before resolving it', async ({ skip }) => {
    const root = await temporaryRoot('arkdown-markitdown-reparse-')
    const fakeRoot = await createFakeMarkitdown(root)
    const targetRoot = path.join(root, 'target')
    const linkedRoot = path.join(root, 'linked')
    await mkdir(targetRoot)
    await writeFile(path.join(targetRoot, 'input.pdf'), 'fixture', 'utf8')
    try {
      await symlink(targetRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES') skip()
      throw error
    }
    const source = path.join(linkedRoot, 'input.pdf')
    const output = path.join(root, 'output.md')
    const status = path.join(root, 'status.json')
    const trace = path.join(root, 'trace.json')

    await expect(execFileAsync('python', [
      path.resolve('scripts', 'markitdown', 'arkdown_markitdown.py'),
      '--input', source,
      '--output', output,
      '--status', status,
    ], {
      cwd: root,
      env: cliEnvironment(fakeRoot, trace),
      encoding: 'utf8',
      windowsHide: true,
    })).rejects.toMatchObject({ code: 1 })
    expect(JSON.parse(await readFile(status, 'utf8'))).toEqual({ ok: false, error: 'conversion_failed' })
    await expect(readFile(trace, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('holds the validated local path stable until convert_local opens it', async ({ skip }) => {
    if (process.platform !== 'win32') skip()
    const root = await temporaryRoot('arkdown-markitdown-input-race-')
    const fakeRoot = await createFakeMarkitdown(root)
    const sourceRoot = path.join(root, 'source')
    const backupRoot = path.join(root, 'source-backup')
    const replacementRoot = path.join(root, 'replacement')
    const junctionProbe = path.join(root, 'junction-probe')
    await mkdir(sourceRoot)
    await mkdir(replacementRoot)
    await writeFile(path.join(sourceRoot, 'input.pdf'), 'original local content', 'utf8')
    await writeFile(path.join(replacementRoot, 'input.pdf'), 'replacement content', 'utf8')
    try {
      await symlink(replacementRoot, junctionProbe, 'junction')
      await rm(junctionProbe)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES') skip()
      throw error
    }

    const source = path.join(sourceRoot, 'input.pdf')
    const output = path.join(root, 'output.md')
    const status = path.join(root, 'status.json')
    const trace = path.join(root, 'trace.json')
    const ready = path.join(root, 'ready')
    const release = path.join(root, 'release')
    const conversion = execFileAsync('python', [
      path.resolve('scripts', 'markitdown', 'arkdown_markitdown.py'),
      '--input', source,
      '--output', output,
      '--status', status,
    ], {
      cwd: root,
      env: {
        ...cliEnvironment(fakeRoot, trace),
        ARKDOWN_RACE_READY: ready,
        ARKDOWN_RACE_RELEASE: release,
      },
      encoding: 'utf8',
      windowsHide: true,
    })
    await waitForPath(ready)

    const mutationAttempt = await writeFile(source, 'mutated content', 'utf8').then(
      () => ({ outcome: 'written' as const }),
      (error: unknown) => ({ outcome: 'rejected' as const, error }),
    )
    const mutationErrorCode = mutationAttempt.outcome === 'rejected'
      ? (mutationAttempt.error as NodeJS.ErrnoException).code
      : undefined

    const renameAttempt = rename(sourceRoot, backupRoot).then(
      () => ({ outcome: 'renamed' as const }),
      (error: unknown) => ({ outcome: 'rejected' as const, error }),
    )
    const earlyRename = await Promise.race([
      renameAttempt,
      new Promise<{ outcome: 'pending' }>((resolve) => setTimeout(() => resolve({ outcome: 'pending' }), 200)),
    ])
    let reboundBeforeRelease = false
    try {
      if (earlyRename.outcome === 'renamed') {
        reboundBeforeRelease = true
        await symlink(replacementRoot, sourceRoot, 'junction')
      } else if (earlyRename.outcome === 'rejected') {
        const code = (earlyRename.error as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EACCES') throw earlyRename.error
      }
    } finally {
      await writeFile(release, 'continue', 'utf8')
    }
    await conversion
    const finalRename = await renameAttempt
    if (finalRename.outcome === 'rejected') {
      const code = (finalRename.error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES') throw finalRename.error
    }

    expect(mutationAttempt.outcome).toBe('rejected')
    expect(['EPERM', 'EACCES', 'EBUSY']).toContain(mutationErrorCode)
    expect(reboundBeforeRelease).toBe(false)
    expect(await readFile(output, 'utf8')).toBe('original local content')
    expect(JSON.parse(await readFile(status, 'utf8'))).toEqual({ ok: true, chars: 22 })
  }, 15_000)

  it('rejects unsupported, relative, directory, UNC, and device input forms without filesystem probing', async () => {
    const root = await temporaryRoot('arkdown-markitdown-path-forms-')
    const fakeRoot = await createFakeMarkitdown(root)
    const unsupported = path.join(root, 'input.zip')
    await writeFile(unsupported, 'fixture', 'utf8')
    const inspectionCode = [
      'import json, sys',
      'from arkdown_markitdown import validate_local_regular_input',
      'results = {}',
      'for value in sys.argv[1:]:',
      '    try:',
      '        validate_local_regular_input(value)',
      '        results[value] = "accepted"',
      '    except Exception:',
      '        results[value] = "rejected"',
      'print(json.dumps(results))',
    ].join('\n')
    const values = [
      unsupported,
      'relative.pdf',
      root,
      String.raw`\\server.invalid\share\input.pdf`,
      String.raw`\\?\C:\input.pdf`,
      String.raw`\\.\C:\input.pdf`,
    ]
    const { stdout } = await execFileAsync('python', ['-c', inspectionCode, ...values], {
      cwd: path.dirname(path.resolve('scripts', 'markitdown', 'arkdown_markitdown.py')),
      env: cliEnvironment(fakeRoot, path.join(root, 'trace.json')),
      encoding: 'utf8',
      windowsHide: true,
    })
    expect(JSON.parse(stdout)).toEqual(Object.fromEntries(values.map((value) => [value, 'rejected'])))
  })

  it('creates the EPUB fixture deterministically with the required ordered content', async () => {
    const root = await temporaryRoot('arkdown-markitdown-epub-')
    const first = path.join(root, 'first.epub')
    const second = path.join(root, 'second.epub')
    const fixtureScript = path.resolve('scripts', 'markitdown', 'create_epub_fixture.py')

    await execFileAsync('python', [fixtureScript, first], { windowsHide: true })
    await execFileAsync('python', [fixtureScript, second], { windowsHide: true })
    const firstBytes = await readFile(first)
    const secondBytes = await readFile(second)
    expect(createHash('sha256').update(firstBytes).digest('hex')).toBe(
      createHash('sha256').update(secondBytes).digest('hex'),
    )

    const inspectionCode = [
      'import json, sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as book:',
      ' data = {"names": book.namelist(), "mimetype_compression": book.getinfo("mimetype").compress_type, "chapter1": book.read("OEBPS/chapter1.xhtml").decode(), "chapter2": book.read("OEBPS/chapter2.xhtml").decode(), "opf": book.read("OEBPS/content.opf").decode()}',
      'print(json.dumps(data))',
    ].join('\n')
    const { stdout } = await execFileAsync('python', ['-c', inspectionCode, first], {
      encoding: 'utf8',
      windowsHide: true,
    })
    const inspection = JSON.parse(stdout) as Record<string, unknown>
    expect(inspection.names).toEqual([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/nav.xhtml',
      'OEBPS/chapter1.xhtml',
      'OEBPS/chapter2.xhtml',
      'OEBPS/images/pixel.png',
    ])
    expect(inspection.mimetype_compression).toBe(0)
    expect(inspection.chapter1).toContain('<h1>First Chapter</h1>')
    expect(inspection.chapter1).toContain('<p>A deterministic paragraph with <em>emphasis</em>')
    expect(inspection.chapter1).toContain('<ul><li>First item</li><li>Second item</li></ul>')
    expect(inspection.chapter1).toContain('images/pixel.png')
    expect(inspection.chapter2).toContain('<h2>Second Chapter</h2>')
    expect(inspection.chapter2).toContain('https://example.com/')
    expect(inspection.opf).toContain('chapter1.xhtml')
    expect(inspection.opf).toContain('chapter2.xhtml')
  })

  it('rejects forbidden archive entries while allowing the embedded runtime tree', () => {
    expect(() => assertAllowedArchiveTree([
      'python.exe',
      'python312.dll',
      'python312.zip',
      'python312._pth',
      'Lib/site-packages/markitdown/__init__.py',
      'Lib/site-packages/markitdown-0.1.7.dist-info/METADATA',
      'arkdown_markitdown.py',
      'THIRD_PARTY_LICENSES.txt',
      'component-manifest.json',
    ])).not.toThrow()
    expect(() => assertAllowedArchiveTree(['pythonw.exe'])).toThrow('archive tree')
    expect(() => assertAllowedArchiveTree(['Lib/site-packages/pkg/cache.pyc'])).toThrow('archive tree')
    expect(() => assertAllowedArchiveTree(['Lib/site-packages/markitdown_plugin_sample/__init__.py'])).toThrow('archive tree')
    expect(() => assertAllowedArchiveTree(['samples/private.pdf'])).toThrow('archive tree')
  })

  it('serializes the deterministic public manifest contract', () => {
    const result = {
      archivePath: 'ignored',
      manifestPath: 'ignored',
      version: '0.1.7-py3.12.10' as const,
      bytes: 123,
      sha256: SHA256,
    }

    expect(publicManifest(result)).toEqual({
      version: '0.1.7-py3.12.10',
      archiveName: 'arkdown-markitdown-0.1.7-py3.12.10-win-x64.tar.gz',
      bytes: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(JSON.stringify(publicManifest(result))).toBe(
      `{"version":"0.1.7-py3.12.10","archiveName":"arkdown-markitdown-0.1.7-py3.12.10-win-x64.tar.gz","bytes":123,"sha256":"${SHA256}"}`,
    )
  })
})
