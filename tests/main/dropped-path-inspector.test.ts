import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectDroppedPath } from '../../src/main/dropped-path-inspector'

const readShortcutLink = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ shell: { readShortcutLink } }))

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('classifies only real files and directories and rejects missing targets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-dropped-path-'))
  roots.push(root)
  const file = path.join(root, 'raw data.bin')
  const directory = path.join(root, 'folder')
  await writeFile(file, 'raw')
  await mkdir(directory)

  await expect(inspectDroppedPath(file)).resolves.toEqual({ kind: 'file', absolutePath: file })
  await expect(inspectDroppedPath(directory)).resolves.toEqual({
    kind: 'directory', absolutePath: directory,
  })
  await expect(inspectDroppedPath(path.join(root, 'missing.bin'))).rejects.toMatchObject({
    code: 'FILE_NOT_FOUND',
  })
})

it('rejects a directory junction instead of silently following a linked target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-dropped-junction-'))
  roots.push(root)
  const target = path.join(root, 'target')
  const linked = path.join(root, 'linked')
  await mkdir(target)
  await symlink(target, linked, 'junction')

  await expect(inspectDroppedPath(linked)).rejects.toMatchObject({
    code: 'UNSUPPORTED_FILE_TYPE',
  })
})

it.each(['中文 文档.md', 'notes.txt', 'config.json', 'script.cjs', 'source.ts'])(
  'resolves a document shortcut to the existing target %s only when requested', async (name) => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-shortcut-'))
    roots.push(root)
    const shortcut = path.join(root, '文档快捷方式.LNK')
    const target = path.join(root, name)
    await writeFile(shortcut, 'shortcut fixture')
    await writeFile(target, 'document fixture')
    readShortcutLink.mockReturnValue({ target, args: '' })

    await expect(inspectDroppedPath(shortcut)).resolves.toEqual({ kind: 'file', absolutePath: shortcut })
    expect(readShortcutLink).not.toHaveBeenCalled()
    await expect(inspectDroppedPath(shortcut, true)).resolves.toEqual({ kind: 'file', absolutePath: target })
    expect(readShortcutLink).toHaveBeenCalledWith(shortcut)
  },
)

it.each(['missing', 'corrupt', 'program', 'arguments', 'directory', 'nested-shortcut', 'relative'])(
  'rejects a %s document shortcut without returning an openable target', async (kind) => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-shortcut-invalid-'))
    roots.push(root)
    const shortcut = path.join(root, 'document.lnk')
    const target = path.join(root, kind === 'program' ? 'editor.exe' : kind === 'nested-shortcut' ? 'next.lnk' : 'target.md')
    await writeFile(shortcut, 'shortcut fixture')
    if (kind === 'directory') await mkdir(target)
    else if (kind !== 'missing') await writeFile(target, '# Keep')
    readShortcutLink.mockReturnValue({ target: kind === 'relative' ? 'target.md' : target, args: kind === 'arguments' ? '--execute' : '' })
    if (kind === 'corrupt') readShortcutLink.mockImplementationOnce(() => { throw new Error('invalid shell link') })

    await expect(inspectDroppedPath(shortcut, true)).rejects.toMatchObject({
      code: kind === 'missing' ? 'FILE_NOT_FOUND' : 'UNSUPPORTED_FILE_TYPE',
    })
  },
)
