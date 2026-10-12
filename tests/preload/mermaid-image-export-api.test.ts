import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS, type ArkdownApi } from '../../src/shared/contracts'

const svgDataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'
const pngDataUrl = 'data:image/png;base64,iVBORw0KGgo='

it('exposes exact Mermaid image copy and save calls through fixed channels', async () => {
  const invoke = vi.fn(async () => ({ ok: true as const, value: null }))
  const api = createArkdownApi(invoke)

  await expect(api.copyMermaidImage?.(pngDataUrl)).resolves.toEqual({ ok: true, value: null })
  await expect(api.saveMermaidImage?.({ svgDataUrl, pngDataUrl }))
    .resolves.toEqual({ ok: true, value: null })

  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.copyMermaidImage, { pngDataUrl }],
    [IPC_CHANNELS.saveMermaidImage, { svgDataUrl, pngDataUrl }],
  ])
})

it('rejects malformed or over-broad Mermaid image payloads before invoking IPC', async () => {
  const invoke = vi.fn()
  const api = createArkdownApi(invoke) as ArkdownApi & {
    copyMermaidImage(input: unknown): Promise<unknown>
    saveMermaidImage(input: unknown): Promise<unknown>
  }

  await expect(api.copyMermaidImage(svgDataUrl)).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  await expect(api.saveMermaidImage({ svgDataUrl, pngDataUrl, extra: true }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(invoke).not.toHaveBeenCalled()
})
