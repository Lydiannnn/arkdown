import path from 'node:path'

export interface ArknotePaths {
  root: string
  notes: string
  settings: string
  token: string
  profile: string
}

export function assertAbsoluteNormalizedPath(value: string, label: string): void {
  if (!path.isAbsolute(value)) throw new Error(`${label}必须是绝对路径`)
  if (path.normalize(value) !== value) throw new Error(`${label}必须是规范化路径`)
}

export function pathsOverlap(first: string, second: string): boolean {
  const firstToSecond = path.relative(first, second)
  const secondToFirst = path.relative(second, first)
  const isInside = (relative: string): boolean => (
    relative === ''
    || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  )
  return isInside(firstToSecond) || isInside(secondToFirst)
}

export function arknotePaths(applicationDirectory: string): ArknotePaths {
  assertAbsoluteNormalizedPath(applicationDirectory, 'Arknote 程序目录')
  const root = path.resolve(applicationDirectory, 'portable-data', 'arknote')
  return {
    root,
    notes: path.join(root, 'notes'),
    settings: path.join(root, 'settings.json'),
    token: path.join(root, 'service-token'),
    profile: path.join(root, 'electron-profile'),
  }
}
