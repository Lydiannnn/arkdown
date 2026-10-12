import { execFile } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const source = path.join(root, 'native/screen-translation/src')
const output = path.join(root, '.native-cache/screen-translation/tests')
await mkdir(output, { recursive: true })
const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
const sources = (await readdir(source)).filter((file) => file.endsWith('.cs')).map((file) => path.join(source, file))
for (const suite of ['CoreTests', 'ProtocolTests', 'OverlayDrawingTests']) {
  const executable = path.join(output, `${suite}.exe`)
  const result = await execute(compiler, [
    '/nologo', '/utf8output', '/codepage:65001', '/target:exe', `/main:${suite}`, `/out:${executable}`,
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
    `/resource:${path.join(root, 'src/shared/screen-translation-crosshair.json')},screen-translation-crosshair.json`,
    ...sources, path.join(root, 'native/screen-translation/tests', `${suite}.cs`),
  ], { windowsHide: true, encoding: 'utf8', timeout: 60_000 })
  if (result.stdout) process.stdout.write(result.stdout)
  const tests = await execute(executable, [], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60_000 })
  process.stdout.write(tests.stdout)
}
