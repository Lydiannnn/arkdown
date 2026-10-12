// Windows-only, opt-in native regression. No Electron/UI instance is started.
// Run: node tests/scripts/run-glass-cursor-native.mjs
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'

if (process.platform !== 'win32') throw Error('This native regression requires Windows x64')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = process.env.ARKDOWN_NATIVE_TEST_OUTPUT
  ? path.resolve(process.env.ARKDOWN_NATIVE_TEST_OUTPUT)
  : path.join(repo, 'native/sticky-note-surface/obj/cursor-native-test')
await mkdir(output, { recursive: true })
const cache = path.join(repo, '.native-cache/sticky-note-surface/43.2.0')
const archive = path.join(cache, 'node-headers.tar.gz')
const nodeLib = path.join(cache, 'x64/node.lib')
for (const [file, sha] of [
  [archive, 'bef9da935120ac15bf09277b29ef5f95134552f5b5d3b4c7c733791fb234ecb6'],
  [nodeLib, '757cde97e0dd2f01aed47326440429a1012624892e6e4cbebf59dac964ac8e6d'],
]) {
  if (createHash('sha256').update(await readFile(file)).digest('hex') !== sha) throw Error('Native dependency cache hash mismatch: ' + file)
}
await tar.x({ file: archive, cwd: output, strip: 1, strict: true,
  filter: (name, entry) => (entry.type === 'File' || entry.type === 'Directory') && /^node_headers\/include(?:\/|$)/u.test(name) })
const programFiles = process.env['ProgramFiles(x86)']
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true,
  env: Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value])), maxBuffer: 16 * 1024 * 1024 })
const msbuild = run(path.join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe'),
  ['-latest', '-products', '*', '-version', '[17.0,18.0)', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-find', 'MSBuild\\Current\\Bin\\MSBuild.exe']).trim()
const versions = (await readdir(path.join(programFiles, 'Windows Kits/10/Include')))
  .filter(v => /^10\.0\.\d+\.0$/u.test(v) && Number(v.split('.')[2]) >= 22621)
  .sort((a, b) => Number(b.split('.')[2]) - Number(a.split('.')[2]))
if (!versions[0] || !msbuild || /[\r\n]/u.test(msbuild)) throw Error('Native build toolchain unavailable')
const source = path.join(repo, 'native/sticky-note-surface/tests/glass_cursor_native.test.cpp')
const shellDragSource = path.join(repo, 'native/sticky-note-surface/src/workspace_shell_drag.cpp')
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
let project = await readFile(path.join(repo, 'native/sticky-note-surface/sticky-note-surface.vcxproj'), 'utf8')
project = project.replace('DynamicLibrary', 'Application').replace('<TargetName>surface</TargetName><TargetExt>.node</TargetExt>', '<TargetName>glass-cursor-native</TargetName><TargetExt>.exe</TargetExt>')
  .replace('<SubSystem>Windows</SubSystem>', '<SubSystem>Console</SubSystem>')
  .replace(/<ItemGroup><ClCompile.*?<\/ItemGroup>/u,
    `<ItemGroup><ClCompile Include="${xml(source)}" /><ClCompile Include="${xml(shellDragSource)}" /></ItemGroup>`)
  .replace(/<ItemGroup><ClInclude.*?<\/ItemGroup>/u, '')
const projectPath = path.join(output, 'cursor-test.vcxproj')
await writeFile(projectPath, project, 'utf8')
try {
  process.stdout.write(run(msbuild, [projectPath, '/t:Rebuild', '/nologo', '/v:minimal', '/p:Configuration=Release', '/p:Platform=x64',
    '/p:WindowsTargetPlatformVersion=' + versions[0], '/p:NodeHeadersDir=' + path.join(output, 'include/node'),
    '/p:NodeLibPath=' + nodeLib, '/p:OutDir=' + output + path.sep, '/p:IntDir=' + path.join(output, 'intermediate') + path.sep]))
  process.stdout.write(run(path.join(output, 'glass-cursor-native.exe'), []))
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  process.exitCode = 1
}
