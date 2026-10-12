import { mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ImageContextService } from '../../src/main/assets/image-context-service'

const createdRoots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-image-menu-'))
  createdRoots.push(root)
  const source = path.join(root, 'source.png')
  await writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  const reveal = vi.fn()
  const copyImageToClipboard = vi.fn(async () => undefined)
  const chooseTarget = vi.fn(async (): Promise<string | null> => (
    path.join(root, 'copy.png')
  ))
  const service = new ImageContextService({
    reveal,
    copyImageToClipboard,
    chooseTarget,
  })
  return { root, source, reveal, copyImageToClipboard, chooseTarget, service }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(createdRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })))
})

it('reveals and copies only canonical supported local image files', async () => {
  const { source, reveal, copyImageToClipboard, service } = await fixture()
  const canonical = await realpath(source)

  await service.reveal(source)
  await service.copyToClipboard(source)

  expect(reveal).toHaveBeenCalledWith(canonical)
  expect(copyImageToClipboard).toHaveBeenCalledWith(canonical)
  await expect(service.reveal(path.join(path.dirname(source), 'missing.png')))
    .rejects.toMatchObject({ code: 'FILE_NOT_FOUND' })
  await expect(service.reveal(path.join(path.dirname(source), 'not-image.txt')))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' })
})

it('creates a new copy without changing source bytes, size, or mtime', async () => {
  const { root, source, service } = await fixture()
  const beforeBytes = await readFile(source)
  const before = await stat(source)

  const target = await service.saveCopy(source)

  expect(target).toBe(path.join(root, 'copy.png'))
  expect(await readFile(target!)).toEqual(beforeBytes)
  const after = await stat(source)
  expect(after.size).toBe(before.size)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(await readFile(source)).toEqual(beforeBytes)
})

it('does not overwrite an existing destination and never updates the source', async () => {
  const { root, source, service } = await fixture()
  const target = path.join(root, 'copy.png')
  await writeFile(target, 'keep')
  const before = await readFile(source)

  await expect(service.copyTo(source)).rejects.toMatchObject({ code: 'ASSET_COPY_FAILED' })
  expect(await readFile(target, 'utf8')).toBe('keep')
  expect(await readFile(source)).toEqual(before)
})

it('rejects directories, symbolic links, unsupported files, and mismatched targets', async () => {
  const { root, source, service, chooseTarget } = await fixture()
  await expect(service.reveal(root)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' })

  const link = path.join(root, 'linked.png')
  try {
    await symlink(source, link)
    await expect(service.reveal(link)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILE_TYPE',
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
  }

  const text = path.join(root, 'note.txt')
  await writeFile(text, 'text')
  await expect(service.copyToClipboard(text)).rejects.toMatchObject({
    code: 'UNSUPPORTED_FILE_TYPE',
  })

  chooseTarget.mockResolvedValueOnce(path.join(root, 'copy.jpg'))
  await expect(service.saveCopy(source)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

it('returns null when the user cancels choosing a destination', async () => {
  const { source, chooseTarget, service } = await fixture()
  chooseTarget.mockResolvedValueOnce(null)
  await expect(service.copyTo(source)).resolves.toBeNull()
})
