// Opt-in, noninteractive Windows Shell data/negotiation regression.
// No Electron, visible window, pointer movement, clipboard write or actual drop.
import { execFileSync } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('This native regression requires Windows x64')
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = process.env.ARKDOWN_NATIVE_TEST_OUTPUT
  ? path.resolve(process.env.ARKDOWN_NATIVE_TEST_OUTPUT)
  : path.join(repo, 'native/sticky-note-surface/obj/workspace-shell-drag-test')
await mkdir(output, { recursive: true })
const programFiles = process.env['ProgramFiles(x86)']
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true,
  env: Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value])), maxBuffer: 16 * 1024 * 1024 })
const msbuild = run(path.join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe'),
  ['-latest', '-products', '*', '-version', '[17.0,18.0)', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-find', 'MSBuild\\Current\\Bin\\MSBuild.exe']).trim()
const versions = (await readdir(path.join(programFiles, 'Windows Kits/10/Include')))
  .filter(v => /^10\.0\.\d+\.0$/u.test(v) && Number(v.split('.')[2]) >= 22621)
  .sort((a, b) => Number(b.split('.')[2]) - Number(a.split('.')[2]))
if (!versions[0] || !msbuild || /[\r\n]/u.test(msbuild)) throw Error('Native build toolchain unavailable')
try {
  process.stdout.write(run(msbuild, [path.join(repo, 'native/sticky-note-surface/tests/workspace_shell_drag.test.vcxproj'),
    '/t:Rebuild', '/nologo', '/v:minimal', '/p:Configuration=Release', '/p:Platform=x64',
    '/p:WindowsTargetPlatformVersion=' + versions[0], '/p:OutDir=' + output + path.sep,
    '/p:IntDir=' + path.join(output, 'intermediate') + path.sep]))
  process.stdout.write(run(path.join(output, 'workspace-shell-drag-test.exe'), []))
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  process.exitCode = 1
}
