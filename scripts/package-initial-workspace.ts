import { cp, stat } from 'node:fs/promises'
import path from 'node:path'

export async function copyInitialWorkspaceToPackages(outputPaths: string[], source = path.resolve('initial-workspace')) {
  if (!(await stat(path.join(source, '01-欢迎使用.md'))).isFile()) throw new Error('Initial workspace template missing')
  for (const output of outputPaths) {
    await cp(source, path.join(output, '初始工作区'), { recursive: true, force: false, errorOnExist: true })
  }
}
