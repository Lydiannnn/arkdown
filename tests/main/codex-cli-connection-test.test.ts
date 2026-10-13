import { version as packageVersion } from '../../package.json'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCodexCliConnectionTester,
  type CodexCliSpawn,
  type CodexCliSpawnOptions,
  type CodexCliSpawnedChild,
} from '../../src/main/codex/codex-cli-connection-test'

interface SpawnCall {
  command: string
  args: readonly string[]
  options: CodexCliSpawnOptions
  child: FakeChild
}

class FakeChild extends EventEmitter implements CodexCliSpawnedChild {
  private static nextPid = 41_000

  readonly pid = FakeChild.nextPid++
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  writtenInput = ''
  readonly kill = vi.fn((signal: NodeJS.Signals | number = 'SIGTERM') => {
    queueMicrotask(() => this.emit('close', null, signal as NodeJS.Signals))
    return true
  })

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.writtenInput += chunk.toString('utf8')
    })
  }
}

const temporaryRoots: string[] = []
const WINDOWS_NODE_WITH_SPACES = String.raw`C:\Program Files\nodejs\node.exe`

function fakeSpawn(
  action: (call: SpawnCall) => void,
): { spawn: CodexCliSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawn: CodexCliSpawn = (command, args, options) => {
    const child = new FakeChild()
    const call = { command, args, options, child }
    calls.push(call)
    action(call)
    return child
  }
  return { spawn, calls }
}

function respondToSuccessfulProbe(
  call: SpawnCall,
  options: {
    account?: unknown
    lingerAfterStdinClose?: boolean
    stderr?: string
    splitResponse?: boolean
    models?: unknown[]
    modelPages?: Array<{ data: unknown[]; nextCursor: string | null }>
  } = {},
): void {
  if (call.args.at(-1)?.includes('--version')) {
    queueMicrotask(() => {
      call.child.stdout.write('codex-cli 1.2.3\n')
      call.child.emit('close', 0, null)
    })
    return
  }

  if (options.stderr) call.child.stderr.write(options.stderr)
  let input = ''
  let initialized = false
  let replied = false
  let modelPage = 0
  call.child.stdin.on('data', (chunk: Buffer) => {
    input += chunk.toString('utf8')
    if (chunk.toString('utf8').includes('"method":"model/list"')) {
      const request = JSON.parse(chunk.toString('utf8'))
      const result = options.modelPages?.[modelPage++] ?? { data: options.models ?? [], nextCursor: null }
      queueMicrotask(() => call.child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'))
      return
    }
    if (!initialized && input.includes('"method":"initialize"')) {
      initialized = true
      queueMicrotask(() => call.child.stdout.write('{"id":1,"result":{}}\n'))
      return
    }
    if (replied || !input.includes('"method":"account/read"')) return
    replied = true
    const account = options.account === undefined ? { type: 'chatgpt' } : options.account
    const response = `${JSON.stringify({ id: 2, result: { account } })}\n`
    queueMicrotask(() => {
      if (options.splitResponse) {
        const midpoint = Math.floor(response.length / 2)
        call.child.stdout.write(response.slice(0, midpoint))
        call.child.stdout.write(response.slice(midpoint))
      } else {
        call.child.stdout.write(response)
      }
    })
  })
  call.child.stdin.once('finish', () => {
    if (!options.lingerAfterStdinClose) queueMicrotask(() => call.child.emit('close', 0, null))
  })
}

function createTester(
  candidates: readonly string[],
  action: (call: SpawnCall) => void = (call) => respondToSuccessfulProbe(call),
  timing: {
    timeoutMs?: number
    cleanupTimeoutMs?: number
    terminationTimeoutMs?: number
  } = {},
) {
  const fake = fakeSpawn(action)
  const terminateProcessTree = vi.fn(async (pid: number) => {
    const call = fake.calls.find((candidate) => candidate.child.pid === pid)
    if (call) queueMicrotask(() => call.child.emit('close', null, 'SIGTERM'))
  })
  const tester = createCodexCliConnectionTester({
    discoverCommands: async () => candidates,
    spawn: fake.spawn,
    terminateProcessTree,
    comSpec: String.raw`C:\Windows\System32\cmd.exe`,
    timeoutMs: timing.timeoutMs,
    cleanupTimeoutMs: timing.cleanupTimeoutMs,
    terminationTimeoutMs: timing.terminationTimeoutMs,
  })
  return { fake, terminateProcessTree, tester }
}

afterEach(() => {
  vi.useRealTimers()
  return Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Codex CLI connection test', () => {
  it('lets a successful CLI probe finish its normal shutdown without premature forced termination', async () => {
    vi.useFakeTimers()
    const { tester, terminateProcessTree } = createTester(['C:\\tools\\codex.exe'], call => {
      respondToSuccessfulProbe(call, { lingerAfterStdinClose: true })
      if (call.args.at(-1) === 'app-server') {
        call.child.stdin.once('finish', () => setTimeout(() => call.child.emit('close', 0, null), 5_000))
      }
    })
    const pending = tester.test()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toEqual({ status: 'connected', cliVersion: 'codex-cli 1.2.3', models: [] })
    expect(terminateProcessTree).not.toHaveBeenCalled()
    await tester.dispose()
  })
  it('uses the injected executable for every probe without independent discovery', async () => {
    const fake = fakeSpawn(call => respondToSuccessfulProbe(call))
    const discoverCommands = vi.fn(async () => ['C:\\other\\codex.exe'])
    const tester = createCodexCliConnectionTester({ resolveExecutable: async () => 'C:\\managed\\codex.exe', discoverCommands, spawn: fake.spawn })
    expect((await tester.test()).status).toBe('connected')
    expect(fake.calls.map(call => call.command)).toEqual(['C:\\managed\\codex.exe', 'C:\\managed\\codex.exe'])
    expect(discoverCommands).not.toHaveBeenCalled()
    await tester.dispose()
  })
  it('does not fall back to an external CLI when the injected runtime is absent', async () => {
    const fake = fakeSpawn(call => respondToSuccessfulProbe(call))
    const tester = createCodexCliConnectionTester({ resolveExecutable: async () => undefined, discoverCommands: async () => ['C:\\other\\codex.exe'], spawn: fake.spawn })
    expect((await tester.test()).status).toBe('not-found')
    expect(fake.calls).toHaveLength(0)
    await tester.dispose()
  })
  it('follows model pagination and rejects a repeated cursor without returning a partial catalog', async () => {
    const model = { model: 'first', displayName: 'First', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: true }
    const valid = createTester([String.raw`C:\tools\codex.exe`], call => respondToSuccessfulProbe(call, { modelPages: [{ data: [model], nextCursor: 'page-2' }, { data: [{ ...model, model: 'second', displayName: 'Second', isDefault: false }], nextCursor: null }] }))
    expect((await valid.tester.test()).models?.map(item => item.modelId)).toEqual(['first', 'second'])
    const invalid = createTester([String.raw`C:\tools\codex.exe`], call => respondToSuccessfulProbe(call, { modelPages: [{ data: [model], nextCursor: 'repeat' }, { data: [], nextCursor: 'repeat' }] }))
    expect(await invalid.tester.test()).toEqual({ status: 'incompatible-response', cliVersion: 'codex-cli 1.2.3' })
  })
  it('retains an authoritative empty model list in the discovery result', async () => {
    const { tester } = createTester([String.raw`C:\tools\codex.exe`])
    expect(await tester.test()).toMatchObject({ status: 'connected', models: [] })
  })
  it('discovers and sanitizes the actual app-server model catalog after login', async () => {
    const { tester } = createTester([String.raw`C:\tools\codex.exe`], call => respondToSuccessfulProbe(call, { models: [{ model: 'account-model', displayName: 'Account model', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }, { reasoningEffort: 'ultra', description: 'Ultra' }], defaultReasoningEffort: 'low', isDefault: true, hidden: false, extraPrivateField: 'DO_NOT_FORWARD' }] }))
    const result = await tester.test()
    expect(result).toMatchObject({ status: 'connected', models: [{ modelId: 'account-model', displayName: 'Account model', supportedReasoningEfforts: ['low', 'ultra'], defaultReasoningEffort: 'low', isDefault: true }] })
    expect(JSON.stringify(result)).not.toContain('DO_NOT_FORWARD')
  })
  it('prefers an absolute .exe result over an earlier .cmd wrapper', async () => {
    const executable = String.raw`C:\tools\codex.exe`
    const { fake, tester } = createTester([
      String.raw`C:\Users\person\AppData\Roaming\npm\codex.cmd`,
      executable,
      'relative\\codex.exe',
    ])

    await expect(tester.test()).resolves.toEqual({
      status: 'connected',
      models: [],
      cliVersion: 'codex-cli 1.2.3',
    })

    expect(fake.calls.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: executable, args: ['--version'] },
      { command: executable, args: ['app-server'] },
    ])
    expect(fake.calls.every((call) => call.options.windowsVerbatimArguments === false)).toBe(true)
  })

  it.skipIf(process.platform !== 'win32' || !existsSync(WINDOWS_NODE_WITH_SPACES))(
    'launches a real direct .exe whose path contains spaces with normal Node quoting',
    async () => {
      const tester = createCodexCliConnectionTester({
        discoverCommands: async () => [WINDOWS_NODE_WITH_SPACES],
        timeoutMs: 2_000,
        cleanupTimeoutMs: 200,
      })

      await expect(tester.test()).resolves.toEqual({
        status: 'incompatible-response',
        cliVersion: process.version,
      })
    },
  )

  it('uses the exact absolute .cmd wrapper through ComSpec when no .exe exists', async () => {
    const wrapper = String.raw`C:\Users\person name\AppData\Roaming\npm\codex.cmd`
    const comSpec = String.raw`C:\Windows\System32\cmd.exe`
    const { fake, tester } = createTester(['codex.cmd', wrapper])

    await expect(tester.test()).resolves.toMatchObject({ status: 'connected' })

    expect(fake.calls.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: comSpec, args: ['/d', '/s', '/c', `""${wrapper}" --version"`] },
      { command: comSpec, args: ['/d', '/s', '/c', `""${wrapper}" app-server"`] },
    ])
    expect(fake.calls.every((call) => call.options.windowsVerbatimArguments === true)).toBe(true)
  })

  it.each([
    String.raw`C:\unsafe%PATH%\codex.cmd`,
    String.raw`C:\unsafe!bang\codex.cmd`,
    String.raw`C:\unsafe&control\codex.cmd`,
    String.raw`C:\unsafe^escape\codex.cmd`,
  ])('rejects a .cmd wrapper path containing cmd expansion or control characters: %s', async (wrapper) => {
    const { fake, tester } = createTester([wrapper])

    await expect(tester.test()).resolves.toEqual({ status: 'not-found' })
    expect(fake.calls).toHaveLength(0)
  })

  it.skipIf(process.platform !== 'win32')(
    'launches a real temporary .cmd wrapper from a path containing spaces',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'arkdown codex cmd test-'))
      temporaryRoots.push(root)
      const scriptPath = path.join(root, 'fake codex server.cjs')
      const wrapperPath = path.join(root, 'codex wrapper.cmd')
      await writeFile(scriptPath, [
        "const readline = require('node:readline')",
        "if (process.argv.includes('--version')) { process.stdout.write('codex-cli windows-safe\\n'); process.exit(0) }",
        "if (!process.argv.includes('app-server')) process.exit(2)",
        "const lines = readline.createInterface({ input: process.stdin })",
        "lines.on('line', (line) => {",
        "  const message = JSON.parse(line)",
        "  if (message.id === 1) process.stdout.write('{\"id\":1,\"result\":{}}\\n')",
        "  if (message.id === 2) process.stdout.write('{\"id\":2,\"result\":{\"account\":{\"type\":\"chatgpt\"}}}\\n')",
        "  if (message.id === 3) process.stdout.write('{\"id\":3,\"result\":{\"data\":[],\"nextCursor\":null}}\\n')",
        "})",
      ].join('\n'), 'utf8')
      await writeFile(
        wrapperPath,
        `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
        'utf8',
      )
      const tester = createCodexCliConnectionTester({
        discoverCommands: async () => [wrapperPath],
        comSpec: process.env.ComSpec,
        timeoutMs: 2_000,
        cleanupTimeoutMs: 200,
      })

      await expect(tester.test()).resolves.toEqual({
        status: 'connected',
        models: [],
        cliVersion: 'codex-cli windows-safe',
      })
    },
  )

  it('returns not-found without spawning when discovery has no absolute supported result', async () => {
    const { fake, tester } = createTester(['codex.exe', String.raw`C:\tools\codex.bat`])

    await expect(tester.test()).resolves.toEqual({ status: 'not-found' })
    expect(fake.calls).toHaveLength(0)
  })

  it('maps a failed version lookup to launch-failed without exposing command output', async () => {
    const { tester } = createTester([String.raw`C:\tools\codex.exe`], (call) => {
      queueMicrotask(() => {
        call.child.stderr.write('private raw diagnostic')
        call.child.emit('close', 7, null)
      })
    })

    await expect(tester.test()).resolves.toEqual({ status: 'launch-failed' })
  })

  it('bounds command discovery and maps its timeout to the public timeout status', async () => {
    vi.useFakeTimers()
    const spawn = vi.fn()
    const tester = createCodexCliConnectionTester({
      discoverCommands: async () => new Promise<readonly string[]>(() => {}),
      spawn,
      discoveryTimeoutMs: 50,
    })
    const pending = tester.test()
    const raced = Promise.race([
      pending,
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 51)),
    ])
    await vi.advanceTimersByTimeAsync(51)

    await expect(raced).resolves.toEqual({ status: 'timeout' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not treat a requested version termination as complete until the child closes', async () => {
    vi.useFakeTimers()
    const fake = fakeSpawn((call) => {
      call.child.kill.mockImplementation(() => true)
      queueMicrotask(() => call.child.stdout.write(Buffer.alloc(4 * 1024 + 1, 0x61)))
    })
    const terminateProcessTree = vi.fn(async (pid: number) => {
      const call = fake.calls.find((candidate) => candidate.child.pid === pid)!
      setTimeout(() => call.child.emit('close', null, 'SIGTERM'), 5)
    })
    const tester = createCodexCliConnectionTester({
      discoverCommands: async () => [String.raw`C:\tools\codex.exe`],
      spawn: fake.spawn,
      terminateProcessTree,
      timeoutMs: 50,
      cleanupTimeoutMs: 10,
      terminationTimeoutMs: 10,
    })
    const result = tester.test()
    const beforeClose = Promise.race([
      result,
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 4)),
    ])
    await vi.advanceTimersByTimeAsync(4)

    await expect(beforeClose).resolves.toBe('still-pending')
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toEqual({ status: 'launch-failed' })
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(fake.calls[0]!.child.pid)
  })

  it('performs only initialization, account/read, and model/list before accepting ChatGPT', async () => {
    const { fake, terminateProcessTree, tester } = createTester(
      [String.raw`C:\tools\codex.exe`],
      (call) => respondToSuccessfulProbe(call, {
        stderr: 'non-protocol startup noise\n',
        splitResponse: true,
      }),
    )

    await expect(tester.test()).resolves.toEqual({
      status: 'connected',
      models: [],
      cliVersion: 'codex-cli 1.2.3',
    })

    const appServer = fake.calls[1]!
    expect(appServer.options).toEqual({
      windowsHide: true,
      windowsVerbatimArguments: false,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    expect(appServer.child.writtenInput.trimEnd().split('\n').map((line) => JSON.parse(line))).toEqual([
      {
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'arkdown', title: 'Arkdown', version: packageVersion },
        },
      },
      { method: 'initialized', params: {} },
      { id: 2, method: 'account/read', params: {} },
      { id: 3, method: 'model/list', params: { includeHidden: false, limit: 100 } },
    ])
    expect(appServer.child.stdin.writableEnded).toBe(true)
    expect(appServer.child.kill).not.toHaveBeenCalled()
    expect(appServer.child.listenerCount('error')).toBe(0)
    expect(appServer.child.listenerCount('close')).toBe(0)
    expect(appServer.child.stdout.listenerCount('data')).toBe(0)
    expect(appServer.child.stderr.listenerCount('data')).toBe(0)
  })

  it('waits for the initialize response before sending initialized and account/read', async () => {
    const { tester } = createTester(
      [String.raw`C:\tools\codex.exe`],
      (call) => {
        if (call.args.at(-1)?.includes('--version')) return respondToSuccessfulProbe(call)
        let input = ''
        let initialized = false
        call.child.stdin.on('data', (chunk: Buffer) => {
          input += chunk.toString('utf8')
          const messages = input.trimEnd().split('\n').map((line) => JSON.parse(line))
          const modelRequest = messages.find(message => message.method === 'model/list')
          if (modelRequest) {
            queueMicrotask(() => call.child.stdout.write(JSON.stringify({ id: modelRequest.id, result: { data: [], nextCursor: null } }) + '\n'))
            return
          }
          if (!initialized) {
            if (messages.some((message) => message.method === 'account/read')) {
              queueMicrotask(() => call.child.emit('close', 2, null))
              return
            }
            initialized = true
            queueMicrotask(() => call.child.stdout.write('{"id":1,"result":{}}\n'))
            return
          }
          if (messages.some((message) => message.method === 'account/read')) {
            queueMicrotask(() => call.child.stdout.write(
              '{"id":2,"result":{"account":{"type":"chatgpt"}}}\n',
            ))
          }
        })
        call.child.stdin.once('finish', () => queueMicrotask(() => call.child.emit('close', 0, null)))
      },
      { timeoutMs: 100, cleanupTimeoutMs: 20 },
    )

    await expect(tester.test()).resolves.toEqual({
      status: 'connected',
      models: [],
      cliVersion: 'codex-cli 1.2.3',
    })
  })

  it.each([
    ['API-key account', { type: 'apiKey' }],
    ['null account', null],
  ])('maps a %s to not-logged-in', async (_label, account) => {
    const { tester } = createTester(
      [String.raw`C:\tools\codex.exe`],
      (call) => respondToSuccessfulProbe(call, { account }),
    )

    await expect(tester.test()).resolves.toEqual({
      status: 'not-logged-in',
      cliVersion: 'codex-cli 1.2.3',
    })
  })

  it('maps malformed JSONL to incompatible-response', async () => {
    const { tester } = createTester([String.raw`C:\tools\codex.exe`], (call) => {
      if (call.args.at(-1)?.includes('--version')) return respondToSuccessfulProbe(call)
      queueMicrotask(() => call.child.stdout.write('{not json}\n'))
      call.child.stdin.once('finish', () => queueMicrotask(() => call.child.emit('close', 0, null)))
    })

    await expect(tester.test()).resolves.toEqual({
      status: 'incompatible-response',
      cliVersion: 'codex-cli 1.2.3',
    })
  })

  it.each([
    ['array', []],
    ['string', 'unexpected'],
    ['number', 17],
    ['null', null],
  ])('maps a parsed non-object JSONL %s to incompatible-response', async (_label, message) => {
    const { tester } = createTester([String.raw`C:\tools\codex.exe`], (call) => {
      if (call.args.at(-1)?.includes('--version')) return respondToSuccessfulProbe(call)
      queueMicrotask(() => call.child.stdout.write(`${JSON.stringify(message)}\n`))
      call.child.stdin.once('finish', () => queueMicrotask(() => call.child.emit('close', 0, null)))
    }, { timeoutMs: 50, cleanupTimeoutMs: 5, terminationTimeoutMs: 5 })

    await expect(tester.test()).resolves.toEqual({
      status: 'incompatible-response',
      cliVersion: 'codex-cli 1.2.3',
    })
  })

  it('ignores valid object notifications and unrelated response IDs', async () => {
    const { tester } = createTester([String.raw`C:\tools\codex.exe`], (call) => {
      if (call.args.at(-1)?.includes('--version')) return respondToSuccessfulProbe(call)
      call.child.stdout.write('{"method":"server/ready","params":{}}\n')
      call.child.stdout.write('{"id":99,"result":{}}\n')
      respondToSuccessfulProbe(call)
    })

    await expect(tester.test()).resolves.toEqual({
      status: 'connected',
      models: [],
      cliVersion: 'codex-cli 1.2.3',
    })
  })

  it('maps an exit before account/read responds to incompatible-response', async () => {
    const { tester } = createTester([String.raw`C:\tools\codex.exe`], (call) => {
      if (call.args.at(-1)?.includes('--version')) return respondToSuccessfulProbe(call)
      queueMicrotask(() => call.child.emit('close', 0, null))
    })

    await expect(tester.test()).resolves.toEqual({
      status: 'incompatible-response',
      cliVersion: 'codex-cli 1.2.3',
    })
  })

  it.each(['stdout', 'stderr'] as const)('rejects oversized %s output', async (streamName) => {
    const { tester } = createTester([String.raw`C:\tools\codex.exe`], (call) => {
      if (call.args.at(-1)?.includes('--version')) return respondToSuccessfulProbe(call)
      queueMicrotask(() => call.child[streamName].write(Buffer.alloc(1024 * 1024 + 1, 0x61)))
    })

    await expect(tester.test()).resolves.toEqual({
      status: 'incompatible-response',
      cliVersion: 'codex-cli 1.2.3',
    })
  })

  it('times out, closes stdin, and terminates only its exact child', async () => {
    vi.useFakeTimers()
    const { fake, terminateProcessTree, tester } = createTester(
      [String.raw`C:\tools\codex.exe`],
      (call) => {
        if (call.args.at(-1)?.includes('--version')) respondToSuccessfulProbe(call)
      },
      { timeoutMs: 100, cleanupTimeoutMs: 20 },
    )
    const result = tester.test()
    await vi.advanceTimersByTimeAsync(120)

    await expect(result).resolves.toEqual({
      status: 'timeout',
      cliVersion: 'codex-cli 1.2.3',
    })
    expect(fake.calls[0]!.child.kill).not.toHaveBeenCalled()
    expect(fake.calls[1]!.child.stdin.writableEnded).toBe(true)
    expect(fake.calls[1]!.child.kill).not.toHaveBeenCalled()
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(fake.calls[1]!.child.pid)
  })

  it('forces the exact App Server child to exit only after closing stdin and waiting', async () => {
    vi.useFakeTimers()
    let stdinWasClosedWhenTerminated = false
    const { fake, terminateProcessTree, tester } = createTester(
      [String.raw`C:\tools\codex.exe`],
      (call) => {
        respondToSuccessfulProbe(call, { lingerAfterStdinClose: true })
      },
      { timeoutMs: 100, cleanupTimeoutMs: 20 },
    )
    terminateProcessTree.mockImplementation(async (pid: number) => {
      const call = fake.calls.find((candidate) => candidate.child.pid === pid)!
      stdinWasClosedWhenTerminated = call.child.stdin.writableEnded
      queueMicrotask(() => call.child.emit('close', null, 'SIGTERM'))
    })
    const result = tester.test()
    await vi.advanceTimersByTimeAsync(20)

    await expect(result).resolves.toEqual({
      status: 'connected',
      models: [],
      cliVersion: 'codex-cli 1.2.3',
    })
    expect(stdinWasClosedWhenTerminated).toBe(true)
    expect(fake.calls[0]!.child.kill).not.toHaveBeenCalled()
    expect(fake.calls[1]!.child.kill).not.toHaveBeenCalled()
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(fake.calls[1]!.child.pid)
  })

  it('returns timeout instead of connected when termination resolves but App Server never closes', async () => {
    vi.useFakeTimers()
    const fake = fakeSpawn((call) => {
      respondToSuccessfulProbe(call, { lingerAfterStdinClose: true })
      call.child.kill.mockImplementation(() => true)
    })
    const terminateProcessTree = vi.fn(async (_pid: number) => {})
    const tester = createCodexCliConnectionTester({
      discoverCommands: async () => [String.raw`C:\tools\codex.exe`],
      spawn: fake.spawn,
      terminateProcessTree,
      timeoutMs: 50,
      cleanupTimeoutMs: 10,
      terminationTimeoutMs: 10,
    })
    const result = tester.test()
    const raced = Promise.race([
      result,
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 21)),
    ])
    await vi.advanceTimersByTimeAsync(21)

    await expect(raced).resolves.toEqual({
      status: 'timeout',
      cliVersion: 'codex-cli 1.2.3',
    })
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(fake.calls[1]!.child.pid)
    expect(fake.calls[1]!.child.stdout.listenerCount('data')).toBe(0)
  })

  it('returns launch-failed instead of connected when App Server termination rejects', async () => {
    vi.useFakeTimers()
    const fake = fakeSpawn((call) => respondToSuccessfulProbe(call, { lingerAfterStdinClose: true }))
    const terminateProcessTree = vi.fn(async () => {
      throw new Error('taskkill failed')
    })
    const tester = createCodexCliConnectionTester({
      discoverCommands: async () => [String.raw`C:\tools\codex.exe`],
      spawn: fake.spawn,
      terminateProcessTree,
      timeoutMs: 50,
      cleanupTimeoutMs: 10,
      terminationTimeoutMs: 10,
    })
    const result = tester.test()
    await vi.advanceTimersByTimeAsync(20)

    await expect(result).resolves.toEqual({
      status: 'launch-failed',
      cliVersion: 'codex-cli 1.2.3',
    })
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(fake.calls[1]!.child.pid)
  })

  it('returns timeout instead of connected when App Server termination hangs', async () => {
    vi.useFakeTimers()
    const fake = fakeSpawn((call) => respondToSuccessfulProbe(call, { lingerAfterStdinClose: true }))
    const terminateProcessTree = vi.fn(async () => await new Promise<void>(() => {}))
    const tester = createCodexCliConnectionTester({
      discoverCommands: async () => [String.raw`C:\tools\codex.exe`],
      spawn: fake.spawn,
      terminateProcessTree,
      timeoutMs: 50,
      cleanupTimeoutMs: 10,
      terminationTimeoutMs: 10,
    })
    const result = tester.test()
    await vi.advanceTimersByTimeAsync(20)

    await expect(result).resolves.toEqual({
      status: 'timeout',
      cliVersion: 'codex-cli 1.2.3',
    })
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(fake.calls[1]!.child.pid)
  })

  it('dispose is idempotent, aborts an in-flight version probe, and waits for close', async () => {
    vi.useFakeTimers()
    const fake = fakeSpawn(() => {})
    let terminationRequested = false
    const terminateProcessTree = vi.fn(async (pid: number) => {
      terminationRequested = true
      const call = fake.calls.find((candidate) => candidate.child.pid === pid)!
      setTimeout(() => call.child.emit('close', null, 'SIGTERM'), 5)
    })
    const tester = createCodexCliConnectionTester({
      discoverCommands: async () => [String.raw`C:\tools\codex.exe`],
      spawn: fake.spawn,
      terminateProcessTree,
      timeoutMs: 100,
      terminationTimeoutMs: 20,
    })
    const probe = tester.test()
    await vi.advanceTimersByTimeAsync(0)
    const firstDispose = tester.dispose()
    const secondDispose = tester.dispose()
    await vi.advanceTimersByTimeAsync(0)

    expect(secondDispose).toBe(firstDispose)
    expect(terminationRequested).toBe(true)
    let disposed = false
    void firstDispose.then(() => { disposed = true })
    await vi.advanceTimersByTimeAsync(4)
    expect(disposed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await expect(firstDispose).resolves.toBeUndefined()
    await expect(probe).resolves.toEqual({ status: 'launch-failed' })
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(fake.calls[0]!.child.pid)
  })

  it('dispose aborts an in-flight App Server probe without a duplicate termination', async () => {
    vi.useFakeTimers()
    const fake = fakeSpawn((call) => {
      if (call.args.at(-1)?.includes('--version')) respondToSuccessfulProbe(call)
    })
    const terminateProcessTree = vi.fn(async (pid: number) => {
      const call = fake.calls.find((candidate) => candidate.child.pid === pid)!
      queueMicrotask(() => call.child.emit('close', null, 'SIGTERM'))
    })
    const tester = createCodexCliConnectionTester({
      discoverCommands: async () => [String.raw`C:\tools\codex.exe`],
      spawn: fake.spawn,
      terminateProcessTree,
      timeoutMs: 100,
      cleanupTimeoutMs: 10,
      terminationTimeoutMs: 20,
    })
    const probe = tester.test()
    await vi.advanceTimersByTimeAsync(0)

    await expect(tester.dispose()).resolves.toBeUndefined()
    await expect(probe).resolves.toEqual({
      status: 'incompatible-response',
      cliVersion: 'codex-cli 1.2.3',
    })
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(fake.calls[1]!.child.pid)
  })

  it('dispose rejects when an active child cannot be confirmed closed', async () => {
    vi.useFakeTimers()
    const fake = fakeSpawn(() => {})
    const terminateProcessTree = vi.fn(async () => {})
    const tester = createCodexCliConnectionTester({
      discoverCommands: async () => [String.raw`C:\tools\codex.exe`],
      spawn: fake.spawn,
      terminateProcessTree,
      timeoutMs: 100,
      terminationTimeoutMs: 10,
    })
    void tester.test()
    await vi.advanceTimersByTimeAsync(0)
    const disposal = tester.dispose()
    const disposalResult = expect(disposal).rejects.toThrow(
      'Codex CLI child process did not close',
    )
    await vi.advanceTimersByTimeAsync(20)

    await disposalResult
    expect(terminateProcessTree).toHaveBeenCalledTimes(2)
  })

  it('dispose retries an exact PID after an earlier probe termination timed out', async () => {
    vi.useFakeTimers()
    const fake = fakeSpawn((call) => respondToSuccessfulProbe(call, { lingerAfterStdinClose: true }))
    let attempts = 0
    const terminateProcessTree = vi.fn(async (pid: number) => {
      attempts += 1
      if (attempts === 2) {
        const call = fake.calls.find((candidate) => candidate.child.pid === pid)!
        queueMicrotask(() => call.child.emit('close', null, 'SIGTERM'))
      }
    })
    const tester = createCodexCliConnectionTester({
      discoverCommands: async () => [String.raw`C:\tools\codex.exe`],
      spawn: fake.spawn,
      terminateProcessTree,
      timeoutMs: 50,
      cleanupTimeoutMs: 10,
      terminationTimeoutMs: 10,
    })
    const probe = tester.test()
    await vi.advanceTimersByTimeAsync(20)
    await expect(probe).resolves.toEqual({
      status: 'timeout',
      cliVersion: 'codex-cli 1.2.3',
    })

    const disposal = tester.dispose()
    const disposalResult = expect(disposal).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)

    await disposalResult
    expect(terminateProcessTree).toHaveBeenCalledTimes(2)
    expect(terminateProcessTree).toHaveBeenNthCalledWith(1, fake.calls[1]!.child.pid)
    expect(terminateProcessTree).toHaveBeenNthCalledWith(2, fake.calls[1]!.child.pid)
  })

  it.each(['rejects', 'hangs'] as const)(
    'dispose retries the same exact PID when it overlaps a probe termination that %s',
    async (failureMode) => {
      vi.useFakeTimers()
      const fake = fakeSpawn((call) => respondToSuccessfulProbe(call, {
        lingerAfterStdinClose: true,
      }))
      let attempts = 0
      const terminateProcessTree = vi.fn(async (pid: number) => {
        attempts += 1
        if (attempts === 1) {
          if (failureMode === 'rejects') throw new Error('taskkill failed')
          return await new Promise<void>(() => {})
        }
        const call = fake.calls.find((candidate) => candidate.child.pid === pid)!
        queueMicrotask(() => call.child.emit('close', null, 'SIGTERM'))
      })
      const tester = createCodexCliConnectionTester({
        discoverCommands: async () => [String.raw`C:\tools\codex.exe`],
        spawn: fake.spawn,
        terminateProcessTree,
        timeoutMs: 50,
        cleanupTimeoutMs: 10,
        terminationTimeoutMs: 10,
      })
      const probe = tester.test()
      await vi.advanceTimersByTimeAsync(10)
      expect(terminateProcessTree).toHaveBeenCalledTimes(1)
      const disposal = tester.dispose()
      const disposalResult = expect(disposal).resolves.toBeUndefined()
      await vi.advanceTimersByTimeAsync(10)

      await disposalResult
      await expect(probe).resolves.toEqual({
        status: failureMode === 'rejects' ? 'launch-failed' : 'timeout',
        cliVersion: 'codex-cli 1.2.3',
      })
      expect(terminateProcessTree).toHaveBeenCalledTimes(2)
      expect(terminateProcessTree).toHaveBeenNthCalledWith(1, fake.calls[1]!.child.pid)
      expect(terminateProcessTree).toHaveBeenNthCalledWith(2, fake.calls[1]!.child.pid)
    },
  )

  it('allows a later dispose call to retry active children after an earlier dispose rejects', async () => {
    vi.useFakeTimers()
    const fake = fakeSpawn(() => {})
    let attempts = 0
    const terminateProcessTree = vi.fn(async (pid: number) => {
      attempts += 1
      if (attempts === 3) {
        const call = fake.calls.find((candidate) => candidate.child.pid === pid)!
        queueMicrotask(() => call.child.emit('close', null, 'SIGTERM'))
      }
    })
    const tester = createCodexCliConnectionTester({
      discoverCommands: async () => [String.raw`C:\tools\codex.exe`],
      spawn: fake.spawn,
      terminateProcessTree,
      timeoutMs: 100,
      terminationTimeoutMs: 10,
    })
    void tester.test()
    await vi.advanceTimersByTimeAsync(0)
    const firstDispose = tester.dispose()
    const firstResult = expect(firstDispose).rejects.toThrow(
      'Codex CLI child process did not close',
    )
    await vi.advanceTimersByTimeAsync(20)
    await firstResult
    expect(terminateProcessTree).toHaveBeenCalledTimes(2)

    const secondDispose = tester.dispose()
    expect(secondDispose).not.toBe(firstDispose)
    await vi.advanceTimersByTimeAsync(0)

    await expect(secondDispose).resolves.toBeUndefined()
    expect(terminateProcessTree).toHaveBeenCalledTimes(3)
    expect(terminateProcessTree).toHaveBeenNthCalledWith(1, fake.calls[0]!.child.pid)
    expect(terminateProcessTree).toHaveBeenNthCalledWith(2, fake.calls[0]!.child.pid)
    expect(terminateProcessTree).toHaveBeenNthCalledWith(3, fake.calls[0]!.child.pid)
  })

  it('rejects tests after disposal without spawning another child', async () => {
    const fake = fakeSpawn(() => {})
    const tester = createCodexCliConnectionTester({
      discoverCommands: async () => [String.raw`C:\tools\codex.exe`],
      spawn: fake.spawn,
    })
    await tester.dispose()

    await expect(tester.test()).rejects.toThrow('Codex CLI connection tester is disposed')
    expect(fake.calls).toHaveLength(0)
  })
})
