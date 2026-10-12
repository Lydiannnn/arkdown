// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm, rmdir, symlink, rename, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDocumentViewService } from '../../src/main/documents/document-view-service'
import type { DocumentViewResult, DocumentViewSource } from '../../src/shared/document-view'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root))
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('arkdown-view-')) {
      throw new Error('Unsafe test cleanup path')
    }
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-view-'))
  roots.push(root)
  await mkdir(path.join(root, 'workspace'))
  await writeFile(path.join(root, 'workspace', 'root.md'), '[Other](../other.md)')
  let source: DocumentViewSource | null = { absolutePath: path.join(root, 'workspace', 'root.md'), session: 1 }
  const opened: Array<{ kind: string; path: string }> = []
  const options = {
    getSource: () => source,
    openDocument: async (target: string) => { opened.push({ kind: 'document', path: target }) },
    openExternalPath: async (target: string) => { opened.push({ kind: 'external', path: target }) },
  }
  return { root, options, opened, service: createDocumentViewService(options), setSource(next: DocumentViewSource | null) { source = next } }
}

function document(result: DocumentViewResult) {
  if (result.kind !== 'document') throw new Error(`Expected document, got ${result.kind}`)
  return result.document
}

describe('window-owned document view', () => {
  it('forwards only the token-owned anchor and line when opening an editing window', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'target.md'), '# Section\ntext')
    const locations: unknown[] = []
    const service = createDocumentViewService({ ...f.options, openDocument: async (...args) => { locations.push(args) } })
    const target = document(await service.navigate({ href: '../target.md:2#section' }))
    await service.open(target.id)
    expect(locations).toEqual([[await realpath(path.join(f.root, 'target.md')), { anchor: 'section', line: 2 }]])
  })

  it('returns canonical identities for a junction link back to the root and an A/B cycle', async () => {
    const f = await fixture()
    const actual = path.join(f.root, 'actual')
    await mkdir(path.join(actual, 'sub'), { recursive: true })
    const aPath = path.join(actual, 'A.md')
    const bPath = path.join(actual, 'sub', 'B.md')
    await writeFile(aPath, '[B](../workspace/alias/sub/B.md)')
    await writeFile(bPath, '[A](../A.md)')
    await writeFile(path.join(f.root, 'outside.md'), 'canonical parent')
    await writeFile(path.join(f.root, 'workspace', 'outside.md'), 'lexical alias parent')
    await symlink(actual, path.join(f.root, 'workspace', 'alias'), 'junction')
    f.setSource({ absolutePath: await realpath(aPath), session: 2 })

    const rawHref = '../workspace/alias/A.md#heading'
    const rootViaAlias = document(await f.service.navigate({ href: rawHref }))
    expect(rootViaAlias.absolutePath).toBe(await realpath(aPath))
    expect(rootViaAlias.anchor).toBe('heading')
    expect((await f.service.refresh(rootViaAlias.id)).text).toBe('[B](../workspace/alias/sub/B.md)')

    const b = document(await f.service.navigate({ href: '../workspace/alias/sub/B.md' }))
    expect(b.absolutePath).toBe(await realpath(bPath))
    const back = document(await f.service.navigate({ href: '../A.md', sourceId: b.id }))
    expect(back.absolutePath).toBe(rootViaAlias.absolutePath)
    const again = document(await f.service.navigate({ href: '../workspace/alias/sub/B.md', sourceId: back.id }))
    expect(again.absolutePath).toBe(b.absolutePath)
    const outside = document(await f.service.navigate({ href: '../../outside.md', sourceId: b.id }))
    expect(outside.text).toBe('canonical parent')
  })

  it('binds preview refresh and open to the canonical target if its directory alias is retargeted', async () => {
    const f = await fixture()
    const actual = path.join(f.root, 'actual')
    const other = path.join(f.root, 'other')
    const alias = path.join(f.root, 'alias')
    await mkdir(actual)
    await mkdir(other)
    await writeFile(path.join(actual, 'B.md'), 'original physical target')
    await writeFile(path.join(other, 'B.md'), 'replacement alias target')
    await symlink(actual, alias, 'junction')
    const b = document(await f.service.navigate({ href: '../alias/B.md' }))
    await rename(alias, path.join(f.root, 'previous-alias'))
    await symlink(other, alias, 'junction')
    expect(await f.service.inspect(b.id)).toEqual({ changed: false, exists: true })
    expect(await f.service.refresh(b.id)).toMatchObject({ absolutePath: await realpath(path.join(actual, 'B.md')), text: 'original physical target' })
    await f.service.open(b.id)
    expect(f.opened).toEqual([{ kind: 'document', path: await realpath(path.join(actual, 'B.md')) }])
  })

  it('reads parent/Chinese paths, follows tokens from their own directory, and preserves raw text', async () => {
    const f = await fixture()
    await mkdir(path.join(f.root, '中文'))
    await writeFile(path.join(f.root, '中文', '有 空格.md'), '\uFEFF# 标题\r\n\t正文\r\n')
    await writeFile(path.join(f.root, 'other.md'), 'outside')
    const first = document(await f.service.navigate({ href: '../中文/有%20空格.md#标题' }))
    expect(first).toMatchObject({ text: '# 标题\r\n\t正文\r\n', kind: 'markdown', anchor: '标题', displayName: '有 空格.md' })
    const second = document(await f.service.navigate({ sourceId: first.id, href: '../other.md' }))
    expect(second.text).toBe('outside')
    expect(second.absolutePath).toBe(path.join(f.root, 'other.md'))
    expect(f.opened).toEqual([])
  })

  it('allows empty UTF-8 documents and rejects missing, binary, invalid UTF-8 and oversized files distinctly', async () => {
    const f = await fixture()
    for (const [name, contents, code] of [
      ['empty.txt', '', null], ['binary.txt', Buffer.from([0, 1, 2]), 'DOCUMENT_VIEW_BINARY'],
      ['encoding.txt', Buffer.from([0xff, 0xfe, 0x41, 0]), 'DOCUMENT_VIEW_ENCODING'],
      ['oversize.txt', Buffer.alloc(8 * 1024 * 1024 + 1, 65), 'DOCUMENT_VIEW_TOO_LARGE'],
    ] as const) {
      await writeFile(path.join(f.root, name), contents)
      if (code) await expect(f.service.navigate({ href: `../${name}` })).rejects.toMatchObject({ code })
      else expect(document(await f.service.navigate({ href: `../${name}` })).text).toBe('')
    }
    await expect(f.service.navigate({ href: '../missing.md' })).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_NOT_FOUND' })
  })

  it('accepts the exact 8 MiB limit without truncating', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'limit.txt'), Buffer.alloc(8 * 1024 * 1024, 65))
    const result = document(await f.service.navigate({ href: '../limit.txt' }))
    expect(result.text.length).toBe(8 * 1024 * 1024)
    expect(result.text.at(-1)).toBe('A')
  })

  it('returns JSON as raw code with its requested line and distinguishes same-named files', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'browser.json'), '{\n  "a": 1\n}\n')
    await writeFile(path.join(f.root, 'workspace', 'browser.json'), '{"a":2}')
    const outside = document(await f.service.navigate({ href: '../browser.json#L2' }))
    const inside = document(await f.service.navigate({ href: './browser.json' }))
    expect(outside).toMatchObject({ text: '{\n  "a": 1\n}\n', kind: 'code', line: 2 })
    expect(inside).toMatchObject({ text: '{"a":2}', kind: 'code' })
    expect(outside.absolutePath).not.toBe(inside.absolutePath)
    expect(outside.id).not.toBe(inside.id)
    await f.service.open(outside.id)
    expect(f.opened).toEqual([{ kind: 'document', path: path.join(f.root, 'browser.json') }])
  })

  it('only lets the latest concurrent refresh accept the disk revision', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'other.md'), 'one')
    const item = document(await f.service.navigate({ href: '../other.md' }))
    await writeFile(path.join(f.root, 'other.md'), 'two')
    const pending = await Promise.allSettled([f.service.refresh(item.id), f.service.refresh(item.id)])
    expect(pending[0]).toMatchObject({ status: 'rejected', reason: { code: 'DOCUMENT_VIEW_STALE' } })
    expect(pending[1]).toMatchObject({ status: 'fulfilled', value: { text: 'two' } })
    if (pending[1].status !== 'fulfilled') throw new Error('Expected latest refresh')
    expect(pending[1].value.id).not.toBe(item.id)
    expect(await f.service.inspect(pending[1].value.id)).toEqual({ changed: false, exists: true })
    expect(await f.service.inspect(item.id)).toEqual({ changed: true, exists: true })
  })

  it('rejects a directory action replaced by a junction before opening it', async () => {
    const f = await fixture()
    const target = path.join(f.root, 'folder')
    await mkdir(target)
    const item = await f.service.navigate({ href: '../folder' })
    if (item.kind !== 'directory') throw new Error('Expected directory')
    await rmdir(target)
    await symlink(path.join(f.root, 'workspace'), target, 'junction')
    await expect(f.service.open(item.id)).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_UNSUPPORTED' })
    expect(f.opened).toEqual([])
  })

  it('issues a fresh refresh token and retains location without accepting changes for the old snapshot', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'other.md'), 'one')
    const first = document(await f.service.navigate({ href: '../other.md#section' }))
    expect(await f.service.inspect(first.id)).toEqual({ changed: false, exists: true })
    await writeFile(path.join(f.root, 'other.md'), 'two')
    expect(await f.service.inspect(first.id)).toEqual({ changed: true, exists: true })
    expect(await f.service.inspect(first.id)).toEqual({ changed: true, exists: true })
    const refreshed = await f.service.refresh(first.id)
    expect(refreshed).toMatchObject({ text: 'two', anchor: 'section' })
    expect(refreshed.id).not.toBe(first.id)
    expect(refreshed.revision).not.toBe(first.revision)
    expect(await f.service.inspect(refreshed.id)).toEqual({ changed: false, exists: true })
    expect(await f.service.inspect(first.id)).toEqual({ changed: true, exists: true })
    await rm(path.join(f.root, 'other.md'))
    expect(await f.service.inspect(first.id)).toEqual({ changed: true, exists: false })
  })

  it('issues directory and safe attachment actions, rejects executables, and revalidates before open', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'report.pdf'), '%PDF')
    await writeFile(path.join(f.root, 'run.exe'), 'MZ')
    const directory = await f.service.navigate({ href: '../' })
    const attachment = await f.service.navigate({ href: '../report.pdf' })
    expect(directory.kind).toBe('directory')
    expect(attachment.kind).toBe('external-file')
    if (directory.kind === 'document' || attachment.kind === 'document') throw new Error('Wrong result')
    await f.service.open(directory.id)
    await f.service.open(attachment.id)
    expect(f.opened).toEqual([{ kind: 'external', path: f.root }, { kind: 'external', path: path.join(f.root, 'report.pdf') }])
    await expect(f.service.navigate({ href: '../run.exe' })).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_UNSUPPORTED' })
    await rm(path.join(f.root, 'report.pdf'))
    await expect(f.service.open(attachment.id)).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_NOT_FOUND' })
    expect(f.opened).toHaveLength(2)
  })

  it('opens text through the document callback only and rejects a file replaced by a directory', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'other.md'), 'text')
    const item = document(await f.service.navigate({ href: '../other.md' }))
    await f.service.open(item.id)
    expect(f.opened).toEqual([{ kind: 'document', path: path.join(f.root, 'other.md') }])
    await rm(path.join(f.root, 'other.md'))
    await mkdir(path.join(f.root, 'other.md'))
    await expect(f.service.open(item.id)).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_UNSUPPORTED' })
    expect(f.opened).toHaveLength(1)
  })

  it('rejects foreign tokens, tokens from older sessions, arbitrary paths and unsafe raw hrefs', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'other.md'), 'text')
    const item = document(await f.service.navigate({ href: '../other.md' }))
    const foreign = createDocumentViewService(f.options)
    await expect(foreign.refresh(item.id)).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_STALE' })
    await expect(f.service.open(item.absolutePath)).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_STALE' })
    await expect(f.service.navigate({ href: 'C:/x.md' })).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_INVALID_LINK' })
    f.setSource({ absolutePath: path.join(f.root, 'workspace', 'root.md'), session: 2 })
    await expect(f.service.refresh(item.id)).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_STALE' })
    await expect(f.service.navigate({ href: './other.md', sourceId: item.id })).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_STALE' })
    f.setSource(null)
    await expect(f.service.navigate({ href: '../other.md' })).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_NO_SOURCE' })
  })

  it('discards an in-flight read when its trusted source changes or clear invalidates the operation', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'other.md'), 'text')
    const pending = f.service.navigate({ href: '../other.md' })
    f.setSource({ absolutePath: path.join(f.root, 'new.md'), session: 2 })
    await expect(pending).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_STALE' })
    const after = f.service.navigate({ href: './other.md' })
    f.service.clear()
    await expect(after).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_STALE' })
  })

  it('bounds unique token history while retaining every visible token during more than 128 deep navigations', async () => {
    const f = await fixture()
    await Promise.all(Array.from({ length: 140 }, (_, i) => writeFile(path.join(f.root, `${i}.md`), `${i}`)))
    const first = document(await f.service.navigate({ href: '../0.md' }))
    let active = [first]
    for (let i = 1; i < 140; i++) {
      const next = document(await f.service.navigate({ href: `./${i}.md`, sourceId: active.at(-1)!.id, activeIds: active.map(item => item.id) }))
      active = [...active, next].slice(-32)
    }
    await expect(f.service.refresh(first.id)).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_STALE' })
    for (const item of active) expect((await f.service.refresh(item.id)).text).toBe(item.text)
  })

  it('keeps visible ancestors alive across more than 128 branches with fresh snapshot tokens', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'A.md'), 'ancestor')
    await writeFile(path.join(f.root, 'B.md'), 'branch')
    await Promise.all(Array.from({ length: 140 }, (_, i) => writeFile(path.join(f.root, `child-${i}.md`), 'child')))
    const a = document(await f.service.navigate({ href: '../A.md' }))
    let b = document(await f.service.navigate({ href: './B.md', sourceId: a.id, activeIds: [a.id] }))
    for (let i = 0; i < 140; i++) {
      const child = document(await f.service.navigate({ href: `./child-${i}.md`, sourceId: b.id, activeIds: [a.id, b.id] }))
      const returned = document(await f.service.navigate({ href: './B.md', sourceId: child.id, activeIds: [a.id, b.id, child.id] }))
      expect(returned.absolutePath).toBe(b.absolutePath)
      b = returned
    }
    expect((await f.service.refresh(a.id)).text).toBe('ancestor')
    await writeFile(path.join(f.root, 'B.md'), 'explicit navigation refresh')
    const updated = document(await f.service.navigate({ href: './B.md', sourceId: a.id, activeIds: [a.id, b.id] }))
    expect(updated).toMatchObject({ absolutePath: b.absolutePath, text: 'explicit navigation refresh' })
    expect(updated.revision).not.toBe(b.revision)
    expect(await f.service.inspect(updated.id)).toEqual({ changed: false, exists: true })
  })

  it('does not accept a new navigation revision for an older snapshot when the UI ignores its response', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'B.md'), 'shown snapshot')
    const shown = document(await f.service.navigate({ href: '../B.md' }))
    await writeFile(path.join(f.root, 'B.md'), 'new disk bytes')
    // The renderer may cancel this request by selecting an existing breadcrumb.
    await f.service.navigate({ href: '../B.md', activeIds: [shown.id] })
    expect(await f.service.inspect(shown.id)).toEqual({ changed: true, exists: true })
    expect((await f.service.refresh(shown.id)).text).toBe('new disk bytes')
  })

  it('does not accept an ignored refresh response for the older displayed snapshot', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'B.md'), 'shown snapshot')
    const shown = document(await f.service.navigate({ href: '../B.md' }))
    await writeFile(path.join(f.root, 'B.md'), 'new disk bytes')
    // Local breadcrumb selection or another failed navigation can ignore this result.
    await f.service.refresh(shown.id)
    expect(await f.service.inspect(shown.id)).toEqual({ changed: true, exists: true })
  })

  it('retains visible ancestor tokens across more than 128 refreshes without requiring a new navigation', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'A.md'), 'ancestor')
    await writeFile(path.join(f.root, 'B.md'), 'current')
    const a = document(await f.service.navigate({ href: '../A.md' }))
    let b = document(await f.service.navigate({ href: './B.md', sourceId: a.id, activeIds: [a.id] }))
    for (let i = 0; i < 140; i++) b = await f.service.refresh(b.id)
    expect((await f.service.refresh(a.id)).text).toBe('ancestor')
    expect(await f.service.inspect(b.id)).toEqual({ changed: false, exists: true })
  })

  it('discards an older navigation when a newer navigation starts in the same session', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'A.md'), 'old navigation')
    await writeFile(path.join(f.root, 'B.md'), 'current navigation')
    const outcomes = await Promise.allSettled([f.service.navigate({ href: '../A.md' }), f.service.navigate({ href: '../B.md' })])
    expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: { code: 'DOCUMENT_VIEW_STALE' } })
    expect(outcomes[1]).toMatchObject({ status: 'fulfilled', value: { kind: 'document', document: { text: 'current navigation' } } })
  })

  it('rejects keepalive tokens from a foreign service or old source session', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'A.md'), 'text')
    const foreign = createDocumentViewService(f.options)
    const a = document(await foreign.navigate({ href: '../A.md' }))
    await expect(f.service.navigate({ href: '../A.md', activeIds: [a.id] })).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_STALE' })
    const own = document(await f.service.navigate({ href: '../A.md' }))
    f.setSource({ absolutePath: path.join(f.root, 'workspace', 'root.md'), session: 2 })
    await expect(f.service.navigate({ href: '../A.md', activeIds: [own.id] })).rejects.toMatchObject({ code: 'DOCUMENT_VIEW_STALE' })
  })
})
