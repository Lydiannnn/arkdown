import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { workspacePickerDefaultPath } from '../../src/main/workspace/workspace-picker-state'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('arkdown-picker-')) throw new Error('Unexpected test root')
    await rm(root, { recursive: true, force: true })
  }
})
it('prefers each window validated activation without reading or modifying the shared previous directory', async () => {
  const previous = vi.fn(async () => 'C:/previous')
  expect(await workspacePickerDefaultPath(async () => ({ root: 'C:/window-a' }), previous)).toBe('C:/window-a')
  expect(await workspacePickerDefaultPath(async () => ({ root: 'C:/window-b' }), previous)).toBe('C:/window-b')
  expect(previous).not.toHaveBeenCalled()
})
it('falls back only to an existing directory and otherwise lets the system pick its default', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-picker-')); roots.push(root)
  const directory = path.join(root, 'previous'); await mkdir(directory)
  const file = path.join(root, 'file.txt'); await writeFile(file, 'synthetic', 'utf8')
  const noCurrent = async () => { throw new Error('activation disappeared') }
  expect(await workspacePickerDefaultPath(noCurrent, () => directory)).toBe(directory)
  for (const candidate of [null, 'relative', file, path.join(root, 'missing')]) {
    expect(await workspacePickerDefaultPath(noCurrent, () => candidate)).toBeNull()
  }
})
