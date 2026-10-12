// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { createCodexCliLoginService, isOfficialCodexLoginUrl } from '../../src/main/codex/codex-cli-login-service'

class Child extends EventEmitter {
  pid = 78121
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  messages: any[] = []
  constructor() {
    super()
    this.stdin.on('data', data => { this.messages.push(JSON.parse(data.toString())) })
    this.stdin.on('finish', () => queueMicrotask(() => this.emit('close', 0, null)))
  }
  reply(value: unknown) { this.stdout.write(JSON.stringify(value) + '\n') }
}
const official = 'https://auth.openai.com/oauth/authorize?client_id=codex&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'
function harness(options: { timeoutMs?: number; cleanupTimeoutMs?: number; terminateProcessTree?: (pid: number) => Promise<void> } = {}) {
  const child = new Child()
  const resolveExecutable = vi.fn(async () => 'C:\\managed\\codex.exe')
  const spawn = vi.fn((_command: string) => child)
  const openExternal = vi.fn(async (_url: string) => {})
  const service = createCodexCliLoginService({ resolveExecutable, spawn: spawn as never, openExternal, ...options })
  return { child, resolveExecutable, spawn, openExternal, service }
}
async function begin(h: ReturnType<typeof harness>) {
  const pending = h.service.start('panel-1')
  await vi.waitFor(() => expect(h.child.messages[0]?.method).toBe('initialize'))
  h.child.reply({ id: 1, result: {} })
  await vi.waitFor(() => expect(h.child.messages.at(-1)?.method).toBe('account/login/start'))
  return { pending }
}
it('reports a missing runtime without starting a process or opening a browser', async () => {
  const h = harness(); h.resolveExecutable.mockResolvedValue(undefined as never)
  expect(await h.service.start('panel-1')).toEqual({ status: 'not-found' })
  expect(h.spawn).not.toHaveBeenCalled(); expect(h.openExternal).not.toHaveBeenCalled()
  await h.service.dispose()
})
it('opens only an official browser login, waits for its matching completion and drains the child', async () => {
  const h = harness(); const { pending } = await begin(h)
  expect(h.spawn.mock.calls[0]?.[0]).toBe('C:\\managed\\codex.exe')
  expect(h.child.messages.at(-1)).toEqual({ id: 2, method: 'account/login/start', params: { type: 'chatgpt' } })
  h.child.reply({ id: 2, result: { type: 'chatgpt', loginId: 'login-1', authUrl: official } })
  await vi.waitFor(() => expect(h.openExternal).toHaveBeenCalledExactlyOnceWith(official))
  h.child.reply({ method: 'account/login/completed', params: { loginId: 'another', success: true } })
  h.child.reply({ method: 'account/login/completed', params: { loginId: 'login-1', success: true, error: null } })
  expect(await pending).toEqual({ status: 'completed' })
  expect(h.child.stdin.writableEnded).toBe(true)
  expect(h.child.messages.some(item => item.method === 'account/logout')).toBe(false)
  await h.service.dispose()
})
it.each(['https://evil.invalid/oauth/authorize', 'https://auth.openai.com.evil.invalid/oauth/authorize',
  'https://auth.openai.com@evil.invalid/oauth/authorize', 'http://auth.openai.com/oauth/authorize',
  'https://auth.openai.com:444/oauth/authorize', 'https://auth.openai.com/anything',
  'https://auth.openai.com/oauth/authorize#fragment'])('refuses an unapproved login URL: %s', async url => {
  expect(isOfficialCodexLoginUrl(url)).toBe(false)
  const h = harness(); const { pending } = await begin(h)
  h.child.reply({ id: 2, result: { type: 'chatgpt', loginId: 'login-1', authUrl: url } })
  expect(await pending).toEqual({ status: 'failed' })
  expect(h.openExternal).not.toHaveBeenCalled(); await h.service.dispose()
})
it('cancels only its owner, sends login cancellation and closes the process without logout', async () => {
  const h = harness(); const { pending } = await begin(h)
  h.child.reply({ id: 2, result: { type: 'chatgpt', loginId: 'login-1', authUrl: official } })
  await vi.waitFor(() => expect(h.openExternal).toHaveBeenCalledOnce())
  await h.service.cancel('other-panel')
  expect(h.child.stdin.writableEnded).toBe(false)
  await h.service.cancel('panel-1')
  expect(await pending).toEqual({ status: 'cancelled' })
  expect(h.child.messages).toContainEqual({ id: 3, method: 'account/login/cancel', params: { loginId: 'login-1' } })
  expect(h.child.messages.some(item => item.method === 'account/logout')).toBe(false)
  await h.service.dispose()
})
it('cancels while executable resolution is pending and never starts a late process', async () => {
  const h = harness(); let finish!: (value: string) => void
  h.resolveExecutable.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = h.service.start('panel-1')
  await vi.waitFor(() => expect(h.resolveExecutable).toHaveBeenCalledOnce())
  await h.service.cancel('panel-1')
  finish('C:\\managed\\codex.exe')
  expect(await pending).toEqual({ status: 'cancelled' })
  await Promise.resolve(); expect(h.spawn).not.toHaveBeenCalled(); await h.service.dispose()
})
it('times out a stalled login and recovers the dedicated process', async () => {
  const h = harness({ timeoutMs: 10 })
  expect(await h.service.start('panel-1')).toEqual({ status: 'timeout' })
  expect(h.child.stdin.writableEnded).toBe(true)
  await h.service.dispose()
})
it('rejects a broken protocol stream without exposing diagnostics', async () => {
  const h = harness(); const { pending } = await begin(h)
  h.child.stdout.emit('error', new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC'))
  expect(await pending).toEqual({ status: 'failed' })
  await h.service.dispose()
})
it('force terminates a login child that ignores stdin closure', async () => {
  const terminateProcessTree = vi.fn(async (_pid: number) => { h.child.emit('close', null, 'SIGKILL') })
  const h = harness({ cleanupTimeoutMs: 5, terminateProcessTree })
  h.child.stdin.removeAllListeners('finish')
  const { pending } = await begin(h)
  await h.service.cancel('panel-1')
  expect(await pending).toEqual({ status: 'cancelled' })
  expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(h.child.pid)
  await h.service.dispose()
})
