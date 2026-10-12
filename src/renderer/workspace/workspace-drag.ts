export const WORKSPACE_ENTRY_MIME = 'application/x-arkdown-workspace-entry'

export function encodeWorkspaceDrag(workspace: string, relativePath: string, kind: string): string {
  return JSON.stringify({ workspace, relativePath, kind })
}

export function decodeWorkspaceDrag(payload: string, workspace: string | undefined): {
  absolutePath: string; kind: 'file' | 'folder'
} | null {
  if (!workspace) return null
  try {
    const value = JSON.parse(payload)
    if (value.workspace !== workspace || typeof value.relativePath !== 'string'
      || !['document', 'directory'].includes(value.kind)) return null
    const parts = value.relativePath.replaceAll('\\', '/').split('/')
    if (parts.some((part: string) => !part || part === '.' || part === '..' || /[:\0\r\n]/.test(part))) return null
    return { absolutePath: `${workspace.replaceAll('\\', '/').replace(/\/$/, '')}/${parts.join('/')}`,
      kind: value.kind === 'directory' ? 'folder' : 'file' }
  } catch { return null }
}
