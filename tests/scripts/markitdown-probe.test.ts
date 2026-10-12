import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import fsPromises, { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createStructureInspector,
  PROBE_SAMPLE_FIELDS,
  renderProbeMarkdown,
  resolveAuthorizedSamples,
  runMarkItDownProbe,
  writeEmbeddedStructureProbe,
  type ProbeOptions,
  type ProbeStructureMetrics,
} from '../../scripts/probe-markitdown-conversion'
import { inspectBuiltComponent } from '../../scripts/verify-markitdown-component'
import type { ComponentBuildResult } from '../../scripts/build-markitdown-component'

const temporaryRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })))
})

async function temporaryRoot(prefix = 'arkdown-probe-test-'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

function structure(
  kind: ProbeStructureMetrics['kind'],
  units = 1,
): ProbeStructureMetrics {
  return {
    kind,
    sourceUnits: units,
    coveredUnits: units,
    missingUnits: 0,
    noTextUnits: 0,
    blankUnits: 0,
    unverifiableUnits: 0,
    sourceRows: 0,
    coveredRows: 0,
    sourceCells: 0,
    coveredCells: 0,
    sourceTextChars: units * 10,
    matchedTextChars: units * 10,
    expectedHeadings: 0,
    preservedHeadings: 0,
    expectedListItems: 0,
    preservedListItems: 0,
    expectedEmphasis: 0,
    preservedEmphasis: 0,
    expectedLinks: 0,
    preservedLinks: 0,
  }
}

async function writeFakeConverter(root: string, body: string): Promise<string> {
  const filename = path.join(root, `converter-${Math.random().toString(16).slice(2)}.cjs`)
  await writeFile(filename, body, 'utf8')
  return filename
}

async function baseOptions(
  root: string,
  converter: string,
  source: string,
  overrides: Partial<ProbeOptions> = {},
): Promise<ProbeOptions> {
  const operationParent = path.join(root, 'operations')
  await mkdir(operationParent, { recursive: true })
  return {
    component: {
      version: 'test-component',
      archiveBytes: 123,
      archiveSha256: 'a'.repeat(64),
      command: process.execPath,
      cliPath: converter,
    },
    samples: [{ id: 'pdf-1', format: 'pdf', sourcePath: source, expectedUnits: 1 }],
    operationParent,
    inspectStructure: async () => structure('pages'),
    ...overrides,
  }
}

function publicPdfFixture(pages: readonly string[]): Buffer {
  const fontId = 3 + pages.length * 2
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ]
  for (let index = 0; index < pages.length; index += 1) {
    const pageId = 3 + index * 2
    const contentId = pageId + 1
    const text = pages[index]!.replace(/([\\()])/gu, '\\$1')
    const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
    )
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, 'ascii'))
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body, 'ascii')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'ascii')
}

async function runPublicProcess(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const diagnosticLimit = 16_384
    let stdout = ''
    let stderr = ''
    const child = spawn(command, [...args], {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    })
    // This helper runs only public synthetic fixtures, never private sample inputs.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-diagnosticLimit) })
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-diagnosticLimit) })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(
      `public_process_failed exit=${code} signal=${signal ?? 'none'}\nstdout: ${stdout}\nstderr: ${stderr}`,
    )))
  })
}

describe('MarkItDown conversion probe core', () => {
  it('reports bounded diagnostics for a failed public fixture subprocess', async () => {
    const root = await temporaryRoot()
    await expect(runPublicProcess(process.execPath, ['-e', [
      "process.stdout.write('synthetic stdout')",
      "process.stderr.write('synthetic stderr')",
      'process.exitCode = 7',
    ].join(';')], root)).rejects.toThrow(
      'public_process_failed exit=7 signal=none\nstdout: synthetic stdout\nstderr: synthetic stderr',
    )
  })

  it('passes literal argument arrays and records anonymous output metrics', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'source.pdf')
    await writeFile(source, 'source', 'utf8')
    const converter = await writeFakeConverter(root, [
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "const value = (name) => args[args.indexOf(name) + 1]",
      "const text = '# Heading\\n\\n| A |\\n| --- |\\n| B |'",
      "fs.writeFileSync(value('--output'), text)",
      "fs.writeFileSync(value('--status'), JSON.stringify({ ok: true, chars: [...text].length }))",
    ].join('\n'))
    let observed: readonly string[] = []
    const report = await runMarkItDownProbe(await baseOptions(root, converter, source, {
      onArguments: (args) => { observed = args },
    }))

    expect(observed).toEqual([
      converter,
      '--input', expect.stringMatching(/input\.pdf$/u),
      '--output', expect.stringMatching(/output\.md$/u),
      '--status', expect.stringMatching(/status\.json$/u),
    ])
    expect(report.samples[0]).toMatchObject({
      id: 'pdf-1',
      format: 'pdf',
      outputBytes: 30,
      outputChars: 30,
      headings: 1,
      tableRows: 2,
      exitStatus: 'exit-0',
      statusValid: true,
      processExited: true,
      cleanupComplete: true,
      executionResult: 'pass',
      fidelityResult: 'pass',
      result: 'pass',
    })
    expect(Object.keys(report.samples[0]!).sort()).toEqual([...PROBE_SAMPLE_FIELDS].sort())
  })

  it('rejects unsupported identities and oversized input before spawn', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'source.pdf')
    await writeFile(source, '12345', 'utf8')
    const converter = await writeFakeConverter(root, 'process.exit(99)')
    const options = await baseOptions(root, converter, source, {
      limits: { inputBytes: 4, outputBytes: 32 * 1024 * 1024 },
    })
    await expect(runMarkItDownProbe(options)).rejects.toThrow('invalid_probe_input')
    options.limits = { inputBytes: 5, outputBytes: 32 * 1024 * 1024 }
    options.samples[0] = { ...options.samples[0]!, id: 'private-name' }
    await expect(runMarkItDownProbe(options)).rejects.toThrow('invalid_probe_configuration')
  })

  it('selects 120s for PDF/PPTX/EPUB and 300s for XLSX', async () => {
    const root = await temporaryRoot()
    const converter = await writeFakeConverter(root, [
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "const value = (name) => args[args.indexOf(name) + 1]",
      "fs.writeFileSync(value('--output'), '# Safe')",
      "fs.writeFileSync(value('--status'), JSON.stringify({ ok: true, chars: 6 }))",
    ].join('\n'))
    const samples = await Promise.all([
      ['pdf-1', 'pdf'],
      ['pptx-1', 'pptx'],
      ['xlsx-1', 'xlsx'],
      ['epub-1', 'epub'],
    ].map(async ([id, format]) => {
      const sourcePath = path.join(root, `${id}.${format}`)
      await writeFile(sourcePath, 'source', 'utf8')
      return { id, format, sourcePath, expectedUnits: 1 }
    })) as ProbeOptions['samples']
    const selected: Array<[number, string]> = []
    const options = await baseOptions(root, converter, samples[0]!.sourcePath, {
      samples,
      onTimeoutSelected: (timeout, format) => selected.push([timeout, format]),
      inspectStructure: async (sample) => structure(
        sample.format === 'pdf' ? 'pages' : sample.format === 'pptx' ? 'slides' : sample.format === 'xlsx' ? 'sheets' : 'chapters',
      ),
    })
    const report = await runMarkItDownProbe(options)
    expect(selected).toEqual([
      [120_000, 'pdf'],
      [120_000, 'pptx'],
      [300_000, 'xlsx'],
      [120_000, 'epub'],
    ])
    expect(report.decision).toBe('pass')
  })

  it('separates execution success from fidelity and excludes content-free units', async () => {
    const root = await temporaryRoot()
    const converter = await writeFakeConverter(root, [
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "const value = (name) => args[args.indexOf(name) + 1]",
      "fs.writeFileSync(value('--output'), '# Readable output')",
      "fs.writeFileSync(value('--status'), JSON.stringify({ ok: true, chars: 17 }))",
    ].join('\n'))
    const samples = await Promise.all([
      ['pdf-1', 'pdf', 3],
      ['pdf-2', 'pdf', 1],
      ['xlsx-1', 'xlsx', 1],
      ['xlsx-2', 'xlsx', 1],
      ['xlsx-large', 'xlsx', 1],
    ].map(async ([id, format, expectedUnits]) => {
      const sourcePath = path.join(root, `${id}.${format}`)
      await writeFile(sourcePath, 'source', 'utf8')
      return { id, format, sourcePath, expectedUnits }
    })) as ProbeOptions['samples']
    const options = await baseOptions(root, converter, samples[0]!.sourcePath, {
      samples,
      inspectStructure: async (sample) => {
        if (sample.id === 'pdf-2') {
          return {
            ...structure('pages'),
            coveredUnits: 0,
            missingUnits: 0,
            noTextUnits: 1,
            sourceTextChars: 0,
            matchedTextChars: 0,
          }
        }
        if (sample.id === 'pdf-1') {
          return {
            ...structure('pages', 3),
            coveredUnits: 2,
            missingUnits: 0,
            noTextUnits: 1,
            unverifiableUnits: 1,
            sourceTextChars: 20,
            matchedTextChars: 20,
          }
        }
        if (sample.id === 'xlsx-large') {
          return {
            ...structure('sheets'),
            coveredUnits: 0,
            missingUnits: 0,
            blankUnits: 1,
            sourceTextChars: 0,
            matchedTextChars: 0,
          }
        }
        if (sample.id === 'xlsx-2') {
          return {
            ...structure('sheets'),
            coveredUnits: 0,
            missingUnits: 1,
            sourceRows: 2,
            coveredRows: 1,
            sourceCells: 2,
            coveredCells: 1,
            sourceTextChars: 10,
            matchedTextChars: 5,
          }
        }
        return {
          ...structure('sheets'),
          coveredUnits: 0,
          missingUnits: 1,
          sourceRows: 1,
          sourceCells: 2,
          sourceTextChars: 10,
          matchedTextChars: 0,
        }
      },
    })
    const report = await runMarkItDownProbe(options)

    expect(report.samples.map((sample) => ({
      id: sample.id,
      execution: sample.executionResult,
      fidelity: sample.fidelityResult,
      result: sample.result,
    }))).toEqual([
      { id: 'pdf-1', execution: 'pass', fidelity: 'conditional', result: 'conditional' },
      { id: 'pdf-2', execution: 'pass', fidelity: 'pass', result: 'pass' },
      { id: 'xlsx-1', execution: 'pass', fidelity: 'fail', result: 'fail' },
      { id: 'xlsx-2', execution: 'pass', fidelity: 'conditional', result: 'conditional' },
      { id: 'xlsx-large', execution: 'pass', fidelity: 'pass', result: 'pass' },
    ])
    expect(report).toMatchObject({
      executionDecision: 'pass',
      fidelityDecision: 'fail',
      decision: 'fail',
    })
  })

  it('kills a timed-out child and removes its random operation directory', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'source.pdf')
    await writeFile(source, 'source', 'utf8')
    const converter = await writeFakeConverter(root, 'setInterval(() => {}, 1000)')
    const report = await runMarkItDownProbe(await baseOptions(root, converter, source, {
      timeoutForFormat: () => 100,
    }))
    expect(report.samples[0]).toMatchObject({
      exitStatus: 'timeout',
      timedOut: true,
      processExited: true,
      cleanupComplete: true,
      result: 'fail',
    })
    expect(await readdir(path.join(root, 'operations'))).toEqual([])
  })

  it('fails closed when output crosses the configured byte cap', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'source.pdf')
    await writeFile(source, 'source', 'utf8')
    const converter = await writeFakeConverter(root, [
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "const output = args[args.indexOf('--output') + 1]",
      "fs.writeFileSync(output, '123456789')",
      "setInterval(() => {}, 1000)",
    ].join('\n'))
    const report = await runMarkItDownProbe(await baseOptions(root, converter, source, {
      limits: { inputBytes: 256 * 1024 * 1024, outputBytes: 8 },
      timeoutForFormat: () => 5_000,
    }))
    expect(report.samples[0]).toMatchObject({
      exitStatus: 'output-limit',
      outputLimitExceeded: true,
      processExited: true,
      cleanupComplete: true,
      result: 'fail',
    })
  })

  it.each([
    { artifact: 'output', outputBytes: 32, statusBytes: 23, errorCode: undefined, want: 'exit-0' },
    { artifact: 'output', outputBytes: 8, statusBytes: 23, errorCode: undefined, want: 'output-limit' },
    { artifact: 'status', outputBytes: 32, statusBytes: 23, errorCode: undefined, want: 'exit-0' },
    { artifact: 'status', outputBytes: 32, statusBytes: 65_537, errorCode: undefined, want: 'status-limit' },
    { artifact: 'output', outputBytes: 32, statusBytes: 23, errorCode: 'EACCES', want: 'reject' },
    { artifact: 'output', outputBytes: 32, statusBytes: 23, errorCode: 'ENOENT', want: 'reject' },
  ])('handles an owned pending rename: $artifact, cap $outputBytes, status $statusBytes, error $errorCode', async ({
    artifact, outputBytes, statusBytes, errorCode, want,
  }) => {
    const root = await temporaryRoot()
    const source = path.join(root, 'source.pdf')
    await writeFile(source, 'source')
    const converter = await writeFakeConverter(root, '')
    const actualStat = fsPromises.stat
    let pending = ''
    let destination = ''
    let renamed = false
    let renameError: string | undefined
    vi.spyOn(fsPromises, 'stat').mockImplementation(async (...args) => {
      if (args[0] === pending && !renamed) {
        renamed = true
        // Coordinate the real atomic rename precisely between readdir and stat.
        await rename(pending, destination)
        if (errorCode === 'ENOENT') await rm(destination)
        try {
          return await actualStat(...args)
        } catch (error) {
          renameError = (error as NodeJS.ErrnoException).code
          if (errorCode) throw Object.assign(new Error('denied'), { code: errorCode })
          throw error
        }
      }
      return await actualStat(...args)
    })
    syncBuiltinESMExports()
    // Reload after installing the boundary spy: Vite caches the named builtin import.
    vi.resetModules()
    const { runMarkItDownProbe: runCoordinatedProbe } = await import('../../scripts/probe-markitdown-conversion')
    const options = await baseOptions(root, converter, source, {
      limits: { inputBytes: 1024, outputBytes },
      onArguments: (args) => {
        const output = args[args.indexOf('--output') + 1]!
        const status = args[args.indexOf('--status') + 1]!
        destination = artifact === 'output' ? output : status
        pending = path.join(path.dirname(destination), `.${path.basename(destination)}.test.pending`)
        writeFileSync(artifact === 'output' ? pending : output, '# Safe output')
        writeFileSync(artifact === 'status' ? pending : status,
          statusBytes > 65_536 ? 'x'.repeat(statusBytes) : JSON.stringify({ ok: true, chars: 13 }))
      },
    })
    if (want === 'reject') {
      await expect(runCoordinatedProbe(options)).rejects.toThrow('probe_failed')
    } else {
      const report = await runCoordinatedProbe(options)
      expect(report.samples[0]).toMatchObject({
        exitStatus: want,
        outputLimitExceeded: want === 'output-limit',
        statusLimitExceeded: want === 'status-limit',
        result: want === 'exit-0' ? 'pass' : 'fail',
        cleanupComplete: true,
        processExited: true,
      })
    }
    expect(renameError).toBe('ENOENT')
  })

  it('compares the full batch against its pre-run source baseline', async () => {
    const root = await temporaryRoot()
    const first = path.join(root, 'first.pdf')
    const second = path.join(root, 'second.pdf')
    await Promise.all([writeFile(first, 'first', 'utf8'), writeFile(second, 'second', 'utf8')])
    const converter = await writeFakeConverter(root, [
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "const value = (name) => args[args.indexOf(name) + 1]",
      "fs.writeFileSync(value('--output'), '# Safe')",
      "fs.writeFileSync(value('--status'), JSON.stringify({ ok: true, chars: 6 }))",
    ].join('\n'))
    let calls = 0
    const options = await baseOptions(root, converter, first, {
      samples: [
        { id: 'pdf-1', format: 'pdf', sourcePath: first, expectedUnits: 1 },
        { id: 'pdf-2', format: 'pdf', sourcePath: second, expectedUnits: 1 },
      ],
      inspectStructure: async () => {
        calls += 1
        if (calls === 1) await writeFile(second, 'changed', 'utf8')
        return structure('pages')
      },
    })
    const report = await runMarkItDownProbe(options)
    expect(report.samples[1]).toMatchObject({
      sourceHashUnchanged: false,
      sourceSizeUnchanged: false,
      result: 'fail',
    })
  })

  it('rejects zero-unit or private-field structure results', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'source.pdf')
    await writeFile(source, 'source', 'utf8')
    const converter = await writeFakeConverter(root, [
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "const value = (name) => args[args.indexOf(name) + 1]",
      "fs.writeFileSync(value('--output'), '# Safe')",
      "fs.writeFileSync(value('--status'), JSON.stringify({ ok: true, chars: 6 }))",
    ].join('\n'))
    const report = await runMarkItDownProbe(await baseOptions(root, converter, source, {
      inspectStructure: async () => ({ ...structure('pages', 0), privateText: 'secret' } as unknown as ProbeStructureMetrics),
    }))
    expect(report.samples[0]).toMatchObject({
      outputWithinLimit: true,
      structureValid: false,
      executionResult: 'pass',
      fidelityResult: 'conditional',
      result: 'conditional',
    })
    expect(JSON.stringify(report)).not.toContain('secret')
  })

  it('fails when operation removal claims success but leaves the directory', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'source.pdf')
    await writeFile(source, 'source', 'utf8')
    const converter = await writeFakeConverter(root, [
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "const value = (name) => args[args.indexOf(name) + 1]",
      "fs.writeFileSync(value('--output'), '# Safe')",
      "fs.writeFileSync(value('--status'), JSON.stringify({ ok: true, chars: 6 }))",
    ].join('\n'))
    const report = await runMarkItDownProbe(await baseOptions(root, converter, source, {
      removeOperationDirectory: async () => undefined,
    }))
    expect(report.samples[0]).toMatchObject({ cleanupComplete: false, result: 'fail' })
  })

  it('resolves hashed sample identities and renders no paths or converted text', async () => {
    const root = await temporaryRoot()
    const assets = path.join(root, 'assets')
    await mkdir(assets)
    const source = path.join(root, 'anonymous.pdf')
    await writeFile(source, 'source', 'utf8')
    const relative = 'anonymous.pdf'
    const resolved = await resolveAuthorizedSamples(root, [{
      id: 'pdf-1',
      format: 'pdf',
      relativeNameSha256: createHash('sha256').update(relative).digest('hex'),
    }])
    expect(resolved).toEqual([{ id: 'pdf-1', format: 'pdf', sourcePath: source, expectedUnits: 0 }])

    const converter = await writeFakeConverter(root, [
      "const fs = require('node:fs')",
      "const args = process.argv.slice(2)",
      "const value = (name) => args[args.indexOf(name) + 1]",
      "fs.writeFileSync(value('--output'), '# PRIVATE-CONVERTED-TEXT')",
      "fs.writeFileSync(value('--status'), JSON.stringify({ ok: true, chars: 24 }))",
    ].join('\n'))
    const report = await runMarkItDownProbe(await baseOptions(root, converter, source))
    const markdown = renderProbeMarkdown(report)
    expect(markdown).toContain('pdf-1')
    expect(markdown).not.toContain(root)
    expect(markdown).not.toContain('PRIVATE-CONVERTED-TEXT')
  })
})

describe('MarkItDown public synthetic four-format POC', () => {
  it('converts PDF, PPTX, XLSX, and EPUB through the exact embedded narrow CLI', async () => {
    const root = await temporaryRoot('arkdown-public-four-format-')
    const repoRoot = process.cwd()
    const componentRoot = path.join(repoRoot, '.components', 'markitdown')
    const manifestPath = path.join(componentRoot, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      archiveName: string
      bytes: number
      sha256: string
      version: string
    }
    expect(manifest).toMatchObject({
      version: '0.1.7-py3.12.10',
      bytes: 75_859_983,
      sha256: 'd375e42d98cdecdce653b35f2e94a97a0844cf872da0b1fb629eff9c5bd2edec',
    })
    const runtimeRoot = path.join(root, 'runtime')
    await inspectBuiltComponent({
      archivePath: path.join(componentRoot, manifest.archiveName),
      manifestPath,
      version: manifest.version as ComponentBuildResult['version'],
      bytes: manifest.bytes,
      sha256: manifest.sha256,
    }, {
      repoRoot,
      extractionRoot: runtimeRoot,
      smoke: async () => [
        { format: 'pdf', chars: 1 },
        { format: 'pptx', chars: 1 },
        { format: 'xlsx', chars: 1 },
        { format: 'epub', chars: 1 },
      ],
    })
    const python = path.join(runtimeRoot, 'python.exe')
    const pdf = path.join(root, 'fixture.pdf')
    const pptx = path.join(root, 'fixture.pptx')
    const xlsx = path.join(root, 'fixture.xlsx')
    const epub = path.join(root, 'fixture.epub')
    await writeFile(pdf, publicPdfFixture(['AlphaQuasar Public PDF Evidence']))
    await runPublicProcess(python, ['-I', '-c', [
      'import sys',
      'from openpyxl import Workbook',
      'from pptx import Presentation',
      'book = Workbook()',
      'sheet = book.active',
      'sheet.title = "AlphaSheet"',
      'sheet.append(["AlphaHeader", "BetaHeader"])',
      'sheet.append(["AlphaValue", "BetaValue"])',
      'book.save(sys.argv[1])',
      'deck = Presentation()',
      'slide = deck.slides.add_slide(deck.slide_layouts[5])',
      'slide.shapes.title.text = "GammaNebula Public Slide Evidence"',
      'deck.save(sys.argv[2])',
    ].join(';'), xlsx, pptx], runtimeRoot)
    await runPublicProcess(
      python,
      ['-I', path.join(repoRoot, 'scripts', 'markitdown', 'create_epub_fixture.py'), epub],
      runtimeRoot,
    )
    const probeScript = path.join(runtimeRoot, 'structure-probe.py')
    await writeEmbeddedStructureProbe(probeScript)
    const inspector = createStructureInspector({
      command: python,
      prefixArgs: ['-I'],
      probeScript,
    })
    const report = await runMarkItDownProbe({
      component: {
        version: manifest.version,
        archiveBytes: manifest.bytes,
        archiveSha256: manifest.sha256,
        command: python,
        cliPath: path.join(runtimeRoot, 'arkdown_markitdown.py'),
        prefixArgs: ['-I'],
        runtimeRoot,
      },
      samples: [
        { id: 'pdf-1', format: 'pdf', sourcePath: pdf, expectedUnits: 1 },
        { id: 'pptx-1', format: 'pptx', sourcePath: pptx, expectedUnits: 1 },
        { id: 'xlsx-1', format: 'xlsx', sourcePath: xlsx, expectedUnits: 1 },
        { id: 'epub-1', format: 'epub', sourcePath: epub, expectedUnits: 2 },
      ],
      operationParent: path.join(root, 'operations'),
      inspectStructure: async (sample, outputPath, timeoutMs) => {
        if (sample.format === 'epub') {
          const output = await readFile(outputPath, 'utf8')
          const headings = [/^#\s+First Chapter\s*$/mu, /^##\s+Second Chapter\s*$/mu]
            .filter((pattern) => pattern.test(output)).length
          const list = [/^\s*[-*+]\s+First item\s*$/mu, /^\s*[-*+]\s+Second item\s*$/mu]
            .filter((pattern) => pattern.test(output)).length
          return {
            ...structure('chapters', 2),
            coveredUnits: headings,
            missingUnits: 2 - headings,
            expectedHeadings: 2,
            preservedHeadings: headings,
            expectedListItems: 2,
            preservedListItems: list,
            expectedEmphasis: 1,
            preservedEmphasis: /(?:\*|_)emphasis(?:\*|_)/u.test(output) ? 1 : 0,
            expectedLinks: 1,
            preservedLinks: /\[the example link\]\(https:\/\/example\.com\/?\)/u.test(output) ? 1 : 0,
          }
        }
        return await inspector(sample, outputPath, timeoutMs)
      },
    })

    expect(report.formats).toEqual([
      { format: 'pdf', executionResult: 'pass', fidelityResult: 'pass', result: 'pass' },
      { format: 'pptx', executionResult: 'pass', fidelityResult: 'pass', result: 'pass' },
      { format: 'xlsx', executionResult: 'pass', fidelityResult: 'pass', result: 'pass' },
      { format: 'epub', executionResult: 'pass', fidelityResult: 'pass', result: 'pass' },
    ])
    expect(report.executionDecision).toBe('pass')
    expect(report.fidelityDecision).toBe('pass')
    expect(report.decision).toBe('pass')
    expect(report.samples.every((sample) => (
      sample.exitStatus === 'exit-0'
      && sample.outputBytes > 0
      && sample.processExited
      && sample.cleanupComplete
    ))).toBe(true)
    await expect(access(path.join(root, 'operations'))).resolves.toBeUndefined()
    expect(await readdir(path.join(root, 'operations'))).toEqual([])
  }, 180_000)
})
