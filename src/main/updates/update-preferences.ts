import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { parseUpdateVersion } from '../../shared/app-update'
import { ensureUpdateDirectory, openUpdateFile } from './update-cache'

/** Scoped by installation directory and channel at the composition root. No user document paths. */
export class UpdatePreferences {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly directory: string) {}
  async readSkippedVersion(): Promise<string | null> {
    try {
      const handle = await openUpdateFile(path.join(this.directory, 'skip.json'))
      try {
        if ((await handle.stat()).size > 4096) return null
        const buffer = Buffer.alloc(4097), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        if (bytesRead > 4096) return null
        const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, ''))
        return value?.schemaVersion === 1 && Object.keys(value).length === 2 && parseUpdateVersion(value.version) ? value.version : null
      } finally { await handle.close() }
    } catch { return null }
  }
  skipVersion(version: string): Promise<void> {
    if (!parseUpdateVersion(version)) return Promise.reject(new Error('Invalid update version'))
    const operation = this.tail.then(async () => {
      await ensureUpdateDirectory(this.directory)
      const target = path.join(this.directory, 'skip.json')
      try { const existing = await openUpdateFile(target); await existing.close() }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await writeFileAtomic(target, JSON.stringify({ schemaVersion: 1, version }) + '\n', { encoding: 'utf8', mode: 0o600 })
    })
    this.tail = operation.catch(() => {}); return operation
  }
}
