import { EventEmitter } from 'node:events'
import { constants as fsConstants } from 'node:fs'
import { appendFile, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMarkItDownRunner,
  type MarkItDownSpawn,
  type MarkItDownSpawnedChild,
} from '../../src/main/document-conversion/markitdown-runner'
import type { DocumentConversionRuntime } from '../../src/main/document-conversion/component-manager'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-runner-test-'))
  roots.push(root)
  return root
}

const runtime = (root: string): DocumentConversionRuntime => Object.freeze({
  version: '1.2.3',
  root,
  pythonExecutable: path.join(root, 'python.exe'),
  entryScript: path.join(root, 'arkdown_markitdown.py'),
})

interface SpawnCall {
  command: string
  args: readonly string[]
  options: Parameters<MarkItDownSpawn>[2]
  child: FakeChild
}

class FakeChild extends EventEmitter implements MarkItDownSpawnedChild {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit('close', null, 'SIGTERM'))
    return true
  })
}

function fakeSpawn(
  action: (call: SpawnCall) => void | Promise<void>,
): { spawn: MarkItDownSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawn: MarkItDownSpawn = (command, args, options) => {
    const child = new FakeChild()
    const call = { command, args, options, child }
    calls.push(call)
    queueMicrotask(() => { void action(call) })
    return child
  }
  return { spawn, calls }
}

async function succeed(call: SpawnCall, markdown = '# 标题\n'): Promise<void> {
  const output = call.args[4]!
  const status = call.args[6]!
  await writeFile(output, markdown, 'utf8')
  await writeFile(status, JSON.stringify({ ok: true, chars: [...markdown].length }), 'utf8')
  call.child.emit('close', 0, null)
}

describe('MarkItDown runner', () => {
  it('spawns Python without a shell using only the required UTF-8 environment and exact arguments', async () => {
    const tempRoot = await temporaryRoot()
    const componentRoot = await temporaryRoot()
    const source = path.join(tempRoot, '输入 file.pdf')
    await writeFile(source, 'fixture')
    const fake = fakeSpawn((call) => succeed(call))
    const runner = createMarkItDownRunner({ tempRoot, spawn: fake.spawn })

    await expect(runner.convert({
      canonicalPath: source,
      format: 'pdf',
      runtime: runtime(componentRoot),
      signal: new AbortController().signal,
    })).resolves.toEqual({ markdown: '# 标题\n', warnings: [] })

    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]!
    expect(call.command).toBe(path.join(componentRoot, 'python.exe'))
    expect(call.args).toEqual([
      path.join(componentRoot, 'arkdown_markitdown.py'),
      '--input', source,
      '--output', path.join(call.options.cwd, 'output.md'),
      '--status', path.join(call.options.cwd, 'status.json'),
    ])
    expect(call.options).toEqual({
      cwd: expect.stringMatching(/arkdown-markitdown-[^\\/]+$/u),
      windowsHide: true,
      shell: false,
      env: {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    })
    expect(await readdir(tempRoot)).toEqual(['输入 file.pdf'])
  })

  it.each([
    ['pdf', 120_000],
    ['pptx', 120_000],
    ['epub', 120_000],
    ['xlsx', 300_000],
  ] as const)('terminates its child after the %s timeout of %d ms', async (format, timeoutMs) => {
    vi.useFakeTimers()
    const tempRoot = await temporaryRoot()
    const componentRoot = await temporaryRoot()
    const source = path.join(tempRoot, `input.${format}`)
    await writeFile(source, 'fixture')
    let notifySpawned!: () => void
    const spawned = new Promise<void>((resolve) => { notifySpawned = resolve })
    const fake = fakeSpawn(() => { notifySpawned() })
    const conversion = createMarkItDownRunner({ tempRoot, spawn: fake.spawn }).convert({
      canonicalPath: source,
      format,
      runtime: runtime(componentRoot),
      signal: new AbortController().signal,
    })
    await spawned

    await vi.advanceTimersByTimeAsync(timeoutMs - 1)
    expect(fake.calls[0]!.child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(conversion).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_TIMEOUT' })
    expect(fake.calls[0]!.child.kill).toHaveBeenCalledTimes(1)
    expect(await readdir(tempRoot)).toEqual([`input.${format}`])
  })

  it.each([
    ['extra status field', { ok: true, chars: 3, markdown: 'secret' }],
    ['failure status', { ok: false, error: 'conversion_failed' }],
    ['wrong character count', { ok: true, chars: 99 }],
  ])('rejects %s without returning output', async (_label, statusRecord) => {
    const tempRoot = await temporaryRoot()
    const componentRoot = await temporaryRoot()
    const source = path.join(tempRoot, 'input.pdf')
    await writeFile(source, 'fixture')
    const fake = fakeSpawn(async (call) => {
      await writeFile(call.args[4]!, 'abc', 'utf8')
      await writeFile(call.args[6]!, JSON.stringify(statusRecord), 'utf8')
      call.child.emit('close', 0, null)
    })
    await expect(createMarkItDownRunner({ tempRoot, spawn: fake.spawn }).convert({
      canonicalPath: source, format: 'pdf', runtime: runtime(componentRoot), signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_FAILED' })
    expect(await readdir(tempRoot)).toEqual(['input.pdf'])
  })

  it('rejects syntactically invalid status JSON', async () => {
    const tempRoot = await temporaryRoot()
    const componentRoot = await temporaryRoot()
    const source = path.join(tempRoot, 'input.pdf')
    await writeFile(source, 'fixture')
    const fake = fakeSpawn(async (call) => {
      await writeFile(call.args[4]!, 'abc', 'utf8')
      await writeFile(call.args[6]!, '{"ok":true,"chars":', 'utf8')
      call.child.emit('close', 0, null)
    })

    await expect(createMarkItDownRunner({ tempRoot, spawn: fake.spawn }).convert({
      canonicalPath: source, format: 'pdf', runtime: runtime(componentRoot), signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_FAILED' })
    expect(await readdir(tempRoot)).toEqual(['input.pdf'])
  })

  it('uses supported nonblocking and no-follow flags before validating status and output files', async () => {
    const tempRoot = await temporaryRoot()
    const componentRoot = await temporaryRoot()
    const source = path.join(tempRoot, 'input.pdf')
    await writeFile(source, 'fixture')
    const acquisitions: Array<{ name: string; flags: number | undefined }> = []
    const openFile = async (filePath: string, flags?: number) => {
      acquisitions.push({ name: path.basename(filePath), flags })
      return open(filePath, flags ?? 'r')
    }
    const fake = fakeSpawn((call) => succeed(call, 'abc'))

    await expect(createMarkItDownRunner({ tempRoot, spawn: fake.spawn, openFile }).convert({
      canonicalPath: source, format: 'pdf', runtime: runtime(componentRoot), signal: new AbortController().signal,
    })).resolves.toEqual({ markdown: 'abc', warnings: [] })

    const expectedFlags = fsConstants.O_RDONLY
      | (fsConstants.O_NONBLOCK ?? 0)
      | (fsConstants.O_NOFOLLOW ?? 0)
    expect(acquisitions).toEqual([
      { name: 'status.json', flags: expectedFlags },
      { name: 'output.md', flags: expectedFlags },
    ])
    expect(await readdir(tempRoot)).toEqual(['input.pdf'])
  })

  it.each([
    ['status', 64 * 1024, 'DOCUMENT_CONVERSION_FAILED'],
    ['output', 32 * 1024 * 1024, 'DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE'],
  ] as const)('bounds %s acquisition when the opened file grows after validation', async (kind, limit, code) => {
    const tempRoot = await temporaryRoot()
    const componentRoot = await temporaryRoot()
    const source = path.join(tempRoot, 'input.pdf')
    await writeFile(source, 'fixture')
    let bytesAcquired = 0
    let raced = false
    const openFile = async (filePath: string) => {
      const handle = await open(filePath, 'r')
      return {
        stat: () => handle.stat(),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const isTarget = path.basename(filePath) === (kind === 'status' ? 'status.json' : 'output.md')
          if (!raced && isTarget) {
            raced = true
            await appendFile(filePath, Buffer.alloc(limit + 1, 0x61))
          }
          const result = await handle.read(buffer, offset, length, position)
          if (isTarget) bytesAcquired += result.bytesRead
          return result
        },
        close: () => handle.close(),
      }
    }
    const fake = fakeSpawn((call) => succeed(call, 'abc'))

    await expect(createMarkItDownRunner({ tempRoot, spawn: fake.spawn, openFile }).convert({
      canonicalPath: source, format: 'pdf', runtime: runtime(componentRoot), signal: new AbortController().signal,
    })).rejects.toMatchObject({ code })
    expect(raced).toBe(true)
    expect(bytesAcquired).toBeLessThanOrEqual(limit + 1)
    expect(await readdir(tempRoot)).toEqual(['input.pdf'])
  })

  it('rejects nonzero exits and independently bounded stdout, stderr, and status data', async () => {
    for (const mode of ['exit', 'stdout', 'stderr', 'status'] as const) {
      const tempRoot = await temporaryRoot()
      const componentRoot = await temporaryRoot()
      const source = path.join(tempRoot, 'input.pdf')
      await writeFile(source, 'fixture')
      const fake = fakeSpawn(async (call) => {
        if (mode === 'stdout') call.child.stdout.write(Buffer.alloc(64 * 1024 + 1))
        if (mode === 'stderr') call.child.stderr.write(Buffer.alloc(64 * 1024 + 1))
        if (mode === 'status') await writeFile(call.args[6]!, Buffer.alloc(64 * 1024 + 1))
        if (mode === 'exit' || mode === 'status') call.child.emit('close', mode === 'exit' ? 7 : 0, null)
      })
      await expect(createMarkItDownRunner({ tempRoot, spawn: fake.spawn }).convert({
        canonicalPath: source, format: 'pdf', runtime: runtime(componentRoot), signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_FAILED' })
      if (mode === 'stdout' || mode === 'stderr') expect(fake.calls[0]!.child.kill).toHaveBeenCalledTimes(1)
      expect(await readdir(tempRoot)).toEqual(['input.pdf'])
    }
  })

  it.each(['invalid-utf8', 'too-large'] as const)('rejects %s output without truncating it', async (mode) => {
    const tempRoot = await temporaryRoot()
    const componentRoot = await temporaryRoot()
    const source = path.join(tempRoot, 'input.pdf')
    await writeFile(source, 'fixture')
    const fake = fakeSpawn(async (call) => {
      const output = mode === 'invalid-utf8' ? Buffer.from([0xc3, 0x28]) : Buffer.alloc(32 * 1024 * 1024 + 1, 0x61)
      await writeFile(call.args[4]!, output)
      await writeFile(call.args[6]!, JSON.stringify({ ok: true, chars: output.length }))
      call.child.emit('close', 0, null)
    })
    await expect(createMarkItDownRunner({ tempRoot, spawn: fake.spawn }).convert({
      canonicalPath: source, format: 'pdf', runtime: runtime(componentRoot), signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: mode === 'too-large' ? 'DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE' : 'DOCUMENT_CONVERSION_FAILED',
    })
    expect(await readdir(tempRoot)).toEqual(['input.pdf'])
  })

  it('maps cleanup failure after successful conversion to a stable public failure', async () => {
    const tempRoot = await temporaryRoot()
    const componentRoot = await temporaryRoot()
    const source = path.join(tempRoot, 'input.pdf')
    await writeFile(source, 'fixture')
    const fake = fakeSpawn((call) => succeed(call))
    const cleanupFailure = new Error('raw Windows cleanup failure')
    const removeDirectory = vi.fn(async () => { throw cleanupFailure })
    const failure = await createMarkItDownRunner({
      tempRoot,
      spawn: fake.spawn,
      removeDirectory,
    }).convert({
      canonicalPath: source, format: 'pdf', runtime: runtime(componentRoot), signal: new AbortController().signal,
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toMatchObject({ code: 'DOCUMENT_CONVERSION_FAILED' })
    expect(failure).not.toBe(cleanupFailure)
    expect(removeDirectory).toHaveBeenCalledOnce()
  })

  it.each(['conversion failure', 'abort', 'timeout'] as const)(
    'preserves the primary %s when cleanup also fails',
    async (mode) => {
      if (mode === 'timeout') vi.useFakeTimers()
      const tempRoot = await temporaryRoot()
      const componentRoot = await temporaryRoot()
      const source = path.join(tempRoot, 'input.pdf')
      await writeFile(source, 'fixture')
      let notifySpawned!: () => void
      const spawned = new Promise<void>((resolve) => { notifySpawned = resolve })
      const fake = fakeSpawn((call) => {
        notifySpawned()
        if (mode === 'conversion failure') call.child.emit('close', 7, null)
      })
      const cleanupFailure = new Error('raw Windows cleanup failure')
      const removeDirectory = vi.fn(async () => { throw cleanupFailure })
      const controller = new AbortController()
      const abortFailure = new DOMException('caller cancelled', 'AbortError')
      const conversion = createMarkItDownRunner({
        tempRoot,
        spawn: fake.spawn,
        removeDirectory,
      }).convert({
        canonicalPath: source, format: 'pdf', runtime: runtime(componentRoot), signal: controller.signal,
      })
      const rejection = mode === 'abort'
        ? expect(conversion).rejects.toBe(abortFailure)
        : expect(conversion).rejects.toMatchObject({
            code: mode === 'timeout' ? 'DOCUMENT_CONVERSION_TIMEOUT' : 'DOCUMENT_CONVERSION_FAILED',
          })
      await spawned

      if (mode === 'abort') controller.abort(abortFailure)
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(120_000)

      await rejection
      expect(removeDirectory).toHaveBeenCalledOnce()
    },
  )

  it('cancellation terminates only the child owned by that operation', async () => {
    const tempRoot = await temporaryRoot()
    const componentRoot = await temporaryRoot()
    const one = path.join(tempRoot, 'one.pdf')
    const two = path.join(tempRoot, 'two.pdf')
    await Promise.all([writeFile(one, 'one'), writeFile(two, 'two')])
    let notifyTwo!: () => void
    const bothSpawned = new Promise<void>((resolve) => { notifyTwo = resolve })
    const fake = fakeSpawn(() => { if (fake.calls.length === 2) notifyTwo() })
    const runner = createMarkItDownRunner({ tempRoot, spawn: fake.spawn })
    const controller = new AbortController()
    const first = runner.convert({ canonicalPath: one, format: 'pdf', runtime: runtime(componentRoot), signal: controller.signal })
    const second = runner.convert({ canonicalPath: two, format: 'pdf', runtime: runtime(componentRoot), signal: new AbortController().signal })
    await bothSpawned
    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const firstCall = fake.calls.find((call) => call.args[2] === one)!
    const secondCall = fake.calls.find((call) => call.args[2] === two)!
    expect(firstCall.child.kill).toHaveBeenCalledTimes(1)
    expect(secondCall.child.kill).not.toHaveBeenCalled()
    await succeed(secondCall, 'second')
    await expect(second).resolves.toEqual({ markdown: 'second', warnings: [] })
    expect((await readdir(tempRoot)).sort()).toEqual(['one.pdf', 'two.pdf'])
  })
})
