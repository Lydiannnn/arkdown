import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveDataRoot } from '../../src/main/settings/portable-paths'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

it('uses portable-data beside the packaged executable when writable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-paths-'))
  roots.push(root)

  const result = await resolveDataRoot({
    executablePath: path.join(root, 'Arkdown.exe'),
    fallbackUserDataPath: path.join(root, 'fallback'),
    isPackaged: true,
  })

  expect(result).toEqual({ path: path.join(root, 'portable-data'), portable: true })
})

it('falls back to the user-data path when the portable location is not writable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-paths-'))
  roots.push(root)
  const blockedParent = path.join(root, 'not-a-directory')
  await writeFile(blockedParent, 'file', 'utf8')

  const result = await resolveDataRoot({
    executablePath: path.join(blockedParent, 'Arkdown.exe'),
    fallbackUserDataPath: path.join(root, 'fallback'),
    isPackaged: true,
  })

  expect(result).toEqual({ path: path.join(root, 'fallback'), portable: false })
})
