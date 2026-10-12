import {
  MERMAID_CACHE_MAX_BYTES,
  MERMAID_CACHE_MAX_ENTRIES,
  MERMAID_MAX_EDGES,
  MERMAID_MAX_SOURCE_LENGTH,
  MERMAID_QUEUE_LIMIT,
  MERMAID_RENDER_BUDGET_MS,
  MERMAID_VERSION,
  type MermaidAppearance,
  type MermaidRenderer,
  type MermaidRenderRequest,
  type MermaidRenderResult,
  type MermaidSyntaxErrorSummary,
} from './mermaid-types'
import { sanitizeMermaidSvg, svgToDataUrl } from './mermaid-svg-sanitizer'

const MERMAID_RENDER_CONFIG_VERSION = 1
const SECURE_CONFIG_KEYS = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'maxEdges',
  'suppressErrorRendering',
  'htmlLabels',
  'fontFamily',
  'altFontFamily',
  'themeCSS',
  'themeVariables',
  'look',
  'theme',
] as const

interface MermaidModule {
  initialize(config: Record<string, unknown>): void
  parse(source: string, options: { suppressErrors: true }): Promise<unknown>
  render(id: string, source: string): Promise<{ svg: string; bindFunctions?: unknown }>
}

export interface MermaidRenderServiceOptions {
  loadMermaid?: () => Promise<MermaidModule>
  now?: () => number
  hash?: (value: string) => Promise<string>
}

let rendererWindowService: MermaidRenderer | undefined

interface CacheEntry {
  result: Extract<MermaidRenderResult, { status: 'ready' }>
  bytes: number
}

interface InFlightEntry {
  task: Promise<MermaidRenderResult>
  controller: AbortController
  callers: Set<object>
}

function sourceLimitResult(): MermaidRenderResult {
  return {
    status: 'resource-error',
    code: 'SOURCE_LIMIT',
    message: 'Mermaid 源码超过 20,000 字符限制',
  }
}

function queueLimitResult(): MermaidRenderResult {
  return {
    status: 'resource-error',
    code: 'QUEUE_LIMIT',
    message: 'Mermaid 图形生成队列已满',
  }
}

function timeoutResult(): MermaidRenderResult {
  return {
    status: 'resource-error',
    code: 'TIMEOUT',
    message: 'Mermaid 图形生成超时',
  }
}

function syntaxErrorResult(
  summary: MermaidSyntaxErrorSummary = { kind: 'generic' },
): MermaidRenderResult {
  return { status: 'syntax-error', message: 'Mermaid 语法错误', summary }
}

function normalizedSyntaxErrorSummary(
  error: unknown,
  source?: string,
): MermaidSyntaxErrorSummary {
  const internalMessage = error instanceof Error ? error.message : ''
  const lineMatch = /^[ \t]*(?:Parse|Lexical) error on line ([1-9]\d{0,5})(?::|[ \t]|$)/iu.exec(
    internalMessage,
  )
  if (lineMatch && source !== undefined) {
    const line = Number(lineMatch[1])
    const sourceLineCount = source.split(/\r\n?|\n/u).length
    if (Number.isSafeInteger(line) && line <= sourceLineCount) return { kind: 'line', line }
  }
  if (/^[ \t]*No diagram type detected\b/iu.test(internalMessage)) {
    return { kind: 'unknown-diagram' }
  }
  return { kind: 'generic' }
}

function classifyFailure(error: unknown, source?: string): MermaidRenderResult {
  const internalMessage = error instanceof Error ? error.message : ''
  if (/too large|svg.*(?:size|limit)/i.test(internalMessage)) {
    return {
      status: 'resource-error',
      code: 'SVG_LIMIT',
      message: 'Mermaid 图形过大，无法安全显示',
    }
  }
  if (/(?:max|too many).*edges?|edges?.*(?:limit|maximum)/i.test(internalMessage)) {
    return {
      status: 'resource-error',
      code: 'EDGE_LIMIT',
      message: 'Mermaid 图形过于复杂，无法安全显示',
    }
  }
  // Never expose Mermaid's exception text: it can contain source, paths, and stacks.
  return syntaxErrorResult(normalizedSyntaxErrorSummary(error, source))
}

function themeVariables(appearance: MermaidAppearance): Record<string, string> {
  const dark = appearance.colorScheme === 'dark'
  const canvas = dark ? '#17191d' : '#ffffff'
  const surface = dark ? '#242830' : '#f4f6f8'
  const text = dark ? '#f3f4f6' : '#20242a'
  const border = dark ? '#7d8794' : '#5b6571'

  return {
    fontFamily: appearance.bodyFontFamily,
    primaryColor: appearance.themeColor,
    primaryTextColor: text,
    primaryBorderColor: border,
    secondaryColor: surface,
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: canvas,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    background: canvas,
    mainBkg: surface,
    textColor: text,
    lineColor: border,
  }
}

function initializationConfig(appearance: MermaidAppearance): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    maxTextSize: MERMAID_MAX_SOURCE_LENGTH,
    maxEdges: MERMAID_MAX_EDGES,
    look: 'classic',
    theme: 'base',
    fontFamily: appearance.bodyFontFamily,
    altFontFamily: appearance.bodyFontFamily,
    themeVariables: themeVariables(appearance),
    secure: [...SECURE_CONFIG_KEYS],
  }
}

async function defaultLoadMermaid(): Promise<MermaidModule> {
  const loaded = await import('mermaid')
  return loaded.default as unknown as MermaidModule
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function cacheMaterial(request: MermaidRenderRequest): string {
  const { appearance } = request
  return JSON.stringify([
    MERMAID_VERSION,
    MERMAID_RENDER_CONFIG_VERSION,
    request.source,
    appearance.revision,
    appearance.editorTheme,
    appearance.colorScheme,
    appearance.themeColor,
    appearance.bodyFontFamily,
  ])
}

export function createMermaidRenderService(options: MermaidRenderServiceOptions = {}): MermaidRenderer {
  const loadMermaid = options.loadMermaid ?? defaultLoadMermaid
  const now = options.now ?? (() => performance.now())
  const hash = options.hash ?? sha256
  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, InFlightEntry>()
  let cacheBytes = 0
  let outstandingJobs = 0
  let nextRenderId = 0
  let modulePromise: Promise<MermaidModule> | undefined
  let admissionTail: Promise<void> = Promise.resolve()
  let tail: Promise<void> = Promise.resolve()

  function getMermaid(): Promise<MermaidModule> {
    if (!modulePromise) {
      const loading = loadMermaid()
      modulePromise = loading
      void loading.catch(() => {
        if (modulePromise === loading) modulePromise = undefined
      })
    }
    return modulePromise
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work)
    tail = run.then(() => undefined, () => undefined)
    return run
  }

  function readCache(key: string): MermaidRenderResult | undefined {
    const entry = cache.get(key)
    if (!entry) return undefined
    cache.delete(key)
    cache.set(key, entry)
    return entry.result
  }

  function writeCache(key: string, result: Extract<MermaidRenderResult, { status: 'ready' }>): void {
    const bytes = result.dataUrl.length * 2
    if (bytes > MERMAID_CACHE_MAX_BYTES) return

    const previous = cache.get(key)
    if (previous) {
      cacheBytes -= previous.bytes
      cache.delete(key)
    }
    cache.set(key, { result, bytes })
    cacheBytes += bytes

    while (cache.size > MERMAID_CACHE_MAX_ENTRIES || cacheBytes > MERMAID_CACHE_MAX_BYTES) {
      const oldestKey = cache.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const oldest = cache.get(oldestKey)
      cache.delete(oldestKey)
      cacheBytes -= oldest?.bytes ?? 0
    }
  }

  async function execute(
    request: MermaidRenderRequest,
    signal: AbortSignal,
  ): Promise<MermaidRenderResult> {
    const startedAt = now()
    let result: MermaidRenderResult
    try {
      if (signal.aborted) return timeoutResult()
      const mermaid = await getMermaid()
      if (signal.aborted) return timeoutResult()
      mermaid.initialize(initializationConfig(request.appearance))
      const parsed = await mermaid.parse(request.source, { suppressErrors: true })
      if (signal.aborted) {
        result = timeoutResult()
      } else if (parsed === false) {
        result = syntaxErrorResult()
      } else {
        const rendered = await mermaid.render(`arkdown-mermaid-${++nextRenderId}`, request.source)
        if (signal.aborted) return timeoutResult()
        const safeSvg = sanitizeMermaidSvg(rendered.svg)
        result = { status: 'ready', dataUrl: svgToDataUrl(safeSvg) }
      }
    } catch (error) {
      result = classifyFailure(error, request.source)
    }

    // This deadline is deliberately non-preemptive. Mermaid mutates window-global
    // configuration, so the FIFO remains occupied until its current call settles;
    // a late value is discarded and the next queued job can then proceed safely.
    if (now() - startedAt > MERMAID_RENDER_BUDGET_MS) return timeoutResult()
    return result
  }

  function waitForCaller(entry: InFlightEntry, signal: AbortSignal): Promise<MermaidRenderResult> {
    if (signal.aborted) {
      if (entry.callers.size === 0) entry.controller.abort()
      return Promise.resolve(timeoutResult())
    }

    const caller = {}
    entry.callers.add(caller)
    return new Promise((resolve) => {
      let settled = false
      let onAbort: () => void
      const settle = (result: MermaidRenderResult, aborted: boolean) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        entry.callers.delete(caller)
        if (aborted && entry.callers.size === 0) entry.controller.abort()
        resolve(result)
      }
      onAbort = () => settle(timeoutResult(), true)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      void entry.task.then(
        (result) => settle(result, false),
        (error: unknown) => settle(classifyFailure(error), false),
      )
    })
  }

  return {
    async render(request: MermaidRenderRequest): Promise<MermaidRenderResult> {
      const snapshot: MermaidRenderRequest = {
        ...request,
        source: request.source,
        appearance: { ...request.appearance },
      }
      if (snapshot.source.length > MERMAID_MAX_SOURCE_LENGTH) return sourceLimitResult()

      const admission = admissionTail.then(async () => {
        const key = await hash(cacheMaterial(snapshot))
        if (snapshot.signal.aborted) return { task: Promise.resolve(timeoutResult()) }
        const cached = readCache(key)
        if (cached) return { task: Promise.resolve(cached) }

        let existing = inFlight.get(key)
        if (existing?.controller.signal.aborted) {
          if (inFlight.get(key) === existing) inFlight.delete(key)
          existing = undefined
        }
        if (existing) return { task: waitForCaller(existing, snapshot.signal) }
        if (outstandingJobs >= MERMAID_QUEUE_LIMIT) {
          return { task: Promise.resolve(queueLimitResult()) }
        }

        outstandingJobs += 1
        const controller = new AbortController()
        const task = enqueue(() => execute(snapshot, controller.signal)).then((result) => {
          if (result.status === 'ready') writeCache(key, result)
          return result
        }, (error: unknown) => classifyFailure(error, snapshot.source))
        const entry: InFlightEntry = { task, controller, callers: new Set() }
        inFlight.set(key, entry)

        void task.finally(() => {
          outstandingJobs -= 1
          if (inFlight.get(key) === entry) inFlight.delete(key)
        })
        return { task: waitForCaller(entry, snapshot.signal) }
      })
      admissionTail = admission.then(() => undefined, () => undefined)
      const { task } = await admission
      return task
    },
  }
}

/** One service per renderer realm keeps Mermaid's global configuration and FIFO shared. */
export function getWindowMermaidRenderService(): MermaidRenderer {
  rendererWindowService ??= createMermaidRenderService()
  return rendererWindowService
}
