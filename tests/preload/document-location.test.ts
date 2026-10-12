import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { createBufferedEventTransport } from '../../src/preload/buffered-event-transport'

it('buffers a validated main-owned location until the renderer subscribes', () => {
  let receive!: (payload: unknown) => void
  const transport = createBufferedEventTransport<unknown>(listener => { receive = listener })
  const args: Parameters<typeof createArkdownApi> = [vi.fn()]
  args[29] = transport
  const api = createArkdownApi(...args)
  const location = { absolutePath: 'C:\\notes\\sample.ts', line: 8, anchor: 'section' }
  receive(location)
  const listener = vi.fn()
  const detach = api.onDocumentLocation!(listener)
  expect(listener).toHaveBeenCalledExactlyOnceWith(location)
  for (const invalid of [{ ...location, line: 0 }, { ...location, absolutePath: '../escape' }, { ...location, extra: true }, { absolutePath: location.absolutePath }, Object.create(location)]) receive(invalid)
  expect(listener).toHaveBeenCalledOnce()
  detach()
  receive({ ...location, line: 9 })
  expect(listener).toHaveBeenCalledOnce()
})
