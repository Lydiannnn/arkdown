import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'

const snapshot = { svgDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', colorScheme: 'light' as const, themeColor: '#336699' }

it('opens the exact vector snapshot and reads a validated viewer snapshot', async () => {
  const invoke = vi.fn(async (channel: string) => ({ ok: true, value: channel.endsWith(':get') ? snapshot : null }))
  const api = createArkdownApi(invoke)
  await expect(api.openMermaidViewer?.(snapshot)).resolves.toEqual({ ok: true, value: null })
  await expect(api.getMermaidViewerSnapshot?.()).resolves.toEqual({ ok: true, value: snapshot })
  expect(invoke.mock.calls).toEqual([['mermaid-viewer:open', snapshot], ['mermaid-viewer:get']])
})

it.each([
  { ...snapshot, svgDataUrl: 'https://example.com/diagram.svg' },
  { ...snapshot, colorScheme: 'auto' },
  { ...snapshot, themeColor: 'url(file:///secret)' },
  { ...snapshot, path: 'C:/private' },
  { ...snapshot, svgDataUrl: 'data:image/svg+xml;base64,' + 'A'.repeat(3_000_000) },
])('rejects invalid viewer payload before crossing IPC', async input => {
  const invoke = vi.fn()
  const api = createArkdownApi(invoke)
  await expect(api.openMermaidViewer?.(input as never)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(invoke).not.toHaveBeenCalled()
})

it('rejects malformed snapshot replies instead of displaying arbitrary URLs', async () => {
  const api = createArkdownApi(async () => ({ ok: true, value: { ...snapshot, svgDataUrl: 'file:///secret.svg' } }))
  await expect(api.getMermaidViewerSnapshot?.()).resolves.toMatchObject({ ok: false })
})

it('rejects accessors and inherited snapshots without evaluating their values', async () => {
  const invoke = vi.fn()
  const api = createArkdownApi(invoke)
  const getter = vi.fn(() => snapshot.svgDataUrl)
  const accessor = { ...snapshot }
  Object.defineProperty(accessor, 'svgDataUrl', { get: getter })
  for (const input of [accessor, Object.create(snapshot)]) {
    await expect(api.openMermaidViewer?.(input)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(getter).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
})
