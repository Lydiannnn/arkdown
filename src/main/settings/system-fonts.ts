import { execFile } from 'node:child_process'
import {
  DEFAULT_FONT_CHOICES,
  isSafeFontFamilyName,
} from '../../shared/editor-appearance-preferences'

export const FALLBACK_SYSTEM_FONTS = DEFAULT_FONT_CHOICES

export interface FontCommandOptions {
  encoding: 'utf8'
  windowsHide: true
  env: NodeJS.ProcessEnv
}

export type FontCommandRunner = (
  file: string,
  args: string[],
  options: FontCommandOptions,
) => Promise<{ stdout: string }>

const WINDOWS_FONT_REGISTRY_SCRIPT = [
  '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
  "$paths = @('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')",
  '$names = foreach ($fontPath in $paths) {',
  '  if (Test-Path -LiteralPath $fontPath) {',
  '    (Get-ItemProperty -LiteralPath $fontPath).PSObject.Properties |',
  "      Where-Object { $_.Name -notlike 'PS*' } |",
  '      ForEach-Object { $_.Name }',
  '  }',
  '}',
  '$names | Sort-Object -Unique | ConvertTo-Json -Compress',
].join('\n')

const defaultRunner: FontCommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout) => {
    if (error) {
      reject(error)
      return
    }
    resolve({ stdout: String(stdout) })
  })
})

function normalizeRegistryFontName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const family = value
    .replace(/\s*\((?:TrueType|OpenType)\)\s*$/iu, '')
    .trim()
  return isSafeFontFamilyName(family) ? family : null
}

export function parseWindowsFontRegistryOutput(output: string): string[] {
  const source = output.replace(/^\uFEFF/u, '').trim()
  if (!source) return []
  try {
    const parsed = JSON.parse(source) as unknown
    const values = Array.isArray(parsed) ? parsed : [parsed]
    return Array.from(new Set(values
      .map(normalizeRegistryFontName)
      .filter((value): value is string => value !== null)))
      .sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
  } catch {
    return []
  }
}

export async function listSystemFontFamilies(
  run: FontCommandRunner = defaultRunner,
): Promise<string[]> {
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_FONT_REGISTRY_SCRIPT],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      },
    )
    return Array.from(new Set([
      ...FALLBACK_SYSTEM_FONTS,
      ...parseWindowsFontRegistryOutput(stdout),
    ])).sort((left, right) => left.localeCompare(right, 'en', { sensitivity: 'base' }))
  } catch {
    return [...FALLBACK_SYSTEM_FONTS]
  }
}
