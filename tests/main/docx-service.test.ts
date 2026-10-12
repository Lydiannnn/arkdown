import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

const mocks = vi.hoisted(() => ({
  runPandoc: vi.fn<(
    executable: string,
    args: readonly string[],
    cwd: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<void>>(),
  runPandocText: vi.fn<(
    executable: string,
    args: readonly string[],
    cwd: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<string>>(),
  afterAtomicWrite: undefined as undefined | ((file: string) => Promise<void>),
}))

vi.mock('write-file-atomic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('write-file-atomic')>()
  const actualWriteFileAtomic = actual.default as unknown as (
    ...args: readonly unknown[]
  ) => Promise<void>
  return {
    ...actual,
    default: async (...args: readonly unknown[]) => {
      await actualWriteFileAtomic(...args)
      await mocks.afterAtomicWrite?.(String(args[0]))
    },
  }
})

vi.mock('../../src/main/docx/pandoc-locator', () => ({
  resolvePandocExecutable: vi.fn(async () => 'pandoc.exe'),
}))

vi.mock('../../src/main/docx/pandoc-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/docx/pandoc-runner')>()
  return {
    ...actual,
    runPandoc: mocks.runPandoc,
    runPandocText: mocks.runPandocText,
  }
})

import { DocxService } from '../../src/main/docx/docx-service'
import { PandocTerminationUnconfirmedError } from '../../src/main/docx/pandoc-runner'

function observeCompletion(promise: Promise<unknown>): {
  isSettled: () => boolean
  observed: Promise<void>
} {
  let settled = false
  return {
    isSettled: () => settled,
    observed: promise.then(
      () => { settled = true },
      () => { settled = true },
    ),
  }
}

describe('DocxService', () => {
  let root = ''
  let tempRoot = ''
  let exportsRoot = ''

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'arkdown-docx-export-'))
    tempRoot = path.join(root, 'temp')
    exportsRoot = path.join(root, 'exports')
    await Promise.all([
      mkdir(tempRoot, { recursive: true }),
      mkdir(exportsRoot, { recursive: true }),
    ])
    mocks.runPandoc.mockReset()
    mocks.runPandocText.mockReset()
    mocks.afterAtomicWrite = undefined
    mocks.runPandocText.mockResolvedValue('converted:plain')
    mocks.runPandoc.mockImplementation(async (_executable, args, cwd) => {
      const output = args.find((argument) => argument.startsWith('--output='))?.slice(9)
      if (!output) throw new Error('missing output')
      const format = args.find((argument) => argument.startsWith('--to='))?.slice(5)
      await writeFile(path.join(cwd, output), `converted:${format}`, 'utf8')
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('exports DOCX through Pandoc and atomically replaces the chosen file', async () => {
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const targetPath = path.join(exportsRoot, 'report.docx')
    await writeFile(targetPath, 'old', 'utf8')

    await service.exportDocx('# Report', targetPath)

    expect(mocks.runPandoc).toHaveBeenCalledWith(
      'pandoc.exe',
      expect.arrayContaining([
        'document.md',
        '--from=gfm+raw_html',
        '--to=docx',
        '--output=document.docx',
      ]),
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('converted:docx')
    await expect(readdir(exportsRoot)).resolves.toEqual(['report.docx'])
  })

  it('waits for first-use Pandoc installation and uses the verified executable', async () => {
    let ready!: (value: string) => void
    const ensurePandoc = vi.fn(() => new Promise<string>(resolve => { ready = resolve }))
    const service = new DocxService({ tempRoot, executablePath: path.join(root, 'Arkdown.exe'), resourcesPath: root, ensurePandoc })
    const target = path.join(exportsRoot, 'managed.docx')
    const operation = service.exportDocx('# Managed', target)
    await vi.waitFor(() => expect(ensurePandoc).toHaveBeenCalledOnce())
    expect(mocks.runPandoc).not.toHaveBeenCalled()
    ready(path.join(root, 'components', 'pandoc.exe'))
    await operation
    expect(mocks.runPandoc.mock.calls[0][0]).toBe(path.join(root, 'components', 'pandoc.exe'))
    expect(await readFile(target, 'utf8')).toBe('converted:docx')
  })

  it('aborts pending Pandoc preparation from the export caller without disposing the shared service', async () => {
    const ensurePandoc = vi.fn((signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const service = new DocxService({ tempRoot, executablePath: path.join(root, 'Arkdown.exe'), resourcesPath: root, ensurePandoc })
    const controller = new AbortController()
    const target = path.join(exportsRoot, 'owner.docx')
    await writeFile(target, 'original')
    const pending = service.exportDocx('# New', target, { signal: controller.signal })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(ensurePandoc).toHaveBeenCalledOnce())
    controller.abort()
    await rejection
    expect(mocks.runPandoc).not.toHaveBeenCalled()
    expect(await readFile(target, 'utf8')).toBe('original')
    ensurePandoc.mockImplementation(async () => path.join(root, 'components', 'pandoc.exe'))
    await service.exportDocx('# Retry', target)
    expect(await readFile(target, 'utf8')).toBe('converted:docx')
  })

  it('keeps the original destination when component preparation is canceled', async () => {
    const service = new DocxService({ tempRoot, executablePath: path.join(root, 'Arkdown.exe'), resourcesPath: root,
      ensurePandoc: async () => { throw new DOMException('cancelled', 'AbortError') } })
    const target = path.join(exportsRoot, 'preserve.docx')
    await writeFile(target, 'original')
    await expect(service.exportDocx('# New', target)).rejects.toThrow()
    expect(mocks.runPandoc).not.toHaveBeenCalled()
    expect(await readFile(target, 'utf8')).toBe('original')
  })

  it('reports shutdown when disposal races the completed atomic export write', async () => {
    let reportAtomicWrite = () => {}
    const atomicWriteCompleted = new Promise<void>((resolve) => { reportAtomicWrite = resolve })
    let releaseAtomicWrite = () => {}
    const atomicWriteRelease = new Promise<void>((resolve) => { releaseAtomicWrite = resolve })
    const targetPath = path.join(exportsRoot, 'dispose-race.docx')
    mocks.afterAtomicWrite = async (file) => {
      if (file !== targetPath) return
      reportAtomicWrite()
      await atomicWriteRelease
    }
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })

    const exporting = service.exportDocx('# Report', targetPath)
    await atomicWriteCompleted
    const disposal = service.dispose()
    releaseAtomicWrite()

    await expect(exporting).rejects.toMatchObject({ name: 'AbortError' })
    await disposal
    mocks.afterAtomicWrite = undefined
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('converted:docx')
  })

  it('rejects export shutdown while final operation cleanup is pending', async () => {
    let operationDirectory = ''
    let reportCleanupStarted = () => {}
    const cleanupStarted = new Promise<void>((resolve) => { reportCleanupStarted = resolve })
    let releaseCleanup = () => {}
    const cleanupRelease = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const targetPath = path.join(exportsRoot, 'dispose-cleanup-race.docx')
    mocks.runPandoc.mockImplementationOnce(async (_executable, args, cwd) => {
      operationDirectory = cwd
      const output = args.find((argument) => argument.startsWith('--output='))?.slice(9)
      if (!output) throw new Error('missing output')
      await writeFile(path.join(cwd, output), 'converted:docx', 'utf8')
    })
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const serviceCleanup = service as unknown as {
      removeOwnedDirectory(directory: string): Promise<void>
    }
    const removeOwnedDirectory = serviceCleanup.removeOwnedDirectory.bind(service)
    serviceCleanup.removeOwnedDirectory = async (directory) => {
      if (directory === operationDirectory) {
        reportCleanupStarted()
        await cleanupRelease
      }
      await removeOwnedDirectory(directory)
    }

    const exporting = service.exportDocx('# Report', targetPath)
    await cleanupStarted
    await expect(readFile(targetPath, 'utf8')).resolves.toBe('converted:docx')
    expect((await stat(operationDirectory)).isDirectory()).toBe(true)
    const instanceRoot = path.dirname(path.dirname(operationDirectory))

    const disposal = service.dispose()
    const disposalOutcome = observeCompletion(disposal)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(disposalOutcome.isSettled()).toBe(false)

    releaseCleanup()
    await expect(exporting).rejects.toMatchObject({ name: 'AbortError' })
    await disposal
    await disposalOutcome.observed
    await expect(stat(instanceRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(path.join(tempRoot, 'docx'))).resolves.toEqual([])
  })

  it('passes Mermaid fenced source to Pandoc without renderer output substitution', async () => {
    const markdown = [
      '# Diagram',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
    ].join('\n')
    let stagedMarkdown = ''
    mocks.runPandoc.mockImplementationOnce(async (_executable, args, cwd) => {
      stagedMarkdown = await readFile(path.join(cwd, 'document.md'), 'utf8')
      const output = args.find((argument) => argument.startsWith('--output='))?.slice(9)
      if (!output) throw new Error('missing output')
      await writeFile(path.join(cwd, output), 'converted:docx', 'utf8')
    })
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })

    await service.exportDocx(markdown, path.join(exportsRoot, 'diagram.docx'))

    expect(stagedMarkdown).toBe(markdown)
    expect(stagedMarkdown).toContain('```mermaid\ngraph TD\n  A --> B\n```')
    expect(stagedMarkdown).not.toContain('data:image/svg+xml')
    expect(stagedMarkdown).not.toContain('<svg')
  })

  it('reuses only an existing writable regular file with the expected extension', async () => {
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const existing = path.join(exportsRoot, 'existing.docx')
    const missing = path.join(exportsRoot, 'missing.docx')
    const directory = path.join(exportsRoot, 'directory.docx')
    await writeFile(existing, 'old', 'utf8')
    await mkdir(directory)

    await expect(service.canReuseTarget(existing)).resolves.toBe(true)
    await expect(service.canReuseTarget(missing)).resolves.toBe(false)
    await expect(service.canReuseTarget(directory)).resolves.toBe(false)
    await expect(service.canReuseTarget(path.join(exportsRoot, 'existing.txt'))).resolves.toBe(false)
  })

  it('rejects any target that is not a DOCX file', async () => {
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })

    await expect(service.exportDocx(
      '# Report',
      path.join(exportsRoot, 'report.txt'),
    )).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' })
    expect(mocks.runPandoc).not.toHaveBeenCalled()
  })

  it('isolates editor media by service instance and dispose removes only the owning root', async () => {
    const otherInstanceDirectory = path.join(tempRoot, 'docx', 'other-instance-capability')
    await mkdir(otherInstanceDirectory, { recursive: true })
    await writeFile(path.join(otherInstanceDirectory, 'owned.png'), 'other', 'utf8')
    mocks.runPandoc.mockImplementation(async (_executable, args, cwd) => {
      const mediaDirectory = path.join(cwd, 'media', 'media')
      await mkdir(mediaDirectory, { recursive: true })
      await writeFile(path.join(mediaDirectory, 'image.png'), path.basename(args[0] ?? ''), 'utf8')
      await writeFile(
        path.join(cwd, 'document.md'),
        '<img src="media/media/image.png" alt="diagram" />',
        'utf8',
      )
    })
    const firstService = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const secondService = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const firstSource = path.join(root, 'first.docx')
    const secondSource = path.join(root, 'second.docx')
    await Promise.all([
      writeFile(firstSource, 'first', 'utf8'),
      writeFile(secondSource, 'second', 'utf8'),
    ])

    const first = await firstService.import(firstSource)
    const second = await secondService.import(secondSource)

    const firstImage = first.markdown.match(/<img src="([^"]+)"/u)?.[1]
    const secondImage = second.markdown.match(/<img src="([^"]+)"/u)?.[1]
    expect(firstImage).toBeTruthy()
    expect(secondImage).toBeTruthy()
    expect(firstImage).not.toBe(secondImage)
    await expect(readFile(firstImage!, 'utf8')).resolves.toBe('first.docx')
    await expect(readFile(secondImage!, 'utf8')).resolves.toBe('second.docx')
    await expect(stat(path.join(firstImage!, '..', '..', '..', 'document.md'))).rejects
      .toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(otherInstanceDirectory, 'owned.png'), 'utf8')).resolves.toBe('other')

    await firstService.dispose()
    await firstService.dispose()

    await expect(stat(firstImage!)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(secondImage!, 'utf8')).resolves.toBe('second.docx')
    await expect(readFile(path.join(otherInstanceDirectory, 'owned.png'), 'utf8')).resolves.toBe('other')
    await secondService.dispose()
  })

  it('reports shutdown when disposal races the final imported Markdown read', async () => {
    let reportRead = () => {}
    const readCompleted = new Promise<void>((resolve) => { reportRead = resolve })
    let releaseRead = () => {}
    const readRelease = new Promise<void>((resolve) => { releaseRead = resolve })
    const deferredReadFile = (async (...args: readonly unknown[]) => {
      const result = await (readFile as unknown as (
        ...readArgs: readonly unknown[]
      ) => Promise<unknown>)(...args)
      const file = String(args[0])
      if (path.basename(file) !== 'document.md') return result
      reportRead()
      await readRelease
      return result
    }) as typeof readFile
    const service = new DocxService(
      {
        tempRoot,
        executablePath: path.join(root, 'Arkdown.exe'),
        resourcesPath: root,
      },
      { readFile: deferredReadFile },
    )
    const source = path.join(root, 'dispose-race.docx')
    await writeFile(source, 'fake docx', 'utf8')

    const importing = service.import(source)
    await readCompleted
    const disposal = service.dispose()
    releaseRead()

    await expect(importing).rejects.toMatchObject({ name: 'AbortError' })
    await disposal
    await expect(readdir(path.join(tempRoot, 'docx'))).resolves.toEqual([])
  })

  it('keeps earlier editor media alive across later imports in the same service lifetime', async () => {
    mocks.runPandoc.mockImplementation(async (_executable, args, cwd) => {
      const sourceName = path.basename(args[0] ?? '')
      const mediaDirectory = path.join(cwd, 'media', 'media')
      await mkdir(mediaDirectory, { recursive: true })
      await writeFile(path.join(mediaDirectory, 'image.png'), sourceName, 'utf8')
      await writeFile(
        path.join(cwd, 'document.md'),
        '<img src="media/media/image.png" alt="diagram" />',
        'utf8',
      )
    })
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const firstSource = path.join(root, 'first.docx')
    const secondSource = path.join(root, 'second.docx')
    await Promise.all([
      writeFile(firstSource, 'first', 'utf8'),
      writeFile(secondSource, 'second', 'utf8'),
    ])

    const first = await service.import(firstSource)
    const firstImage = first.markdown.match(/<img src="([^"]+)"/u)?.[1]
    const second = await service.import(secondSource)
    const secondImage = second.markdown.match(/<img src="([^"]+)"/u)?.[1]

    await expect(readFile(firstImage!, 'utf8')).resolves.toBe('first.docx')
    await expect(readFile(secondImage!, 'utf8')).resolves.toBe('second.docx')
    await service.dispose()
    await expect(stat(firstImage!)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(secondImage!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves plain document text while normalizing unsafe controls', async () => {
    mocks.runPandocText.mockResolvedValueOnce([
      'Imported\r',
      'Image alt text',
      'Entity & reference',
      'File URL (file:///C:/Temp/private.png)',
      'Wrapped [label](file:///C:/Temp/private.png)',
      'Drive C:\\Temp\\private.txt',
      'UNC \\\\server\\private\\document.docx',
      `Operation ${tempRoot}\\private.txt`,
      'controls\u0000\u001b removed',
    ].join('\n'))
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const source = path.join(root, 'source.docx')
    await writeFile(source, 'fake docx', 'utf8')
    const controller = new AbortController()

    const imported = await service.importText(source, {
      signal: controller.signal,
      timeoutMs: 60_000,
    })

    expect(imported).toEqual({
      text: [
        'Imported',
        'Image alt text',
        'Entity & reference',
        'File URL (file:///C:/Temp/private.png)',
        'Wrapped [label](file:///C:/Temp/private.png)',
        'Drive C:\\Temp\\private.txt',
        'UNC \\\\server\\private\\document.docx',
        `Operation ${tempRoot}\\private.txt`,
        'controls removed',
      ].join('\n'),
    })
    expect(Object.keys(imported)).toEqual(['text'])
    expect(mocks.runPandocText).toHaveBeenCalledWith(
      'pandoc.exe',
      expect.arrayContaining(['--from=docx', '--to=plain', '--wrap=none']),
      expect.any(String),
      { signal: expect.any(AbortSignal), timeoutMs: 60_000 },
    )
    const pandocArgs = mocks.runPandocText.mock.calls[0]?.[1] ?? []
    expect(pandocArgs.some((argument) => argument.startsWith('--extract-media'))).toBe(false)
    expect(pandocArgs.some((argument) => argument.startsWith('--output'))).toBe(false)
    expect(mocks.runPandoc).not.toHaveBeenCalled()
    await expect(stat(path.join(tempRoot, 'docx-ai'))).rejects.toMatchObject({ code: 'ENOENT' })
    await service.dispose()
  })

  it.each([
    ['fails', new Error('conversion failed')],
    ['is aborted', new DOMException('conversion canceled', 'AbortError')],
    ['times out', Object.assign(new Error('conversion timed out'), { code: 'DOCX_CONVERSION_FAILED' })],
  ])('does not create a text-only operation directory when Pandoc %s', async (_case, failure) => {
    mocks.runPandocText.mockRejectedValueOnce(failure)
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const source = path.join(root, 'source.docx')
    await writeFile(source, 'fake docx', 'utf8')

    await expect(service.importText(source)).rejects.toBe(failure)

    await expect(stat(path.join(tempRoot, 'docx-ai'))).rejects.toMatchObject({ code: 'ENOENT' })
    await service.dispose()
  })

  it('propagates a caller abort through the combined operation signal', async () => {
    let runnerSignal: AbortSignal | undefined
    let reportStarted = () => {}
    const started = new Promise<void>((resolve) => { reportStarted = resolve })
    mocks.runPandocText.mockImplementationOnce(async (_executable, _args, _cwd, options) => {
      runnerSignal = options?.signal
      reportStarted()
      return await new Promise<string>((_resolve, reject) => {
        runnerSignal?.addEventListener('abort', () => reject(runnerSignal?.reason), { once: true })
      })
    })
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const source = path.join(root, 'source.docx')
    await writeFile(source, 'fake docx', 'utf8')
    const controller = new AbortController()
    const reason = new DOMException('caller canceled', 'AbortError')
    const importing = service.importText(source, { signal: controller.signal })
    await started

    controller.abort(reason)

    await expect(importing).rejects.toBe(reason)
    expect(runnerSignal?.aborted).toBe(true)
    expect(runnerSignal?.reason).toBe(reason)
    await service.dispose()
  })

  it('keeps ordinary import media until shutdown abort reaches the active operation', async () => {
    let operationDirectory = ''
    let runnerSignal: AbortSignal | undefined
    let releaseRunner = () => {}
    let reportStarted = () => {}
    const started = new Promise<void>((resolve) => { reportStarted = resolve })
    mocks.runPandoc.mockImplementationOnce(async (_executable, _args, cwd, options) => {
      operationDirectory = cwd
      runnerSignal = options?.signal
      const mediaDirectory = path.join(cwd, 'media', 'media')
      await mkdir(mediaDirectory, { recursive: true })
      await writeFile(path.join(mediaDirectory, 'image.png'), 'live-media', 'utf8')
      reportStarted()
      await new Promise<void>((_resolve, reject) => {
        releaseRunner = () => reject(new DOMException('runner stopped', 'AbortError'))
      })
    })
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const source = path.join(root, 'source.docx')
    await writeFile(source, 'fake docx', 'utf8')
    const importing = service.import(source)
    await started

    const disposal = service.dispose()
    const disposalOutcome = observeCompletion(disposal)
    await new Promise((resolve) => setTimeout(resolve, 25))
    const settledBeforeRunner = disposalOutcome.isSettled()
    const shutdownAborted = runnerSignal?.aborted
    let mediaStillExists = true
    try {
      await readFile(path.join(operationDirectory, 'media', 'media', 'image.png'), 'utf8')
    } catch {
      mediaStillExists = false
    }

    releaseRunner()
    await expect(importing).rejects.toMatchObject({ name: 'AbortError' })
    await disposal
    await disposalOutcome.observed
    expect(shutdownAborted).toBe(true)
    expect(settledBeforeRunner).toBe(false)
    expect(mediaStillExists).toBe(true)
    await expect(readdir(path.join(tempRoot, 'docx'))).resolves.toEqual([])
  })

  it('waits for an active export to terminate and clean before disposal removes its root', async () => {
    let operationDirectory = ''
    let runnerSignal: AbortSignal | undefined
    let releaseRunner = () => {}
    let reportStarted = () => {}
    const started = new Promise<void>((resolve) => { reportStarted = resolve })
    mocks.runPandoc.mockImplementationOnce(async (_executable, _args, cwd, options) => {
      operationDirectory = cwd
      runnerSignal = options?.signal
      reportStarted()
      await new Promise<void>((_resolve, reject) => {
        releaseRunner = () => reject(new DOMException('runner stopped', 'AbortError'))
      })
    })
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const exporting = service.exportDocx('# Report', path.join(exportsRoot, 'report.docx'))
    await started

    const disposal = service.dispose()
    const disposalOutcome = observeCompletion(disposal)
    await new Promise((resolve) => setTimeout(resolve, 25))
    const settledBeforeRunner = disposalOutcome.isSettled()
    const shutdownAborted = runnerSignal?.aborted
    const operationExists = await stat(operationDirectory).then(() => true, () => false)

    releaseRunner()
    await expect(exporting).rejects.toMatchObject({ name: 'AbortError' })
    await disposal
    await disposalOutcome.observed
    expect(shutdownAborted).toBe(true)
    expect(settledBeforeRunner).toBe(false)
    expect(operationExists).toBe(true)
    await expect(readdir(path.join(tempRoot, 'docx'))).resolves.toEqual([])
  })

  it('waits for an active AI plain-text import before disposal removes its root', async () => {
    let operationRoot = ''
    let runnerSignal: AbortSignal | undefined
    let releaseRunner = () => {}
    let reportStarted = () => {}
    const started = new Promise<void>((resolve) => { reportStarted = resolve })
    mocks.runPandocText.mockImplementationOnce(async (_executable, _args, cwd, options) => {
      operationRoot = cwd
      runnerSignal = options?.signal
      reportStarted()
      return await new Promise<string>((_resolve, reject) => {
        releaseRunner = () => reject(new DOMException('runner stopped', 'AbortError'))
      })
    })
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const source = path.join(root, 'source.docx')
    await writeFile(source, 'fake docx', 'utf8')
    const importing = service.importText(source)
    await started

    const disposal = service.dispose()
    const disposalOutcome = observeCompletion(disposal)
    await new Promise((resolve) => setTimeout(resolve, 25))
    const settledBeforeRunner = disposalOutcome.isSettled()
    const shutdownAborted = runnerSignal?.aborted
    const operationExists = await stat(operationRoot).then(() => true, () => false)

    releaseRunner()
    await expect(importing).rejects.toMatchObject({ name: 'AbortError' })
    await disposal
    await disposalOutcome.observed
    expect(shutdownAborted).toBe(true)
    expect(settledBeforeRunner).toBe(false)
    expect(operationExists).toBe(true)
    await expect(readdir(path.join(tempRoot, 'docx'))).resolves.toEqual([])
  })

  it('closes the operation gate as soon as disposal begins', async () => {
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const existingTarget = path.join(exportsRoot, 'existing.docx')
    await writeFile(existingTarget, 'existing', 'utf8')

    const disposal = service.dispose()
    await expect(service.import('relative.docx')).rejects.toMatchObject({
      code: 'DOCX_CONVERSION_FAILED',
    })
    await disposal
    await expect(service.canReuseTarget(existingTarget)).resolves.toBe(false)
    await expect(stat(path.join(tempRoot, 'docx'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not let a forged termination handle delay disposal cleanup', async () => {
    let releaseForgedConfirmation = () => {}
    const forgedConfirmation = new Promise<void>((resolve) => {
      releaseForgedConfirmation = resolve
    })
    const forgedFailure = Object.create(PandocTerminationUnconfirmedError.prototype) as Error
      & { termination: { isConfirmed(): boolean; readonly whenConfirmed: Promise<void> } }
    Object.defineProperties(forgedFailure, {
      name: { value: 'PandocTerminationUnconfirmedError' },
      termination: {
        value: {
          isConfirmed: () => false,
          whenConfirmed: forgedConfirmation,
        },
      },
    })
    mocks.runPandocText.mockRejectedValueOnce(forgedFailure)
    const service = new DocxService({
      tempRoot,
      executablePath: path.join(root, 'Arkdown.exe'),
      resourcesPath: root,
    })
    const source = path.join(root, 'source.docx')
    await writeFile(source, 'fake docx', 'utf8')

    await expect(service.importText(source)).rejects.toBe(forgedFailure)
    const disposal = service.dispose()
    const disposalOutcome = observeCompletion(disposal)
    await new Promise((resolve) => setTimeout(resolve, 25))
    const settledBeforeForgedConfirmation = disposalOutcome.isSettled()

    releaseForgedConfirmation()
    await disposal
    await disposalOutcome.observed

    expect(settledBeforeForgedConfirmation).toBe(true)
    await expect(readdir(path.join(tempRoot, 'docx'))).resolves.toEqual([])
  })
})
