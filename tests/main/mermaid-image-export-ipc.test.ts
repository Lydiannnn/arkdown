import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'

const svgDataUrl = 'data:image/svg+xml;base64,PHN2Zy8+'
const pngDataUrl = 'data:image/png;base64,iVBORw0KGgo='

function dependencies() {
  return {
    chooseDirectory: vi.fn(),
    workspace: {} as never,
    documents: {} as never,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    mermaidImageExport: {
      copyPng: vi.fn(async () => undefined),
      save: vi.fn(async () => 'C:\\exports\\diagram.svg'),
    },
  }
}

it('dispatches exact bounded Mermaid copy and save payloads', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)

  await expect(operations.copyMermaidImage({ pngDataUrl })).resolves.toEqual({
    ok: true,
    value: null,
  })
  await expect(operations.saveMermaidImage({ svgDataUrl, pngDataUrl })).resolves.toEqual({
    ok: true,
    value: null,
  })

  expect(deps.mermaidImageExport.copyPng).toHaveBeenCalledWith(pngDataUrl)
  expect(deps.mermaidImageExport.save).toHaveBeenCalledWith({ svgDataUrl, pngDataUrl })
})

it.each([
  { copy: { pngDataUrl: svgDataUrl } },
  { copy: { pngDataUrl, extra: true } },
  { save: { svgDataUrl: pngDataUrl, pngDataUrl } },
  { save: { svgDataUrl, pngDataUrl, sourcePath: 'C:\\private\\diagram.svg' } },
])('rejects malformed Mermaid image export payloads before side effects', async (fixture) => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)

  const result = fixture.copy
    ? await operations.copyMermaidImage(fixture.copy)
    : await operations.saveMermaidImage(fixture.save)

  expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(deps.mermaidImageExport.copyPng).not.toHaveBeenCalled()
  expect(deps.mermaidImageExport.save).not.toHaveBeenCalled()
})
