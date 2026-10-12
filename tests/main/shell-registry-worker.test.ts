import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { canInitializeDesktopRegistration, createRegistryWorker, isolatedRegistryRoot, WindowsShellRegistry } from '../../src/main/shell-integration/windows-registry'
import { ShellMenuRegistration } from '../../src/main/shell-integration/registration'

it('blocks ordinary E2E before launching the real registry worker', async () => {
  vi.stubEnv('ARKDOWN_E2E', '1')
  vi.stubEnv('ARKDOWN_REGISTRY_TEST_ROOT', '')
  const launch = vi.fn()
  try {
    await expect(createRegistryWorker(launch).execute({ action: 'change' })).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_UNSUPPORTED' })
    expect(launch).not.toHaveBeenCalled()
  } finally { vi.unstubAllEnvs() }
})
it('allows native isolation only under the fixed test namespace and skips ordinary E2E Arknote initialization', () => {
  expect(canInitializeDesktopRegistration({})).toBe(true)
  expect(canInitializeDesktopRegistration({ ARKDOWN_E2E: '1' })).toBe(false)
  for (const root of ['Software\\Classes', 'Software\\ArkdownNativeTests\\..', 'Software\\ArkdownNativeTests\\test\\escape']) {
    expect(isolatedRegistryRoot({ ARKDOWN_E2E: '1', ARKDOWN_REGISTRY_TEST_ROOT: root })).toBeNull()
  }
  const root = 'Software\\ArkdownNativeTests\\case-123'
  expect(isolatedRegistryRoot({ ARKDOWN_E2E: '1', ARKDOWN_REGISTRY_TEST_ROOT: root })).toBe(root)
  expect(isolatedRegistryRoot({ ARKDOWN_REGISTRY_TEST_ROOT: root })).toBeNull()
})
it.each([
  [null, null, false, false], ['C:\\中文 Apps\\Arkdown.exe', null, true, false],
  ['c:\\中文 apps\\arkdown.exe', 'C:\\中文 Apps\\Arkdown.exe', true, true],
  ['C:\\Other\\Arkdown.exe', 'C:\\Other\\Arkdown.exe', false, false],
])('resolves the actual executable for both extensions: %j / %j', async (md, txt, markdown, text) => {
  const execute = vi.fn(async () => ({ '.md': { progId: md ? 'Markdown.Type' : null, executable: md }, '.txt': { progId: txt ? 'Text.Type' : null, executable: txt } }))
  const registry = new WindowsShellRegistry({ execute, close: async () => {} })
  await expect(registry.defaultApplicationsStatus('C:\\中文 Apps\\Arkdown.exe')).resolves.toEqual({ markdown, text })
  expect(execute).toHaveBeenCalledExactlyOnceWith({ action: 'associations' })
})

it('reuses one hidden shell-disabled Unicode JSON worker and waits for its exit', async () => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  const requests: unknown[] = []
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      requests.push(JSON.parse(chunk.toString('utf8')))
      child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, value: { label: '中文 便签' } }) + '\n', 'utf8'))
      done()
    },
  })
  const launch = vi.fn(() => child)
  const worker = createRegistryWorker(launch)
  expect(launch).not.toHaveBeenCalled()
  await expect(worker.execute({ action: 'read', key: '中文 文档' })).resolves.toEqual({ label: '中文 便签' })
  await worker.execute({ action: 'read', key: 'next' })
  expect(launch).toHaveBeenCalledTimes(1)
  expect(launch.mock.calls[0]).toEqual(['powershell.exe', expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']), { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }])
  expect(requests).toEqual([{ action: 'read', key: '中文 文档' }, { action: 'read', key: 'next' }])
  let closed = false
  const closing = worker.close().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(child.stdin.writableEnded).toBe(true)
  child.emit('close', 0)
  await closing
  expect(closed).toBe(true)
})

it('propagates compare-before-write conflicts without leaking native stderr', async () => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new Writable({ write(_chunk, _encoding, done) {
    child.stdout.emit('data', Buffer.from('{"ok":false,"conflict":true}\n'))
    done()
  } })
  const worker = createRegistryWorker(() => child)
  await expect(worker.execute({ action: 'change' })).rejects.toMatchObject({ code: 'SHELL_INTEGRATION_CONFLICT' })
  const closing = worker.close()
  child.emit('close', 0)
  await closing
})

it('closes the actual adapter worker after a mid-operation failure and lets the next queued operation complete', async () => {
  let failWrite = true
  let exits = 0
  const launch = vi.fn(() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.toString()) as { action: string }
        const fail = request.action === 'change' && failWrite
        if (fail) failWrite = false
        child.stdout.emit('data', Buffer.from(JSON.stringify(fail
          ? { ok: false, conflict: false }
          : { ok: true, value: request.action === 'change' ? [] : null }) + '\n'))
        done()
      },
      final(done) { exits += 1; child.emit('close', 0); done() },
    })
    return child
  })
  const registration = new ShellMenuRegistration({ executablePath: 'C:\\Arkdown.exe', registry: new WindowsShellRegistry(createRegistryWorker(launch)) })
  let persisted = 0
  const first = registration.setEnabled('documentOpenMenu', true)
  const next = registration.setEnabled('documentOpenMenu', true, async () => { persisted += 1 })
  await expect(first).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  await next
  expect(persisted).toBe(1)
  expect(launch).toHaveBeenCalledTimes(2)
  expect(exits).toBe(2)
})
