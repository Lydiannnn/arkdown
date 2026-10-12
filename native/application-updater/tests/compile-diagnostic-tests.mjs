import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// Compile only: the root agent owns serial native execution and process checks.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const output = process.argv[2]
if (!output || !path.isAbsolute(output)) throw new Error('Pass a unique absolute report scratch directory')
const source = path.join(root, 'native/application-updater/src')
const scratch = path.join(output, 'fault-inputs')
await mkdir(scratch, { recursive: true })
function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error('Fault injection source anchor must occur exactly once: ' + from)
  return text.replace(from, to)
}
const original = (await readdir(source)).filter(name => name.endsWith('.cs')).sort()
const injected = []
for (const name of original) {
  let text = await readFile(path.join(source, name), 'utf8')
  if (name === 'Portable.cs') {
    text = replaceOnce(text, 'dest.Stream.Flush(true);', 'DiagnosticFaults.Flush(dest.Stream);')
    text = replaceOnce(text, 'Directory.GetFiles(ioStage,"*",SearchOption.AllDirectories)', 'DiagnosticFaults.GetFiles(ioStage,"*",SearchOption.AllDirectories)')
    text = replaceOnce(text, 'foreach(var f in trustedFiles) {', 'DiagnosticFaults.BeforeVerify(stage);foreach(var f in trustedFiles) {')
  }
  if (name === 'Safety.cs') {
    text = replaceOnce(text, 'Stream.Dispose();handle.Dispose();', 'Stream.Dispose();handle.Dispose();DiagnosticFaults.AfterDispose();')
    text = replaceOnce(text, 'Directory.CreateDirectory(Safety.IoPath(path))', 'DiagnosticFaults.CreateDirectory(Safety.IoPath(path))')
  }
  const file = path.join(scratch, name); await writeFile(file, text, 'utf8'); injected.push(file)
}
const execute = promisify(execFile)
const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
const common = ['/nologo', '/utf8output', '/codepage:65001', '/target:exe', '/platform:x64', '/optimize+',
  '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
  '/reference:System.Web.Extensions.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll']
for (const [name, inputs] of [['DiagnosticTests', original.map(name => path.join(source, name))], ['DiagnosticFaultTests', injected]]) {
  const executable = path.join(output, name + '.exe')
  const result = await execute(compiler, [...common, '/main:' + name, '/out:' + executable,
    ...inputs, path.join(root, 'native/application-updater/tests', name + '.cs')], { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  if (result.stdout) process.stdout.write(result.stdout)
  console.log('Compiled only: ' + executable)
}
