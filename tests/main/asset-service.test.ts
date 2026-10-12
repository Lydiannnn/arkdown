import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AssetAccessRegistry } from '../../src/main/assets/asset-path'
import { AssetService } from '../../src/main/assets/asset-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { parseLocalMediaHtml } from '../../src/renderer/editor/local-media-view'
import { draftPaths } from '../../src/main/drafts/draft-paths'

const roots: string[] = []
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const clipDraft = '123e4567-e89b-42d3-a456-426614174000'
async function clipboardFixture() {
  const root = await temporaryRoot()
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const readClipboardImage = vi.fn(() => ({ isEmpty: (): boolean => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }))
  const options = { workspace, tempRoot: path.join(root, 'temp'), sessionId: 'clipboard', access: new AssetAccessRegistry(), readClipboardImage }
  return { root, options, service: new AssetService(options), readClipboardImage }
}

it('stages unique bounded PNGs and migrates only owned image references after service restart', async () => {
  const { root, service, options } = await clipboardFixture()
  const first = await service.stageClipboardImage(clipDraft)
  const second = await service.stageClipboardImage(clipDraft)
  expect(first).not.toBeNull()
  expect(second!.relativePath).not.toBe(first!.relativePath)
  expect(await readFile(first!.relativePath)).toEqual(png)
  const foreign = await service.stageClipboardImage('123e4567-e89b-42d3-a456-426614174001')
  const code = '`' + first!.markdown + '`\n\n```md\n' + first!.markdown + '\n```\n\n    ' + first!.markdown
  const source = `${first!.markdown}\n\n${foreign!.markdown}\n\n![external](photo.png)\n\n${code}`
  const migration = await new AssetService(options).migrateDraftAssets(clipDraft, source, path.join(root, 'saved.md'))
  expect(migration.markdown).toContain('![](<assets/clipboard-')
  expect(migration.markdown).toContain(foreign!.markdown)
  expect(migration.markdown).toContain(code)
  expect(migration.markdown).toContain('![external](photo.png)')
  const relative = /!\[\]\(<(assets\/[^>]+)>\)/u.exec(migration.markdown)![1]!
  expect(await readFile(path.join(root, relative))).toEqual(png)
  expect(await readFile(first!.relativePath)).toEqual(png)
  await migration.rollback()
  await expect(stat(path.join(root, relative))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(first!.relativePath)).toEqual(png)
})

it('rebinds only trusted managed history images into idempotent successor copies', async () => {
  const { service, options } = await clipboardFixture()
  const successorId = '223e4567-e89b-42d3-a456-426614174000'
  const foreignId = '323e4567-e89b-42d3-a456-426614174000'
  const image = (await service.stageClipboardImage(clipDraft))!
  const foreign = (await service.stageClipboardImage(foreignId))!
  const literal = '`' + image.markdown + '`'
  const source = `${image.markdown}\n${foreign.markdown}\n${literal}\n![external](photo.png)`
  const rebound = await service.rebindDraftAssets(successorId, source, [clipDraft])
  expect(rebound).toContain(foreign.markdown)
  expect(rebound).toContain(literal)
  expect(rebound).toContain('![external](photo.png)')
  const successorPath = path.join(draftPaths(options.tempRoot, successorId).assetDirectory, image.fileName)
  expect(rebound).toContain(successorPath.replaceAll('\\', '/'))
  expect(await readFile(successorPath)).toEqual(png)
  expect(await service.rebindDraftAssets(successorId, source, [clipDraft])).toBe(rebound)
  expect(await readdir(path.dirname(successorPath))).toEqual([image.fileName])
  expect(await readFile(image.relativePath)).toEqual(png)
  await writeFile(successorPath, 'unexpected bytes')
  await expect(service.rebindDraftAssets(successorId, source, [clipDraft])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(await readFile(image.relativePath)).toEqual(png)
})

it('rejects rebind through a junction and missing retained image bytes instead of claiming a backup', async () => {
  const { root, service, options } = await clipboardFixture()
  const image = (await service.stageClipboardImage(clipDraft))!
  const successorId = '223e4567-e89b-42d3-a456-426614174000'
  const external = path.join(root, 'external')
  await mkdir(external)
  await symlink(external, draftPaths(options.tempRoot, successorId).assetDirectory, 'junction')
  await expect(service.rebindDraftAssets(successorId, image.markdown, [clipDraft])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  expect(await readdir(external)).toEqual([])
  await rm(image.relativePath)
  await expect(service.rebindDraftAssets('423e4567-e89b-42d3-a456-426614174000', image.markdown, [clipDraft])).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects invalid, empty and oversized native images before writing staging files', async () => {
  const { service, readClipboardImage } = await clipboardFixture()
  readClipboardImage.mockReturnValue({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) })
  expect(await service.stageClipboardImage(clipDraft)).toBeNull()
  for (const [width, bytes] of [[4097, png], [1, Buffer.from('fake PNG')], [1, Buffer.alloc(16 * 1024 * 1024 + 1)]] as const) {
    readClipboardImage.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width, height: 1 }), toPNG: () => bytes })
    await expect(service.stageClipboardImage(clipDraft)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  }
  await expect(service.stageClipboardImage('../escape')).rejects.toThrow()
})

it('preserves staging after destination disk failure', async () => {
  const { root, service } = await clipboardFixture()
  const staged = (await service.stageClipboardImage(clipDraft))!
  await writeFile(path.join(root, 'assets'), 'blocks directory creation')
  await expect(service.migrateDraftAssets(clipDraft, staged.markdown, path.join(root, 'saved.md'))).rejects.toThrow()
  expect(await readFile(staged.relativePath)).toEqual(png)
})

it('propagates staging disk failures without returning an unusable image', async () => {
  const { root, service } = await clipboardFixture()
  await writeFile(path.join(root, 'temp'), 'blocks staging')
  await expect(service.stageClipboardImage(clipDraft)).rejects.toThrow()
})

it('migrates visual HTML and encoded preview references to owned clipboard images', async () => {
  const { root, service } = await clipboardFixture()
  const image = (await service.stageClipboardImage(clipDraft))!
  const source = `<img src="${image.previewUrl}" alt="clip" />`
  const migrated = await service.migrateDraftAssets(clipDraft, source, path.join(root, 'note.md'))
  expect(migrated.markdown).toMatch(/^<img src="assets\/clipboard-[^"]+" alt="clip" \/>$/u)
  const descriptor = parseLocalMediaHtml(migrated.markdown, 'C:\\Saved\\note.md')
  expect(descriptor?.source).toMatch(/^assets\/clipboard-/)
  expect(descriptor?.previewSource).toBe(`C:\\Saved\\${descriptor!.source.replaceAll('/', '\\')}`)
  expect(await readFile(path.join(root, descriptor!.source))).toEqual(png)
})

it('rejects symlink staging/destination directories and rolls back partial migration', async () => {
  const { root, service } = await clipboardFixture()
  const first = (await service.stageClipboardImage(clipDraft))!
  const second = (await service.stageClipboardImage(clipDraft))!
  await rm(second.relativePath)
  await expect(service.migrateDraftAssets(clipDraft, `${first.markdown}\n${second.markdown}`, path.join(root, 'note.md'))).rejects.toThrow()
  expect(await readdir(path.join(root, 'assets'))).toEqual([])
  await rm(path.join(root, 'assets'), { recursive: true })
  const external = await temporaryRoot()
  await symlink(external, path.join(root, 'assets'), 'junction')
  await expect(service.migrateDraftAssets(clipDraft, first.markdown, path.join(root, 'note.md'))).rejects.toThrow()
  expect(await readdir(external)).toEqual([])
  const foreignId = '123e4567-e89b-42d3-a456-426614174001'
  await symlink(external, path.join(root, 'temp', 'assets', foreignId), 'junction')
  await expect(service.stageClipboardImage(foreignId)).rejects.toThrow()
  expect(await readdir(external)).toEqual([])
})
async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-assets-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('keeps an image at its source path and returns preview Markdown without copying it', async () => {
  const root = await temporaryRoot()
  const sourceRoot = await temporaryRoot()
  const source = path.join(sourceRoot, 'photo.png')
  await writeFile(source, Buffer.from([1, 2, 3]))
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const access = new AssetAccessRegistry()
  const service = new AssetService({ workspace, tempRoot: path.join(root, 'temp'), sessionId: 'session-a', access })

  const sourceBefore = await stat(source)
  const imported = await service.import(source)

  expect(imported.category).toBe('image')
  expect(imported.relativePath).toBe(await realpath(source))
  expect(imported.markdown).toContain(source)
  expect(imported.markdown).toContain('style="zoom:100%;"')
  expect(imported.previewUrl).toContain('arkdown-asset://external/')
  await expect(readFile(path.join(root, 'assets', 'photo.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await access.resolve(imported.previewUrl)).toBe(await realpath(source))
  expect(await readFile(source)).toEqual(Buffer.from([1, 2, 3]))
  expect((await stat(source)).mtimeMs).toBe(sourceBefore.mtimeMs)
})

it('does not copy or rename a source when the workspace has a conflicting asset name', async () => {
  const root = await temporaryRoot()
  const sourceRoot = await temporaryRoot()
  await mkdir(path.join(root, 'assets'))
  await writeFile(path.join(root, 'assets', 'clip.mp3'), 'old')
  const source = path.join(sourceRoot, 'clip.mp3')
  await writeFile(source, 'new')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const service = new AssetService({
    workspace,
    tempRoot: path.join(root, 'temp'),
    sessionId: 'session-b',
    access: new AssetAccessRegistry(),
  })

  const imported = await service.import(source)

  expect(imported.fileName).toBe('clip.mp3')
  expect(imported.relativePath).toBe(await realpath(source))
  expect(imported.markdown).toContain(`<audio src="${source}"`)
  expect(await readFile(path.join(root, 'assets', 'clip.mp3'), 'utf8')).toBe('old')
  await expect(readFile(path.join(root, 'assets', 'clip-2.mp3'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(source, 'utf8')).toBe('new')
})

it('rejects unsupported document types such as docx', async () => {
  const root = await temporaryRoot()
  const source = path.join(root, 'note.docx')
  await writeFile(source, 'not supported')
  const service = new AssetService({
    workspace: new WorkspaceService(),
    tempRoot: path.join(root, 'temp'),
    sessionId: 'session-c',
    access: new AssetAccessRegistry(),
  })

  await expect(service.import(source)).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' })
})


it('leaves source-linked Markdown unchanged when an unnamed draft is saved', async () => {
  const root = await temporaryRoot()
  const sourceRoot = await temporaryRoot()
  const tempRoot = path.join(root, 'temp')
  const destinationRoot = path.join(root, 'saved')
  await mkdir(destinationRoot)
  const source = path.join(sourceRoot, 'photo.png')
  await writeFile(source, Buffer.from([9, 8, 7]))
  const workspace = new WorkspaceService()
  const access = new AssetAccessRegistry()
  const service = new AssetService({ workspace, tempRoot, sessionId: 'session-d', access })
  const draftId = '123e4567-e89b-42d3-a456-426614174000'
  const imported = await service.import(source, draftId)
  await workspace.setRoot(destinationRoot)

  const migration = await service.migrateDraftAssets(draftId, imported.markdown)

  expect(migration.markdown).toBe(imported.markdown)
  expect(migration.markdown).toContain(source)
  await expect(readFile(path.join(destinationRoot, 'assets', 'photo.png')))
    .rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(source)).toEqual(Buffer.from([9, 8, 7]))

  await migration.rollback()
  expect(await readFile(source)).toEqual(Buffer.from([9, 8, 7]))
})
