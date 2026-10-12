export const WORKSPACE_COLOR_IDS = Object.freeze([
  '#C62828',
  '#800080',
  '#2563EB',
  '#007C91',
  '#18864B',
  '#C66A00',
  '#B83280',
] as const)

export type WorkspaceColorId = typeof WORKSPACE_COLOR_IDS[number]

export interface WorkspaceColorFile {
  schemaVersion: 1
  workspaceKey: string
  marks: Record<string, WorkspaceColorId>
}

export interface WorkspaceColorMarksSnapshot {
  marks: Record<string, WorkspaceColorId>
}

export const WORKSPACE_COLOR_MARK_LIMIT = 10_000
export const WORKSPACE_COLOR_FILE_MAX_BYTES = 1_048_576

const WORKSPACE_COLOR_SET = new Set<string>(WORKSPACE_COLOR_IDS)
const WINDOWS_ABSOLUTE = /^(?:[a-z]:[\\/]|[\\/]{2})/iu

export function isWorkspaceColorId(value: unknown): value is WorkspaceColorId {
  return typeof value === 'string' && WORKSPACE_COLOR_SET.has(value)
}

export function canonicalWorkspaceColorPath(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > 32_768
    || value.includes('\0')
    || WINDOWS_ABSOLUTE.test(value)
    || value.startsWith('/')
  ) return undefined
  const components = value.split(/[\\/]+/u)
  if (
    components.length === 0
    || components.some((component) => component.length === 0 || component === '.' || component === '..')
  ) return undefined
  return components.join('/').toLocaleLowerCase('en-US')
}

export function workspaceColorMarkForPath(
  marks: WorkspaceColorMarksSnapshot['marks'] | undefined,
  relativePath: unknown,
): WorkspaceColorId | undefined {
  const canonicalPath = canonicalWorkspaceColorPath(relativePath)
  if (!canonicalPath || !marks || !Object.hasOwn(marks, canonicalPath)) return undefined
  const color = marks[canonicalPath]
  return isWorkspaceColorId(color) ? color : undefined
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

export function parseWorkspaceColorFile(value: unknown): WorkspaceColorFile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (
    !hasExactKeys(source, ['marks', 'schemaVersion', 'workspaceKey'])
    || source.schemaVersion !== 1
    || typeof source.workspaceKey !== 'string'
    || source.workspaceKey.length === 0
    || source.workspaceKey.length > 32_768
    || typeof source.marks !== 'object'
    || source.marks === null
    || Array.isArray(source.marks)
  ) return undefined
  const entries = Object.entries(source.marks as Record<string, unknown>)
  if (entries.length > WORKSPACE_COLOR_MARK_LIMIT) return undefined
  const marks = Object.create(null) as Record<string, WorkspaceColorId>
  for (const [relativePath, color] of entries) {
    if (canonicalWorkspaceColorPath(relativePath) !== relativePath || !isWorkspaceColorId(color)) {
      continue
    }
    marks[relativePath] = color
  }
  return { schemaVersion: 1, workspaceKey: source.workspaceKey, marks }
}

export function parseWorkspaceColorMarksSnapshot(
  value: unknown,
): WorkspaceColorMarksSnapshot | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (!hasExactKeys(source, ['marks'])) return undefined
  const file = parseWorkspaceColorFile({
    schemaVersion: 1,
    workspaceKey: 'snapshot',
    marks: source.marks,
  })
  return file ? { marks: file.marks } : undefined
}
