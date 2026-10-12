// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { requestBoundedUpdateJson } from '../../src/main/updates/update-http'

afterEach(() => vi.useRealTimers())
it('accepts exactly 128 KiB, handles BOM, and refuses one byte more', async () => {
  for (const [size, accepted] of [[131072, true], [131073, false]] as const) {
    const result = await requestBoundedUpdateJson('https://arkdown.cotax.tech/test', {}, new AbortController().signal,
      async () => new Response('{"x":"' + 'a'.repeat(size - 8) + '"}'))
    expect(result?.json !== undefined).toBe(accepted)
  }
  expect((await requestBoundedUpdateJson('https://arkdown.cotax.tech/test', {}, new AbortController().signal,
    async () => new Response('\ufeff{"ok":true}')))?.json).toEqual({ ok: true })
})
it.each([204, 302, 400, 429, 503])('does not parse a status %s body as a decision', async status => {
  const response = await requestBoundedUpdateJson('https://arkdown.cotax.tech/test', {}, new AbortController().signal,
    async () => new Response(status === 204 ? null : '{"valid":true}', { status }))
  expect(response?.json).toBeUndefined()
})
it('does not follow redirects or attach cookies to its native request', async () => {
  const paths: string[] = []
  const server = createServer((req, res) => { paths.push(req.url!); res.writeHead(302, { Location: '/other' }); res.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    await requestBoundedUpdateJson(`http://127.0.0.1:${address.port}/first`, {}, new AbortController().signal)
    expect(paths).toEqual(['/first'])
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
it('aborts an 8-second request including the response-body wait', async () => {
  vi.useFakeTimers()
  let observed: AbortSignal | undefined
  const pending = requestBoundedUpdateJson('https://arkdown.cotax.tech/test', {}, new AbortController().signal,
    async (_url, init) => {
      observed = init?.signal as AbortSignal
      return new Response(new ReadableStream({ start(controller) {
        observed!.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true })
      } }))
    })
  await vi.advanceTimersByTimeAsync(7999); expect(observed?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1); expect(observed?.aborted).toBe(true)
  expect(await pending).toBeUndefined()
})
it('treats HTML, broken JSON and already cancelled requests as unavailable', async () => {
  for (const body of ['<html>bad</html>', '{']) {
    expect(await requestBoundedUpdateJson('https://arkdown.cotax.tech/test', {}, new AbortController().signal,
      async () => new Response(body))).toBeUndefined()
  }
  const fetcher = vi.fn(); const controller = new AbortController(); controller.abort()
  expect(await requestBoundedUpdateJson('https://arkdown.cotax.tech/test', {}, controller.signal, fetcher)).toBeUndefined()
  expect(fetcher).not.toHaveBeenCalled()
})
