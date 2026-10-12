import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveUserGuidePath } from '../../src/main/user-guide-path'

describe('resolveUserGuidePath', () => {
  it('uses the built guide under the project root in development mode', () => {
    expect(resolveUserGuidePath({
      executablePath: 'C:\\project\\node_modules\\electron\\dist\\electron.exe',
      isPackaged: false,
      projectRoot: 'C:\\project\\Arkdown',
    })).toBe(path.join(
      'C:\\project\\Arkdown',
      'user-guide',
      'dist',
      '使用说明书.html',
    ))
  })

  it('uses the guide beside Arkdown.exe in packaged mode', () => {
    expect(resolveUserGuidePath({
      executablePath: 'D:\\Portable\\Arkdown\\Arkdown.exe',
      isPackaged: true,
      projectRoot: 'C:\\project\\Arkdown',
    })).toBe(path.join('D:\\Portable\\Arkdown', '使用说明书.html'))
  })
})
