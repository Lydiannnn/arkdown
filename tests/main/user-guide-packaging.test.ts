import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyUserGuideToPackages } from '../../scripts/package-user-guide'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })))
})

describe('portable user-guide packaging', () => {
  it('copies the entry and clean asset directory to every package output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arkdown-guide-package-'))
    temporaryRoots.push(root)
    const guideRoot = join(root, 'guide')
    const packageA = join(root, 'package-a')
    const packageB = join(root, 'package-b')

    await mkdir(join(guideRoot, '使用说明书', 'assets'), { recursive: true })
    await writeFile(join(guideRoot, '使用说明书.html'), '<!doctype html>', 'utf8')
    await writeFile(join(guideRoot, '使用说明书', 'index.html'), '<h1>Guide</h1>', 'utf8')
    await writeFile(join(guideRoot, '使用说明书', 'guide.css'), 'body{}', 'utf8')
    await writeFile(join(guideRoot, '使用说明书', 'guide.js'), 'void 0', 'utf8')
    await writeFile(join(guideRoot, '使用说明书', 'search-index.js'), 'window.guideIndex=[]', 'utf8')
    await writeFile(join(guideRoot, '使用说明书', 'assets', 'editor.png'), 'image', 'utf8')
    await mkdir(join(packageA, '使用说明书'), { recursive: true })
    await writeFile(join(packageA, '使用说明书', 'stale.html'), 'stale', 'utf8')
    await mkdir(packageB, { recursive: true })

    await copyUserGuideToPackages([packageA, packageB], guideRoot)

    expect(await readFile(join(packageA, '使用说明书.html'), 'utf8')).toContain('<!doctype html>')
    expect(await readFile(join(packageB, '使用说明书', 'index.html'), 'utf8')).toBe('<h1>Guide</h1>')
    expect(await readFile(join(packageB, '使用说明书', 'guide.css'), 'utf8')).toBe('body{}')
    expect(await readFile(join(packageB, '使用说明书', 'assets', 'editor.png'), 'utf8')).toBe('image')
    await expect(stat(join(packageA, '使用说明书', 'stale.html'))).rejects.toThrow()
  })

  it('fails clearly when the built guide is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'arkdown-guide-missing-'))
    temporaryRoots.push(root)
    const output = join(root, 'package')
    await mkdir(output)

    await expect(copyUserGuideToPackages([output], join(root, 'missing')))
      .rejects.toThrow(/built user guide is missing/i)
  })

  it('connects the copy helper to the Electron Forge postPackage hook', async () => {
    const config = await readFile('forge.config.ts', 'utf8')

    expect(config).toContain('postPackage')
    expect(config).toContain('copyUserGuideToPackages')
  })
})
