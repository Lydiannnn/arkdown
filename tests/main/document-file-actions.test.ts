import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DocumentService } from '../../src/main/documents/document-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspaceFixture(): Promise<{
  root: string
  workspace: WorkspaceService
  documents: DocumentService
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-file-actions-'))
  roots.push(root)
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  return { root, workspace, documents: new DocumentService(workspace) }
}

it('creates a new UTF-8 Markdown document inside the workspace', async () => {
  const { root, documents } = await workspaceFixture()
  await mkdir(path.join(root, 'notes'))

  const snapshot = await documents.create('notes/new.md', '# New document\n')

  expect(snapshot).toMatchObject({
    relativePath: 'notes/new.md',
    markdown: '# New document\n',
    encoding: 'utf8',
    newline: 'lf',
  })
  expect(await readFile(path.join(root, 'notes', 'new.md'), 'utf8')).toBe('# New document\n')
})

it('refuses duplicate, unsupported, and outside create targets', async () => {
  const { root, documents } = await workspaceFixture()
  await writeFile(path.join(root, 'exists.md'), '# exists', 'utf8')

  await expect(documents.create('exists.md', '')).rejects.toThrow()
  await expect(documents.create('note.docx', '')).rejects.toThrow('不支持的文件类型')
  await expect(documents.create('../escape.md', '')).rejects.toThrow('Path is outside the workspace')
})

it('resolves only existing supported documents for reveal and trash actions', async () => {
  const { root, workspace } = await workspaceFixture()
  await mkdir(path.join(root, 'folder'))
  await writeFile(path.join(root, 'note.md'), '# note', 'utf8')
  await writeFile(path.join(root, 'other.txt'), 'plain', 'utf8')
  await writeFile(path.join(root, 'other.docx'), 'no', 'utf8')

  await expect(workspace.resolveExistingDocument('note.md')).resolves.toBe(
    path.join(root, 'note.md'),
  )
  await expect(workspace.resolveExistingDocument('folder')).rejects.toThrow(
    '不支持的文件类型',
  )
  await expect(workspace.resolveExistingDocument('other.txt')).resolves.toBe(
    path.join(root, 'other.txt'),
  )
  await expect(workspace.resolveExistingDocument('other.docx')).rejects.toThrow(
    '不支持的文件类型',
  )
})
