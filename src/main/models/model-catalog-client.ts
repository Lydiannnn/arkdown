import { recommendedModelIds } from '../../shared/model-capability-rules'
import type {
  ModelProtocol,
  ModelProviderId,
} from '../../shared/large-model-settings'
import { MODEL_ID_MAX_LENGTH } from '../../shared/large-model-settings'
import { ModelProtocolError, modelProtocolError } from './model-errors'
import { validateModelBaseUrl } from './model-protocol-client'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_MODELS = 1_000

export interface ModelCatalog {
  models: string[]
  recommendedModelId: string | null
}

export interface ModelCatalogRequest {
  provider: ModelProviderId
  protocol: ModelProtocol
  baseUrl: string
  apiKey: string
  signal: AbortSignal
}

export interface ModelCatalogClient {
  listModels(input: ModelCatalogRequest): Promise<ModelCatalog>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function appendEndpoint(baseUrl: string, suffix: string): URL {
  const endpoint = validateModelBaseUrl(baseUrl)
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}${suffix}`
  return endpoint
}

function catalogEndpoint(input: ModelCatalogRequest): URL {
  const base = validateModelBaseUrl(input.baseUrl)
  if (
    input.provider === 'qwen'
    && base.hostname.toLowerCase() === 'dashscope.aliyuncs.com'
  ) {
    const endpoint = new URL('/api/v1/deployments/models', base.origin)
    endpoint.searchParams.set('page_no', '1')
    endpoint.searchParams.set('page_size', '100')
    endpoint.searchParams.set('version', 'v1.0')
    endpoint.searchParams.set('model_source', 'base')
    return endpoint
  }
  return appendEndpoint(input.baseUrl, '/models')
}

function statusError(status: number): ModelProtocolError {
  if (status === 401 || status === 403) return modelProtocolError('authentication-failed')
  if (status === 408 || status === 504) return modelProtocolError('timeout')
  if (status === 429) return modelProtocolError('rate-limited')
  if ((status >= 300 && status < 400) || status === 404) {
    return modelProtocolError('invalid-endpoint')
  }
  return modelProtocolError('incompatible-response')
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw modelProtocolError('incompatible-response')
  }
  if (response.body === null) throw modelProtocolError('incompatible-response')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw modelProtocolError('incompatible-response')
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw modelProtocolError('incompatible-response')
  }
}

function modelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized !== '' && normalized.length <= MODEL_ID_MAX_LENGTH
    ? normalized
    : undefined
}

function openAiModels(value: unknown): string[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > MAX_MODELS) {
    return undefined
  }
  const models: string[] = []
  for (const candidate of value.data) {
    if (!isRecord(candidate)) return undefined
    const id = modelId(candidate.id)
    if (id === undefined) return undefined
    models.push(id)
  }
  return models
}

function qwenModels(value: unknown): string[] | undefined {
  if (!isRecord(value)) return undefined
  const container = isRecord(value.output) ? value.output : value
  if (!Array.isArray(container.models) || container.models.length > MAX_MODELS) return undefined
  const models: string[] = []
  for (const candidate of container.models) {
    if (!isRecord(candidate)) return undefined
    const id = modelId(candidate.model_name)
    if (id === undefined) return undefined
    models.push(id)
  }
  return models
}

function normalizeCatalog(input: ModelCatalogRequest, value: unknown): ModelCatalog {
  const provider = input.provider
  const parsed = provider === 'qwen'
    ? qwenModels(value) ?? openAiModels(value)
    : openAiModels(value)
  if (parsed === undefined || parsed.length === 0) {
    throw modelProtocolError('incompatible-response')
  }
  const recommended = recommendedModelIds(input)
  const rank = (id: string) => { const at = recommended.indexOf(id); return at < 0 ? Number.MAX_SAFE_INTEGER : at }
  const models = Array.from(new Set(parsed)).sort((left, right) => (
    rank(left) - rank(right) ||
    left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
  ))
  return {
    models,
    recommendedModelId: models[0] ?? null,
  }
}

export function createModelCatalogClient(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): ModelCatalogClient {
  return {
    async listModels(input) {
      const controller = new AbortController()
      const abortFromCaller = () => controller.abort(
        input.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'),
      )
      if (input.signal.aborted) abortFromCaller()
      else input.signal.addEventListener('abort', abortFromCaller, { once: true })
      const timer = setTimeout(() => {
        controller.abort(new DOMException('The request timed out', 'TimeoutError'))
      }, timeoutMs)

      try {
        const response = await fetchImpl(catalogEndpoint(input), {
          method: 'GET',
          redirect: 'manual',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${input.apiKey}`,
            ...(input.protocol === 'anthropic' ? { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01' } : {}),
          },
          signal: controller.signal,
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          throw statusError(response.status)
        }
        return normalizeCatalog(
          input,
          await readBoundedJson(response, controller.signal),
        )
      } catch (error) {
        if (input.signal.aborted) {
          throw input.signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
        }
        if (error instanceof ModelProtocolError) throw error
        if (controller.signal.aborted) throw modelProtocolError('timeout')
        throw modelProtocolError('invalid-endpoint')
      } finally {
        clearTimeout(timer)
        input.signal.removeEventListener('abort', abortFromCaller)
      }
    },
  }
}
