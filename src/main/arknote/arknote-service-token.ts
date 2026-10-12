import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const TOKEN_PATTERN = /^[a-f0-9]{64}$/u

export async function loadOrCreateArknoteServiceToken(filePath: string): Promise<string> {
  try {
    const existing = (await readFile(filePath, 'utf8')).trim()
    if (TOKEN_PATTERN.test(existing)) return existing
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const token = randomBytes(32).toString('hex')
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  return token
}
