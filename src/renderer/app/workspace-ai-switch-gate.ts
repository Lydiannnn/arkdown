import type { DroppedPathInspection } from '../../shared/contracts'

export const WORKSPACE_AI_SWITCH_COPY = Object.freeze({
  title: '切换工作区将创建新的AI对话',
  description: '之后再切回原先工作区可以继续之前的对话',
  confirmLabel: '切换',
  cancelLabel: '取消',
})

function normalizeWorkspacePath(value: string): string {
  const normalized = value.replaceAll('/', '\\')
  const withoutTrailingSeparators = normalized.replace(/\\+$/u, '')
  return (withoutTrailingSeparators || normalized).toLocaleLowerCase('en-US')
}

export function sameWorkspacePath(left: string, right: string): boolean {
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right)
}

export function workspacePathForDroppedInspection(
  inspection: DroppedPathInspection,
): string | null {
  if (inspection.kind === 'directory') return inspection.absolutePath
  const normalized = inspection.absolutePath.replaceAll('/', '\\')
  const separator = normalized.lastIndexOf('\\')
  if (separator < 0) return null
  if (separator === 2 && /^[a-z]:/iu.test(normalized)) return normalized.slice(0, 3)
  return normalized.slice(0, separator)
}
