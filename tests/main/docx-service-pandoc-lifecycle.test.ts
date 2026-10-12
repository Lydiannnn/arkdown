import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

class FakePandocProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => true)
}

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    default: { ...actual, spawn: mocks.spawn },
    spawn: mocks.spawn,
  }
})

vi.mock('../../src/main/docx/pandoc-locator', () => ({
  resolvePandocExecutable: vi.fn(async () => 'pandoc.exe'),
}))

import { DocxService } from '../../src/main/docx/docx-service'

let child: FakePandocProcess
let root = ''

beforeEach(async () => {
  child = new FakePandocProcess()
  mocks.spawn.mockReset()
  root = await mkdtemp(path.join(tmpdir(), 'arkdown-docx-pandoc-lifecycle-'))
  await mkdir(path.join(root, 'temp'), { recursive: true })
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

it('keeps the instance root until a late Pandoc exit confirms shutdown cleanup', async () => {
  vi.useFakeTimers()
  let reportSpawned = () => {}
  const spawned = new Promise<void>((resolve) => { reportSpawned = resolve })
  mocks.spawn.mockImplementation(() => {
    reportSpawned()
    return child
  })
  const service = new DocxService({
    tempRoot: path.join(root, 'temp'),
    executablePath: path.join(root, 'Arkdown.exe'),
    resourcesPath: root,
  })
  const source = path.join(root, 'source.docx')
  await writeFile(source, 'fake docx', 'utf8')
  let importError: unknown
  let importSettled = false
  const importing = service.importText(source).then(
    () => { importSettled = true },
    (error: unknown) => {
      importError = error
      importSettled = true
    },
  )
  await spawned

  let disposeSettled = false
  const disposal = service.dispose().then(
    () => { disposeSettled = true },
    () => { disposeSettled = true },
  )
  await vi.advanceTimersByTimeAsync(10_000)
  await importing
  const rootBeforeLateExit = await readdir(path.join(root, 'temp', 'docx'))
  const importSettledBeforeExit = importSettled
  const disposeSettledBeforeExit = disposeSettled
  const termination = (importError as {
    termination?: { isConfirmed(): boolean; readonly whenConfirmed: Promise<void> }
  } | undefined)?.termination
  const confirmedBeforeExit = termination?.isConfirmed()

  child.emit('exit', null, 'SIGKILL')
  await termination?.whenConfirmed
  await disposal
  const rootAfterLateExit = await readdir(path.join(root, 'temp', 'docx'))

  expect(importError).toMatchObject({ name: 'PandocTerminationUnconfirmedError' })
  expect(importSettledBeforeExit).toBe(true)
  expect(disposeSettledBeforeExit).toBe(false)
  expect(confirmedBeforeExit).toBe(false)
  expect(rootBeforeLateExit).toHaveLength(1)
  expect(termination?.isConfirmed()).toBe(true)
  expect(rootAfterLateExit).toEqual([])
})
