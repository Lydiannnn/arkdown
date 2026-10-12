import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const packageRoot = process.env.ARKDOWN_CAPTURE_PACKAGE
  ? resolve(process.env.ARKDOWN_CAPTURE_PACKAGE)
  : resolve(projectRoot, 'out', 'Arkdown-win32-x64')

function runCapture(scriptName: string): void {
  const script = resolve(import.meta.dirname, scriptName)
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-PackageRoot',
      packageRoot,
      '-ProjectRoot',
      projectRoot,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'inherit',
      windowsHide: false,
    },
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${scriptName} failed with exit code ${result.status}`)
  }
}

function runNodeCapture(scriptName: string): void {
  const script = resolve(import.meta.dirname, scriptName)
  const result = spawnSync(
    process.execPath,
    [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      script,
      '--package-root',
      packageRoot,
      '--project-root',
      projectRoot,
    ],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'inherit',
      windowsHide: false,
    },
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${scriptName} failed with exit code ${result.status}`)
  }
}

runCapture('capture-app-windows.ps1')
runCapture('capture-portable-folder.ps1')
runNodeCapture('capture-sticky-note-box.ts')
