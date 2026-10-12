import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
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

import { runPandoc, runPandocText } from '../../src/main/docx/pandoc-runner'

const STDOUT_BYTE_LIMIT = 16 * 1024 * 1024

let child: FakePandocProcess

beforeEach(() => {
  child = new FakePandocProcess()
  mocks.spawn.mockReset()
  mocks.spawn.mockReturnValue(child)
})

afterEach(() => {
  vi.useRealTimers()
})

function observeRejection(promise: Promise<unknown>): {
  getError: () => unknown
  isSettled: () => boolean
  observed: Promise<void>
} {
  let error: unknown
  let settled = false
  const observed = promise.then(
    () => { settled = true },
    (reason: unknown) => {
      error = reason
      settled = true
    },
  )
  return {
    getError: () => error,
    isSettled: () => settled,
    observed,
  }
}

it('captures Pandoc plain-text stdout without requiring an output file', async () => {
  const conversion = runPandocText(
    'pandoc.exe',
    ['source.docx', '--from=docx', '--to=plain', '--wrap=none'],
    'C:\\temp',
  )

  child.stdout.write('Heading\nplain body')
  child.stdout.end()
  child.emit('close', 0)

  await expect(conversion).resolves.toBe('Heading\nplain body')
})

it('decodes multibyte UTF-8 split across stdout chunks', async () => {
  const conversion = runPandocText('pandoc.exe', ['source.docx'], 'C:\\temp')

  child.stdout.emit('data', Buffer.from([0xe4, 0xb8]))
  child.stdout.emit('data', Buffer.from([0xad, 0x0a, 0xc3, 0xa9]))
  child.emit('close', 0)

  await expect(conversion).resolves.toBe('中\né')
})

it('rejects invalid UTF-8 instead of replacing malformed stdout bytes', async () => {
  const conversion = runPandocText('pandoc.exe', ['source.docx'], 'C:\\temp')

  child.stdout.emit('data', Buffer.from([0xc3, 0x28]))
  child.emit('close', 0)

  await expect(conversion).rejects.toMatchObject({ code: 'DOCX_CONVERSION_FAILED' })
})

it('terminates promptly on an invalid UTF-8 chunk even when the child never closes', async () => {
  vi.useFakeTimers()
  const conversion = runPandocText('pandoc.exe', ['source.docx'], 'C:\\temp')
  const outcome = observeRejection(conversion)

  child.stdout.emit('data', Buffer.from([0xc3, 0x28]))
  await Promise.resolve()
  const killCallsAfterInvalidChunk = child.kill.mock.calls.length
  await vi.advanceTimersByTimeAsync(10_000)
  const settledWithoutClose = outcome.isSettled()
  const errorWithoutClose = outcome.getError()

  if (!settledWithoutClose) child.emit('close', 0)
  await outcome.observed
  expect(killCallsAfterInvalidChunk).toBe(1)
  expect(settledWithoutClose).toBe(true)
  expect(errorWithoutClose).toMatchObject({ name: 'PandocTerminationUnconfirmedError' })
})

it('accepts stdout exactly at the raw byte limit', async () => {
  const conversion = runPandocText('pandoc.exe', ['source.docx'], 'C:\\temp')

  child.stdout.emit('data', Buffer.alloc(STDOUT_BYTE_LIMIT, 0x61))
  child.emit('close', 0)

  const text = await conversion
  expect(text).toHaveLength(STDOUT_BYTE_LIMIT)
  expect(text.at(0)).toBe('a')
  expect(text.at(-1)).toBe('a')
})

it('terminates and rejects when a later stdout chunk exceeds the raw byte limit', async () => {
  const conversion = runPandocText('pandoc.exe', ['source.docx'], 'C:\\temp')
  const outcome = observeRejection(conversion)

  child.stdout.emit('data', Buffer.alloc(STDOUT_BYTE_LIMIT, 0x61))
  child.stdout.emit('data', Buffer.from([0x62]))
  await Promise.resolve()
  const killCallsBeforeExit = child.kill.mock.calls.length
  child.emit('exit', null, 'SIGTERM')
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  const settledOnExit = outcome.isSettled()

  if (!settledOnExit) child.emit('close', 0)
  await outcome.observed
  expect(killCallsBeforeExit).toBe(1)
  expect(settledOnExit).toBe(true)
  expect(outcome.getError()).toMatchObject({ code: 'DOCX_CONVERSION_FAILED' })
})

it.each(['stdout', 'stderr'] as const)(
  'handles a %s pipe error once, terminates Pandoc, and waits for exit',
  async (streamName) => {
    const conversion = runPandocText('pandoc.exe', ['source.docx'], 'C:\\temp')
    const outcome = observeRejection(conversion)
    const stream = child[streamName]
    let thrown: unknown
    try {
      stream.emit('error', new Error(`${streamName} failed`))
      stream.emit('error', new Error(`${streamName} failed again`))
    } catch (error) {
      thrown = error
    }
    const killCallsBeforeExit = child.kill.mock.calls.length
    child.emit('exit', null, 'SIGTERM')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    const settledOnExit = outcome.isSettled()

    if (!settledOnExit) child.emit('close', 1)
    await outcome.observed
    expect(thrown).toBeUndefined()
    expect(killCallsBeforeExit).toBe(1)
    expect(settledOnExit).toBe(true)
    expect(outcome.getError()).toMatchObject({ code: 'DOCX_CONVERSION_FAILED' })
  },
)

it('treats exit without close as confirmed termination after abort', async () => {
  const controller = new AbortController()
  const reason = new DOMException('canceled', 'AbortError')
  const conversion = runPandoc('pandoc.exe', ['source.docx'], 'C:\\temp', {
    signal: controller.signal,
  })
  const outcome = observeRejection(conversion)

  controller.abort(reason)
  child.emit('exit', null, 'SIGTERM')
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  const settledOnExit = outcome.isSettled()

  if (!settledOnExit) child.emit('close', null)
  await outcome.observed
  expect(settledOnExit).toBe(true)
  expect(outcome.getError()).toMatchObject({ name: 'AbortError' })
})

it('settles with an unconfirmed-termination error when kill succeeds but the process never exits', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const conversion = runPandoc('pandoc.exe', ['source.docx'], 'C:\\temp', {
    signal: controller.signal,
  })
  const outcome = observeRejection(conversion)

  controller.abort(new DOMException('canceled', 'AbortError'))
  await vi.advanceTimersByTimeAsync(10_000)
  const settledAfterGrace = outcome.isSettled()
  const errorAfterGrace = outcome.getError()

  if (!settledAfterGrace) child.emit('close', null)
  await outcome.observed
  expect(settledAfterGrace).toBe(true)
  expect(errorAfterGrace).toMatchObject({ name: 'PandocTerminationUnconfirmedError' })
  expect(child.kill.mock.calls).toEqual([[], ['SIGKILL']])
  const termination = (errorAfterGrace as {
    termination: { isConfirmed?: () => boolean; whenConfirmed: Promise<void> }
  }).termination
  const exposedMutableFlag = 'confirmed' in termination
  const initiallyConfirmed = termination.isConfirmed?.()
  const replacement = Object.freeze({
    isConfirmed: () => true,
    whenConfirmed: Promise.resolve(),
  })
  let assignmentFailure: unknown
  let defineFailure: unknown
  let prototypeDefineFailure: unknown
  try {
    ;(errorAfterGrace as { termination: unknown }).termination = replacement
  } catch (error) {
    assignmentFailure = error
  }
  try {
    Object.defineProperty(errorAfterGrace, 'termination', { value: replacement })
  } catch (error) {
    defineFailure = error
  }
  const errorPrototype = Object.getPrototypeOf(errorAfterGrace) as object
  const terminationDescriptor = Object.getOwnPropertyDescriptor(errorPrototype, 'termination')
  try {
    Object.defineProperty(errorPrototype, 'termination', { value: replacement })
  } catch (error) {
    prototypeDefineFailure = error
  }
  if (prototypeDefineFailure === undefined && terminationDescriptor !== undefined) {
    Object.defineProperty(errorPrototype, 'termination', terminationDescriptor)
  }
  const terminationAfterAttacks = (errorAfterGrace as { termination: unknown }).termination
  child.emit('exit', null, 'SIGKILL')
  await termination.whenConfirmed
  expect(exposedMutableFlag).toBe(false)
  expect(initiallyConfirmed).toBe(false)
  expect(termination.isConfirmed?.()).toBe(true)
  expect(terminationAfterAttacks).toBe(termination)
  expect(assignmentFailure).toBeInstanceOf(TypeError)
  expect(defineFailure).toBeInstanceOf(TypeError)
  expect(prototypeDefineFailure).toBeInstanceOf(TypeError)
  expect(Object.isFrozen(errorAfterGrace)).toBe(true)
  expect(Object.isExtensible(errorAfterGrace)).toBe(false)
  expect(Object.isFrozen(termination)).toBe(true)
})

it('does not treat kill returning false as confirmed process termination', async () => {
  vi.useFakeTimers()
  child.kill.mockReturnValue(false)
  const controller = new AbortController()
  const conversion = runPandoc('pandoc.exe', ['source.docx'], 'C:\\temp', {
    signal: controller.signal,
  })
  const outcome = observeRejection(conversion)

  controller.abort(new DOMException('canceled', 'AbortError'))
  await Promise.resolve()
  const settledBeforeGrace = outcome.isSettled()
  await vi.advanceTimersByTimeAsync(10_000)
  const settledAfterGrace = outcome.isSettled()
  const errorAfterGrace = outcome.getError()

  if (!settledAfterGrace) child.emit('close', null)
  await outcome.observed
  expect(settledBeforeGrace).toBe(false)
  expect(settledAfterGrace).toBe(true)
  expect(errorAfterGrace).toMatchObject({ name: 'PandocTerminationUnconfirmedError' })
  expect(child.kill.mock.calls).toEqual([[], ['SIGKILL']])
})

it('bounds a timed-out conversion even when Pandoc never exits', async () => {
  vi.useFakeTimers()
  const conversion = runPandoc('pandoc.exe', ['source.docx'], 'C:\\temp', {
    timeoutMs: 50,
  })
  const outcome = observeRejection(conversion)

  await vi.advanceTimersByTimeAsync(10_000)
  const settledAfterGrace = outcome.isSettled()
  const errorAfterGrace = outcome.getError()

  if (!settledAfterGrace) child.emit('close', null)
  await outcome.observed
  expect(settledAfterGrace).toBe(true)
  expect(errorAfterGrace).toMatchObject({ name: 'PandocTerminationUnconfirmedError' })
})

it('consumes repeated child errors throughout two-phase termination', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const conversion = runPandoc('pandoc.exe', ['source.docx'], 'C:\\temp', {
    signal: controller.signal,
  })
  const outcome = observeRejection(conversion)

  controller.abort(new DOMException('canceled', 'AbortError'))
  let thrown: unknown
  try {
    child.emit('error', Object.assign(new Error('kill error one'), { code: 'EPERM' }))
    child.emit('error', Object.assign(new Error('kill error two'), { code: 'EPERM' }))
  } catch (error) {
    thrown = error
  }
  await vi.advanceTimersByTimeAsync(10_000)
  const settledAfterGrace = outcome.isSettled()
  const errorAfterGrace = outcome.getError()

  if (!settledAfterGrace) child.emit('close', null)
  await outcome.observed
  expect(thrown).toBeUndefined()
  expect(child.kill.mock.calls).toEqual([[], ['SIGKILL']])
  expect(settledAfterGrace).toBe(true)
  expect(errorAfterGrace).toMatchObject({ name: 'PandocTerminationUnconfirmedError' })
})
