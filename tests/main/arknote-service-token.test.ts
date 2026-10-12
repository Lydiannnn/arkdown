import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadOrCreateArknoteServiceToken } from '../../src/main/arknote/arknote-service-token'

const roots: string[] = []

async function tokenPath(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'arknote-token-test-'))
  roots.push(root)
  return path.join(root, 'nested', 'service-token')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('Arknote service token', () => {
  it('creates and reuses one 256-bit token', async () => {
    const filePath = await tokenPath()
    const created = await loadOrCreateArknoteServiceToken(filePath)
    const reused = await loadOrCreateArknoteServiceToken(filePath)

    expect(created).toMatch(/^[a-f0-9]{64}$/u)
    expect(reused).toBe(created)
    expect((await readFile(filePath, 'utf8')).trim()).toBe(created)
  })

  it('replaces a malformed token instead of accepting weak authentication', async () => {
    const filePath = await tokenPath()
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'short-token\n', { encoding: 'utf8', mode: 0o600 })
    await chmod(filePath, 0o600)

    const token = await loadOrCreateArknoteServiceToken(filePath)

    expect(token).toMatch(/^[a-f0-9]{64}$/u)
    expect(token).not.toBe('short-token')
  })
})
