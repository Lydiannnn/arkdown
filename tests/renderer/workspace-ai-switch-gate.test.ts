import { describe, expect, it } from 'vitest'
import {
  sameWorkspacePath,
  workspacePathForDroppedInspection,
} from '../../src/renderer/app/workspace-ai-switch-gate'

describe('workspace AI switch path gate', () => {
  it('treats Windows path case, separator, and trailing separator differences as one workspace', () => {
    expect(sameWorkspacePath('C:/Notes', 'c:\\notes\\')).toBe(true)
    expect(sameWorkspacePath('C:/Notes', 'C:/Other')).toBe(false)
  })

  it('derives the workspace target before a dropped path is opened', () => {
    expect(workspacePathForDroppedInspection({
      kind: 'directory', absolutePath: 'D:\\Other',
    })).toBe('D:\\Other')
    expect(workspacePathForDroppedInspection({
      kind: 'file', absolutePath: 'D:/Other/away.md',
    })).toBe('D:\\Other')
    expect(workspacePathForDroppedInspection({
      kind: 'file', absolutePath: 'C:\\root.md',
    })).toBe('C:\\')
    expect(workspacePathForDroppedInspection({
      kind: 'file', absolutePath: 'relative.md',
    })).toBeNull()
  })
})
