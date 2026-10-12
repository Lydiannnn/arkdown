import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPdfAsset } from '../../src/main/assets/open-asset'

const roots: string[] = []

async function assetPath(fileName: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-open-asset-'))
  roots.push(root)
  const target = path.join(root, fileName)
  await writeFile(target, fileName)
  return target
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('openPdfAsset', () => {
  it('passes an existing absolute PDF path to the system opener', async () => {
    const target = await assetPath('guide.pdf')
    const resolveAsset = vi.fn()
    const openPath = vi.fn().mockResolvedValue('')

    await expect(openPdfAsset(target, resolveAsset, openPath))
      .resolves.toBeUndefined()
    expect(resolveAsset).not.toHaveBeenCalled()
    expect(openPath).toHaveBeenCalledWith(await realpath(target))
  })

  it('rejects a non-attachment source before invoking the system opener', async () => {
    const target = await assetPath('photo.png')
    const resolveAsset = vi.fn()
    const openPath = vi.fn().mockResolvedValue('')

    await expect(openPdfAsset(target, resolveAsset, openPath))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' })
    expect(resolveAsset).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
  })

  it('reports a system opener failure', async () => {
    const target = await assetPath('guide.pdf')
    const openPath = vi.fn().mockResolvedValue('No PDF application is associated')
    await expect(openPdfAsset(
      target,
      vi.fn(),
      openPath,
    )).rejects.toThrow('No PDF application is associated')
  })
})
