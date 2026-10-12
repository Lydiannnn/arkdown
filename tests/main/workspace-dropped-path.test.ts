import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-drop-'))
  roots.push(root)
  const folder = path.join(root, 'notes')
  await mkdir(folder)
  const markdown = path.join(folder, 'guide.md')
  await writeFile(markdown, '# Guide', 'utf8')
  return { folder, markdown, unsupported: path.join(folder, 'plain.docx') }
}

it('validates a dropped folder as a workspace activation', async () => {
  const { folder } = await fixture()
  const service = new WorkspaceService()

  const result = await service.validateDroppedPath(folder)

  expect(result.documentPath).toBeNull()
  expect(result.activation.summary.absolutePath).toBe(await import('node:fs/promises').then(
    ({ realpath }) => realpath(folder),
  ))
  await result.activation.commit()
  expect(service.getRoot()).toBe(result.activation.summary.absolutePath)
})

it('validates a dropped Markdown file and selects its parent workspace', async () => {
  const { folder, markdown } = await fixture()
  const service = new WorkspaceService()

  const result = await service.validateDroppedPath(markdown)

  expect(result.documentPath).toBe('guide.md')
  expect(result.activation.summary.name).toBe(path.basename(folder))
})

it('rejects unsupported dropped files', async () => {
  const { unsupported } = await fixture()
  await writeFile(unsupported, 'plain', 'utf8')
  const service = new WorkspaceService()

  await expect(service.validateDroppedPath(unsupported)).rejects.toThrow('不支持的文件类型')
})
