import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath, rename, statfs, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type { UpdateArtifact } from './update-protocol'

export function updateArtifactKey(a: UpdateArtifact): string {
  return createHash('sha256').update(JSON.stringify([a.version, a.channel, a.edition, a.kind, a.bytes, a.sha256])).digest('hex')
}
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
export async function ensureUpdateDirectory(target: string): Promise<void> {
  const parent = path.dirname(target)
  if (parent !== target) await ensureUpdateDirectory(parent)
  try { await lstat(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try { await mkdir(target) } catch (creation) { if ((creation as NodeJS.ErrnoException).code !== 'EEXIST') throw creation }
  }
  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(target), path.resolve(target))) throw new Error('更新缓存路径不安全，已停止操作。')
}
export async function openUpdateFile(file: string): Promise<FileHandle> {
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('更新文件不安全，已停止操作。')
  const handle = await open(file, 'r')
  const after = await handle.stat()
  if (after.ino !== before.ino || after.dev !== before.dev || !after.isFile() || after.nlink !== 1) {
    await handle.close(); throw new Error('更新文件已改变，请重新下载。')
  }
  return handle
}
export async function verifyUpdateFile(file: string, artifact: UpdateArtifact, signal?: AbortSignal): Promise<boolean> {
  const handle = await openUpdateFile(file)
  try {
    const before = await handle.stat()
    if (before.size !== artifact.bytes) return false
    const digest = createHash('sha256'), buffer = Buffer.alloc(256 * 1024)
    let offset = 0
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) break
      offset += bytesRead
      if (offset > artifact.bytes) return false
      digest.update(buffer.subarray(0, bytesRead))
    }
    const after = await handle.stat()
    const current = await lstat(file)
    return offset === artifact.bytes && digest.digest('hex') === artifact.sha256
      && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
      && current.ino === after.ino && current.dev === after.dev && !current.isSymbolicLink() && current.nlink === 1
  } finally { await handle.close() }
}
export class UpdateCache {
  readonly root: string
  constructor(root: string) { this.root = path.resolve(root) }
  file(artifact: UpdateArtifact): string { return path.join(this.root, `${updateArtifactKey(artifact)}.${artifact.kind === 'installer' ? 'exe' : 'zip'}`) }
  async getVerified(artifact: UpdateArtifact, signal?: AbortSignal): Promise<string | undefined> {
    await ensureUpdateDirectory(this.root)
    try { return await verifyUpdateFile(this.file(artifact), artifact, signal) ? this.file(artifact) : undefined }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async createPartial(artifact: UpdateArtifact): Promise<{ file: string; handle: FileHandle }> {
    await ensureUpdateDirectory(this.root)
    const space = await statfs(this.root)
    if (space.bavail * space.bsize < artifact.bytes + 64 * 1024 ** 2) throw new Error('下载所需磁盘空间不足，请释放空间后重试。')
    const file = path.join(this.root, `${updateArtifactKey(artifact)}-${randomUUID()}.part`)
    return { file, handle: await open(file, 'wx', 0o600) }
  }
  async promote(file: string, artifact: UpdateArtifact, signal: AbortSignal): Promise<string> {
    if (path.dirname(file) !== this.root || !/^[a-f0-9]{64}-[a-f0-9-]{36}\.part$/.test(path.basename(file))) throw new Error('Invalid partial update')
    await ensureUpdateDirectory(this.root)
    if (!await verifyUpdateFile(file, artifact, signal)) throw new Error('更新包校验失败，请重新下载。')
    signal.throwIfAborted()
    try { const existing = await openUpdateFile(this.file(artifact)); await existing.close() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rename(file, this.file(artifact))
    return this.file(artifact)
  }
  async removePartial(file: string): Promise<void> {
    if (path.dirname(file) !== this.root || !/^[a-f0-9]{64}-[a-f0-9-]{36}\.part$/.test(path.basename(file))) throw new Error('Invalid partial update')
    await ensureUpdateDirectory(this.root)
    try { const handle = await openUpdateFile(file); await handle.close(); await unlink(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
