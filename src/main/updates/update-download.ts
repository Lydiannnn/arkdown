import { createHash } from 'node:crypto'
import { isUpdateArtifactUrl, type UpdateArtifact } from './update-protocol'
import type { UpdateTransport } from './update-http'
import { UpdateCache, updateArtifactKey } from './update-cache'
export interface DownloadProgress { phase: 'downloading' | 'verifying' | 'ready'; received: number; total: number }
export class UpdateDownloadManager {
  private active?: { key: string; controller: AbortController; promise: Promise<string> }
  constructor(readonly cache: UpdateCache, readonly transport: UpdateTransport = (url, init) => fetch(url, init), readonly onProgress?: (state: DownloadProgress) => void) {}
  start(artifact: UpdateArtifact): Promise<string> {
    const key = updateArtifactKey(artifact)
    if (this.active) return this.active.key === key ? this.active.promise : Promise.reject(new Error('另一个更新下载尚未结束。'))
    const controller = new AbortController()
    const promise = this.run(structuredClone(artifact), controller).finally(() => { if (this.active?.controller === controller) this.active = undefined })
    this.active = { key, controller, promise }
    return promise
  }
  async cancel(): Promise<void> { const pending = this.active; if (pending) { pending.controller.abort(); await pending.promise.catch(() => {}) } }
  private report(state: DownloadProgress) { try { this.onProgress?.(state) } catch { /* A display observer cannot own a download. */ } }
  private async run(artifact: UpdateArtifact, controller: AbortController): Promise<string> {
    if (!isUpdateArtifactUrl(artifact.url) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 32 * 1024 ** 3
      || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('更新包来源或校验信息无效。')
    const signal = controller.signal, total = artifact.bytes
    const cached = await this.cache.getVerified(artifact, signal)
    signal.throwIfAborted()
    if (cached) { this.report({ phase: 'ready', received: total, total }); return cached }
    let partial: Awaited<ReturnType<UpdateCache['createPartial']>> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let timedOut = false
    const timeout = () => { timedOut = true; controller.abort() }
    let timer = setTimeout(timeout, 30_000); timer.unref?.()
    const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(timeout, 30_000); timer.unref?.() }
    const cancelReader = () => { void reader?.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancelReader, { once: true })
    try {
      let url = artifact.url, response: Response | undefined
      const visited = new Set<string>()
      for (let redirects = 0; redirects <= 5; redirects++) {
        signal.throwIfAborted()
        if (visited.has(url)) throw new Error('更新下载地址发生循环跳转，请稍后重试。')
        visited.add(url)
        response = await this.transport(url, { signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
          headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' } })
        signal.throwIfAborted()
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || redirects === 5) throw new Error('更新下载跳转无效，请稍后重试。')
        const next = new URL(location, url)
        const assetRedirect = new URL(url).hostname === 'github.com' && next.hostname === 'release-assets.githubusercontent.com'
          && next.protocol === 'https:' && !next.port && !next.username && !next.password && !next.hash
          && next.pathname.startsWith('/github-production-release-asset/')
        if (!isUpdateArtifactUrl(next.href) && !assetRedirect) throw new Error('更新下载被重定向到不受信任的地址，已停止下载。')
        url = next.href; resetTimeout()
      }
      if (!response || response.status !== 200 || !response.body) throw new Error(`更新下载失败（HTTP ${response?.status ?? 0}），请检查网络后重试。`)
      const declared = response.headers.get('content-length'), encoding = response.headers.get('content-encoding')
      if (encoding && encoding !== 'identity' || declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== total)) {
        await response.body.cancel(); throw new Error('更新包大小与发布信息不一致，请稍后重试。')
      }
      partial = await this.cache.createPartial(artifact)
      signal.throwIfAborted(); reader = response.body.getReader()
      const digest = createHash('sha256'); let received = 0
      this.report({ phase: 'downloading', received, total })
      for (;;) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) break
        resetTimeout(); received += chunk.value.byteLength
        if (received > total) throw new Error('更新包大小与发布信息不一致，请重新下载。')
        let offset = 0
        while (offset < chunk.value.byteLength) {
          const { bytesWritten } = await partial.handle.write(chunk.value, offset, chunk.value.byteLength - offset)
          if (!bytesWritten) throw new Error('更新包写入失败，请检查磁盘空间及权限。')
          offset += bytesWritten; signal.throwIfAborted()
        }
        digest.update(chunk.value); this.report({ phase: 'downloading', received, total })
      }
      clearTimeout(timer)
      this.report({ phase: 'verifying', received, total })
      if (received !== total || digest.digest('hex') !== artifact.sha256) throw new Error('更新包校验失败，请重新下载。')
      await partial.handle.sync(); await partial.handle.close()
      const file = await this.cache.promote(partial.file, artifact, signal)
      signal.throwIfAborted(); this.report({ phase: 'ready', received, total }); return file
    } catch (error) {
      if (timedOut) throw new Error('更新下载长时间没有响应，请检查网络后重试。')
      if (signal.aborted) throw new Error('更新下载已取消。')
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOSPC') throw new Error('下载所需磁盘空间不足，请释放空间后重试。')
      if (code === 'EACCES' || code === 'EPERM') throw new Error('无法写入更新缓存，请检查目录权限或安全软件拦截。')
      throw error
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancelReader)
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock() }
      if (partial) { await partial.handle.close().catch(() => {}); await this.cache.removePartial(partial.file) }
    }
  }
}
