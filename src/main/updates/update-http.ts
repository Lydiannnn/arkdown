import { APP_UPDATE_WEBSITE, isUpdateUuid, type UpdateIdentity } from '../../shared/app-update'
import { parseUpdateDecision, type UpdateDecision } from './update-protocol'

export type UpdateTransport = (url: string, init: RequestInit) => Promise<Response>
export interface BoundedUpdateResponse { status: number; json?: unknown }

/** Internal transport only: the composition root supplies fixed production URLs, never IPC input. */
export async function requestBoundedUpdateJson(url: string, init: RequestInit, signal: AbortSignal,
  transport: UpdateTransport = (url, options) => fetch(url, options)): Promise<BoundedUpdateResponse | undefined> {
  if (signal.aborted) return undefined
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 8000)
  timer.unref?.()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const response = await transport(url, { ...init, signal: controller.signal, credentials: 'omit',
      redirect: 'manual', cache: 'no-store', headers: { Accept: 'application/json', ...init.headers } })
    if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); return undefined }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined)
      return { status: response.status }
    }
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 131072)) {
      void response.body?.cancel().catch(() => undefined); return undefined
    }
    if (!response.body) return undefined
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []; let size = 0
    while (true) {
      const chunk = await reader.read()
      if (controller.signal.aborted) return undefined
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 131072) { controller.abort(); return undefined }
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
    return { status: 200, json: JSON.parse(body) }
  } catch { return undefined }
  finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort)
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock() }
  }
}

export async function requestUpdateDecision(identity: UpdateIdentity, installationId: string, signal: AbortSignal,
  transport?: UpdateTransport): Promise<UpdateDecision | undefined> {
  if (!isUpdateUuid(installationId)) return undefined
  const url = new URL('api/v1/update-check', APP_UPDATE_WEBSITE)
  url.search = new URLSearchParams({ ...identity, installationId }).toString()
  const response = await requestBoundedUpdateJson(url.href, {}, signal, transport)
  return response?.status === 200 ? parseUpdateDecision(response.json, identity) : undefined
}
