import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DocumentService } from '../../src/main/documents/document-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  workspace: WorkspaceService
  documents: DocumentService
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-document-types-'))
  roots.push(root)
  await Promise.all([
    writeFile(path.join(root, 'note.md'), '# Markdown', 'utf8'),
    writeFile(path.join(root, 'notes.txt'), 'plain text', 'utf8'),
    writeFile(path.join(root, 'report.qmd'), '# Quarto', 'utf8'),
    writeFile(path.join(root, 'draft.docx'), 'not a real docx', 'utf8'),
    writeFile(path.join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  ])
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  return { root, workspace, documents: new DocumentService(workspace) }
}

it('lists editable documents and visible DOCX imports while omitting assets', async () => {
  const { workspace } = await fixture()

  await expect(workspace.listDirectory('')).resolves.toEqual([
    { name: 'draft.docx', relativePath: 'draft.docx', kind: 'document' },
    { name: 'note.md', relativePath: 'note.md', kind: 'document' },
    { name: 'notes.txt', relativePath: 'notes.txt', kind: 'document' },
    { name: 'report.qmd', relativePath: 'report.qmd', kind: 'document' },
  ])
})

it.each(['notes.txt', 'report.qmd'])(
  'opens and validates dropped supported document %s',
  async (name) => {
    const { root, workspace, documents } = await fixture()

    const dropped = await workspace.validateDroppedPath(path.join(root, name))
    expect(dropped.documentPath).toBe(name)
    await expect(documents.read(name)).resolves.toMatchObject({ relativePath: name })
  },
)

it.each(['draft.docx', 'photo.png'])(
  'does not treat %s as an editable document',
  async (name) => {
    const { root, workspace, documents } = await fixture()

    await expect(workspace.validateDroppedPath(path.join(root, name))).rejects.toThrow()
    await expect(documents.read(name)).rejects.toThrow()
  },
)
