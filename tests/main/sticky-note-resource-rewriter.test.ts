import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StickyNoteResourceRewriter } from '../../src/main/sticky-notes/sticky-note-resource-rewriter'

let root = ''
let sourceDirectory = ''
let resourcesDirectory = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arkdown-sticky-rewrite-'))
  sourceDirectory = path.join(root, 'source')
  resourcesDirectory = path.join(root, 'note', 'resources')
  await mkdir(path.join(sourceDirectory, 'images'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('StickyNoteResourceRewriter', () => {
  it('copies relative and absolute Markdown images without modifying their sources', async () => {
    const relativeSource = path.join(sourceDirectory, 'images', 'photo.png')
    const absoluteSource = path.join(sourceDirectory, 'cover.jpg')
    await writeFile(relativeSource, Buffer.from([1, 2, 3]))
    await writeFile(absoluteSource, Buffer.from([4, 5, 6]))
    const relativeBefore = await stat(relativeSource)
    const absoluteBefore = await stat(absoluteSource)

    const result = await new StickyNoteResourceRewriter().rewrite({
      markdown: [
        '![相对图片](images/photo.png)',
        `![绝对图片](<${absoluteSource}>)`,
      ].join('\n'),
      sourceDirectory,
      resourcesDirectory,
    })

    expect(result.warnings).toEqual([])
    expect(result.markdown).toBe([
      '![相对图片](resources/photo.png)',
      '![绝对图片](<resources/cover.jpg>)',
    ].join('\n'))
    await expect(readFile(path.join(resourcesDirectory, 'photo.png')))
      .resolves.toEqual(Buffer.from([1, 2, 3]))
    await expect(readFile(path.join(resourcesDirectory, 'cover.jpg')))
      .resolves.toEqual(Buffer.from([4, 5, 6]))
    expect((await stat(relativeSource)).mtimeMs).toBe(relativeBefore.mtimeMs)
    expect((await stat(absoluteSource)).mtimeMs).toBe(absoluteBefore.mtimeMs)
  })

  it('rewrites file URLs and supported Arkdown local-media HTML while preserving attributes', async () => {
    const fileUrlImage = path.join(sourceDirectory, 'url image.png')
    const htmlImage = path.join(sourceDirectory, 'html.png')
    const audio = path.join(sourceDirectory, 'clip.mp3')
    const video = path.join(sourceDirectory, 'clip.mp4')
    await Promise.all([
      writeFile(fileUrlImage, 'url-image'),
      writeFile(htmlImage, 'html-image'),
      writeFile(audio, 'audio'),
      writeFile(video, 'video'),
    ])

    const result = await new StickyNoteResourceRewriter().rewrite({
      markdown: [
        `![URL](<${pathToFileURL(fileUrlImage).href}>)`,
        `<img src="${htmlImage}" alt="照片" style="zoom:80%;display:block;" />`,
        `<audio src="${audio}"></audio>`,
        `<video src="${video}" controls=""></video>`,
      ].join('\n'),
      sourceDirectory,
      resourcesDirectory,
    })

    expect(result.warnings).toEqual([])
    expect(result.markdown).toContain('![URL](<resources/url image.png>)')
    expect(result.markdown).toContain(
      '<img src="resources/html.png" alt="照片" style="zoom:80%;display:block;" />',
    )
    expect(result.markdown).toContain('<audio src="resources/clip.mp3"></audio>')
    expect(result.markdown).toContain('<video src="resources/clip.mp4" controls=""></video>')
  })

  it('leaves remote, data and code references unchanged', async () => {
    const markdown = [
      '![remote](https://example.com/photo.png)',
      '![data](data:image/png;base64,AAAA)',
      '`![inline](images/photo.png)`',
      '```md',
      '![fenced](images/photo.png)',
      '```',
    ].join('\n')

    const result = await new StickyNoteResourceRewriter().rewrite({
      markdown,
      sourceDirectory,
      resourcesDirectory,
    })

    expect(result).toMatchObject({ markdown, warnings: [], copiedResources: [] })
  })

  it('deduplicates matching bytes and separates colliding names with different bytes', async () => {
    const first = path.join(sourceDirectory, 'one', 'same.png')
    const duplicate = path.join(sourceDirectory, 'two', 'duplicate.png')
    const collision = path.join(sourceDirectory, 'three', 'same.png')
    await Promise.all([
      mkdir(path.dirname(first), { recursive: true }),
      mkdir(path.dirname(duplicate), { recursive: true }),
      mkdir(path.dirname(collision), { recursive: true }),
    ])
    await Promise.all([
      writeFile(first, 'identical'),
      writeFile(duplicate, 'identical'),
      writeFile(collision, 'different'),
    ])

    const result = await new StickyNoteResourceRewriter().rewrite({
      markdown: [
        `![一](<${first}>)`,
        `![重复](<${duplicate}>)`,
        `![冲突](<${collision}>)`,
      ].join('\n'),
      sourceDirectory,
      resourcesDirectory,
    })

    expect(result.markdown).toBe([
      '![一](<resources/same.png>)',
      '![重复](<resources/same.png>)',
      '![冲突](<resources/same-2.png>)',
    ].join('\n'))
    expect(result.copiedResources.map(({ relativePath }) => relativePath))
      .toEqual(['resources/same.png', 'resources/same-2.png'])
  })

  it('reports missing and unsupported local resources without blocking the rewrite', async () => {
    const result = await new StickyNoteResourceRewriter().rewrite({
      markdown: [
        '![缺失](images/missing.png)',
        '![不支持](files/archive.zip)',
        '正文',
      ].join('\n'),
      sourceDirectory,
      resourcesDirectory,
    })

    expect(result.markdown).toContain('![缺失](images/missing.png)')
    expect(result.markdown).toContain('![不支持](files/archive.zip)')
    expect(result.warnings).toEqual([
      { source: path.join(sourceDirectory, 'images', 'missing.png'), reason: 'missing' },
      { source: path.join(sourceDirectory, 'files', 'archive.zip'), reason: 'unsupported' },
    ])
  })
})
