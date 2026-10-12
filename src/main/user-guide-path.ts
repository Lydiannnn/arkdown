import path from 'node:path'

export interface ResolveUserGuidePathOptions {
  executablePath: string
  isPackaged: boolean
  projectRoot: string
}

export function resolveUserGuidePath(options: ResolveUserGuidePathOptions): string {
  return options.isPackaged
    ? path.join(path.dirname(options.executablePath), '使用说明书.html')
    : path.join(options.projectRoot, 'user-guide', 'dist', '使用说明书.html')
}
