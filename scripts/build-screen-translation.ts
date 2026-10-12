import { execFile } from 'node:child_process'
import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function buildScreenTranslation(
  { repoRoot = defaultRoot }: { repoRoot?: string } = {},
): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Screen translation requires Windows and .NET Framework 4.8')
  const root = path.resolve(repoRoot)
  const source = path.join(root, 'native', 'screen-translation')
  const output = path.join(root, '.native-cache', 'screen-translation')
  const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  await access(compiler)
  await mkdir(output, { recursive: true })
  const executable = path.join(output, 'Arkdown.ScreenTranslation.exe')
  const sources = (await readdir(path.join(source, 'src'))).filter((name) => name.endsWith('.cs')).sort()
  await execute(compiler, [
    '/nologo', '/utf8output', '/codepage:65001', '/target:winexe', '/platform:anycpu', '/optimize+',
    `/out:${executable}`, `/win32manifest:${path.join(source, 'app.manifest')}`,
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
    `/resource:${path.join(root, 'src/shared/screen-translation-crosshair.json')},screen-translation-crosshair.json`,
    ...sources.map((name) => path.join(source, 'src', name)),
  ], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
  await writeFile(`${executable}.config`, '<?xml version="1.0" encoding="utf-8"?>\n<configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" /></startup></configuration>\n', 'utf8')
  return executable
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void buildScreenTranslation().then((executable) => process.stdout.write(`${executable}\n`)).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
