import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyPandocToPackages } from '../../scripts/package-pandoc'
import { editionComponents } from '../../scripts/package-editions'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('portable Pandoc packaging', () => {
  it('copies the bundled executable into every portable application directory', async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-pandoc-source-'))
    const firstPackage = await mkdtemp(path.join(tmpdir(), 'arkdown-pandoc-package-a-'))
    const secondPackage = await mkdtemp(path.join(tmpdir(), 'arkdown-pandoc-package-b-'))
    roots.push(projectRoot, firstPackage, secondPackage)
    await writeFile(path.join(projectRoot, 'pandoc.exe'), Buffer.from('pandoc-test-binary'))

    await copyPandocToPackages([firstPackage, secondPackage], projectRoot)

    await expect(readFile(path.join(firstPackage, 'pandoc', 'pandoc.exe')))
      .resolves.toEqual(Buffer.from('pandoc-test-binary'))
    await expect(readFile(path.join(secondPackage, 'pandoc', 'pandoc.exe')))
      .resolves.toEqual(Buffer.from('pandoc-test-binary'))
  })

  it('selects the pinned expanded Pandoc tree for Full edition packaging', () => {
    const component = editionComponents().find(value => value.id === 'pandoc')
    expect(component).toMatchObject({ id: 'pandoc', version: '3.10.1-r2', resourcePath: 'components/pandoc' })
    expect(component?.sourceRoot).toBe(path.resolve('.components/pandoc-3.10.1-r2/runtime'))
    expect(component?.treeManifestSha256).toMatch(/^[a-f0-9]{64}$/u)
  })
})
