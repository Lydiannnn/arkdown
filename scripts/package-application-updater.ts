import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ApplicationUpdaterArtifact } from './build-application-updater'
export async function packageApplicationUpdater(roots: string[], artifact: ApplicationUpdaterArtifact): Promise<void> {
  const bytes = Buffer.from(artifact.bytes)
  if (bytes.length !== artifact.trust.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.trust.sha256) throw new Error('Update helper snapshot changed')
  for (const root of roots) {
    const directory = path.join(root, 'resources/application-updater')
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'Arkdown.Update.exe'), bytes, { flag: 'wx' })
  }
}
