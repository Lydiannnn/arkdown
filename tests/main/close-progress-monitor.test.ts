import { expect, it } from 'vitest'
import { CloseProgressMonitor } from '../../src/main/close/close-progress-monitor'

function fixture() {
  let time = 0
  const monitor = new CloseProgressMonitor(() => time)
  return { monitor, at: (next: number) => { time = next; return monitor.snapshot() } }
}
it('keeps fast close invisible and offers status at 500ms', () => {
  const f = fixture()
  expect(f.at(499).feedback).toBe('hidden')
  expect(f.at(500).feedback).toBe('progress')
  f.monitor.finish()
  expect(f.at(30_000).feedback).toBe('hidden')
})
it('does not treat renderer heartbeats or repeating the same stage as actual progress', () => {
  const f = fixture()
  f.at(9_900); f.monitor.heartbeat(); f.monitor.enter('prepare-editor')
  expect(f.at(10_000)).toMatchObject({ feedback: 'no-progress', idleMs: 10_000, rendererAliveAt: 9_900 })
})
it('still reports a 30 second phase when real slow work keeps the idle interval short', () => {
  const f = fixture()
  for (const time of [9_000, 18_000, 27_000]) {
    const completed = f.monitor.beginOperation('document')
    f.at(time); completed()
  }
  expect(f.at(30_000)).toMatchObject({ feedback: 'long-wait', idleMs: 3_000, stageElapsedMs: 30_000 })
})
it('never applies machine deadlines while waiting for the human decision', () => {
  const f = fixture()
  f.monitor.enter('await-user')
  expect(f.at(120_000).feedback).toBe('await-user')
  f.monitor.enter('settle-document')
  expect(f.monitor.snapshot()).toMatchObject({ feedback: 'hidden', stageElapsedMs: 0, idleMs: 0 })
  expect(f.at(130_000).feedback).toBe('no-progress')
})
it('counts registered terminal operations once, and does not let merely starting work renew progress', () => {
  const f = fixture()
  f.at(9_000)
  const done = f.monitor.beginOperation('preferences')
  expect(f.at(10_000).feedback).toBe('no-progress')
  done()
  expect(f.monitor.snapshot()).toMatchObject({ feedback: 'progress', idleMs: 0, pending: {} })
  f.at(19_900); done()
  expect(f.at(20_000).feedback).toBe('no-progress')
})

it('does not flash progress while a cancelled human decision restores editing, but still reveals a slow restore', () => {
  const f = fixture()
  f.monitor.enter('await-user')
  f.at(120_000)
  f.monitor.enter('restore-editor')
  expect(f.monitor.snapshot().feedback).toBe('hidden')
  expect(f.at(120_200).feedback).toBe('hidden')
  expect(f.at(120_500).feedback).toBe('progress')
  expect(f.at(130_000).feedback).toBe('no-progress')
})
it('records pending categories without exposing operation parameters and preserves snapshots', () => {
  const f = fixture()
  const first = f.monitor.beginOperation('document')
  const second = f.monitor.beginOperation('document')
  f.monitor.beginOperation('ipc')
  const snapshot = f.monitor.snapshot()
  expect(snapshot.pending).toEqual({ document: 2, ipc: 1 })
  expect(Object.isFrozen(snapshot.pending)).toBe(true)
  first(); second()
  expect(f.monitor.snapshot().pending).toEqual({ ipc: 1 })
  expect(snapshot.pending).toEqual({ document: 2, ipc: 1 })
})
it('freezes elapsed time and rejects late heartbeat/stage/completion updates after terminal', () => {
  const f = fixture()
  const done = f.monitor.beginOperation('owner')
  f.at(550); f.monitor.finish()
  const final = f.monitor.snapshot()
  f.at(50_000); done(); f.monitor.heartbeat(); f.monitor.enter('native-close')
  expect(f.monitor.snapshot()).toEqual(final)
})
it('allows a repeated close request to show status without creating new progress', () => {
  const f = fixture()
  f.at(100); f.monitor.reveal()
  expect(f.monitor.snapshot()).toMatchObject({ feedback: 'progress', idleMs: 100 })
  expect(f.at(10_000).feedback).toBe('no-progress')
})
it('keeps time monotonic if the injected clock goes backwards', () => {
  const f = fixture()
  expect(f.at(10_000).feedback).toBe('no-progress')
  expect(f.at(500)).toMatchObject({ elapsedMs: 10_000, idleMs: 10_000 })
})
