import { describe, expect, it, vi } from 'vitest'
import type { ImportedAsset, ArkdownApi } from '../../src/shared/contracts'
import { chooseImageForInsertion } from '../../src/renderer/editor/image-insertion'

const imported: ImportedAsset = {
  assetId: 'asset-1',
  category: 'image',
  fileName: 'photo.png',
  relativePath: 'assets/photo.png',
  previewUrl: 'arkdown-asset://external/photo.png',
  markdown: '![photo](assets/photo.png)',
}

describe('system image insertion', () => {
  it('opens an image-only picker, imports the selected file, and inserts copied markdown', async () => {
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    const importAsset = vi.fn(async () => ({ ok: true as const, value: imported }))
    const insertMarkdown = vi.fn()
    const reportError = vi.fn()
    const api = {
      pathForDroppedFile: vi.fn(() => 'C:\\pictures\\photo.png'),
      importAsset,
    } as unknown as ArkdownApi

    const input = chooseImageForInsertion({ api, insertMarkdown, reportError })
    expect(input.type).toBe('file')
    expect(input.accept).toContain('image/png')
    expect(input.accept).toContain('image/svg+xml')

    Object.defineProperty(input, 'files', { value: [file] })
    input.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(importAsset).toHaveBeenCalledWith('C:\\pictures\\photo.png'))
    expect(insertMarkdown).toHaveBeenCalledWith(imported.markdown)
    expect(reportError).not.toHaveBeenCalled()
  })

  it('reports an import error without inserting content', async () => {
    const file = new File(['image'], 'photo.png', { type: 'image/png' })
    const insertMarkdown = vi.fn()
    const reportError = vi.fn()
    const api = {
      pathForDroppedFile: vi.fn(() => 'C:\\pictures\\photo.png'),
      importAsset: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'OPERATION_FAILED', message: '无法复制图片' },
      })),
    } as unknown as ArkdownApi

    const input = chooseImageForInsertion({ api, insertMarkdown, reportError })
    Object.defineProperty(input, 'files', { value: [file] })
    input.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith('无法复制图片'))
    expect(insertMarkdown).not.toHaveBeenCalled()
  })
})
