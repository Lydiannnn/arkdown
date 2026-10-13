import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DocumentService } from '../../src/main/documents/document-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import {
  searchCurrentDirectoryDocuments,
  searchDescendantDocuments,
} from '../../src/renderer/workspace/workspace-navigation'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each([
  ['', '.arkdown-initial-workspace.json'],
  ['nested', '.ARKDOWN-INITIAL-WORKSPACE.JSON'],
])('omits the initialization marker in %s from browsing and search without changing files', async (folder, marker) => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-internal-files-'))
  roots.push(root)
  const directory = path.join(root, folder)
  await mkdir(directory, { recursive: true })
  const visibleNames = [
    'notes.md', 'config.json', '.settings.json', '.env',
    '.arkdown-initial-workspace.backup.json', 'copy.arkdown-initial-workspace.json',
  ]
  for (const name of [...visibleNames, marker]) {
    await writeFile(path.join(directory, name), '{"version":3}', 'utf8')
  }
  const markerPath = path.join(directory, marker)
  const before = await stat(markerPath)
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const documents = new DocumentService(workspace)
  const listDirectory = async (relativePath: string) => ({
    ok: true as const, value: await workspace.listDirectory(relativePath),
  })
  const readDocument = async (relativePath: string) => ({
    ok: true as const, value: await documents.read(relativePath),
  })

  expect((await workspace.listDirectory(folder)).map(entry => entry.name).sort())
    .toEqual([...visibleNames].sort())
  const results = folder
    ? await searchDescendantDocuments({ query: 'version', listDirectory, readDocument, remainingLimit: 50 })
    : await searchCurrentDirectoryDocuments({ query: 'version', listDirectory, readDocument })
  expect(results.matches.map(match => match.relativePath).sort())
    .toEqual(visibleNames.map(name => folder ? `${folder}/${name}` : name).sort())
  expect(results.failedDocuments).toEqual([])
  expect(results.failedDirectories).toEqual([])
  expect(await readFile(markerPath, 'utf8')).toBe('{"version":3}')
  expect((await stat(markerPath)).mtimeMs).toBe(before.mtimeMs)
})

it('retains a user directory that happens to use the reserved marker filename', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-internal-directory-'))
  roots.push(root)
  await mkdir(path.join(root, '.arkdown-initial-workspace.json'))
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  expect(await workspace.listDirectory('')).toEqual([{
    name: '.arkdown-initial-workspace.json',
    relativePath: '.arkdown-initial-workspace.json',
    kind: 'directory',
  }])
})
