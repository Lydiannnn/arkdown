import { expect, it } from 'vitest'
import {
  documentSessionReducer,
  EMPTY_SESSION,
  isDirty,
} from '../../src/renderer/editor/document-session'

it('keeps an untitled blank page ready for editing', () => {
  expect(EMPTY_SESSION.status).toBe('ready')
  expect(EMPTY_SESSION.relativePath).toBeNull()

  const changed = documentSessionReducer(EMPTY_SESSION, {
    type: 'changed',
    markdown: '# 新文档',
  })

  expect(changed.status).toBe('ready')
  expect(isDirty(changed)).toBe(true)
})
