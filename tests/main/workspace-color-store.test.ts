import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_COLOR_IDS,
  canonicalWorkspaceColorPath,
  parseWorkspaceColorFile,
  parseWorkspaceColorMarksSnapshot,
} from '../../src/shared/workspace-color-marks'
import { WorkspaceColorStore } from '../../src/main/workspace/workspace-color-store'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-color-workspace-'))
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'arkdown-color-data-'))
  roots.push(root, dataRoot)
  await mkdir(path.join(root, 'Notes'))
  await writeFile(path.join(root, 'Notes', 'First.md'), '# First')
  return { root, dataRoot, store: new WorkspaceColorStore(dataRoot) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspace color mark protocol', () => {
  it('uses exactly the first seven approved theme colors', () => {
    expect(WORKSPACE_COLOR_IDS).toEqual([
      '#C62828', '#800080', '#2563EB', '#007C91', '#18864B', '#C66A00', '#B83280',
    ])
  })

  it('normalizes safe relative paths and rejects traversal or absolute paths', () => {
    expect(canonicalWorkspaceColorPath('Notes\\First.md')).toBe('notes/first.md')
    expect(canonicalWorkspaceColorPath('Notes//First.md')).toBe('notes/first.md')
    for (const value of ['', '../outside', 'notes/../outside', 'C:\\outside', '/outside', '\\\\server\\share']) {
      expect(canonicalWorkspaceColorPath(value)).toBeUndefined()
    }
  })

  it('strictly parses bounded color files', () => {
    expect(parseWorkspaceColorFile({
      schemaVersion: 1,
      workspaceKey: 'c:\\workspace',
      marks: { 'notes/first.md': '#2563EB' },
    })).toEqual({
      schemaVersion: 1,
      workspaceKey: 'c:\\workspace',
      marks: { 'notes/first.md': '#2563EB' },
    })
    expect(parseWorkspaceColorFile({
      schemaVersion: 1,
      workspaceKey: 'c:\\workspace',
      marks: { 'notes/first.md': '#5F6368' },
    })).toEqual({
      schemaVersion: 1,
      workspaceKey: 'c:\\workspace',
      marks: {},
    })
    expect(parseWorkspaceColorFile({
      schemaVersion: 1,
      workspaceKey: 'c:\\workspace',
      marks: Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`${index}.md`, '#2563EB'])),
    })).toBeUndefined()
  })

  it('keeps valid marks when individual persisted or snapshot entries are invalid', () => {
    const marks = {
      'notes/first.md': '#2563EB',
      '../outside.md': '#18864B',
      'notes/invalid-color.md': '#5F6368',
      'Notes/NonCanonical.md': '#C62828',
    }
    expect(parseWorkspaceColorFile({
      schemaVersion: 1,
      workspaceKey: 'c:\\workspace',
      marks,
    })?.marks).toEqual({ 'notes/first.md': '#2563EB' })
    expect(parseWorkspaceColorMarksSnapshot({ marks })?.marks).toEqual({
      'notes/first.md': '#2563EB',
    })
  })

  it('stores prototype-named paths as own mark entries without changing the container prototype', () => {
    const value = JSON.parse(`{
      "schemaVersion": 1,
      "workspaceKey": "c:\\\\workspace",
      "marks": {
        "__proto__": "#2563EB",
        "constructor": "#18864B",
        "prototype": "#C62828"
      }
    }`) as unknown
    const parsed = parseWorkspaceColorFile(value)

    expect(Object.getPrototypeOf(parsed?.marks)).toBeNull()
    expect(Object.keys(parsed?.marks ?? {})).toEqual([
      '__proto__', 'constructor', 'prototype',
    ])
    expect(Object.hasOwn(parsed?.marks ?? {}, '__proto__')).toBe(true)
    expect(parsed?.marks['__proto__']).toBe('#2563EB')
    expect(parsed?.marks.constructor).toBe('#18864B')
    expect(parsed?.marks.prototype).toBe('#C62828')
  })
})

describe('WorkspaceColorStore', () => {
  it('persists marks outside the workspace under a hashed file name', async () => {
    const { root, dataRoot, store } = await fixture()
    await store.set(root, 'Notes/First.md', '#2563EB')
    await expect(store.get(root)).resolves.toMatchObject({
      marks: { 'notes/first.md': '#2563EB' },
    })
    const colorRoot = path.join(dataRoot, 'workspace-color-marks')
    const names = await readdir(colorRoot)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^[0-9a-f]{64}\.json$/u)
    expect(names[0]).not.toContain(path.basename(root))
    expect(await readdir(root)).toEqual(['Notes'])

    const persisted = JSON.parse(await readFile(path.join(colorRoot, names[0]), 'utf8')) as unknown
    expect(parseWorkspaceColorFile(persisted)?.marks).toEqual({ 'notes/first.md': '#2563EB' })
  })

  it('deduplicates Windows-style path case and moves or deletes whole subtrees', async () => {
    const { root, store } = await fixture()
    await mkdir(path.join(root, 'Notes', 'Child'))
    await writeFile(path.join(root, 'Notes', 'Child', 'Second.md'), '# Second')
    await store.set(root, 'Notes/First.md', '#2563EB')
    await store.set(root, 'NOTES/first.MD', '#18864B')
    await store.set(root, 'Notes/Child/Second.md', '#C62828')
    await store.move(root, 'notes', 'Archive')
    expect((await store.get(root)).marks).toEqual({
      'archive/first.md': '#18864B',
      'archive/child/second.md': '#C62828',
    })
    await store.delete(root, 'archive/child')
    expect((await store.get(root)).marks).toEqual({ 'archive/first.md': '#18864B' })
  })

  it('rejects a junction or symlink that resolves outside the workspace', async () => {
    const { root, dataRoot, store } = await fixture()
    const outside = path.join(dataRoot, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'external.md'), '# External')
    const link = path.join(root, 'External')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.set(root, 'External/external.md', '#2563EB')).rejects.toThrow()
    expect((await store.get(root)).marks).toEqual({})
  })

  it.each(['__proto__', 'constructor'])(
    'does not let the inherited %s property bypass entry existence validation',
    async (relativePath) => {
      const { root, store } = await fixture()

      await expect(store.set(root, relativePath, '#2563EB')).rejects.toThrow()
      expect((await store.get(root)).marks).toEqual({})

      await writeFile(path.join(root, relativePath), 'real entry')
      await expect(store.set(root, relativePath, '#2563EB')).resolves.toMatchObject({
        marks: { [relativePath]: '#2563EB' },
      })
    },
  )

  it('fails closed on malformed or oversized persisted input', async () => {
    const { root, dataRoot, store } = await fixture()
    const target = store.filePathForWorkspace(root)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, '{not json')
    await expect(store.get(root)).resolves.toMatchObject({ marks: {} })
    await writeFile(target, 'x'.repeat(1_048_577))
    await expect(store.get(root)).resolves.toMatchObject({ marks: {} })
  })

  it('recovers valid persisted marks from a file containing invalid entries', async () => {
    const { root, store } = await fixture()
    const target = store.filePathForWorkspace(root)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify({
      schemaVersion: 1,
      workspaceKey: root.toLocaleLowerCase('en-US'),
      marks: {
        'notes/first.md': '#2563EB',
        '../outside.md': '#18864B',
        'notes/bad.md': '#5F6368',
      },
    }))

    await expect(store.get(root)).resolves.toMatchObject({
      marks: { 'notes/first.md': '#2563EB' },
    })
  })

  it('keeps the prior file when an atomic write fails', async () => {
    const { root, dataRoot } = await fixture()
    const normal = new WorkspaceColorStore(dataRoot)
    await normal.set(root, 'Notes/First.md', '#2563EB')
    const writeTextFileAtomic = vi.fn(async () => { throw new Error('disk full') })
    const failing = new WorkspaceColorStore(dataRoot, { writeTextFileAtomic })
    await expect(failing.set(root, 'Notes/First.md', '#18864B')).rejects.toThrow('disk full')
    expect((await normal.get(root)).marks).toEqual({ 'notes/first.md': '#2563EB' })
  })
})
