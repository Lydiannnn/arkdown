import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { draftPaths, resolveTempRoot } from '../../src/main/drafts/draft-paths'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveTempRoot', () => {
  it('uses temp beside the portable executable directory when packaged', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-draft-paths-'))
    roots.push(root)
    const portableDirectory = path.join(root, 'portable')

    await expect(resolveTempRoot({
      portableExecutableDirectory: portableDirectory,
      executablePath: path.join(root, 'runtime', 'Arkdown.exe'),
      fallbackUserDataPath: path.join(root, 'fallback'),
      isPackaged: true,
    })).resolves.toEqual({
      path: path.join(portableDirectory, 'temp'),
      portable: true,
    })
  })

  it('uses the development data directory while unpackaged', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-draft-paths-'))
    roots.push(root)

    await expect(resolveTempRoot({
      executablePath: path.join(root, 'runtime', 'electron.exe'),
      fallbackUserDataPath: path.join(root, 'fallback'),
      isPackaged: false,
      developmentRoot: root,
    })).resolves.toEqual({
      path: path.join(root, '.arkdown-dev-data', 'temp'),
      portable: true,
    })
  })

  it('falls back to userData temp when the portable directory cannot be created', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-draft-paths-'))
    roots.push(root)
    const blocked = path.join(root, 'blocked')
    await writeFile(blocked, 'not a directory', 'utf8')

    await expect(resolveTempRoot({
      portableExecutableDirectory: blocked,
      executablePath: path.join(root, 'runtime', 'Arkdown.exe'),
      fallbackUserDataPath: path.join(root, 'fallback'),
      isPackaged: true,
    })).resolves.toEqual({
      path: path.join(root, 'fallback', 'temp'),
      portable: false,
    })
  })
})

describe('draftPaths', () => {
  it('returns fixed draft and asset children for a lowercase UUID', () => {
    const result = draftPaths('C:\\Arkdown\\temp', '123e4567-e89b-42d3-a456-426614174000')

    expect(result.draftDirectory).toBe(path.join(
      'C:\\Arkdown\\temp',
      'drafts',
      '123e4567-e89b-42d3-a456-426614174000',
    ))
    expect(result.bodyPath).toBe(path.join(result.draftDirectory, 'body.md'))
    expect(result.manifestPath).toBe(path.join(result.draftDirectory, 'manifest.json'))
    expect(result.assetDirectory).toBe(path.join(
      'C:\\Arkdown\\temp',
      'assets',
      '123e4567-e89b-42d3-a456-426614174000',
    ))
  })

  it.each([
    '123E4567-E89B-42D3-A456-426614174000',
    '../escape',
    'not-a-uuid',
  ])('rejects unsafe draft id %s', (draftId) => {
    expect(() => draftPaths('C:\\Arkdown\\temp', draftId)).toThrow('Invalid draft id')
  })
})
