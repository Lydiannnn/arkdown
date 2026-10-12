import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StickyNoteStore } from '../../src/main/sticky-notes/sticky-note-store'
import {
  stickyNoteIndexPath,
  stickyNotePaths,
} from '../../src/main/sticky-notes/sticky-note-paths'
import { MAX_ACTIVE_STICKY_NOTES } from '../../src/shared/sticky-notes'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

let root = ''
let sequence = 0
const NOW = new Date('2026-07-31T03:00:00.000Z')
const LEGACY_HELP_MARKDOWN = `#### 便签盒子使用说明

欢迎使用 Arkdown 便签盒子。

## 创建与编辑

- 在便签盒子中选择“创建新便签”。
- 便签内容会在停止输入后实时保存。
- 保存状态会显示“实时保存中...”或“已保存”。

## 桌面便签

- 使用“释放到桌面”打开独立便签窗口。
- Pin 可以让便签始终置顶。
- 使用“从桌面回收”关闭桌面展示，但不会删除便签内容。

## 搜索与归档

- 在便签盒子中按 Ctrl+F 搜索当前活跃便签。
- 不常用的便签可以归档，归档便签不占用 35 个活跃位置。

## 免安装版提示

启用开机启动后，如果移动 Arkdown 程序文件夹，原有开机启动路径将失效。
`

function nextId(): string {
  sequence += 1
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`
}

function createStore(): StickyNoteStore {
  return new StickyNoteStore({
    root,
    now: () => new Date(NOW),
    createId: nextId,
  })
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arkdown-sticky-store-'))
  sequence = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('StickyNoteStore', () => {
  it('retries transient Windows atomic-write failures', async () => {
    let attempts = 0
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      atomicWrite: async (filePath, contents) => {
        attempts += 1
        if (attempts === 1) {
          throw Object.assign(new Error('temporary file lock'), { code: 'EPERM' })
        }
        await writeFile(filePath, contents, 'utf8')
      },
    })

    await expect(store.initialize()).resolves.toMatchObject({ defaultHelpNoteCreated: true })
    expect(attempts).toBeGreaterThan(1)
  })

  it('creates one ordinary help note on first initialization', async () => {
    const store = createStore()

    const first = await store.initialize()
    const second = await store.initialize()

    expect(first).toEqual(second)
    expect(first.defaultHelpNoteCreated).toBe(true)
    expect(first.notes).toHaveLength(1)
    expect(first.notes[0]).toMatchObject({
      name: '便签260731-壹',
      status: 'active',
      released: false,
      pinned: false,
      lineSpacingMode: 'compact',
      style: {
        mode: 'material',
        materialPresetId: 'mica-light',
      },
    })
    const help = await store.get(first.notes[0].id)
    expect(help.markdown).toMatch(/^#### 欢迎使用 Arkdown 便签盒子。$/mu)
    const headings = help.markdown
      .split(/\r?\n/u)
      .filter((line) => /^#{1,6} /u.test(line))
    expect(headings).not.toHaveLength(0)
    expect(headings.every((line) => line.startsWith('#### '))).toBe(true)
    expect(help.markdown).toContain('实时保存')
    expect(help.markdown).toContain('右键有更多操作可选。')
    expect(help.markdown).toContain('可选4种便签材质，选一个好看的。')
  })

  it('preserves the prior current-default note when reopening the store', async () => {
    const store = createStore()
    const initialized = await store.initialize()
    const helpRecord = initialized.notes[0]
    const helpPath = stickyNotePaths(root, helpRecord).markdown
    const priorDefault = `#### 留住一瞬

写下此刻，留给明天。

灵感、琐事，或一句喜欢的话。

---

内容实时保存。右键“释放到桌面”，让它陪在身边。
`
    await writeFile(helpPath, priorDefault, 'utf8')

    const reloaded = createStore()
    const reopened = await reloaded.initialize()

    expect(reopened.notes).toHaveLength(1)
    expect((await reloaded.get(helpRecord.id)).markdown).toBe(priorDefault)
    expect(await readFile(helpPath, 'utf8')).toBe(priorDefault)
  })

  it('migrates an untouched legacy help note to the all-H4 template', async () => {
    const store = createStore()
    const initialized = await store.initialize()
    const helpRecord = initialized.notes[0]
    const helpPath = stickyNotePaths(root, helpRecord).markdown
    await writeFile(helpPath, LEGACY_HELP_MARKDOWN, 'utf8')

    const reloaded = createStore()
    await reloaded.initialize()
    const help = await reloaded.get(helpRecord.id)
    const headings = help.markdown
      .split(/\r?\n/u)
      .filter((line) => /^#{1,6} /u.test(line))

    expect(help.markdown).not.toBe(LEGACY_HELP_MARKDOWN)
    expect(headings.every((line) => line.startsWith('#### '))).toBe(true)
  })

  it('does not migrate a user-edited legacy help note', async () => {
    const store = createStore()
    const initialized = await store.initialize()
    const helpRecord = initialized.notes[0]
    const helpPath = stickyNotePaths(root, helpRecord).markdown
    const edited = `${LEGACY_HELP_MARKDOWN}\n用户补充内容。\n`
    await writeFile(helpPath, edited, 'utf8')

    const reloaded = createStore()
    await reloaded.initialize()

    expect((await reloaded.get(helpRecord.id)).markdown).toBe(edited)
  })

  it('creates, reads, writes and lists a detached document', async () => {
    const store = createStore()
    await store.initialize()

    const created = await store.create({ name: '开发记录', markdown: '# 第一版' })
    expect(created.record.lineSpacingMode).toBe('compact')
    await store.writeMarkdown(created.record.id, '# 第二版')
    const active = await store.list('active')
    const read = await store.get(created.record.id)

    expect(active.map(({ record }) => record.name)).toContain('开发记录')
    expect(read.markdown).toBe('# 第二版')
    read.record.name = '只修改副本'
    expect((await store.get(created.record.id)).record.name).toBe('开发记录')
  })

  it('atomically writes a loaded schema v2 index back as schema v5', async () => {
    const original = createStore()
    const currentIndex = await original.initialize()
    const v2Index = {
      ...currentIndex,
      schemaVersion: 2,
      notes: currentIndex.notes.map(({ lineSpacingMode: _lineSpacingMode, ...note }) => note),
    }
    await writeFile(stickyNoteIndexPath(root), `${JSON.stringify(v2Index, null, 2)}\n`, 'utf8')

    const writes: string[] = []
    const reloaded = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      atomicWrite: async (filePath, contents) => {
        if (filePath === stickyNoteIndexPath(root)) writes.push(contents)
        await writeFile(filePath, contents, 'utf8')
      },
    })

    const upgraded = await reloaded.initialize()

    expect(upgraded).toMatchObject({
      schemaVersion: 5,
      notes: [{ lineSpacingMode: 'compact' }],
    })
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0])).toMatchObject({
      schemaVersion: 5,
      notes: [{ lineSpacingMode: 'compact' }],
    })
  })

  it('persists normalized material ids when loading an existing schema v4 index', async () => {
    const original = createStore()
    const currentIndex = await original.initialize()
    const legacyIndex = {
      ...currentIndex,
      notes: currentIndex.notes.map((note, index) => index === 0
        ? { ...note, style: { mode: 'material', materialPresetId: 'acrylic-light' } }
        : note),
    }
    await writeFile(stickyNoteIndexPath(root), `${JSON.stringify(legacyIndex, null, 2)}\n`, 'utf8')

    const reloaded = createStore()
    const normalized = await reloaded.initialize()
    const persisted = JSON.parse(await readFile(stickyNoteIndexPath(root), 'utf8')) as {
      notes: Array<{ style: { materialPresetId?: string } }>
    }

    expect(normalized.notes[0].style).toEqual({
      mode: 'material',
      materialPresetId: 'flowing-glass',
    })
    expect(persisted.notes[0].style.materialPresetId).toBe('flowing-glass')
  })

  it('renames the markdown file without changing the note id or resources', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: '旧名称', markdown: '# 内容' })
    const oldPaths = stickyNotePaths(root, created.record)
    await writeFile(path.join(oldPaths.resources, 'image.png'), 'asset', 'utf8')

    const renamed = await store.rename(created.record.id, '新名称')
    const newPaths = stickyNotePaths(root, renamed.record)

    expect(renamed.record.id).toBe(created.record.id)
    await expect(readFile(newPaths.markdown, 'utf8')).resolves.toBe('# 内容')
    await expect(readFile(path.join(newPaths.resources, 'image.png'), 'utf8'))
      .resolves.toBe('asset')
    await expect(stat(oldPaths.markdown)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['gif', 'txt'])('rejects %s as a sticky note background', async (extension) => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: `Unsupported ${extension}` })
    const source = path.join(root, `wallpaper.${extension}`)
    await writeFile(source, 'not a supported background', 'utf8')

    await expect(store.replaceBackgroundImage(created.record.id, source))
      .rejects.toThrow('背景图片无效')
  })

  it('saves and reopens an ordinary SVG background in its owning note', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: 'SVG background' })
    const source = path.join(root, 'wallpaper.svg')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>'
    await writeFile(source, svg, 'utf8')
    const updated = await store.applyBackground(created.record.id, DEFAULT_BACKGROUND_SETTINGS, {
      kind: 'replace', sourceAbsolutePath: source,
    })
    expect(updated.background.imageRelativePath).toMatch(/^resources\/[0-9a-f-]+\.svg$/u)
    const reopened = createStore()
    await reopened.initialize()
    expect((await reopened.get(created.record.id)).record.background).toEqual(updated.background)
    const resolved = await reopened.resolveBackgroundImagePath(created.record.id)
    await expect(readFile(resolved!, 'utf8')).resolves.toBe(svg)
  })

  it('rejects an invalidated background session before changing the note or its resources', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: 'Cancelled apply' })
    const source = path.join(root, 'cancelled.svg')
    await writeFile(source, '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8')
    await expect(store.applyBackground(created.record.id, {
      ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 91,
    }, { kind: 'replace', sourceAbsolutePath: source }, () => {
      throw new Error('stale session')
    })).rejects.toThrow('stale session')
    expect((await store.get(created.record.id)).record.background).toEqual(created.record.background)
    expect(await readdir(stickyNotePaths(root, created.record).resources).catch(() => [])).toEqual([])
  })

  it('updates background display settings without accepting a caller-supplied resource path', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: 'Background display settings' })

    const updated = await store.setBackground(created.record.id, {
      ...DEFAULT_BACKGROUND_SETTINGS,
      imageRelativePath: 'resources/untrusted.png',
      imageOpacityPercent: 45,
      maskType: 'diagonal-bottom-right',
      maskOpacityPercent: 55,
      maskTransitionPercent: 65,
    })

    expect(updated.background).toEqual({
      imageRelativePath: null,
      imageOpacityPercent: 45,
      imageAlignment: DEFAULT_BACKGROUND_SETTINGS.imageAlignment,
      maskType: 'diagonal-bottom-right',
      maskOpacityPercent: 55,
      maskTransitionPercent: 65,
      maskStrengthPercent: DEFAULT_BACKGROUND_SETTINGS.maskStrengthPercent,
    })
    expect((await store.get(created.record.id)).record.background).toEqual(updated.background)
  })

  it('copies a static background into only its owning note and resolves its read path', async () => {
    const store = createStore()
    await store.initialize()
    const first = await store.create({ name: 'First background' })
    const second = await store.create({ name: 'Second background' })
    const source = path.join(root, 'wallpaper.webp')
    await writeFile(source, 'background image', 'utf8')

    const firstUpdated = await store.replaceBackgroundImage(first.record.id, source)
    const secondUpdated = await store.replaceBackgroundImage(second.record.id, source)
    const firstPath = await store.resolveBackgroundImagePath(first.record.id)
    const secondPath = await store.resolveBackgroundImagePath(second.record.id)

    expect(firstUpdated.background.imageRelativePath).toMatch(/^resources\/[0-9a-f-]+\.webp$/u)
    expect(secondUpdated.background.imageRelativePath).toMatch(/^resources\/[0-9a-f-]+\.webp$/u)
    expect(firstUpdated.background.imageRelativePath).not.toBe(secondUpdated.background.imageRelativePath)
    expect(firstPath).toBe(path.join(
      stickyNotePaths(root, firstUpdated).resources,
      path.basename(firstUpdated.background.imageRelativePath!),
    ))
    expect(secondPath).toBe(path.join(
      stickyNotePaths(root, secondUpdated).resources,
      path.basename(secondUpdated.background.imageRelativePath!),
    ))
    await expect(readFile(firstPath!, 'utf8')).resolves.toBe('background image')
    await expect(readFile(secondPath!, 'utf8')).resolves.toBe('background image')
  })

  it('rolls back a replacement when persisting the new background fails', async () => {
    let failNextIndexWrite = false
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      atomicWrite: async (filePath, contents) => {
        if (filePath === stickyNoteIndexPath(root) && failNextIndexWrite) {
          throw new Error('index write failed')
        }
        await writeFile(filePath, contents, 'utf8')
      },
    })
    await store.initialize()
    const created = await store.create({ name: 'Rollback background' })
    const firstSource = path.join(root, 'first.png')
    const replacementSource = path.join(root, 'replacement.png')
    await writeFile(firstSource, 'first image', 'utf8')
    await writeFile(replacementSource, 'replacement image', 'utf8')
    const original = await store.replaceBackgroundImage(created.record.id, firstSource)
    const originalPath = await store.resolveBackgroundImagePath(created.record.id)
    failNextIndexWrite = true

    await expect(store.replaceBackgroundImage(created.record.id, replacementSource))
      .rejects.toThrow('index write failed')

    const retained = await store.get(created.record.id)
    const resourceNames = await readdir(stickyNotePaths(root, retained.record).resources)
    expect(retained.record.background).toEqual(original.background)
    expect(await store.resolveBackgroundImagePath(created.record.id)).toBe(originalPath)
    expect(resourceNames).toEqual([path.basename(original.background.imageRelativePath!)])
    await expect(readFile(originalPath!, 'utf8')).resolves.toBe('first image')
  })

  it('atomically applies replacement controls and a managed path before cleaning up the old image', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: 'Atomic replacement' })
    const firstSource = path.join(root, 'first.png')
    const replacementSource = path.join(root, 'replacement.webp')
    await writeFile(firstSource, 'first image', 'utf8')
    await writeFile(replacementSource, 'replacement image', 'utf8')
    const first = await store.applyBackground(created.record.id, DEFAULT_BACKGROUND_SETTINGS, {
      kind: 'replace', sourceAbsolutePath: firstSource,
    })
    const firstPath = await store.resolveBackgroundImagePath(created.record.id)

    const updated = await store.applyBackground(created.record.id, {
      ...DEFAULT_BACKGROUND_SETTINGS,
      imageRelativePath: 'resources/caller-controlled.png',
      imageOpacityPercent: 47,
      maskType: 'diagonal-bottom-right',
      maskOpacityPercent: 58,
      maskTransitionPercent: 69,
    }, { kind: 'replace', sourceAbsolutePath: replacementSource })

    expect(updated.background).toEqual({
      imageRelativePath: expect.stringMatching(/^resources\/[0-9a-f-]+\.webp$/u),
      imageOpacityPercent: 47,
      imageAlignment: DEFAULT_BACKGROUND_SETTINGS.imageAlignment,
      maskType: 'diagonal-bottom-right',
      maskOpacityPercent: 58,
      maskTransitionPercent: 69,
      maskStrengthPercent: DEFAULT_BACKGROUND_SETTINGS.maskStrengthPercent,
    })
    expect(updated.background.imageRelativePath).not.toBe('resources/caller-controlled.png')
    expect(updated.background.imageRelativePath).not.toBe(first.background.imageRelativePath)
    await expect(stat(firstPath!)).rejects.toMatchObject({ code: 'ENOENT' })
    const replacementPath = await store.resolveBackgroundImagePath(created.record.id)
    expect(replacementPath).not.toBeNull()
    await expect(readFile(replacementPath!, 'utf8'))
      .resolves.toBe('replacement image')
  })

  it('rolls back a newly copied image and all control changes when the atomic apply write fails', async () => {
    let failNextIndexWrite = false
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      atomicWrite: async (filePath, contents) => {
        if (filePath === stickyNoteIndexPath(root) && failNextIndexWrite) {
          throw new Error('index write failed')
        }
        await writeFile(filePath, contents, 'utf8')
      },
    })
    await store.initialize()
    const created = await store.create({ name: 'Atomic rollback' })
    const originalSource = path.join(root, 'original.png')
    const replacementSource = path.join(root, 'replacement.png')
    await writeFile(originalSource, 'original image', 'utf8')
    await writeFile(replacementSource, 'replacement image', 'utf8')
    const original = await store.applyBackground(created.record.id, DEFAULT_BACKGROUND_SETTINGS, {
      kind: 'replace', sourceAbsolutePath: originalSource,
    })
    const originalPath = await store.resolveBackgroundImagePath(created.record.id)
    failNextIndexWrite = true

    await expect(store.applyBackground(created.record.id, {
      ...DEFAULT_BACKGROUND_SETTINGS,
      imageRelativePath: 'resources/not-allowed.png',
      imageOpacityPercent: 90,
      maskType: 'circle',
      maskOpacityPercent: 80,
      maskTransitionPercent: 70,
    }, { kind: 'replace', sourceAbsolutePath: replacementSource })).rejects.toThrow('index write failed')

    expect((await store.get(created.record.id)).record.background).toEqual(original.background)
    expect(await store.resolveBackgroundImagePath(created.record.id)).toBe(originalPath)
    await expect(readdir(stickyNotePaths(root, original).resources))
      .resolves.toEqual([path.basename(original.background.imageRelativePath!)])
  })

  it('only removes the old image after persisting a null managed path', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: 'Atomic remove' })
    const source = path.join(root, 'background.png')
    await writeFile(source, 'background image', 'utf8')
    const withImage = await store.applyBackground(created.record.id, DEFAULT_BACKGROUND_SETTINGS, {
      kind: 'replace', sourceAbsolutePath: source,
    })
    const oldPath = await store.resolveBackgroundImagePath(created.record.id)

    const removed = await store.applyBackground(created.record.id, {
      ...DEFAULT_BACKGROUND_SETTINGS,
      imageRelativePath: 'resources/caller-controlled.png',
      imageOpacityPercent: 32,
      maskType: 'none',
      maskOpacityPercent: 0,
      maskTransitionPercent: 50,
    }, { kind: 'remove' })

    expect(removed.background).toEqual({
      imageRelativePath: null,
      imageOpacityPercent: 32,
      imageAlignment: DEFAULT_BACKGROUND_SETTINGS.imageAlignment,
      maskType: 'none',
      maskOpacityPercent: 0,
      maskTransitionPercent: 50,
      maskStrengthPercent: DEFAULT_BACKGROUND_SETTINGS.maskStrengthPercent,
    })
    await expect(stat(oldPath!)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await store.get(withImage.id)).record.background).toEqual(removed.background)
  })

  it('keeps its existing managed image path while applying updated controls', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: 'Atomic keep' })
    const source = path.join(root, 'background.png')
    await writeFile(source, 'background image', 'utf8')
    const withImage = await store.applyBackground(created.record.id, DEFAULT_BACKGROUND_SETTINGS, {
      kind: 'replace', sourceAbsolutePath: source,
    })

    const kept = await store.applyBackground(created.record.id, {
      ...DEFAULT_BACKGROUND_SETTINGS,
      imageRelativePath: 'resources/caller-controlled.png',
      imageOpacityPercent: 32,
      maskType: 'column-vertical',
      maskOpacityPercent: 40,
      maskTransitionPercent: 60,
    }, { kind: 'keep' })

    expect(kept.background).toEqual({
      imageRelativePath: withImage.background.imageRelativePath,
      imageOpacityPercent: 32,
      imageAlignment: DEFAULT_BACKGROUND_SETTINGS.imageAlignment,
      maskType: 'column-vertical',
      maskOpacityPercent: 40,
      maskTransitionPercent: 60,
      maskStrengthPercent: DEFAULT_BACKGROUND_SETTINGS.maskStrengthPercent,
    })
    const keptPath = await store.resolveBackgroundImagePath(created.record.id)
    expect(keptPath).not.toBeNull()
    await expect(readFile(keptPath!, 'utf8'))
      .resolves.toBe('background image')
  })

  it('enforces the 35 active-note limit without counting the create tile', async () => {
    const store = createStore()
    await store.initialize()
    for (let index = 1; index < MAX_ACTIVE_STICKY_NOTES; index += 1) {
      await store.create({ name: `便签-${index}` })
    }

    await expect(store.create({ name: '第 36 个便签' }))
      .rejects.toThrow('便签盒子已满')
    await expect(store.list('active')).resolves.toHaveLength(MAX_ACTIVE_STICKY_NOTES)
  })

  it('archives and restores the entire note while clearing desktop state', async () => {
    const store = createStore()
    await store.initialize()
    const created = await store.create({ name: '待归档', markdown: '# 保留内容' })
    await store.updateRecord(created.record.id, (record) => ({
      ...record,
      released: true,
      pinned: true,
      windowBounds: { x: 20, y: 30, width: 320, height: 320 },
      lastOpenedAt: NOW.toISOString(),
    }))
    const activePaths = stickyNotePaths(root, (await store.get(created.record.id)).record)
    await writeFile(path.join(activePaths.resources, 'image.png'), 'asset', 'utf8')

    const archived = await store.archive(created.record.id)
    const archivedPaths = stickyNotePaths(root, archived.record)

    expect(archived.record).toMatchObject({
      status: 'archived',
      released: false,
      pinned: false,
      archivedAt: NOW.toISOString(),
    })
    await expect(stat(activePaths.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(archivedPaths.markdown, 'utf8')).resolves.toBe('# 保留内容')
    await expect(readFile(path.join(archivedPaths.resources, 'image.png'), 'utf8'))
      .resolves.toBe('asset')

    const restored = await store.restore(created.record.id)
    expect(restored.record).toMatchObject({
      status: 'active',
      released: false,
      pinned: false,
      archivedAt: null,
    })
    await expect(readFile(stickyNotePaths(root, restored.record).markdown, 'utf8'))
      .resolves.toBe('# 保留内容')
  })

  it('blocks restore when all 35 active slots are occupied', async () => {
    const store = createStore()
    await store.initialize()
    const archivedCandidate = await store.create({ name: '归档项' })
    await store.archive(archivedCandidate.record.id)
    for (let index = 1; index < MAX_ACTIVE_STICKY_NOTES; index += 1) {
      await store.create({ name: `活跃项-${index}` })
    }

    await expect(store.restore(archivedCandidate.record.id))
      .rejects.toThrow('便签盒子已满')
    expect((await store.get(archivedCandidate.record.id)).record.status).toBe('archived')
  })

  it('deletes only the selected note and its resources', async () => {
    const store = createStore()
    await store.initialize()
    const selected = await store.create({ name: '删除我', markdown: 'selected' })
    const retained = await store.create({ name: '保留我', markdown: 'retained' })
    const selectedPaths = stickyNotePaths(root, selected.record)
    await mkdir(selectedPaths.resources, { recursive: true })
    await writeFile(path.join(selectedPaths.resources, 'asset.png'), 'asset', 'utf8')

    await store.delete(selected.record.id)

    await expect(stat(selectedPaths.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(store.get(selected.record.id)).rejects.toThrow('便签不存在')
    await expect(store.get(retained.record.id)).resolves.toMatchObject({ markdown: 'retained' })
  })

  it('deletes an archived batch with one index write', async () => {
    const atomicWrite = vi.fn(async (filePath: string, contents: string) => {
      await writeFile(filePath, contents, 'utf8')
    })
    const store = new StickyNoteStore({
      root,
      now: () => new Date(NOW),
      createId: nextId,
      atomicWrite,
    })
    await store.initialize()
    const first = await store.create({ name: 'Archived batch A', markdown: 'A' })
    const second = await store.create({ name: 'Archived batch B', markdown: 'B' })
    const archivedFirst = await store.archive(first.record.id)
    const archivedSecond = await store.archive(second.record.id)
    atomicWrite.mockClear()

    await store.deleteArchived([first.record.id, second.record.id])

    expect(atomicWrite).toHaveBeenCalledTimes(1)
    await expect(store.list('archived')).resolves.toEqual([])
    await expect(stat(stickyNotePaths(root, archivedFirst.record).directory))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(stickyNotePaths(root, archivedSecond.record).directory))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists only active notes in the last desktop session', async () => {
    const store = createStore()
    await store.initialize()
    const released = await store.create({ name: 'Released note' })
    const ordinary = await store.create({ name: 'Ordinary note' })
    await store.updateRecord(released.record.id, (record) => ({
      ...record,
      released: true,
    }))

    await store.writeOpenNoteIds([
      released.record.id,
      ordinary.record.id,
      released.record.id,
    ])

    await expect(store.readOpenNoteIds()).resolves.toEqual([
      released.record.id,
      ordinary.record.id,
    ])
  })


  it('persists the complete active-note order without changing archive order', async () => {
    const store = createStore()
    await store.initialize()
    const first = await store.create({ name: 'First' })
    const archived = await store.create({ name: 'Archived' })
    const second = await store.create({ name: 'Second' })
    await store.archive(archived.record.id)
    const helpId = (await store.list('active'))
      .find(({ record }) => record.id !== first.record.id && record.id !== second.record.id)!
      .record.id

    await store.reorderActiveNotes([second.record.id, first.record.id, helpId])

    await expect(store.list('active')).resolves.toMatchObject([
      { record: { id: second.record.id } },
      { record: { id: first.record.id } },
      { record: { id: helpId } },
    ])
    await expect(store.list('archived')).resolves.toMatchObject([
      { record: { id: archived.record.id } },
    ])

    const reloaded = createStore()
    await expect(reloaded.list('active')).resolves.toMatchObject([
      { record: { id: second.record.id } },
      { record: { id: first.record.id } },
      { record: { id: helpId } },
    ])
  })

  it('rejects incomplete, duplicate, archived, and unknown active-note orders', async () => {
    const store = createStore()
    await store.initialize()
    const archived = await store.create({ name: 'Archived' })
    await store.archive(archived.record.id)
    const activeIds = (await store.list('active')).map(({ record }) => record.id)

    await expect(store.reorderActiveNotes(activeIds.slice(1))).rejects.toThrow('order')
    await expect(store.reorderActiveNotes([activeIds[0], activeIds[0]]))
      .rejects.toThrow('order')
    await expect(store.reorderActiveNotes([...activeIds.slice(0, -1), archived.record.id]))
      .rejects.toThrow('order')
    await expect(store.reorderActiveNotes([
      ...activeIds.slice(0, -1),
      '00000000-0000-4000-8000-ffffffffffff',
    ])).rejects.toThrow('order')
  })
})
