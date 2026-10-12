import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  SCREENSHOT_OCR_PACKAGE_MANIFEST,
  SCREENSHOT_OCR_PROTOCOL,
  SCREENSHOT_OCR_RESOURCE_URLS,
  type ScreenshotOcrPackageManifest,
} from '../../shared/screenshot-ocr-manifest'
import { screenshotOcrDevelopmentResourcesPath } from './screenshot-ocr-development-resources'

export { SCREENSHOT_OCR_PROTOCOL, SCREENSHOT_OCR_RESOURCE_URLS }

export function screenshotOcrRuntimeResourcesPath(input: {
  isPackaged: boolean
  resourcesPath: string
  developmentRoot: string
}): string {
  return input.isPackaged
    ? path.resolve(input.resourcesPath)
    : screenshotOcrDevelopmentResourcesPath(input.developmentRoot)
}

interface ProtocolPrivilegeRegistrar {
  registerSchemesAsPrivileged(schemes: Array<{
    scheme: string
    privileges: { secure: boolean; standard: boolean; supportFetchAPI: boolean; stream: boolean; corsEnabled: boolean }
  }>): void
}

export function registerScreenshotOcrScheme(protocol: ProtocolPrivilegeRegistrar): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCREENSHOT_OCR_PROTOCOL,
    privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  }])
}

export interface ScreenshotOcrResolvedResource { bytes: Uint8Array; contentType: string }

function unavailable(): never { throw new Error('OCR_RESOURCE_UNAVAILABLE') }

function equalPath(first: string, second: string): boolean {
  return process.platform === 'win32'
    ? path.normalize(first).toLocaleLowerCase('en-US') === path.normalize(second).toLocaleLowerCase('en-US')
    : path.normalize(first) === path.normalize(second)
}

function contentType(name: string): string {
  if (name.endsWith('.tar')) return 'application/x-tar'
  if (name.endsWith('.wasm')) return 'application/wasm'
  if (name.endsWith('.mjs') || name.endsWith('.js')) return 'text/javascript; charset=utf-8'
  return unavailable()
}

export function createScreenshotOcrResourceResolver(options: {
  resourcesPath: string
  manifest?: ScreenshotOcrPackageManifest
  /** Must audit the compiled component tree before returning its root. No downloading here. */
  resolveBaseRoot?: () => Promise<string | undefined>
  resolveActiveMedium?: (name: 'medium-det.tar' | 'medium-rec.tar') => Promise<ScreenshotOcrResolvedResource | undefined>
}): { resolve(url: string): Promise<ScreenshotOcrResolvedResource> } {
  const manifest = options.manifest ?? SCREENSHOT_OCR_PACKAGE_MANIFEST
  const allowed = new Map(manifest.artifacts.map((artifact) => [artifact.name, artifact]))
  return {
    async resolve(rawUrl) {
      let url: URL
      try { url = new URL(rawUrl) } catch { return unavailable() }
      if (url.protocol !== `${SCREENSHOT_OCR_PROTOCOL}:` || url.hostname !== 'bundle'
        || url.username || url.password || url.port || url.search || url.hash
        || rawUrl.includes('%') || rawUrl.includes('\\')
        || rawUrl.includes('/../') || rawUrl.includes('/./')) unavailable()
      const name = url.pathname.slice(1)
      if (!name || url.pathname !== `/${name}` || name.split('/').some((part) => !part || part === '.' || part === '..')) unavailable()
      if (name === 'medium-det.tar' || name === 'medium-rec.tar') {
        try {
          const resource = await options.resolveActiveMedium?.(name)
          return resource ?? unavailable()
        } catch { return unavailable() }
      }
      const artifact = allowed.get(name)
      const externalWorker = name === 'worker.js' && options.resolveBaseRoot !== undefined
      if (!artifact && !externalWorker) unavailable()
      try {
        const resolvedRoot = options.resolveBaseRoot
          ? await options.resolveBaseRoot()
          : path.resolve(options.resourcesPath, 'screenshot-ocr')
        if (!resolvedRoot) unavailable()
        const root = path.resolve(resolvedRoot)
        const rootInfo = await lstat(root)
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) unavailable()
        const canonicalRoot = await realpath(root)
        if (!equalPath(canonicalRoot, root)) unavailable()
        let current = root
        const parts = name.split('/')
        for (let index = 0; index < parts.length; index += 1) {
          current = path.join(current, parts[index]!)
          const info = await lstat(current)
          if (info.isSymbolicLink()) unavailable()
          if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) unavailable()
          if (index === parts.length - 1 && (artifact
            ? info.size !== artifact.bytes
            : info.size <= 0 || info.size > 32 * 1024 * 1024)) unavailable()
        }
        const canonicalTarget = await realpath(current)
        if (!equalPath(canonicalTarget, current)
          || !equalPath(path.dirname(canonicalTarget), path.dirname(current))) unavailable()
        const bytes = await readFile(current)
        if (artifact && (bytes.byteLength !== artifact.bytes
          || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)) unavailable()
        if (externalWorker && (bytes.byteLength <= 0 || bytes.byteLength > 32 * 1024 * 1024)) unavailable()
        return { bytes: new Uint8Array(bytes), contentType: contentType(name) }
      } catch { return unavailable() }
    },
  }
}

export function createScreenshotOcrProtocolHandler(options: {
  resourcesPath: string
  manifest?: ScreenshotOcrPackageManifest
  resolveBaseRoot?: () => Promise<string | undefined>
  resolveActiveMedium?: (name: 'medium-det.tar' | 'medium-rec.tar') => Promise<ScreenshotOcrResolvedResource | undefined>
}): (request: { url: string }) => Promise<Response> {
  const resolver = createScreenshotOcrResourceResolver(options)
  const crossOriginHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  } as const
  return async (request) => {
    try {
      const resource = await resolver.resolve(request.url)
      return new Response(resource.bytes as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': resource.contentType,
          'Content-Length': String(resource.bytes.byteLength),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...crossOriginHeaders,
        },
      })
    } catch {
      return new Response(null, {
        status: 404,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '0',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...crossOriginHeaders,
        },
      })
    }
  }
}
