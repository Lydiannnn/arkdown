import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowsDisplayEvidence {
  id: string
  bounds: Rect
  workArea: Rect
  scaleFactor: number
}

export interface WindowsDisplayCapabilities {
  primaryRealScaleFactor: number
  displays: readonly WindowsDisplayEvidence[]
  negativeCoordinateDisplay: 'exercised' | 'authoritative-unavailable'
  hdrAdvancedColor: 'exercised' | 'unavailable'
  protectedContentAffinity: 'exercised' | 'unsupported'
}

export type ScreenshotSourceDisplayEvidence =
  | 'differently-scaled-secondary-exercised'
  | 'authoritative-unavailable-primary-fallback'

export function chooseScreenshotSourceDisplay(
  displays: readonly WindowsDisplayEvidence[],
  preference: 'differently-scaled-secondary',
): { display: WindowsDisplayEvidence; evidence: ScreenshotSourceDisplayEvidence } {
  if (displays.length === 0) throw new Error('No authoritative display evidence')
  const primary = displays.find(({ bounds }) => bounds.x === 0 && bounds.y === 0) ?? displays[0]!
  if (preference === 'differently-scaled-secondary') {
    const secondary = displays.find(({ id, scaleFactor }) => (
      id !== primary.id && Math.abs(scaleFactor - primary.scaleFactor) >= 0.01
    ))
    if (secondary) {
      return { display: secondary, evidence: 'differently-scaled-secondary-exercised' }
    }
  }
  return { display: primary, evidence: 'authoritative-unavailable-primary-fallback' }
}

export interface ScreenshotEnvironmentEvidence extends WindowsDisplayCapabilities {
  shortcut: 'registered-and-activated' | 'occupied-menu-fallback' | 'registered-menu-trigger'
  ocr: {
    language: string
    status: 'completed' | 'language-unavailable' | 'unavailable'
    blockCount: number
    wordCount: number
  }
}

function exactOwnKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function parseRect(value: unknown): Rect | undefined {
  if (!exactOwnKeys(value, ['x', 'y', 'width', 'height'])) return undefined
  const numbers = [value.x, value.y, value.width, value.height]
  if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number))
    || Math.abs(value.x as number) > 1_000_000
    || Math.abs(value.y as number) > 1_000_000
    || (value.width as number) <= 0
    || (value.height as number) <= 0
    || (value.width as number) > 100_000
    || (value.height as number) > 100_000) return undefined
  return {
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  }
}

export function parseWindowsDisplayCapabilities(value: unknown): WindowsDisplayCapabilities {
  if (!exactOwnKeys(value, ['primaryScaleFactor', 'displays', 'hdr', 'protectedContent'])
    || typeof value.primaryScaleFactor !== 'number'
    || !Number.isFinite(value.primaryScaleFactor)
    || value.primaryScaleFactor < 0.5
    || value.primaryScaleFactor > 8
    || !Array.isArray(value.displays)
    || value.displays.length === 0
    || value.displays.length > 32
    || !['exercised', 'unavailable', 'probe-error'].includes(value.hdr as string)
    || !['exercised', 'unsupported', 'probe-error'].includes(value.protectedContent as string)) {
    throw new Error('Invalid Windows display capability probe')
  }
  if (value.hdr === 'probe-error' || value.protectedContent === 'probe-error') {
    throw new Error('Windows display capability probe reported a probe error')
  }
  const ids = new Set<string>()
  const displays: WindowsDisplayEvidence[] = []
  for (const candidate of value.displays) {
    if (!exactOwnKeys(candidate, ['id', 'bounds', 'workArea', 'scaleFactor'])
      || typeof candidate.id !== 'string'
      || candidate.id.length === 0
      || candidate.id.length > 256
      || ids.has(candidate.id)
      || typeof candidate.scaleFactor !== 'number'
      || !Number.isFinite(candidate.scaleFactor)
      || candidate.scaleFactor < 0.5
      || candidate.scaleFactor > 8) throw new Error('Invalid Windows display capability entry')
    const bounds = parseRect(candidate.bounds)
    const workArea = parseRect(candidate.workArea)
    if (!bounds || !workArea) throw new Error('Invalid Windows display capability geometry')
    ids.add(candidate.id)
    displays.push({ id: candidate.id, bounds, workArea, scaleFactor: candidate.scaleFactor })
  }
  return {
    primaryRealScaleFactor: value.primaryScaleFactor,
    displays,
    negativeCoordinateDisplay: displays.some(({ bounds }) => bounds.x < 0 || bounds.y < 0)
      ? 'exercised'
      : 'authoritative-unavailable',
    hdrAdvancedColor: value.hdr as 'exercised' | 'unavailable',
    protectedContentAffinity: value.protectedContent as 'exercised' | 'unsupported',
  }
}

export async function probeWindowsDisplayCapabilities(
  script = path.resolve('tests/e2e/fixtures/windows-display-capabilities.ps1'),
): Promise<WindowsDisplayCapabilities> {
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const { stdout } = await execFileAsync(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024,
  })
  return parseWindowsDisplayCapabilities(JSON.parse(stdout.trim()) as unknown)
}

export function createScreenshotEnvironmentEvidence(
  capabilities: WindowsDisplayCapabilities,
  runtime: Pick<ScreenshotEnvironmentEvidence, 'shortcut' | 'ocr'>,
): ScreenshotEnvironmentEvidence {
  if (!['registered-and-activated', 'occupied-menu-fallback', 'registered-menu-trigger'].includes(runtime.shortcut)
    || !exactOwnKeys(runtime.ocr, ['language', 'status', 'blockCount', 'wordCount'])
    || typeof runtime.ocr.language !== 'string'
    || runtime.ocr.language.length > 64
    || !['completed', 'language-unavailable', 'unavailable'].includes(runtime.ocr.status)
    || !Number.isSafeInteger(runtime.ocr.blockCount)
    || runtime.ocr.blockCount < 0
    || !Number.isSafeInteger(runtime.ocr.wordCount)
    || runtime.ocr.wordCount < 0) throw new Error('Invalid screenshot runtime environment evidence')
  return { ...capabilities, shortcut: runtime.shortcut, ocr: { ...runtime.ocr } }
}
