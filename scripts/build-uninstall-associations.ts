import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_APPLICATION_CANDIDATES } from '../src/shared/default-application-registration.ts'

export async function uninstallAssociationInclude(repo: string) {
  const source = await readFile(path.join(repo, 'installer/windows/uninstall-associations.ps1'), 'utf8')
  const script = source.replace('__ARKDOWN_CANDIDATES_JSON__', JSON.stringify(DEFAULT_APPLICATION_CANDIDATES).replaceAll("'", "''"))
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  if (encoded.length > 30000) throw new Error('Uninstall cleanup exceeds the Windows command-line budget')
  return {
    include: "const\n  AssociationCleanupEncoded =\n" + (encoded.match(/.{1,160}/g) ?? []).map(part => `    '${part}'`).join(' +\n') + ';\n',
    sha256: createHash('sha256').update(script, 'utf8').digest('hex'),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = process.argv[2]
  if (!output) throw new Error('Expected output include path')
  const result = await uninstallAssociationInclude(path.resolve(import.meta.dirname, '..'))
  await writeFile(output, result.include, 'utf8')
}
