import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { DocumentService } from '../../src/main/documents/document-service'
import { DraftService } from '../../src/main/drafts/draft-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-reselect-'))
  roots.push(root)
  const directory = path.join(root, 'workspace')
  await mkdir(directory)
  await writeFile(path.join(directory, 'note.md'), '# Original\n', 'utf8')
  const workspace = new WorkspaceService()
  await workspace.setRoot(directory)
  const documents = new DocumentService(workspace)
  const drafts = new DraftService({ root: path.join(root, 'drafts'), appVersion: '1.0.4' })
  let chosen: string | null = directory
  let lastWorkspace: string | null = directory
  const reportError = vi.fn()
  const operations = createIpcOperations({ workspace, documents, drafts,
    chooseDirectory: async () => chosen,
    getLastWorkspace: () => lastWorkspace,
    setLastWorkspace: value => { lastWorkspace = value },
    reportError,
  })
  const opened = await operations.readDocument({ relativePath: 'note.md' })
  if (!opened.ok) throw new Error('Fixture failed to open its document')
  const snapshot = opened.value
  const save = (markdown: string) => operations.saveDocument({ relativePath: 'note.md', markdown,
    expectedRevision: snapshot.revision, encoding: snapshot.encoding, newline: snapshot.newline })
  return { root, directory, workspace, documents, drafts, operations, snapshot, save, reportError,
    choose: (value: string | null) => { chosen = value } }
}

it('saves the already open document to disk after choosing its current workspace again', async () => {
  const f = await fixture()
  await f.operations.chooseWorkspace()
  expect(await f.save('# Edited after reselection\n')).toMatchObject({ ok: true })
  expect(await readFile(path.join(f.directory, 'note.md'), 'utf8')).toBe('# Edited after reselection\n')
})

it.each([false, true])('persists the original document draft after reselection (prior backup: %s)', async priorBackup => {
  const f = await fixture()
  const draftId = randomUUID()
  const input = { draftId, markdown: '# Before picker', expectedOriginalRevision: f.snapshot.revision,
    encoding: f.snapshot.encoding, newline: f.snapshot.newline }
  if (priorBackup) expect(await f.operations.saveDraft(input)).toMatchObject({ ok: true })
  await f.operations.chooseWorkspace()
  expect(await f.operations.saveDraft({ ...input, markdown: '# After picker' })).toMatchObject({ ok: true })
  const stored = await f.drafts.read(draftId)
  expect(stored?.markdown).toBe('# After picker')
  expect(stored?.manifest.originalAbsolutePath).toBe(path.join(f.workspace.getRoot(), 'note.md'))
})

it('treats repeated equivalent selections as no transition and retains the existing mutation lease', async () => {
  const f = await fixture()
  const active = f.workspace.getActivationSnapshot()
  for (const chosen of [f.directory, path.join(f.directory, '.'), f.directory.toUpperCase()]) {
    f.choose(chosen)
    expect(await f.operations.chooseWorkspace()).toEqual({ ok: true, value: null })
    expect(await f.workspace.withMutationLease(active, async () => 'still valid')).toBe('still valid')
  }
  expect(await f.save('# Still owned')).toMatchObject({ ok: true })
})

it('keeps current save authority when the folder picker is cancelled', async () => {
  const f = await fixture()
  f.choose(null)
  expect(await f.operations.chooseWorkspace()).toEqual({ ok: true, value: null })
  expect(await f.save('# Saved after cancel')).toMatchObject({ ok: true })
  expect(await readFile(path.join(f.directory, 'note.md'), 'utf8')).toBe('# Saved after cancel')
})

it('still clears the previous document on a different workspace and requires opening the new document', async () => {
  const f = await fixture()
  const other = path.join(f.root, 'other')
  await mkdir(other)
  await writeFile(path.join(other, 'note.md'), '# Other\n', 'utf8')
  f.choose(other)
  expect(await f.operations.chooseWorkspace()).toMatchObject({ ok: true, value: { name: 'other' } })
  expect(await f.save('# Must not cross workspaces')).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(await readFile(path.join(other, 'note.md'), 'utf8')).toBe('# Other\n')
  expect(await readFile(path.join(f.directory, 'note.md'), 'utf8')).toBe('# Original\n')
  const opened = await f.operations.readDocument({ relativePath: 'note.md' })
  if (!opened.ok) throw new Error('Failed to open the new document')
  expect(await f.operations.saveDocument({ relativePath: 'note.md', markdown: '# Other saved',
    expectedRevision: opened.value.revision, encoding: 'utf8', newline: 'lf' })).toMatchObject({ ok: true })
  expect(await readFile(path.join(other, 'note.md'), 'utf8')).toBe('# Other saved')
})

it.each(['before validation', 'after validation'])('rejects same-path directory replacement %s instead of trusting its old session', async moment => {
  const f = await fixture()
  const moved = path.join(f.root, 'original-directory')
  const replace = async () => {
    await rename(f.directory, moved)
    await mkdir(f.directory)
    await writeFile(path.join(f.directory, 'note.md'), '# Replacement\n', 'utf8')
  }
  if (moment === 'before validation') await replace()
  else {
    const validate = f.workspace.validateRoot.bind(f.workspace)
    vi.spyOn(f.workspace, 'validateRoot').mockImplementationOnce(async root => {
      const result = await validate(root)
      await replace()
      return result
    })
  }
  expect(await f.operations.chooseWorkspace()).toMatchObject({ ok: false })
  expect(await readFile(path.join(f.directory, 'note.md'), 'utf8')).toBe('# Replacement\n')
  expect(await readFile(path.join(moved, 'note.md'), 'utf8')).toBe('# Original\n')
  // Restore the same physical directory. A rejected selection must not have
  // discarded the original ownership or replaced its recorded directory identity.
  await rm(f.directory, { recursive: true })
  await rename(moved, f.directory)
  expect(await f.save('# Original session survived')).toMatchObject({ ok: true })
})

it('retains document conflict detection after a same-workspace selection', async () => {
  const f = await fixture()
  await writeFile(path.join(f.directory, 'note.md'), '# Changed externally', 'utf8')
  await f.operations.chooseWorkspace()
  expect(await f.save('# Stale editor')).toMatchObject({ ok: false, error: { code: 'DOCUMENT_CONFLICT' } })
  expect(await readFile(path.join(f.directory, 'note.md'), 'utf8')).toBe('# Changed externally')
})
