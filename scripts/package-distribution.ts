import { spawn } from 'node:child_process'
import path from 'node:path'
import { parsePackageEdition } from './package-editions.ts'

const edition = parsePackageEdition(process.argv[2])
const repoRoot = path.resolve(import.meta.dirname, '..')
async function run(script: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', script, ...args], {
      cwd: repoRoot, env: { ...process.env, ARKDOWN_PACKAGE_EDITION: edition }, stdio: 'inherit', windowsHide: true, shell: false,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Packaging process failed: ${code ?? signal}`)))
  })
}
await run(path.join(repoRoot, 'scripts/build-user-guide.ts'), [])
await run(path.join(repoRoot, 'node_modules/@electron-forge/cli/dist/electron-forge.js'), ['package', ...process.argv.slice(3)])
