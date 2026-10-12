import { act, renderHook } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditIndicatorSnapshot } from '../../src/renderer/editor/edit-indicators/line-diff'
import { useEditIndicatorModel } from '../../src/renderer/editor/edit-indicators/use-edit-indicator-model'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

const clientMock = vi.hoisted(() => ({
  compute: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('../../src/renderer/editor/edit-indicators/edit-indicator-client', () => ({
  createEditIndicatorClient: () => clientMock,
}))

const clean: EditIndicatorSnapshot = {
  openingLineCount: 1,
  savedLineCount: 1,
  currentLineCount: 1,
  states: ['none'],
}

const unsaved: EditIndicatorSnapshot = {
  openingLineCount: 1,
  savedLineCount: 1,
  currentLineCount: 1,
  states: ['unsaved'],
}

const base = {
  documentKey: 'note-a',
  openingMarkdown: 'alpha',
  savedMarkdown: 'alpha',
  currentMarkdown: 'alpha',
  enabled: true,
}

beforeEach(() => {
  vi.useFakeTimers()
  clientMock.compute.mockReset()
  clientMock.dispose.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useEditIndicatorModel', () => {
  it('does no diff work in visual mode and computes the latest baselines when source mode opens', async () => {
    clientMock.compute.mockResolvedValue({ ...clean, states: ['saved'] })
    const { result, rerender } = renderHook((input) => useEditIndicatorModel(input), {
      initialProps: { ...base, enabled: false },
    })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(clientMock.compute).not.toHaveBeenCalled()
    expect(result.current).toMatchObject({ lineStates: [], status: 'idle' })
    rerender({ ...base, enabled: false, currentMarkdown: 'edited', savedMarkdown: 'edited' })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(clientMock.compute).not.toHaveBeenCalled()
    rerender({ ...base, enabled: true, currentMarkdown: 'edited', savedMarkdown: 'edited' })
    await act(async () => { vi.advanceTimersByTime(120) })
    expect(clientMock.compute).toHaveBeenCalledExactlyOnceWith({
      documentKey: 'note-a', openingMarkdown: 'alpha', savedMarkdown: 'edited', currentMarkdown: 'edited',
    })
    expect(result.current).toMatchObject({ lineStates: ['saved'], status: 'ready' })
  })

  it('disposes work on leaving source mode and rejects a late response even after source reopens', async () => {
    const old = deferred<EditIndicatorSnapshot | null>()
    const current = deferred<EditIndicatorSnapshot | null>()
    clientMock.compute.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const { result, rerender } = renderHook((input) => useEditIndicatorModel(input), { initialProps: base })
    await act(async () => { vi.advanceTimersByTime(120) })
    rerender({ ...base, enabled: false })
    expect(clientMock.dispose).toHaveBeenCalledOnce()
    expect(result.current).toMatchObject({ lineStates: [], status: 'idle' })
    rerender({ ...base, currentMarkdown: 'new edit' })
    await act(async () => { vi.advanceTimersByTime(120) })
    await act(async () => { old.resolve(clean) })
    expect(result.current.lineStates).toEqual([])
    await act(async () => { current.resolve(unsaved) })
    expect(result.current).toMatchObject({ lineStates: ['unsaved'], status: 'ready' })
  })

  it('cancels a debounce when switching to visual mode before the worker starts', async () => {
    clientMock.compute.mockResolvedValue(clean)
    const { rerender } = renderHook((input) => useEditIndicatorModel(input), { initialProps: base })
    await act(async () => { vi.advanceTimersByTime(100) })
    rerender({ ...base, enabled: false })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(clientMock.compute).not.toHaveBeenCalled()
  })

  it('debounces for exactly 120ms and resets continuously without eagerly constructing work', async () => {
    clientMock.compute.mockResolvedValue(clean)
    const { rerender } = renderHook((input) => useEditIndicatorModel(input), {
      initialProps: base,
    })

    await act(async () => { vi.advanceTimersByTime(119) })
    expect(clientMock.compute).not.toHaveBeenCalled()
    rerender({ ...base, currentMarkdown: 'alpha!' })
    await act(async () => { vi.advanceTimersByTime(119) })
    expect(clientMock.compute).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(clientMock.compute).toHaveBeenCalledTimes(1)
    expect(clientMock.compute).toHaveBeenCalledWith({
      documentKey: 'note-a',
      openingMarkdown: 'alpha',
      savedMarkdown: 'alpha',
      currentMarkdown: 'alpha!',
    })
  })

  it('clears synchronously for new computation inputs and ignores a late old result', async () => {
    const first = deferred<EditIndicatorSnapshot | null>()
    const second = deferred<EditIndicatorSnapshot | null>()
    clientMock.compute.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook((input) => useEditIndicatorModel(input), {
      initialProps: base,
    })

    await act(async () => { vi.advanceTimersByTime(120) })
    await act(async () => { first.resolve(unsaved) })
    expect(result.current).toMatchObject({
      lineStates: ['unsaved'], status: 'ready', markdownVersion: 1, modelVersion: 1,
    })

    rerender({
      ...base,
      documentKey: 'note-b',
      openingMarkdown: 'beta',
      savedMarkdown: 'beta',
      currentMarkdown: 'beta',
    })
    expect(result.current).toMatchObject({
      lineStates: [], status: 'computing', markdownVersion: 2, modelVersion: 2,
    })
    await act(async () => { vi.advanceTimersByTime(120) })
    await act(async () => { first.resolve(unsaved) })
    expect(result.current.lineStates).toEqual([])
    await act(async () => { second.resolve(clean) })
    expect(result.current).toMatchObject({ lineStates: ['none'], status: 'ready' })
  })

  it('retains computed source data without recomputing on an unchanged render', async () => {
    clientMock.compute.mockResolvedValue(unsaved)
    const { result, rerender } = renderHook((input) => useEditIndicatorModel(input), {
      initialProps: base,
    })

    await act(async () => { vi.advanceTimersByTime(120) })
    expect(result.current.lineStates).toEqual(['unsaved'])
    const versions = [result.current.markdownVersion, result.current.modelVersion]

    rerender({ ...base })
    expect(clientMock.compute).toHaveBeenCalledTimes(1)
    expect([result.current.markdownVersion, result.current.modelVersion]).toEqual(versions)
    expect(result.current.lineStates).toEqual(['unsaved'])
  })

  it('retains the last same-document indicators while the next edit is computing', async () => {
    const pending = deferred<EditIndicatorSnapshot | null>()
    clientMock.compute.mockResolvedValueOnce(unsaved).mockReturnValueOnce(pending.promise)
    const dirtyInput = { ...base, currentMarkdown: 'alpha!' }
    const { result, rerender } = renderHook((input) => useEditIndicatorModel(input), {
      initialProps: dirtyInput,
    })

    await act(async () => { vi.advanceTimersByTime(120) })
    expect(result.current).toMatchObject({
      lineStates: ['unsaved'], status: 'ready', markdownVersion: 1, modelVersion: 1,
    })
    const lastStates = result.current.lineStates

    rerender({ ...dirtyInput, currentMarkdown: 'alpha!!' })

    expect(result.current).toMatchObject({
      lineStates: ['unsaved'], status: 'computing', markdownVersion: 1, modelVersion: 1,
    })
    expect(result.current.lineStates).toBe(lastStates)

    rerender({ ...dirtyInput, currentMarkdown: 'alpha!!' })
    expect(result.current.lineStates).toBe(lastStates)

    await act(async () => { vi.advanceTimersByTime(120) })
    await act(async () => { pending.resolve(unsaved) })
    expect(result.current).toMatchObject({
      lineStates: ['unsaved'], status: 'ready', markdownVersion: 2, modelVersion: 2,
    })
  })

  it('ignores a late response from the prior document generation', async () => {
    const oldResult = deferred<EditIndicatorSnapshot | null>()
    const nextResult = deferred<EditIndicatorSnapshot | null>()
    clientMock.compute.mockReturnValueOnce(oldResult.promise).mockReturnValueOnce(nextResult.promise)
    const { result, rerender } = renderHook((input) => useEditIndicatorModel(input), {
      initialProps: base,
    })
    await act(async () => { vi.advanceTimersByTime(120) })

    rerender({
      ...base,
      documentKey: 'note-b',
      openingMarkdown: 'beta',
      savedMarkdown: 'beta',
      currentMarkdown: 'beta',
    })
    expect(result.current).toMatchObject({ lineStates: [], status: 'computing' })
    await act(async () => { oldResult.resolve(unsaved) })
    expect(result.current).toMatchObject({ lineStates: [], status: 'computing' })

    await act(async () => { vi.advanceTimersByTime(120) })
    await act(async () => { nextResult.resolve(clean) })
    expect(result.current).toMatchObject({ lineStates: ['none'], status: 'ready' })
  })

  it('increments only modelVersion on save and classifies the result against the new baseline', async () => {
    clientMock.compute.mockResolvedValueOnce(unsaved).mockResolvedValueOnce({ ...clean, states: ['saved'] })
    const dirtyInput = { ...base, currentMarkdown: 'alpha!' }
    const { result, rerender } = renderHook((input) => useEditIndicatorModel(input), {
      initialProps: dirtyInput,
    })

    await act(async () => { vi.advanceTimersByTime(120) })
    expect(result.current.lineStates).toEqual(['unsaved'])
    rerender({ ...dirtyInput, savedMarkdown: 'alpha!' })
    expect(result.current).toMatchObject({
      lineStates: ['unsaved'], markdownVersion: 1, modelVersion: 1, status: 'computing',
    })
    await act(async () => { vi.advanceTimersByTime(120) })
    expect(result.current.lineStates).toEqual(['saved'])
  })

  it('logs one still-current failure, exposes failed/empty state, and recovers on later input', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    clientMock.compute
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(clean)
    const { result, rerender } = renderHook((input) => useEditIndicatorModel(input), {
      initialProps: base,
    })

    await act(async () => { vi.advanceTimersByTime(120) })
    expect(result.current).toMatchObject({ lineStates: [], status: 'failed' })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('edit-indicator-diff-failed', expect.any(Error))

    rerender({ ...base, currentMarkdown: 'changed' })
    await act(async () => { vi.advanceTimersByTime(120) })
    expect(result.current.status).toBe('ready')
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('guards StrictMode cleanup and never publishes work after unmount', async () => {
    const pending = deferred<EditIndicatorSnapshot | null>()
    clientMock.compute.mockReturnValue(pending.promise)
    const { unmount } = renderHook(() => useEditIndicatorModel(base), {
      wrapper: StrictMode,
    })
    await act(async () => { vi.advanceTimersByTime(120) })
    unmount()
    expect(clientMock.dispose).toHaveBeenCalled()
    await act(async () => { pending.resolve(unsaved) })
  })
})
