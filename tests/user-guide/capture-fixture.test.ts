import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'

it('builds the approved sanitized three-document screenshot workspace', async () => {
  const script = await readFile('scripts/capture-app-windows.ps1', 'utf8')

  expect(script).toContain("(Join-Path $workspaceRoot '欢迎使用.md')")
  expect(script).toContain("(Join-Path $workspaceRoot '学习笔记.md')")
  expect(script).toContain("(Join-Path $workspaceRoot '资料\\Markdown 示例.md')")

  const stickyScript = await readFile('scripts/capture-sticky-note-box.ts', 'utf8')
  expect(stickyScript).toContain('项目灵感')
  expect(stickyScript).toContain('今日待办')
})
