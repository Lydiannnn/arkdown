import { expect, it, vi } from 'vitest'
import { createCloseNativeUserWait } from '../../src/main/close/close-native-user-wait'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
it('reports only the exact native picker lifetime as human wait, including a picker opened before close', async () => {
  const tracker = createCloseNativeUserWait(), picker = deferred(), enter = vi.fn()
  const flight = tracker.run(() => picker.promise)
  const observer = tracker.observe(enter)
  observer.enter('settle-document')
  expect(enter).toHaveBeenLastCalledWith('await-user')
  picker.resolve(); await flight
  expect(enter).toHaveBeenLastCalledWith('settle-document')
  observer.enter('settle-preferences')
  expect(enter).toHaveBeenLastCalledWith('settle-preferences')
})
it('restores the latest actual phase after nested choices and never revives detached preparation', async () => {
  const tracker = createCloseNativeUserWait(), first = deferred(), second = deferred(), enter = vi.fn()
  const observer = tracker.observe(enter)
  observer.enter('settle-document')
  const a = tracker.run(() => first.promise), b = tracker.run(() => second.promise)
  first.resolve(); await a
  expect(enter).toHaveBeenLastCalledWith('await-user')
  observer.dispose(); enter.mockClear()
  second.resolve(); await b
  expect(enter).not.toHaveBeenCalled()
  const later = tracker.observe(enter)
  expect(enter).toHaveBeenLastCalledWith('prepare-editor')
  later.dispose()
})
it('clears human wait on rejected and synchronously failed native picker calls', async () => {
  const tracker = createCloseNativeUserWait(), enter = vi.fn(), observer = tracker.observe(enter)
  observer.enter('settle-document')
  await expect(tracker.run(() => { throw new Error('picker failed') })).rejects.toThrow('picker failed')
  expect(enter).toHaveBeenLastCalledWith('settle-document')
  observer.dispose()
})
