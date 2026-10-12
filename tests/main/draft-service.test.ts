import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftService, type SaveDraftRecord } from '../../src/main/drafts/draft-service'
import { draftPaths } from '../../src/main/drafts/draft-paths'

const draftId = '123e4567-e89b-42d3-a456-426614174000'
let root = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arkdown-drafts-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function input(markdown: string): SaveDraftRecord {
  return {
    draftId,
    markdown,
    originalAbsolutePath: path.join(root, 'workspace', 'note.md'),
    workspaceAbsolutePath: path.join(root, 'workspace'),
    originalRevision: 'a'.repeat(64),
    originalMtimeMs: 123,
    encoding: 'utf8',
    newline: 'lf',
  }
}

describe('DraftService', () => {
  it('upgrades a legacy pair before changing either file so an interrupted upgrade retains its last body', async () => {
    const initial = new DraftService({ root, appVersion: '1.0.3' })
    await initial.write(input('legacy body'))
    await rm(path.join(root, 'records', `${draftId}.json`))
    let reachedBody!: () => void
    let releaseBody!: () => void
    const bodyStarted = new Promise<void>((resolve) => { reachedBody = resolve })
    const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve })
    const upgrading = new DraftService({ root, appVersion: '1.0.4', atomicWrite: async (target, contents) => {
      await writeFile(target, contents, 'utf8')
      if (target.endsWith('body.md')) { reachedBody(); await bodyGate }
    } })
    const pending = upgrading.write(input('next body'))
    await bodyStarted
    try {
      expect((await new DraftService({ root, appVersion: '1.0.4' }).read(draftId))?.markdown).toBe('legacy body')
    } finally { releaseBody(); await pending }
  })

  it('recovers an interrupted Save As rollback between restoring the draft and assets', async () => {
    const service = new DraftService({ root, appVersion: '1.0.4' })
    const paths = draftPaths(root, draftId)
    await mkdir(paths.assetDirectory, { recursive: true })
    await writeFile(path.join(paths.assetDirectory, 'image.png'), 'image')
    await service.write(input('with image'))
    await service.beginFinalizeSaved(draftId)
    const [stagingName] = await readdir(path.join(root, 'pending-finalize'))
    const staging = path.join(root, 'pending-finalize', stagingName)
    await rename(path.join(staging, 'draft'), paths.draftDirectory)
    expect((await new DraftService({ root, appVersion: '1.0.4' }).read(draftId))?.markdown).toBe('with image')
    expect(await readFile(path.join(paths.assetDirectory, 'image.png'), 'utf8')).toBe('image')
  })
  it('keeps a committed draft recoverable across an interrupted body/manifest rewrite', async () => {
    const service = new DraftService({ root, appVersion: '1.0.4' })
    await service.write(input('complete backup'))
    await writeFile(draftPaths(root, draftId).bodyPath, 'interrupted next body', 'utf8')
    const restarted = new DraftService({ root, appVersion: '1.0.4' })
    expect((await restarted.read(draftId))?.markdown).toBe('complete backup')
  })

  it('never revives an ended draft after cleanup fails or a late backup arrives', async () => {
    const service = new DraftService({ root, appVersion: '1.0.4',
      removeDirectory: async () => { throw new Error('cleanup denied') },
    })
    await service.write(input('discard this'))
    await service.discard(draftId)
    expect(await readFile(draftPaths(root, draftId).bodyPath, 'utf8')).toBe('discard this')
    await expect(service.write(input('late autosave'))).rejects.toThrow('ended')
    const restarted = new DraftService({ root, appVersion: '1.0.4' })
    expect(await restarted.listRecoverable()).toEqual([])
    expect(await restarted.read(draftId)).toBeNull()
  })

  it('removes completed saves from active enumeration while retaining their rejection tombstones', async () => {
    const service = new DraftService({ root, appVersion: '1.0.4' })
    await service.write(input('complete'))
    await service.discard(draftId)
    expect(await readdir(path.join(root, 'records'))).toEqual([])
    const restarted = new DraftService({ root, appVersion: '1.0.4' })
    expect(await restarted.listRecoverable()).toEqual([])
    await expect(restarted.write(input('late write'))).rejects.toThrow('ended')
  })

  it('revokes the clean history lease when its window owner releases it', async () => {
    const service = new DraftService({ root, appVersion: '1.0.4' })
    const owner = {}
    service.claim(draftId, owner)
    await service.write(input('undo this'))
    await service.markClean(draftId)
    service.releaseOwner(owner)
    await expect(service.write(input('late after close'))).rejects.toThrow('ended')
    expect(await new DraftService({ root, appVersion: '1.0.4' }).listRecoverable()).toEqual([])
  })

  it('preserves a new live-history backup after discovery has read its previous ended record', async () => {
    let retainOldBody = true
    const service = new DraftService({ root, appVersion: '1.0.4', removeDirectory: async (directory) => {
      if (retainOldBody) throw new Error('cleanup temporarily unavailable')
      await rm(directory, { recursive: true, force: true })
    } })
    await service.write(input('old edit'))
    await service.markClean(draftId)
    retainOldBody = false
    const read = service.read.bind(service)
    vi.spyOn(service, 'read').mockImplementationOnce(async (id) => {
      const ended = await read(id)
      expect(ended).toBeNull()
      // A still-open editor starts a genuine new edit between discovery's read
      // and its later cleanup turn. Cleanup must recheck inside the same queue.
      await service.write(input('new live edit'))
      return ended
    })
    await service.listRecoverable()
    expect(await readFile(draftPaths(root, draftId).bodyPath, 'utf8')).toBe('new live edit')
    const restarted = new DraftService({ root, appVersion: '1.0.4' })
    expect((await restarted.read(draftId))?.markdown).toBe('new live edit')
    expect(await restarted.listRecoverable()).toEqual([expect.objectContaining({ draftId })])
  })

  it('retains active contents when the durable terminal commit fails', async () => {
    let fail = false
    const service = new DraftService({ root, appVersion: '1.0.4', atomicWrite: async (target, contents) => {
      if (fail && contents.includes('"ended"')) throw new Error('terminal denied')
      await writeFile(target, contents, 'utf8')
    } })
    await service.write(input('keep this'))
    fail = true
    await expect(service.discard(draftId)).rejects.toThrow('terminal denied')
    expect((await new DraftService({ root, appVersion: '1.0.4' }).read(draftId))?.markdown).toBe('keep this')
  })

  it('does not restore committed Save As staging left by failed cleanup', async () => {
    const service = new DraftService({ root, appVersion: '1.0.4',
      removeDirectory: async () => { throw new Error('cleanup denied') },
    })
    await service.write(input('saved as'))
    const transaction = await service.beginFinalizeSaved(draftId)
    await transaction.commit()
    const restarted = new DraftService({ root, appVersion: '1.0.4' })
    expect(await restarted.listRecoverable()).toEqual([])
  })

  it('filters disk-identical drafts but preserves conflicts and ignored drafts for manual review', async () => {
    const service = new DraftService({ root, appVersion: '1.0.4' })
    const original = input('same').originalAbsolutePath!
    await mkdir(path.dirname(original), { recursive: true })
    await writeFile(original, '\uFEFFsame\r\n', 'utf8')
    await service.write(input('same\n'))
    expect(await service.listRecoverable()).toEqual([])
    await service.write(input('different'))
    await service.markIgnored(draftId)
    expect(await service.listRecoverable()).toEqual([])
    expect(await service.listRecoverable(true)).toEqual([expect.objectContaining({ draftId })])
  })
  it('retains only clipboard history after save and releases it after ownership ends', async () => {
    const service = new DraftService({ root, appVersion: '0.1.0' })
    const paths = draftPaths(root, draftId)
    const image = path.join(paths.assetDirectory, 'clipboard-123e4567-e89b-42d3-a456-426614174000.png')
    await mkdir(paths.assetDirectory, { recursive: true })
    await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
    await service.write(input(`![](<${image}>)`))
    expect(await service.retainClipboardHistoryAfterSave(draftId)).toBe(true)
    expect(await service.listRecoverable()).toEqual([])
    expect((await readFile(image)).length).toBeGreaterThan(0)
    await service.releaseSavedClipboardHistory(draftId)
    await expect(readFile(image)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('drains an in-flight dirty backup before releasing saved clipboard history', async () => {
    let unblock!: () => void
    let began!: () => void
    const started = new Promise<void>((done) => { began = done })
    const blocked = new Promise<void>((done) => { unblock = done })
    let hold = false
    const service = new DraftService({ root, appVersion: '0.1.0', atomicWrite: async (target, contents) => {
      if (hold && target.endsWith('body.md')) { began(); await blocked }
      await writeFile(target, contents, 'utf8')
    } })
    const paths = draftPaths(root, draftId)
    const name = 'clipboard-123e4567-e89b-42d3-a456-426614174000.png'
    await mkdir(paths.assetDirectory, { recursive: true })
    await writeFile(path.join(paths.assetDirectory, name), 'PNG history')
    await service.write(input('saved'))
    await service.retainClipboardHistoryAfterSave(draftId)
    hold = true
    const backup = service.write(input(`dirty ![](<${path.join(paths.assetDirectory, name)}>)`))
    await started
    const release = service.releaseSavedClipboardHistory(draftId)
    unblock()
    await Promise.all([backup, release])
    const recovered = await new DraftService({ root, appVersion: '0.1.0' }).read(draftId)
    expect(recovered?.markdown).toContain('dirty')
    expect(await readFile(path.join(paths.assetDirectory, name), 'utf8')).toBe('PNG history')
  })
  it('writes a durable body and manifest without touching the original', async () => {
    const original = input('# draft').originalAbsolutePath!
    await mkdir(path.dirname(original), { recursive: true })
    await writeFile(original, '# original', 'utf8')
    const service = new DraftService({ root, appVersion: '0.1.0' })

    const summary = await service.write(input('# draft'))
    const paths = draftPaths(root, draftId)
    const manifest = JSON.parse(await readFile(paths.manifestPath, 'utf8')) as Record<string, unknown>

    expect(summary.draftId).toBe(draftId)
    expect(await readFile(paths.bodyPath, 'utf8')).toBe('# draft')
    expect(manifest.bodySha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await readFile(original, 'utf8')).toBe('# original')
  })

  it('keeps the previous complete draft recoverable when a manifest write fails', async () => {
    let failManifestOnce = false
    const atomicWrite = vi.fn(async (filePath: string, contents: string) => {
      if (failManifestOnce && filePath.endsWith('manifest.json')) {
        failManifestOnce = false
        throw new Error('disk full')
      }
      await writeFile(filePath, contents, 'utf8')
    })
    const service = new DraftService({ root, appVersion: '0.1.0', atomicWrite })
    await service.write(input('# one'))
    failManifestOnce = true

    await expect(service.write(input('# two'))).rejects.toThrow('disk full')
    await expect(service.read(draftId)).resolves.toMatchObject({ markdown: '# one' })
  })

  it('serializes rapid writes per draft so the latest content wins', async () => {
    const service = new DraftService({ root, appVersion: '0.1.0' })

    await Promise.all([
      service.write(input('# one')),
      service.write(input('# two')),
      service.write(input('# three')),
    ])

    await expect(service.read(draftId)).resolves.toMatchObject({ markdown: '# three' })
  })

  it('quarantines corrupt records instead of returning them', async () => {
    const service = new DraftService({ root, appVersion: '0.1.0' })
    await service.write(input('# valid'))
    await writeFile(path.join(root, 'records', `${draftId}.json`), '{corrupted', 'utf8')

    await expect(service.listRecoverable()).resolves.toEqual([])
    await expect(readdir(path.join(root, 'quarantine'))).resolves.toHaveLength(2)
  })

  it('discards only the selected draft and its matching asset directory', async () => {
    const secondId = '223e4567-e89b-42d3-a456-426614174000'
    const service = new DraftService({ root, appVersion: '0.1.0' })
    await service.write(input('# first'))
    await service.write({ ...input('# second'), draftId: secondId })
    const selected = draftPaths(root, draftId)
    const retained = draftPaths(root, secondId)
    await mkdir(selected.assetDirectory, { recursive: true })
    await writeFile(path.join(selected.assetDirectory, 'image.png'), 'asset', 'utf8')

    await service.discard(draftId)

    await expect(readFile(selected.bodyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(selected.assetDirectory, 'image.png'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(retained.bodyPath, 'utf8')).resolves.toBe('# second')
  })

  it('can finalize a successfully saved draft', async () => {
    const service = new DraftService({ root, appVersion: '0.1.0' })
    await service.write(input('# saved'))

    await service.finalizeSaved(draftId)

    await expect(service.read(draftId)).resolves.toBeNull()
  })

  it('stages draft finalization so Save As rollback restores body and assets', async () => {
    const service = new DraftService({ root, appVersion: '0.1.0' })
    await service.write(input('# saved'))
    const paths = draftPaths(root, draftId)
    await mkdir(paths.assetDirectory, { recursive: true })
    await writeFile(path.join(paths.assetDirectory, 'image.png'), 'asset', 'utf8')

    const finalize = await service.beginFinalizeSaved(draftId)
    await expect(service.read(draftId)).resolves.toBeNull()
    await expect(service.write(input('# cannot race staged finalize'))).rejects.toThrow('finalized')
    await finalize.rollback()

    await expect(service.read(draftId)).resolves.toMatchObject({ markdown: '# saved' })
    await expect(readFile(path.join(paths.assetDirectory, 'image.png'), 'utf8')).resolves.toBe('asset')
  })

  it('commits staged draft finalization once and rejects replay', async () => {
    const service = new DraftService({ root, appVersion: '0.1.0' })
    await service.write(input('# saved'))

    const finalize = await service.beginFinalizeSaved(draftId)
    await finalize.commit()

    await expect(service.read(draftId)).resolves.toBeNull()
    await expect(finalize.commit()).rejects.toThrow('complete')
    await expect(finalize.rollback()).rejects.toThrow('complete')
  })

  it('conservatively recovers a pending finalization after process interruption', async () => {
    const firstProcess = new DraftService({ root, appVersion: '0.1.0' })
    await firstProcess.write(input('# interrupted'))
    const paths = draftPaths(root, draftId)
    await mkdir(paths.assetDirectory, { recursive: true })
    await writeFile(path.join(paths.assetDirectory, 'image.png'), 'asset', 'utf8')
    await firstProcess.beginFinalizeSaved(draftId)

    const restartedProcess = new DraftService({ root, appVersion: '0.1.0' })
    await expect(restartedProcess.listRecoverable()).resolves.toEqual([
      expect.objectContaining({ draftId }),
    ])
    await expect(restartedProcess.read(draftId)).resolves.toMatchObject({ markdown: '# interrupted' })
    await expect(readFile(path.join(paths.assetDirectory, 'image.png'), 'utf8')).resolves.toBe('asset')
  })

  it('hides ignored drafts from recovery prompts while retaining readable data', async () => {
    const service = new DraftService({ root, appVersion: '0.1.0' })
    await service.write(input('# later'))

    await service.markIgnored(draftId)

    await expect(service.listRecoverable()).resolves.toEqual([])
    await expect(service.read(draftId)).resolves.toMatchObject({
      markdown: '# later',
      manifest: { draftId, ignoredAt: expect.any(String) },
    })
  })
})
