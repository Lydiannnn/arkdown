import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { MermaidViewerManager } from '../../src/main/mermaid-viewer/manager'

const snapshot = {
  svgDataUrl: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>').toString('base64')}`,
  colorScheme: 'dark' as const,
  themeColor: '#123456',
}

class Window extends EventEmitter {
  destroyed = false
  minimized = false
  shown = 0
  focused = 0
  isDestroyed = () => this.destroyed
  isMinimized = () => this.minimized
  restore = () => { this.minimized = false }
  show = () => { this.shown++ }
  focus = () => { this.focused++ }
  destroy = () => { this.destroyed = true; this.emit('closed') }
}

function setup(load: () => Promise<void> = async () => undefined) {
  const owner = new Window()
  const viewers: Window[] = []
  const disposals: (() => void)[] = []
  const createWindow = vi.fn(() => {
    const window = new Window()
    viewers.push(window)
    const dispose = vi.fn()
    disposals.push(dispose)
    return { window, load, dispose }
  })
  return { owner, viewers, disposals, createWindow, manager: new MermaidViewerManager({ createWindow }) }
}

it('coalesces simultaneous identical opens and restores the already loaded viewer', async () => {
  let ready!: () => void
  const s = setup(() => new Promise<void>(resolve => { ready = resolve }))
  const first = s.manager.open(s.owner, snapshot)
  const second = s.manager.open(s.owner, { ...snapshot })
  expect(s.viewers).toHaveLength(1)
  expect(s.viewers[0]!.shown).toBe(0)
  ready()
  await Promise.all([first, second])
  expect(s.viewers[0]!.shown).toBeGreaterThan(0)
  s.viewers[0]!.minimized = true
  await s.manager.open(s.owner, snapshot)
  expect(s.viewers).toHaveLength(1)
  expect(s.viewers[0]!.minimized).toBe(false)
})

it('bounds viewers per owner, releases a closed slot, and isolates owners', async () => {
  const s = setup()
  for (const themeColor of ['#111111', '#222222', '#333333', '#444444']) {
    await s.manager.open(s.owner, { ...snapshot, themeColor })
  }
  await expect(s.manager.open(s.owner, snapshot)).rejects.toMatchObject({ code: 'MERMAID_VIEWER_LIMIT_REACHED' })
  await s.manager.open(new Window(), snapshot)
  s.viewers[0]!.destroy()
  await s.manager.open(s.owner, snapshot)
  expect(s.viewers).toHaveLength(6)
  expect(s.disposals[0]).toHaveBeenCalledOnce()
})

it('rejects active SVG content before constructing a native window', async () => {
  const s = setup()
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/x"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
  ]) {
    await expect(s.manager.open(s.owner, {
      ...snapshot, svgDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  }
  expect(s.viewers).toHaveLength(0)
})

it('destroys viewers and releases listeners when the owner closes during load', async () => {
  let ready!: () => void
  const s = setup(() => new Promise<void>(resolve => { ready = resolve }))
  const opening = s.manager.open(s.owner, snapshot)
  s.owner.destroy()
  await expect(opening).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  ready()
  await Promise.resolve()
  expect(s.viewers[0]!.destroyed).toBe(true)
  expect(s.viewers[0]!.shown).toBe(0)
  expect(s.disposals[0]).toHaveBeenCalledOnce()
  expect(s.owner.listenerCount('closed')).toBe(0)
  await expect(s.manager.open(s.owner, snapshot)).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
})

it('cleans failed loads and permits a subsequent open without stale slots or listeners', async () => {
  let fail = true
  const s = setup(async () => { if (fail) throw new Error('load failed') })
  await expect(s.manager.open(s.owner, snapshot)).rejects.toThrow('load failed')
  expect(s.viewers[0]!.destroyed).toBe(true)
  expect(s.disposals[0]).toHaveBeenCalledOnce()
  expect(s.owner.listenerCount('closed')).toBe(0)
  fail = false
  await s.manager.open(s.owner, snapshot)
  expect(s.viewers[1]!.shown).toBe(1)
  s.viewers[1]!.destroy()
  expect(s.owner.listenerCount('closed')).toBe(0)
})
