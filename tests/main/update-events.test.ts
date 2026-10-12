// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { UpdateEventSender } from '../../src/main/updates/update-events'
import type { UpdateTransport } from '../../src/main/updates/update-http'
afterEach(() => vi.useRealTimers())
it('sends only four anonymous fields and retries once with the same event ID', async () => {
  vi.useFakeTimers(); const transport = vi.fn<UpdateTransport>().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(new Response(null, { status: 204 }))
  const sender = new UpdateEventSender({ version: '1.0.4', channel: 'stable' }, transport)
  sender.send('update_check'); await vi.advanceTimersByTimeAsync(0)
  expect(transport).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(1000); expect(transport).toHaveBeenCalledTimes(2)
  const first = JSON.parse(transport.mock.calls[0][1].body as string)
  expect(Object.keys(first).sort()).toEqual(['channel', 'eventId', 'type', 'version'])
  expect(first).toMatchObject({ version: '1.0.4', channel: 'stable', type: 'update_check' })
  expect(transport.mock.calls[1][1].body).toBe(transport.mock.calls[0][1].body)
  expect(transport.mock.calls[0][0]).toBe('https://arkdown.cotax.tech/api/v1/events'); sender.dispose()
})
it.each([400, 401, 403, 429, 204])('does not retry status %s', async status => {
  vi.useFakeTimers(); const transport = vi.fn<UpdateTransport>().mockResolvedValue(new Response(null, { status }))
  const sender = new UpdateEventSender({ version: '1.0.4', channel: 'stable' }, transport)
  sender.send('website_opened'); await vi.advanceTimersByTimeAsync(10000); expect(transport).toHaveBeenCalledOnce(); sender.dispose()
})
it('cancels pending retry at disposal', async () => {
  vi.useFakeTimers(); const transport = vi.fn<UpdateTransport>().mockRejectedValue(new Error('offline'))
  const sender = new UpdateEventSender({ version: '1.0.4', channel: 'stable' }, transport)
  sender.send('update_opened'); await vi.advanceTimersByTimeAsync(0); sender.dispose(); await vi.advanceTimersByTimeAsync(10000)
  expect(transport).toHaveBeenCalledOnce()
})
