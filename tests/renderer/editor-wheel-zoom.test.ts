import { expect, it, vi } from 'vitest'
import { createEditorWheelZoomHandler } from '../../src/renderer/editor/editor-wheel-zoom'

function wheel(input: Partial<WheelEvent> = {}): WheelEvent {
  return {
    ctrlKey: true,
    deltaX: 0,
    deltaY: -100,
    preventDefault: vi.fn(),
    ...input,
  } as unknown as WheelEvent
}

it('maps Ctrl+vertical wheel to the existing editor zoom actions and suppresses native zoom', () => {
  let now = 100
  const onZoom = vi.fn()
  const handler = createEditorWheelZoomHandler(onZoom, { now: () => now })
  const up = wheel({ deltaY: -100 })
  handler(up)
  expect(onZoom).toHaveBeenLastCalledWith('in')
  expect(up.preventDefault).toHaveBeenCalledOnce()

  now += 100
  const down = wheel({ deltaY: 100 })
  handler(down)
  expect(onZoom).toHaveBeenLastCalledWith('out')
  expect(down.preventDefault).toHaveBeenCalledOnce()
})

it('leaves ordinary, zero, and horizontal wheel input untouched', () => {
  const onZoom = vi.fn()
  const handler = createEditorWheelZoomHandler(onZoom)
  const inputs = [
    wheel({ ctrlKey: false }),
    wheel({ deltaY: 0 }),
    wheel({ deltaX: 120, deltaY: 20 }),
  ]
  inputs.forEach(handler)
  expect(onZoom).not.toHaveBeenCalled()
  for (const input of inputs) expect(input.preventDefault).not.toHaveBeenCalled()
})

it('bounds a same-direction touchpad burst while allowing a direction change immediately', () => {
  let now = 100
  const onZoom = vi.fn()
  const handler = createEditorWheelZoomHandler(onZoom, { now: () => now, minimumIntervalMs: 50 })
  handler(wheel({ deltaY: -2 }))
  now = 110
  handler(wheel({ deltaY: -3 }))
  now = 120
  handler(wheel({ deltaY: -4 }))
  expect(onZoom.mock.calls).toEqual([['in']])

  now = 125
  handler(wheel({ deltaY: 3 }))
  expect(onZoom.mock.calls).toEqual([['in'], ['out']])

  now = 180
  handler(wheel({ deltaY: 2 }))
  expect(onZoom.mock.calls).toEqual([['in'], ['out'], ['out']])
})
