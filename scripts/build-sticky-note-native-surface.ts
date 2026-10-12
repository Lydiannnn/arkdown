import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as tar from 'tar'

export const ELECTRON_NATIVE_SURFACE_VERSION = '43.2.0'
// https://electronjs.org/headers/v43.2.0/SHASUMS256.txt
const HEADER_SHA256 = 'bef9da935120ac15bf09277b29ef5f95134552f5b5d3b4c7c733791fb234ecb6'
const NODE_LIB_SHA256 = '757cde97e0dd2f01aed47326440429a1012624892e6e4cbebf59dac964ac8e6d'
export const NATIVE_SURFACE_INPUTS = [
  'native/sticky-note-surface/src/addon.cpp',
  'native/sticky-note-surface/src/material_effects.h',
  'native/sticky-note-surface/src/glass_resize_hit_test.h',
  'native/sticky-note-surface/src/workspace_shell_drag.h',
  'native/sticky-note-surface/src/workspace_shell_drag.cpp',
  'native/sticky-note-surface/src/update_executable_pin.h',
  'native/sticky-note-surface/src/delay_hook.cpp',
  'native/sticky-note-surface/sticky-note-surface.vcxproj',
  'native/sticky-note-surface/NOTICE',
  'scripts/build-sticky-note-native-surface.ts',
] as const
const SCRIPT = fileURLToPath(import.meta.url)
const REPO = path.resolve(path.dirname(SCRIPT), '..')
const execFileAsync = promisify(execFile)
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export async function nativeSurfaceSourceHash(repoRoot: string): Promise<string> {
  const hash = createHash('sha256')
  for (const relative of NATIVE_SURFACE_INPUTS) {
    const file = path.join(repoRoot, relative)
    const metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw Error('Native surface source must be a regular file: ' + relative)
    hash.update(relative + '\0').update(await readFile(file)).update('\0')
  }
  return hash.digest('hex')
}

export async function obtainNativeSurfaceArtifact(options: {
  file: string; url: string; sha256: string; allowDownload?: boolean; request?: (url: string) => Promise<Response>
}): Promise<Buffer> {
  const metadata = await lstat(options.file).catch(() => undefined)
  if (metadata?.isSymbolicLink()) throw Error('Native artifact cache must not be a symbolic link')
  const existing = metadata?.isFile() ? await readFile(options.file) : undefined
  if (existing && digest(existing) === options.sha256) return existing
  if (options.allowDownload === false) throw Error('Verified native artifact unavailable; cache hash missing or mismatched')
  const url = new URL(options.url)
  if (url.origin !== 'https://electronjs.org' || !url.pathname.startsWith('/headers/v' + ELECTRON_NATIVE_SURFACE_VERSION + '/')) throw Error('Untrusted native header source')
  const response = await (options.request ?? fetch)(options.url)
  if (!response.ok) throw Error('Electron header download failed: HTTP ' + response.status)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 100 * 1024 * 1024 || digest(bytes) !== options.sha256) throw Error('Electron artifact hash mismatch')
  await mkdir(path.dirname(options.file), { recursive: true })
  await writeFile(options.file, bytes)
  return bytes
}

export function nativeSurfaceBuildArguments(options: {
  repoRoot: string; headersDirectory: string; nodeLib: string; sdkVersion: string; architecture: string; intermediateDirectory?: string
}): string[] {
  if (options.architecture !== 'x64') throw Error('Native sticky-note surface supports Windows x64 only')
  if (!/^10\.0\.\d+\.0$/u.test(options.sdkVersion)) throw Error('Invalid Windows SDK version')
  const nativeRoot = path.join(options.repoRoot, 'native/sticky-note-surface')
  return [path.join(nativeRoot, 'sticky-note-surface.vcxproj'), '/t:Rebuild', '/nologo', '/v:minimal',
    '/p:Configuration=Release', '/p:Platform=x64', '/p:WindowsTargetPlatformVersion=' + options.sdkVersion,
    '/p:NodeHeadersDir=' + options.headersDirectory, '/p:NodeLibPath=' + options.nodeLib,
    '/p:OutDir=' + path.join(nativeRoot, 'dist/x64') + path.sep,
    '/p:IntDir=' + (options.intermediateDirectory ?? path.join(nativeRoot, 'obj/x64')) + path.sep]
}

export async function extractNativeSurfaceHeaders(archive: string, extraction: string): Promise<string> {
  await tar.x({ file: archive, cwd: extraction, strip: 1, strict: true, filter: (name, entry) => 'type' in entry && (entry.type === 'File' || entry.type === 'Directory') && /^node_headers\/include(?:\/|$)/u.test(name) })
  const headersDirectory = path.join(extraction, 'include/node')
  if (!(await lstat(path.join(headersDirectory, 'node_api.h')).catch(() => undefined))?.isFile()) throw Error('Verified Electron header archive missing node_api.h')
  return headersDirectory
}

async function discoverToolchain(): Promise<{ msbuild: string; sdkVersion: string }> {
  const programFiles = process.env['ProgramFiles(x86)'] ?? process.env.PROGRAMFILES_X86
  if (!programFiles) throw Error('Windows ProgramFiles(x86) is unavailable')
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe')
  if (!(await lstat(vswhere).catch(() => undefined))?.isFile()) throw Error('Install Visual Studio 2022 Build Tools with C++ x64 tools (vswhere missing)')
  const { stdout } = await execFileAsync(vswhere, ['-latest', '-products', '*', '-version', '[17.0,18.0)', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-find', 'MSBuild\\Current\\Bin\\MSBuild.exe'], { encoding: 'utf8', windowsHide: true })
  const candidates = stdout.trim().split(/\r?\n/u).filter(Boolean)
  if (candidates.length !== 1 || !(await lstat(candidates[0]).catch(() => undefined))?.isFile()) throw Error('Visual Studio 2022 C++ MSBuild prerequisite unavailable')
  const kits = path.join(programFiles, 'Windows Kits/10')
  const versions = (await readdir(path.join(kits, 'Include'))).filter(v => /^10\.0\.\d+\.0$/u.test(v) && Number(v.split('.')[2]) >= 22621).sort((a, b) => Number(b.split('.')[2]) - Number(a.split('.')[2]))
  for (const version of versions) {
    const files = ['Include/' + version + '/cppwinrt/winrt/Windows.UI.Composition.h', 'Include/' + version + '/um/windows.h', 'Lib/' + version + '/um/x64/windowsapp.lib']
    if ((await Promise.all(files.map(async file => (await lstat(path.join(kits, file)).catch(() => undefined))?.isFile()))).every(Boolean)) return { msbuild: candidates[0], sdkVersion: version }
  }
  throw Error('Windows SDK 10.0.22621.0 or newer with C++/WinRT and x64 libraries is required')
}

export async function buildStickyNoteNativeSurface(options: { repoRoot?: string; cacheRoot?: string; architecture?: string; allowDownload?: boolean } = {}): Promise<string> {
  if (process.platform !== 'win32' || (options.architecture ?? process.arch) !== 'x64') throw Error('Native sticky-note surface supports Windows x64 only')
  const repoRoot = path.resolve(options.repoRoot ?? REPO)
  const pkg = JSON.parse((await readFile(path.join(repoRoot, 'package.json'), 'utf8')).replace(/^\uFEFF/u, ''))
  if (pkg.devDependencies?.electron !== ELECTRON_NATIVE_SURFACE_VERSION) throw Error('Electron version differs from verified native header lock; update lock explicitly')
  const toolchain = await discoverToolchain()
  const sourceSha256 = await nativeSurfaceSourceHash(repoRoot)
  const cacheRoot = path.resolve(options.cacheRoot ?? path.join(repoRoot, '.native-cache/sticky-note-surface'))
  const versionRoot = path.join(cacheRoot, ELECTRON_NATIVE_SURFACE_VERSION)
  const archive = path.join(versionRoot, 'node-headers.tar.gz'), nodeLib = path.join(versionRoot, 'x64/node.lib')
  const base = 'https://electronjs.org/headers/v' + ELECTRON_NATIVE_SURFACE_VERSION + '/'
  await obtainNativeSurfaceArtifact({ file: archive, url: base + 'node-v' + ELECTRON_NATIVE_SURFACE_VERSION + '-headers.tar.gz', sha256: HEADER_SHA256, allowDownload: options.allowDownload })
  await obtainNativeSurfaceArtifact({ file: nodeLib, url: base + 'x64/node.lib', sha256: NODE_LIB_SHA256, allowDownload: options.allowDownload })
  const extraction = await mkdtemp(path.join(versionRoot, 'headers-'))
  const output = path.join(repoRoot, 'native/sticky-note-surface/dist/x64')
  await mkdir(output, { recursive: true })
  await rm(path.join(output, 'manifest.json'), { force: true })
  try {
    const headersDirectory = await extractNativeSurfaceHeaders(archive, extraction)
    const env = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]))
    const result = await execFileAsync(toolchain.msbuild, nativeSurfaceBuildArguments({ repoRoot, headersDirectory, nodeLib, sdkVersion: toolchain.sdkVersion, architecture: 'x64' }), { env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    process.stdout.write(result.stdout); process.stderr.write(result.stderr)
    if (await nativeSurfaceSourceHash(repoRoot) !== sourceSha256) throw Error('Native build source changed during compilation')
    const file = path.join(output, 'surface.node'), metadata = await lstat(file)
    if (!metadata.isFile() || metadata.isSymbolicLink() || !metadata.size) throw Error('Native build did not produce a regular surface.node')
    const manifest = { schemaVersion: 1, platform: 'win32', arch: 'x64', electronVersion: ELECTRON_NATIVE_SURFACE_VERSION, file: 'surface.node', bytes: metadata.size, sha256: digest(await readFile(file)), sourceSha256, windowsSdkVersion: toolchain.sdkVersion }
    await writeFile(path.join(output, 'NOTICE'), await readFile(path.join(repoRoot, 'native/sticky-note-surface/NOTICE')))
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\r\n', 'utf8')
    return output
  } finally { await rm(extraction, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  buildStickyNoteNativeSurface().then(output => console.log('Native surface built: ' + output)).catch(error => { console.error(error); process.exitCode = 1 })
}
