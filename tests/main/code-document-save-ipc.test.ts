// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AssetService } from '../../src/main/assets/asset-service'
import { AssetAccessRegistry } from '../../src/main/assets/asset-path'
import { DraftService } from '../../src/main/drafts/draft-service'
import { DocumentService } from '../../src/main/documents/document-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'

const roots: string[] = []
const draftId = '123e4567-e89b-42d3-a456-426614174000'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root))
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('arkdown-code-ipc-')) throw new Error('Unsafe cleanup')
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  ['ordinary', 'app.ts'], ['save-as', 'browser.json'], ['save-as', '.env.production'], ['save-as', 'Dockerfile'],
] as const)('preserves code bytes and target name through %s to %s without Markdown image rewriting', async (mode, name) => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-code-ipc-'))
  roots.push(root)
  const tempRoot = path.join(root, 'temp')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const documents = new DocumentService(workspace)
  const drafts = new DraftService({ root: tempRoot, appVersion: '1.0.3' })
  const assets = new AssetService({ workspace, tempRoot, sessionId: 'test', access: new AssetAccessRegistry(),
    readClipboardImage: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => png }),
  })
  const operations = createIpcOperations({ workspace, documents, drafts, assets, chooseDirectory: async () => null,
    chooseSavePath: async () => path.join(root, name), getLastWorkspace: () => root, setLastWorkspace: () => undefined,
    reportError: () => undefined,
  })
  const opened = mode === 'ordinary' ? await operations.createDocument({ relativePath: name }) : null
  const revision = opened?.ok ? opened.value.revision : null
  expect(await operations.saveDraft({ draftId, markdown: '', encoding: 'utf8', newline: 'crlf', expectedOriginalRevision: revision })).toMatchObject({ ok: true })
  const pasted = await operations.pasteClipboardImage({ draftId })
  if (!pasted.ok || !pasted.value) throw new Error('Expected real staged image')
  const source = `// ${pasted.value}\r\n  literal source\n\tlast line\r\n`
  expect(await operations.saveDraft({ draftId, markdown: source, encoding: 'utf8', newline: 'crlf', expectedOriginalRevision: revision })).toMatchObject({ ok: true })
  const saved = mode === 'ordinary'
    ? await operations.saveDocument({ relativePath: name, markdown: source, expectedRevision: revision!, encoding: 'utf8', newline: 'crlf' })
    : await operations.saveDocumentAs({ draftId, markdown: source, encoding: 'utf8', newline: 'crlf', suggestedFileName: name })
  expect(saved.ok).toBe(true)
  expect(await readFile(path.join(root, name), 'utf8')).toBe(source)
  expect(operations.getCurrentDocumentAbsolutePath()).toBe(path.join(root, name))
})
