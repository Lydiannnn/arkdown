import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  assertWorkspaceRelativePath,
  resolveExistingInside,
  resolveNewInside,
} from '../../src/main/workspace/workspace-path'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

it('accepts canonical paths inside the workspace', async () => {
  const root = await createRoot('arkdown-workspace-')
  await mkdir(path.join(root, 'docs'))
  await writeFile(path.join(root, 'docs', 'a.md'), '# A', 'utf8')

  await expect(resolveExistingInside(root, 'docs/a.md')).resolves.toBe(path.join(root, 'docs', 'a.md'))
  await expect(resolveNewInside(root, 'docs/new.md')).resolves.toBe(path.join(root, 'docs', 'new.md'))
})

it('rejects absolute paths, traversal, and NUL bytes with a stable error', async () => {
  const root = await createRoot('arkdown-workspace-')
  await mkdir(path.join(root, 'docs'))

  for (const relativePath of [path.join(root, 'docs', 'a.md'), '../outside.md', 'docs/../../outside.md', 'docs\0a.md']) {
    await expect(resolveExistingInside(root, relativePath)).rejects.toThrow('Path is outside the workspace')
    await expect(resolveNewInside(root, relativePath)).rejects.toThrow('Path is outside the workspace')
  }
})

it('rejects Windows device, ADS, malformed, and drive-relative path components', async () => {
  const root = await createRoot('arkdown-workspace-')

  for (const relativePath of [
    'notes:stream.md',
    'CON.md',
    'NUL.md',
    'aux',
    'COM1.txt',
    'LPT9.md',
    'COM\u00b9.md',
    'bad?.md',
    'bad*.md',
    'bad<.md',
    'bad>.md',
    'bad".md',
    'bad|.md',
    'name.',
    'name ',
    'docs\\..\\outside.md',
    '\\\\server\\share\\outside.md',
    'C:\\outside.md',
    'C:outside.md',
  ]) {
    await expect(resolveExistingInside(root, relativePath)).rejects.toThrow('Path is outside the workspace')
    await expect(resolveNewInside(root, relativePath)).rejects.toThrow('Path is outside the workspace')
  }
})

it('validates provider paths before filesystem or document-type dispatch', () => {
  expect(() => assertWorkspaceRelativePath('notes/a.md')).not.toThrow()
  for (const relativePath of ['', '.', '..', 'notes/a.md:stream', 'CON.md', '\\\\?\\C:\\device.md']) {
    expect(() => assertWorkspaceRelativePath(relativePath)).toThrow('Path is outside the workspace')
  }
})

it('rejects existing targets that escape through a directory junction', async () => {
  const root = await createRoot('arkdown-workspace-')
  const outside = await createRoot('arkdown-outside-')
  await writeFile(path.join(outside, 'secret.md'), '# Secret', 'utf8')
  await symlink(outside, path.join(root, 'escape'), 'junction')

  await expect(resolveExistingInside(root, 'escape/secret.md')).rejects.toThrow('Path is outside the workspace')
})

it('rejects new targets whose parent escapes through a directory junction', async () => {
  const root = await createRoot('arkdown-workspace-')
  const outside = await createRoot('arkdown-outside-')
  await symlink(outside, path.join(root, 'escape'), 'junction')

  await expect(resolveNewInside(root, 'escape/new.md')).rejects.toThrow('Path is outside the workspace')
})

it('refuses a new target when its final component is an existing junction', async () => {
  const root = await createRoot('arkdown-workspace-')
  const outside = await createRoot('arkdown-outside-')
  await symlink(outside, path.join(root, 'new-target'), 'junction')

  await expect(resolveNewInside(root, 'new-target')).rejects.toThrow('New workspace path already exists')
})

it('refuses new targets that already exist as ordinary files or directories', async () => {
  const root = await createRoot('arkdown-workspace-')
  await writeFile(path.join(root, 'existing.md'), '', 'utf8')
  await mkdir(path.join(root, 'existing-directory'))

  await expect(resolveNewInside(root, 'existing.md')).rejects.toThrow('New workspace path already exists')
  await expect(resolveNewInside(root, 'existing-directory')).rejects.toThrow('New workspace path already exists')
})
