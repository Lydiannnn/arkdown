import { createHash } from 'node:crypto'
import path from 'node:path'

function windowsPathIdentity(absolutePath: string): string {
  return path.win32.normalize(absolutePath).toLocaleLowerCase('en-US')
}

export function recentDocumentMenuItemId(absolutePath: string): string {
  const digest = createHash('sha256')
    .update('arkdown:recent-document\0', 'utf8')
    .update(windowsPathIdentity(absolutePath), 'utf8')
    .digest('base64url')
  return `file.recent.${digest}`
}
