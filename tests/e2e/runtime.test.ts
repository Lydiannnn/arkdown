import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupRuntime,
  cleanupRuntimeAfterExactShutdowns,
  createRuntimeInstance,
  prepareSharedRuntime,
  shutdownElectronApplication,
  shutdownElectronApplicationScope,
  waitForElectronExecutablesQuiet,
} from './support/runtime'

const cleanupRoots: string[] = []

afterEach(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => cleanupRuntime(root)))
})

async function createFakePackagedApplication(): Promise<{
  application: string
  root: string
}> {
  const root = path.join(
    tmpdir(),
    `arkdown-runtime-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  const application = path.join(root, 'Arkdown')
  cleanupRoots.push(root)

  await Promise.all([
    mkdir(path.join(application, 'resources'), { recursive: true }),
    mkdir(path.join(application, 'locales'), { recursive: true }),
    mkdir(path.join(application, 'pandoc'), { recursive: true }),
    mkdir(path.join(application, 'portable-data'), { recursive: true }),
    mkdir(path.join(application, 'temp'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(application, 'Arkdown.exe'), 'secure-arkdown-executable', 'utf8'),
    writeFile(path.join(application, 'Arknote.exe'), 'secure-arknote-executable', 'utf8'),
    writeFile(path.join(application, 'resources', 'app.asar'), 'application', 'utf8'),
    writeFile(path.join(application, 'locales', 'zh-CN.pak'), 'locale', 'utf8'),
    writeFile(path.join(application, 'pandoc', 'pandoc.exe'), 'pandoc', 'utf8'),
    writeFile(path.join(application, 'portable-data', 'settings.json'), 'source-settings', 'utf8'),
    writeFile(path.join(application, 'temp', 'draft.json'), 'source-draft', 'utf8'),
  ])
  return { application, root }
}

describe('Electron E2E runtime preparation', () => {
  it('instruments copied Arkdown and Arknote executables while linking shared static files', async () => {
    const packaged = await createFakePackagedApplication()
    const instrumented: string[] = []

    const shared = await prepareSharedRuntime({
      packagedApplication: packaged.application,
      executableName: 'Arkdown.exe',
      additionalExecutableNames: ['Arknote.exe'],
      instrumentExecutable: async (executable) => {
        instrumented.push(path.basename(executable))
        await appendFile(executable, '-instrumented', 'utf8')
      },
    })
    cleanupRoots.push(shared.root)

    expect(instrumented.sort()).toEqual(['Arkdown.exe', 'Arknote.exe'])
    expect(await readFile(path.join(packaged.application, 'Arkdown.exe'), 'utf8'))
      .toBe('secure-arkdown-executable')
    expect(await readFile(path.join(packaged.application, 'Arknote.exe'), 'utf8'))
      .toBe('secure-arknote-executable')
    expect(await readFile(path.join(shared.application, 'Arkdown.exe'), 'utf8'))
      .toBe('secure-arkdown-executable-instrumented')
    expect(await readFile(path.join(shared.application, 'Arknote.exe'), 'utf8'))
      .toBe('secure-arknote-executable-instrumented')
    expect(await readFile(path.join(shared.application, 'resources', 'app.asar'), 'utf8'))
      .toBe('application')
    expect((await stat(path.join(shared.application, 'resources', 'app.asar'))).nlink)
      .toBeGreaterThanOrEqual(2)

    await expect(stat(path.join(shared.application, 'pandoc'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(shared.application, 'portable-data'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(shared.application, 'temp'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates isolated writable application directories with both instrumented launchers', async () => {
    const packaged = await createFakePackagedApplication()
    let instrumentationCalls = 0
    const shared = await prepareSharedRuntime({
      packagedApplication: packaged.application,
      executableName: 'Arkdown.exe',
      additionalExecutableNames: ['Arknote.exe'],
      instrumentExecutable: async () => {
        instrumentationCalls += 1
      },
    })
    cleanupRoots.push(shared.root)

    const first = await createRuntimeInstance(shared.application, 'arkdown-runtime-first-')
    const second = await createRuntimeInstance(shared.application, 'arkdown-runtime-second-')
    cleanupRoots.push(first.root, second.root)

    expect(first.executable).toBe(path.join(first.application, 'Arkdown.exe'))
    expect(first.arknoteExecutable).toBe(path.join(first.application, 'Arknote.exe'))
    expect(first.portableData).toBe(path.join(first.application, 'portable-data'))
    expect(first.userData).toBe(path.join(first.root, 'user-data'))
    expect(second.portableData).not.toBe(first.portableData)

    await mkdir(path.join(first.application, 'portable-data'), { recursive: true })
    await writeFile(path.join(first.application, 'portable-data', 'settings.json'), 'first', 'utf8')

    expect(instrumentationCalls).toBe(2)
    expect(await readFile(path.join(first.application, 'resources', 'app.asar'), 'utf8'))
      .toBe('application')
    expect(await readFile(path.join(second.application, 'resources', 'app.asar'), 'utf8'))
      .toBe('application')
    await expect(stat(path.join(second.application, 'portable-data', 'settings.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a packaged application that is missing either requested executable', async () => {
    const packaged = await createFakePackagedApplication()
    const executable = path.join(packaged.application, 'Arknote.exe')
    await cleanupRuntime(executable)

    await expect(prepareSharedRuntime({
      packagedApplication: packaged.application,
      executableName: 'Arkdown.exe',
      additionalExecutableNames: ['Arknote.exe'],
      instrumentExecutable: async () => undefined,
    })).rejects.toThrow(`Packaged executable not found: ${executable}`)
  })
})

interface FakeProcess {
  executablePath: string
  pid: number
  parentPid: number
  creationTime: string
}

function createShutdownHarness(observations: readonly (readonly FakeProcess[])[]) {
  let clock = 0
  let observationIndex = 0
  const forceKills: number[][] = []
  const requestedPaths: string[] = []
  const closeRequests: string[] = []

  return {
    closeRequests,
    forceKills,
    now: () => clock,
    options: {
      delay: async (milliseconds: number) => { clock += milliseconds },
      enumerateProcesses: async (executablePath: string) => {
        requestedPaths.push(executablePath)
        const observation = observations[Math.min(observationIndex, observations.length - 1)] ?? []
        observationIndex += 1
        return observation
      },
      forceKill: async (pids: readonly number[]) => { forceKills.push([...pids]) },
      gracefulTimeoutMs: 2,
      now: () => clock,
      pollIntervalMs: 1,
      quietPeriodMs: 3,
      requestClose: async () => { closeRequests.push('close') },
    },
    requestedPaths,
  }
}

describe('scoped Electron E2E shutdown', () => {
  const executable = path.resolve('C:/e2e/runtime/Arkdown.exe')
  const matching = (pid: number): FakeProcess => ({ executablePath: executable, pid, parentPid: 0, creationTime: `created-${pid}` })
  const descendant = (pid: number, parentPid: number): FakeProcess => ({
    executablePath: path.resolve('C:/e2e/runtime/helper.exe'), pid, parentPid, creationTime: `created-${pid}`,
  })

  it('defaults to two uninterrupted seconds of process quiet', async () => {
    let clock = 0

    await shutdownElectronApplication({
      executable,
      delay: async (milliseconds) => { clock += milliseconds },
      enumerateProcesses: async () => [],
      now: () => clock,
      pollIntervalMs: 1,
      requestClose: async () => undefined,
    })

    expect(clock).toBe(2_000)
  })

  it('requires an uninterrupted empty interval before graceful shutdown succeeds', async () => {
    const harness = createShutdownHarness([[], [], [], []])

    await shutdownElectronApplication({ executable, ...harness.options })

    expect(harness.now()).toBe(3)
    expect(harness.closeRequests).toEqual(['close'])
    expect(harness.forceKills).toEqual([])
    expect(new Set(harness.requestedPaths)).toEqual(new Set([executable]))
  })

  it('restarts the quiet interval when a replacement process appears', async () => {
    const harness = createShutdownHarness([
      [],
      [],
      [matching(14)],
      [],
      [],
      [],
      [],
    ])

    await shutdownElectronApplication({
      executable,
      ...harness.options,
      gracefulTimeoutMs: 20,
    })

    expect(harness.now()).toBe(6)
    expect(harness.forceKills).toEqual([])
  })

  it('observes running processes until a graceful close becomes quiet', async () => {
    const harness = createShutdownHarness([
      [matching(21)],
      [matching(21)],
      [],
      [],
      [],
      [],
    ])

    await shutdownElectronApplication({
      executable,
      ...harness.options,
      gracefulTimeoutMs: 20,
    })

    expect(harness.now()).toBe(5)
    expect(harness.closeRequests).toEqual(['close'])
    expect(harness.forceKills).toEqual([])
  })

  it('force-kills only validated processes for the resolved executable after timeout', async () => {
    const unrelated = path.resolve('C:/formal/Arkdown.exe')
    const harness = createShutdownHarness([
      [matching(31)],
      [matching(31)],
      [matching(31), { executablePath: unrelated, pid: 999, parentPid: 0, creationTime: 'created-999' }],
      [],
      [],
      [],
      [],
    ])

    await shutdownElectronApplication({ executable, ...harness.options })

    expect(harness.forceKills).toEqual([[31]])
  })

  it('accepts validated descendants under the scoped root executable', async () => {
    const harness = createShutdownHarness([
      [matching(35), descendant(36, 35)],
      [matching(35), descendant(36, 35)],
      [matching(35), descendant(36, 35)],
      [],
      [],
      [],
      [],
    ])

    await shutdownElectronApplication({ executable, ...harness.options })

    expect(harness.forceKills).toEqual([[35, 36]])
  })

  it('keeps tracking a descendant by PID and creation time after the root exits first', async () => {
    const harness = createShutdownHarness([
      [matching(61), descendant(62, 61)],
      [descendant(62, 61)],
      [descendant(62, 61)],
      [],
      [],
      [],
      [],
    ])

    await shutdownElectronApplication({ executable, ...harness.options })

    expect(harness.forceKills).toEqual([[62]])
  })

  it('does not attach a new child through a reused root PID with a different creation identity', async () => {
    const reusedParent: FakeProcess = {
      executablePath: path.resolve('C:/e2e/runtime/unrelated.exe'),
      pid: 61,
      parentPid: 0,
      creationTime: 'created-after-reuse',
    }
    const child = descendant(63, 61)
    const harness = createShutdownHarness([
      [matching(61)],
      [reusedParent, child],
      [reusedParent, child],
      [reusedParent, child],
      [reusedParent, child],
    ])

    await shutdownElectronApplication({ executable, ...harness.options, gracefulTimeoutMs: 20 })

    expect(harness.forceKills).toEqual([])
  })

  it('restarts the combined quiet gate when either executable reappears across shutdown phases', async () => {
    const arknote = path.resolve('C:/e2e/runtime/Arknote.exe')
    let clock = 0
    let index = 0
    const observations: FakeProcess[][] = [
      [], [],
      [{ executablePath: arknote, pid: 71, parentPid: 0, creationTime: 'created-71' }],
      [], [], [], [],
    ]
    await waitForElectronExecutablesQuiet({
      executables: [executable, arknote],
      enumerateProcesses: async () => observations[Math.min(index++, observations.length - 1)]!,
      delay: async (milliseconds) => { clock += milliseconds },
      now: () => clock,
      pollIntervalMs: 1,
      quietPeriodMs: 3,
      timeoutMs: 20,
    })
    expect(clock).toBe(6)
  })

  it('re-enumerates and clears residual matching processes before the fallback quiet interval', async () => {
    const harness = createShutdownHarness([
      [matching(41)],
      [matching(41)],
      [matching(41)],
      [matching(42)],
      [],
      [],
      [],
      [],
    ])

    await shutdownElectronApplication({ executable, ...harness.options })

    expect(harness.forceKills).toEqual([[41], [42]])
    expect(harness.now()).toBeGreaterThanOrEqual(6)
  })

  it('propagates scoped fallback failures instead of deleting a live runtime', async () => {
    const harness = createShutdownHarness([
      [matching(51)],
      [matching(51)],
      [matching(51)],
    ])
    const failure = new Error('taskkill refused the matching PID')

    await expect(shutdownElectronApplication({
      executable,
      ...harness.options,
      forceKill: async () => { throw failure },
    })).rejects.toBe(failure)
  })
})

describe('packaged-spec Electron application scope', () => {
  it.each(['Arkdown', 'Arknote'] as const)(
    'retains the diagnostic runtime when %s exact shutdown does not reach quiet',
    async (failedExecutable) => {
      const root = path.join(
        tmpdir(),
        `arkdown-runtime-retained-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      )
      cleanupRoots.push(root)
      await mkdir(root, { recursive: true })
      const diagnostic = path.join(root, 'diagnostic.txt')
      await writeFile(diagnostic, 'created\n', 'utf8')
      const failure = new Error(`${failedExecutable} did not become quiet`)

      await expect(cleanupRuntimeAfterExactShutdowns({
        root,
        shutdownArkdown: async () => {
          await appendFile(diagnostic, 'Arkdown-attempted\n', 'utf8')
          if (failedExecutable === 'Arkdown') throw failure
        },
        shutdownArknote: async () => {
          await appendFile(diagnostic, 'Arknote-attempted\n', 'utf8')
          if (failedExecutable === 'Arknote') throw failure
        },
      })).rejects.toBe(failure)

      await expect(readFile(diagnostic, 'utf8')).resolves.toBe(
        'created\nArkdown-attempted\nArknote-attempted\n',
      )
    },
  )

  it('deletes the runtime only after both executable shutdowns reach exact quiet', async () => {
    const root = path.join(
      tmpdir(),
      `arkdown-runtime-deleted-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    )
    cleanupRoots.push(root)
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'diagnostic.txt'), 'created', 'utf8')

    await cleanupRuntimeAfterExactShutdowns({
      root,
      shutdownArkdown: async () => undefined,
      shutdownArknote: async () => undefined,
    })

    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('observes exact-EXE quiet and cleans up after launch rejects before returning a handle', async () => {
    const executable = path.resolve('C:/e2e/handle-less/Arkdown.exe')
    const events: string[] = []
    const enumerated: string[] = []
    let clock = 0
    await shutdownElectronApplicationScope<never>({
      application: undefined,
      executable,
      requestClose: async () => { events.push('close-handle') },
      shutdownOptions: {
        delay: async (milliseconds) => { clock += milliseconds },
        enumerateProcesses: async (executablePath) => {
          enumerated.push(executablePath)
          events.push('enumerate')
          return []
        },
        now: () => clock,
        pollIntervalMs: 1,
        quietPeriodMs: 2,
      },
      afterQuiet: async () => { events.push('cleanup') },
    })

    expect(new Set(enumerated)).toEqual(new Set([executable]))
    expect(events.at(-1)).toBe('cleanup')
    expect(events).not.toContain('close-handle')
  })

  it('propagates shutdown failure and never runs post-quiet cleanup', async () => {
    const failure = new Error('process enumeration failed')
    const afterQuiet = vi.fn(async () => undefined)
    await expect(shutdownElectronApplicationScope({
      application: undefined,
      executable: path.resolve('C:/e2e/failing/Arkdown.exe'),
      requestClose: async () => undefined,
      shutdownOptions: {
        enumerateProcesses: async () => { throw failure },
      },
      afterQuiet,
    })).rejects.toBe(failure)
    expect(afterQuiet).not.toHaveBeenCalled()
  })
})
