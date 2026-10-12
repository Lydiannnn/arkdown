import { expect, it } from 'vitest'
import { decodeWorkspaceDrag, encodeWorkspaceDrag } from '../../src/renderer/workspace/workspace-drag'

it('keeps file and folder paths within the workspace that supplied the drag', () => {
  const payload = encodeWorkspaceDrag('C:/文档', '章节/a b.md', 'document')
  expect(decodeWorkspaceDrag(payload, 'C:/文档')).toEqual({ absolutePath: 'C:/文档/章节/a b.md', kind: 'file' })
  expect(decodeWorkspaceDrag(encodeWorkspaceDrag('C:/文档', '章节', 'directory'), 'C:/文档')?.kind).toBe('folder')
  expect(decodeWorkspaceDrag(payload, 'C:/其他')).toBeNull()
  expect(decodeWorkspaceDrag(encodeWorkspaceDrag('C:/文档', '../私有.md', 'document'), 'C:/文档')).toBeNull()
  expect(decodeWorkspaceDrag('invalid', 'C:/文档')).toBeNull()
})
